'use strict';
// The Hop Report — PSK Reporter live layer (MQTT + retrieval)
// Plain script (not a module) so the page keeps working from file://.

const LIVE_WINDOW = 30 * 60 * 1000;
// Everything downstream of liveStats speaks spots per hour, whatever the
// window length: the scorer's reference and the population baseline are
// both hourly rates, so window counts are scaled up by this factor.
const WINDOWS_PER_HOUR = 3600000 / LIVE_WINDOW;

/* ---------- live spot layer (PSK Reporter) ---------- */

let spots = [];        // { t, band, km, md, rx, who, tp, src }
let lastCtx = null;
let mqttClient = null, mqttGrids = '';
// The retrieval limit survives reloads so a refresh cannot be used to
// query PSK Reporter more often than its rules allow.
let lastQsl = 0;
try { lastQsl = +localStorage.getItem('hopQslAt') || 0; } catch (e) {}
let myGrids = new Set();   // current 4-char square + neighbors, for direction tagging
let liveSince = 0;         // when the current window started filling (0 = no feed yet)
let lostAt = 0;            // when an established link dropped (0 = link healthy)
// Receptions of the operator's own signal, kept apart from the scoring
// window so the heard line can answer "was I heard" even for spots the
// window rejects as ground wave. mqttCall is the callsign the live feed
// is filtered by; ownHeard rows are { t, band, rx, km }.
let mqttCall = '';
let ownHeard = [];

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
  ownHeard = ownHeard.filter(o => o.t > cut);
}

/* ---------- persistence: a reload keeps the spot window ---------- */

const SPOTS_KEY = 'hopSpots';
const BAND_ORD = Object.fromEntries(BANDS.map((b, i) => [b.nm, i]));
let restoredKey = '';

function saveSpots() {
  // Serialized on every render tick and when the tab hides: cheap, and
  // it means a reload starts from the evidence it already had instead
  // of an empty window. Each spot is a bare row of age in whole seconds,
  // band ordinal, and 0/1 flags rather than a keyed object: a busy
  // neighborhood holds tens of thousands of spots, and the object form
  // ran the blob into the browser's per-origin storage quota.
  if (!mqttGrids && !spots.length) return;
  const savedAt = Date.now();
  try {
    localStorage.setItem(SPOTS_KEY, JSON.stringify({
      v: 2, gridKey: mqttGrids, savedAt, liveSince,
      spots: spots.map(s => [Math.round((savedAt - s.t) / 1000), BAND_ORD[s.band],
        s.km, s.md, s.rx ? 1 : 0, s.who, s.tp ? 1 : 0, s.src === 'r' ? 1 : 0]),
      own: ownHeard.map(o => [Math.round((savedAt - o.t) / 1000), BAND_ORD[o.band],
        o.rx, o.km]),
    }));
  } catch (e) { /* storage full or unavailable: persistence is a bonus */ }
}

function restoreSpots(key) {
  // Coverage survives as an amount, not a place: the old session covered
  // [liveSince, savedAt], only the part still inside the rolling window
  // counts, and the closed-tab gap is uncovered time exactly like a
  // dropped link. The estimator downstream only ever divides counts by
  // covered time, so no scoring logic changes. A save in the old keyed
  // format has no v stamp and is discarded, a one-time loss at upgrade.
  if (restoredKey === key) return;
  restoredKey = key;
  let d = null;
  try { d = JSON.parse(localStorage.getItem(SPOTS_KEY)); } catch (e) {}
  if (!d || d.v !== 2 || d.gridKey !== key || !Array.isArray(d.spots)) return;
  const now = Date.now();
  const gap = now - d.savedAt;
  if (!(gap >= 0) || gap >= LIVE_WINDOW) return;   // all aged out, or clock skew
  const cut = now - LIVE_WINDOW;
  spots = [];
  for (const r of d.spots) {
    if (!Array.isArray(r) || !Number.isFinite(r[0]) || !Number.isFinite(r[2])) continue;
    const band = BANDS[r[1]] ? BANDS[r[1]].nm : '';
    const t = d.savedAt - r[0] * 1000;
    if (!band || t <= cut) continue;
    spots.push({ t, band, km: r[2], md: String(r[3] || ''), rx: !!r[4],
                 who: String(r[5] || ''), tp: !!r[6], src: r[7] ? 'r' : 'm' });
  }
  ownHeard = [];
  if (Array.isArray(d.own)) {
    for (const r of d.own) {
      if (!Array.isArray(r) || !Number.isFinite(r[0])) continue;
      const band = BANDS[r[1]] ? BANDS[r[1]].nm : '';
      const t = d.savedAt - r[0] * 1000;
      if (!band || t <= cut) continue;
      ownHeard.push({ t, band, rx: String(r[2] || ''), km: r[3] });
    }
  }
  if (d.liveSince) {
    const covered = Math.min(Math.max(0, d.savedAt - d.liveSince), LIVE_WINDOW - gap);
    liveSince = now - covered;
  }
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
  // Whole kilometers: the grid centers already carry a square of slack,
  // and the persisted rows should not spend fifteen digits per distance.
  const km = Math.round(kmBetween(a, b)), md = mode || '';
  // A reception of the operator's own signal feeds the heard line before
  // any scoring filter runs: a skimmer next door says nothing about the
  // sky, but it is still an answer to "was I heard". The broker can
  // deliver one copy per matching subscription when the callsign and
  // grid filters overlap, hence the exact-match guard.
  if (mqttCall && rxCall && String(txCall || '').toUpperCase() === mqttCall &&
      !ownHeard.some(o => o.t === t && o.band === band && o.rx === rxCall))
    ownHeard.push({ t, band, rx: rxCall, km });
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
  // both raw (n, cw and the display splits) and coverage-weighted (w*).
  // The weighted counts are hourly rates: an MQTT spot was caught in only
  // the filled fraction of the 30 minute window, so it stands for
  // WINDOWS_PER_HOUR/fill spots per hour (never extrapolating from less
  // than five minutes of data), while a retrieval spot arrives with the
  // whole window behind it and counts WINDOWS_PER_HOUR. max2 is the
  // second-longest distance; reach is scored on it so one mangled
  // locator cannot swing a band.
  const w = WINDOWS_PER_HOUR / Math.max(1 / 6, Math.min(1, fill ?? 1));
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
    const wx = x.src === 'r' ? WINDOWS_PER_HOUR : w;
    if (isCw) { cw++; if (x.rx) { cRx++; wcRx += wx; } else { cTx++; wcTx += wx; } }
    else if (x.rx) { dRx++; wdRx += wx; }
    else { dTx++; wdTx += wx; }
    if (x.km > max) { max2 = max; max = x.km; }
    else if (x.km > max2) max2 = x.km;
  }
  return { n, max, max2, cw, dRx, dTx, cRx, cTx, wdRx, wdTx, wcRx, wcTx, tN, tMax };
}

function windowFill() {
  // Filled fraction of the window. The feed carries no history, so a
  // fresh page has only minutes of spots; retrieval spots arrive with the
  // window already covered, so no feed at all means it counts as full.
  return liveSince ? Math.min(1, (Date.now() - liveSince) / LIVE_WINDOW) : 1;
}

function setLiveState(txt, cls) {
  const el = $('mqttState');
  el.textContent = txt;
  el.className = 'lstate' + (cls ? ' ' + cls : '');
  // The line surfaces only when the feed is unreachable or degraded; a
  // healthy live layer speaks through the band facts instead.
  $('liveline').hidden = !(cls === 'bad' || cls === 'warn');
}

function subscribeGrids(c, grids) {
  // topic: pskr/filter/v2/{band}/{mode}/{txcall}/{rxcall}/{txgrid4}/{rxgrid4}/{txdxcc}/{rxdxcc}
  for (const g of grids) {
    c.subscribe(`pskr/filter/v2/+/+/+/+/${g}/+/+/+`); // transmitted from our area
    c.subscribe(`pskr/filter/v2/+/+/+/+/+/${g}/+/+`); // received in our area
  }
}

const callTopic = call => `pskr/filter/v2/+/+/${call}/+/+/+/+/+`;

function setCall(call) {
  // Follows the callsign field: the live feed is additionally filtered
  // by the operator's own call as sender, so reports of their signal
  // arrive as they happen whether or not the retrieval API answers.
  // Rides the existing connection as one extra topic; touches nothing
  // else, and a disconnected client just picks the topic up on connect.
  call = String(call || '').trim().toUpperCase();
  if (call === mqttCall) return;
  const c = mqttClient;
  if (c && c.connected) {
    if (mqttCall) { try { c.unsubscribe(callTopic(mqttCall)); } catch (e) {} }
    if (call) { try { c.subscribe(callTopic(call)); } catch (e) {} }
  }
  mqttCall = call;
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
  const key = grids.join(',');
  if (key === mqttGrids && mqttClient && (mqttClient.connected || cascadeActive)) return;
  if (mqttClient) { try { mqttClient.end(true); } catch (e) {} mqttClient = null; spots = []; ownHeard = []; liveSince = 0; lostAt = 0; }
  mqttGrids = key;
  restoreSpots(key);   // before the mqtt bail-out: a broker-less page still keeps its window
  if (!window.mqtt) {
    setLiveState('mqtt.js failed to load. Scores are model only.', 'bad');
    return;
  }
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
        'Three rounds without an answer. The broker accepts secure WebSockets from https pages, so this is a firewall on port 1886, a broker outage, or this browser\'s own network stack gone stale, which can happen after a sleep and wake. Restarting the browser clears a stale stack; if the page connects fine in a different browser, that was it. Retries continue in the background.';
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
    if (mqttCall) c.subscribe(callTopic(mqttCall));
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
  // The heard line is the answer to the button's question, so a
  // successful query speaks through it instead of leaving a count here.
  // The note keeps only the words the heard line cannot say: the empty
  // answer after a button press. A background query stays quiet even then.
  if (added) $('qslNote').textContent = '';
  else if (!qslAuto) $('qslNote').textContent = 'no reports found. Transmit a few FT8 or CW CQ cycles first.';
  if (lastCtx) renderBands(lastCtx);
};

let qslAuto = false;

function queryMySpots(auto) {
  // The button asks loudly; the five minute background cadence (app.js)
  // passes auto and walks away without a word when the callsign is blank
  // or the retrieval limit has not lapsed yet.
  const call = $('mycall').value.trim().toUpperCase();
  if (!call) { if (!auto) $('qslNote').textContent = 'enter your callsign first'; return; }
  try { localStorage.setItem('hopCall', call); } catch (e) {}
  // Any path that queries also arms the heard line, so the results always
  // have somewhere to land, even if the field never fired its change event.
  setCall(call);
  const wait = 5 * 60 * 1000 - (Date.now() - lastQsl);
  if (wait > 0) {
    if (!auto) $('qslNote').textContent =
      `PSK Reporter allows one query every 5 minutes. ${Math.ceil(wait / 60000)} min to go.`;
    return;
  }
  lastQsl = Date.now();
  try { localStorage.setItem('hopQslAt', String(lastQsl)); } catch (e) {}
  qslAuto = !!auto;
  if (!auto) $('qslNote').textContent = 'querying';
  const s = document.createElement('script');
  s.src = 'https://retrieve.pskreporter.info/query?senderCallsign=' +
    encodeURIComponent(call) + '&flowStartSeconds=-1800&rronly=1&callback=pskrCb';
  s.onload = () => s.remove();
  s.onerror = () => { $('qslNote').textContent = 'query failed (blocked or rate limited)'; s.remove(); };
  document.body.appendChild(s);
}
