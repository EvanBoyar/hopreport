'use strict';
// The Hop Report — PSK Reporter live layer (MQTT + retrieval)
// Plain script (not a module) so the page keeps working from file://.

const LIVE_WINDOW = 60 * 60 * 1000;

/* ---------- live spot layer (PSK Reporter) ---------- */

let spots = [];        // { t, band, km, md, rx, who, src }
let lastCtx = null;
let mqttClient = null, mqttGrids = '';
let lastQsl = 0;
let myGrids = new Set();   // current 4-char square + neighbors, for direction tagging
let liveSince = 0;         // when the current window started filling (0 = no feed yet)
let lostAt = 0;            // when an established link dropped (0 = link healthy)

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

function addSpot(band, gridA, gridB, mode, heardMs, txCall, rxCall, src) {
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
  // A signal that never touched the ionosphere says nothing about the
  // bands: anything inside the band's ground-wave radius is dropped.
  // Except on 6m, where the stretch between line of sight and the Es
  // floor is troposphere: those spots are kept, flagged tp, and tallied
  // apart from the sky counts.
  let tp = false;
  if (km < MIN_SKY_KM[band]) {
    if (band !== '6m' || km < LOS_KM) return;
    tp = true;
  }
  const who = txCall && rxCall ? txCall + '>' + rxCall : '';
  // Duplicates. The MQTT feed re-delivers nothing, but the retrieval
  // query returns the same flows on every 5 minute poll, and a flow may
  // also have been heard live with a slightly different timestamp: a
  // retrieval spot whose named pair already appears within 10 minutes is
  // the same report. Between live spots only an exact match is a
  // duplicate, since the same pair repeating every cycle is real
  // traffic, and the callsigns keep two stations in one square decoding
  // in the same second from collapsing into each other.
  const dup = src === 'r' && who
    ? spots.some(s => s.band === band && s.md === md && s.who === who &&
                      Math.abs(s.t - t) < 10 * 60 * 1000)
    : spots.some(s => s.t === t && s.band === band && s.km === km &&
                      s.md === md && s.who === who);
  if (dup) return;
  // Direction: rx means a monitor in our neighborhood heard this spot;
  // otherwise our neighborhood was the one being heard elsewhere.
  const rx = myGrids.has((gridB || '').slice(0, 4).toUpperCase());
  spots.push({ t, band, km, md, rx, who, tp, src: src === 'r' ? 'r' : 'm' });
}

function liveStats(bandName, useDigi, useCw, fill) {
  // CW spots reach the feed through RBN's skimmers; the CW switch gates
  // them and the digi switch gates every other mode. Counts are kept per
  // mode and per direction so the scorer can weigh and normalize each,
  // both raw (n, cw and the display splits) and coverage-weighted (w*):
  // an MQTT spot was caught in only the filled fraction of the hour, so
  // it stands for 1/fill spots per hour (capped at x12, five minutes of
  // data), while a retrieval spot arrives with the full hour behind it
  // and counts once. max2 is the second-longest distance; reach is
  // scored on it so one mangled locator cannot swing a band.
  const w = 1 / Math.max(1 / 12, Math.min(1, fill ?? 1));
  let n = 0, max = 0, max2 = 0, cw = 0, dRx = 0, dTx = 0, cRx = 0, cTx = 0,
      wdRx = 0, wdTx = 0, wcRx = 0, wcTx = 0, tN = 0, tMax = 0;
  for (const x of spots) {
    if (x.band !== bandName) continue;
    const isCw = x.md === 'CW';
    if (isCw ? !useCw : !useDigi) continue;
    // Tropo spots (6m) ride their own tally; they never touch the sky
    // counts or reach.
    if (x.tp) { tN++; if (x.km > tMax) tMax = x.km; continue; }
    n++;
    const wx = x.src === 'r' ? 1 : w;
    if (isCw) { cw++; if (x.rx) { cRx++; wcRx += wx; } else { cTx++; wcTx += wx; } }
    else if (x.rx) { dRx++; wdRx += wx; }
    else { dTx++; wdTx += wx; }
    if (x.km > max) { max2 = max; max = x.km; }
    else if (x.km > max2) max2 = x.km;
  }
  return { n, max, max2, cw, dRx, dTx, cRx, cTx, wdRx, wdTx, wcRx, wcTx, tN, tMax };
}

let liveState = { txt: '', cls: '' };

function windowFill() {
  // Filled fraction of the hour window. The feed carries no history, so a
  // fresh page has only minutes of spots; retrieval spots arrive as a full
  // hour, so no feed at all means the window counts as full.
  return liveSince ? Math.min(1, (Date.now() - liveSince) / LIVE_WINDOW) : 1;
}

function paintLiveLine() {
  const el = $('mqttState');
  const fill = windowFill();
  const filling = liveState.cls === 'ok' && fill < 1;
  el.textContent = filling
    ? `${liveState.txt} / window ${Math.round(fill * 60)} of 60 min. Leaving the page open sharpens the scores.`
    : liveState.txt;
  el.className = 'lstate' + (liveState.cls ? ' ' + liveState.cls : '');
  // The line surfaces when the feed is unhealthy, and while the hour
  // window is still filling so nobody mistakes a young page for a full
  // reading; once the window is full it speaks through the band facts.
  $('liveline').hidden = !(liveState.cls === 'bad' || liveState.cls === 'warn' || filling);
}

function setLiveState(txt, cls) {
  liveState = { txt, cls: cls || '' };
  paintLiveLine();
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
    if (band) addSpot(band, m.sl, m.rl, String(m.md || '').toUpperCase(),
      Number(m.t) * 1000, m.sc, m.rc);
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
  if (mqttClient) { try { mqttClient.end(true); } catch (e) {} mqttClient = null; spots = []; liveSince = 0; lostAt = 0; }
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
    // Reconnects keep the window's age, but dead air is not coverage:
    // the outage moves the window's start forward so the filled fraction
    // stays honest about what was actually heard.
    if (!liveSince) liveSince = Date.now();
    else if (lostAt) liveSince = Math.min(Date.now(), liveSince + (Date.now() - lostAt));
    lostAt = 0;
    setLiveState(`live: ${grids[0]} + ${grids.length - 1} neighbors via ${url.split('//')[1]}`, 'ok');
    $('qslNote').textContent = '';
    subscribeGrids(c, grids);
  });
  c.on('message', handleSpot);
  const fail = () => {
    if (mqttClient !== c) return;              // superseded by a newer attempt
    if (wasConnected) {                        // an established link dropped
      wasConnected = false;
      lostAt = Date.now();
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
      Number(r.flowStartSeconds) * 1000, r.senderCallsign, r.receiverCallsign, 'r');
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
  s.onload = () => s.remove();
  s.onerror = () => { $('qslNote').textContent = 'query failed (blocked or rate limited)'; s.remove(); };
  document.body.appendChild(s);
}
