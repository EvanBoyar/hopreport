'use strict';
// The Hop Report — PSK Reporter live layer (MQTT + retrieval)
// Plain script (not a module) so the page keeps working from file://.

const LIVE_WINDOW = 60 * 60 * 1000;

/* ---------- live spot layer (PSK Reporter) ---------- */

let spots = [];        // { t, band, km, md, rx }
let lastCtx = null;
let mqttClient = null, mqttGrids = '';
let lastQsl = 0;
let myGrids = new Set();   // current 4-char square + neighbors, for direction tagging

// Bare wss on 1886 is the confirmed-working endpoint (sometimes slow to
// answer, hence the generous timeout), so it leads. wss works from https and
// file:// alike; plain ws is a last resort and only usable off-https.
const MQTT_URLS = ['wss://mqtt.pskreporter.info:1886',
                   'wss://mqtt.pskreporter.info:1886/mqtt']
  .concat(location.protocol === 'https:' ? [] :
    ['ws://mqtt.pskreporter.info:1886', 'ws://mqtt.pskreporter.info:1886/mqtt']);
let goodUrl = null, cascadeActive = false;

function pruneSpots() {
  const cut = Date.now() - LIVE_WINDOW;
  spots = spots.filter(s => s.t > cut);
}

function addSpot(band, gridA, gridB, mode, heardMs) {
  if (!BAND_BY_NAME[band]) return;
  const now = Date.now();
  // Age by when the spot was heard (MQTT t, retrieval flowStartSeconds),
  // not when it reached us; clamp reporter clock skew into the present.
  const t = Math.min(Number.isFinite(heardMs) && heardMs > 0 ? heardMs : now, now);
  if (t <= now - LIVE_WINDOW) return;
  const a = parseGrid((gridA || '').slice(0, 4));
  const b = parseGrid((gridB || '').slice(0, 4));
  if (!a || !b) return;
  const km = kmBetween(a, b), md = mode || '';
  // The retrieval query re-delivers the same reports on every 5 minute
  // poll; over an hour window they would otherwise count many times.
  if (spots.some(s => s.t === t && s.band === band && s.km === km && s.md === md)) return;
  // Direction: rx means a monitor in our neighborhood heard this spot;
  // otherwise our neighborhood was the one being heard elsewhere.
  const rx = myGrids.has((gridB || '').slice(0, 4).toUpperCase());
  spots.push({ t, band, km, md, rx });
}

function liveStats(bandName, useDigi, useCw) {
  // CW spots reach the feed through RBN's skimmers; the CW switch gates
  // them and the digi switch gates every other mode. Counts are kept per
  // mode and per direction so the scorer can weigh and normalize each.
  let n = 0, max = 0, cw = 0, dRx = 0, dTx = 0, cRx = 0, cTx = 0;
  for (const x of spots) {
    if (x.band !== bandName) continue;
    const isCw = x.md === 'CW';
    if (isCw ? !useCw : !useDigi) continue;
    n++;
    if (isCw) { cw++; x.rx ? cRx++ : cTx++; }
    else { x.rx ? dRx++ : dTx++; }
    if (x.km > max) max = x.km;
  }
  return { n, max, cw, dRx, dTx, cRx, cTx };
}

function setLiveState(txt, cls) {
  const el = $('mqttState');
  el.textContent = txt;
  el.className = 'lstate' + (cls ? ' ' + cls : '');
  // The line only surfaces when the feed is unhealthy; a working live
  // layer speaks through the band facts instead.
  $('liveline').hidden = !(cls === 'bad' || cls === 'warn');
}

function subscribeGrids(c, grids) {
  // topic: pskr/filter/v2/{band}/{mode}/{txcall}/{rxcall}/{txgrid4}/{rxgrid4}/{txdxcc}/{rxdxcc}
  for (const g of grids) {
    c.subscribe(`pskr/filter/v2/+/+/+/+/${g}/+/+/+`); // transmitted from our area
    c.subscribe(`pskr/filter/v2/+/+/+/+/+/${g}/+/+`); // received in our area
  }
}

function handleSpot(topic, payload) {
  try {
    const m = JSON.parse(payload.toString());
    const band = (m.b && BAND_BY_NAME[String(m.b).toLowerCase()])
      ? String(m.b).toLowerCase() : bandFromHz(m.f);
    if (band) addSpot(band, m.sl, m.rl, String(m.md || '').toUpperCase(), Number(m.t) * 1000);
  } catch (e) { /* malformed spot, skip */ }
}

function connectLive(pos) {
  const grids = neighborGrids(pos);
  myGrids = new Set(grids);   // before any bail-out: retrieval spots need it too
  if (!window.mqtt) {
    setLiveState('mqtt.js failed to load. Scores are model only.', 'bad');
    return;
  }
  const key = grids.join(',');
  if (key === mqttGrids && mqttClient && (mqttClient.connected || cascadeActive)) return;
  if (mqttClient) { try { mqttClient.end(true); } catch (e) {} mqttClient = null; spots = []; }
  mqttGrids = key;
  const urls = goodUrl
    ? [goodUrl, ...MQTT_URLS.filter(u => u !== goodUrl)]
    : MQTT_URLS.slice();
  attemptConnect(urls, grids);
}

function attemptConnect(urls, grids, round = 1) {
  if (!urls.length) {
    // Never give up: quick rounds at first, then a gentler cadence so we do
    // not hammer the broker. Scores stay model only until the feed answers.
    const delay = round < 3 ? 20 : 60;
    setLiveState(`no answer on round ${round}. Retrying in ${delay} s; scores are model only meanwhile.`, 'warn');
    if (round === 3) {
      $('qslNote').textContent =
        'Three rounds without an answer. The broker accepts secure WebSockets from https pages, so a firewall on port 1886 or a broker outage is likely. Retries continue in the background.';
    }
    setTimeout(() => {
      if (mqttGrids !== grids.join(',')) return;
      const retry = goodUrl
        ? [goodUrl, ...MQTT_URLS.filter(u => u !== goodUrl)]
        : MQTT_URLS.slice();
      attemptConnect(retry, grids, round + 1);
    }, delay * 1000);
    return;
  }
  cascadeActive = true;
  const url = urls[0];
  setLiveState(`trying ${url} (the broker can take up to 20 s)`);
  const c = mqtt.connect(url, {
    clientId: 'bandcond_' + Math.random().toString(16).slice(2, 10),
    keepalive: 60, reconnectPeriod: 0, connectTimeout: 20000,
  });
  mqttClient = c;
  let settled = false, wasConnected = false;
  c.on('connect', () => {
    settled = true; wasConnected = true;
    goodUrl = url; cascadeActive = false;
    setLiveState(`live: ${grids[0]} + ${grids.length - 1} neighbors via ${url.split('//')[1]}`, 'ok');
    $('qslNote').textContent = '';
    subscribeGrids(c, grids);
  });
  c.on('message', handleSpot);
  const fail = () => {
    if (mqttClient !== c) return;              // superseded by a newer attempt
    if (wasConnected) {                        // an established link dropped
      wasConnected = false;
      setLiveState('link lost. Retrying in 15 s.', 'warn');
      setTimeout(() => {
        if (mqttClient !== c) return;
        try { c.end(true); } catch (e) {}
        attemptConnect([goodUrl, ...MQTT_URLS.filter(u => u !== goodUrl)], grids);
      }, 15000);
      return;
    }
    if (settled) return;                       // this attempt already resolved
    settled = true;
    try { c.end(true); } catch (e) {}
    attemptConnect(urls.slice(1), grids, round); // next candidate
  };
  c.on('error', fail);
  c.on('close', fail);
  c.on('offline', fail);
}

// JSONP callback for the retrieval API.
window.pskrCb = function (data) {
  const reps = (data && data.receptionReport) || [];
  let added = 0;
  for (const r of reps) {
    const band = bandFromHz(r.frequency);
    if (!band) continue;
    addSpot(band, r.senderLocator, r.receiverLocator, String(r.mode || '').toUpperCase(),
      Number(r.flowStartSeconds) * 1000);
    added++;
  }
  $('qslNote').textContent = added
    ? `${added} reception reports from the last hour folded into the live layer`
    : 'no reports found. Transmit a few FT8 or CW CQ cycles first.';
  if (lastCtx) renderBands(lastCtx);
};

function queryMySpots() {
  const call = $('mycall').value.trim().toUpperCase();
  if (!call) { $('qslNote').textContent = 'enter your callsign first'; return; }
  const wait = 5 * 60 * 1000 - (Date.now() - lastQsl);
  if (wait > 0) {
    $('qslNote').textContent =
      `PSK Reporter allows one query every 5 minutes. ${Math.ceil(wait / 60000)} min to go.`;
    return;
  }
  lastQsl = Date.now();
  $('qslNote').textContent = 'querying';
  const s = document.createElement('script');
  s.src = 'https://retrieve.pskreporter.info/query?senderCallsign=' +
    encodeURIComponent(call) + '&flowStartSeconds=-3600&rronly=1&callback=pskrCb';
  s.onerror = () => { $('qslNote').textContent = 'query failed (blocked or rate limited)'; };
  document.body.appendChild(s);
}
