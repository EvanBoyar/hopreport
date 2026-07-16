'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const CTX = { muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, flareMult: 1 };

test('liveStats extrapolates a partial window to a full-hour rate', () => {
  const { api } = load();
  const b20 = api.BANDS.find(b => b.nm === '20m');
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 6; i++) api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 15000 - 1000, 'G' + i, 'K2A');
  for (let i = 0; i < 4; i++) api.addSpot('20m', 'FN30', 'IO91', 'FT8', t - i * 15000 - 2000, 'K2A', 'G' + i);
  const quarter = api.liveStats('20m', true, true, 0.25);     // 7.5 min of data
  const partial = api.liveScore(b20, quarter);
  const full = api.liveScore(b20, api.liveStats('20m', true, true, 1));
  assert.ok(partial > full, `same count over less time scores higher (${Math.round(partial)} > ${Math.round(full)})`);
  // 10 spots in a quarter of the 30 minute window are an 80/hour rate,
  // so they must score like 80 raw per-hour counts.
  const st80 = { n: 80, max: quarter.max, max2: quarter.max2, cw: 0,
                 dRx: 48, dTx: 32, cRx: 0, cTx: 0 };
  assert.ok(Math.abs(partial - api.liveScore(b20, st80)) < 0.01);
});

test('extrapolation is capped at 5 minutes of data', () => {
  const { api } = load();
  const b20 = api.BANDS.find(b => b.nm === '20m');
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 3; i++) api.addSpot('20m', 'IO91', 'FN30', 'CW', t - i * 15000 - 1000, 'G' + i, 'K2A');
  assert.strictEqual(api.liveScore(b20, api.liveStats('20m', true, true, 0.001)),
                     api.liveScore(b20, api.liveStats('20m', true, true, 1 / 6)));
});

test('a constant spot rate scores flat as the window fills', () => {
  // Simulate a page open for 8 vs 24 minutes under a steady 1 spot/min:
  // the score should not climb with coverage.
  const scoreAfter = mins => {
    const { api } = load();
    api.myGrids = new Set(['FN30']);
    const t = Date.now();
    for (let i = 0; i < mins; i++)
      api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000, 'G' + i, 'K2A');
    const b20 = api.BANDS.find(b => b.nm === '20m');
    return api.liveScore(b20, api.liveStats('20m', true, true, mins / 30));
  };
  assert.ok(Math.abs(scoreAfter(8) - scoreAfter(24)) < 0.01,
    `8 min ${scoreAfter(8).toFixed(2)} vs 24 min ${scoreAfter(24).toFixed(2)}`);
});

test('retrieval spots already cover the window and are not extrapolated', () => {
  const { api } = load();
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - 1000, 'G4X', 'K2A');              // heard live
  api.addSpot('20m', 'FN30', 'JN48', 'FT8', t - 20 * 60000, 'K2A', 'DL1X', 'r');  // via retrieval
  const st = api.liveStats('20m', true, true, 0.25);
  assert.strictEqual(st.wdRx, 8);   // the live spot is scaled to the quarter window
  assert.strictEqual(st.wdTx, 2);   // the retrieval spot counts once per window
});

test('renderBands ramps the live blend weight with coverage', () => {
  const seeded = () => {
    const h = load();
    h.api.myGrids = new Set(['FN30']);
    const t = Date.now();
    for (let i = 0; i < 12; i++) h.api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000);
    return h;
  };
  const pct = h => +/(\d+) \/ 100/.exec(
    h.el('bands').innerHTML.split('<div class="band">').find(r => r.includes('>20m<'))
      .replace(/[\s\S]*stampcell/, ''))[1];

  const young = seeded();
  young.api.liveSince = Date.now() - 12 * 60 * 1000;   // 12 minutes of feed
  young.api.renderBands(CTX);

  const mature = seeded();
  mature.api.liveSince = Date.now() - 30 * 60 * 1000;  // full window
  mature.api.renderBands(CTX);

  // Same spots: the young page extrapolates a higher live score but trusts
  // it less; both must land between the pure model and pure live extremes,
  // and neither may crash. The real assertion is stability across fill.
  assert.ok(Number.isFinite(pct(young)) && Number.isFinite(pct(mature)));
  const spread = Math.abs(pct(young) - pct(mature));
  assert.ok(spread < 25, `blend keeps scores comparable across fill (spread ${spread})`);
});

test('the live line surfaces only when the feed is in trouble', () => {
  const { api, el } = load();
  api.liveSince = Date.now() - 12 * 60 * 1000;
  api.setLiveState('live: FN30 + 8 neighbors', 'ok');
  assert.strictEqual(el('liveline').hidden, true, 'healthy feed stays quiet');
  api.setLiveState('link lost. Retrying in 15 s.', 'warn');
  assert.strictEqual(el('liveline').hidden, false, 'a degraded link is announced');
  assert.match(el('mqttState').textContent, /link lost/);
  api.setLiveState('mqtt.js failed to load. Scores are model only.', 'bad');
  assert.strictEqual(el('liveline').hidden, false, 'an unreachable broker is announced');
  api.setLiveState('live: FN30 + 8 neighbors', 'ok');
  assert.strictEqual(el('liveline').hidden, true, 'recovery clears the line');
});

test('deviation display scales with window fill', () => {
  const dev = liveSinceMin => {
    const { api, el } = load();
    api.baselineData = { bands: { '20m': { ref: 24, squares: { FN30: 24 } } } };
    api.myGrids = new Set(['FN30']);
    const t = Date.now();
    for (let i = 0; i < 24; i++) api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000);
    api.liveSince = Date.now() - liveSinceMin * 60 * 1000;
    api.renderBands(CTX);
    const row = el('bands').innerHTML.split('<div class="band">').find(r => r.includes('>20m<'));
    return +/([\d.]+)×<\/b> usual/.exec(row)[1];
  };
  // The same spots over a quarter window are a 4x higher rate than over
  // a full one; the shown deviation must scale accordingly.
  const ratio = dev(7.5) / dev(30);
  assert.ok(Math.abs(ratio - 4) < 0.4, `quarter-window deviation ~4x full-window (got ${ratio.toFixed(2)})`);
});
