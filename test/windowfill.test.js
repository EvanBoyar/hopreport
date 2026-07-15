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
  const quarter = api.liveStats('20m', true, true, 0.25);     // 15 min of data
  const partial = api.liveScore(b20, quarter);
  const full = api.liveScore(b20, api.liveStats('20m', true, true, 1));
  assert.ok(partial > full, `same count over less time scores higher (${Math.round(partial)} > ${Math.round(full)})`);
  // 10 spots in a quarter window carry the same rate as 40 in a full one
  const st40 = { n: 40, max: quarter.max, max2: quarter.max2, cw: 0,
                 dRx: 24, dTx: 16, cRx: 0, cTx: 0 };
  assert.ok(Math.abs(partial - api.liveScore(b20, st40)) < 0.01);
});

test('extrapolation is capped at 5 minutes of data', () => {
  const { api } = load();
  const b20 = api.BANDS.find(b => b.nm === '20m');
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 3; i++) api.addSpot('20m', 'IO91', 'FN30', 'CW', t - i * 15000 - 1000, 'G' + i, 'K2A');
  assert.strictEqual(api.liveScore(b20, api.liveStats('20m', true, true, 0.001)),
                     api.liveScore(b20, api.liveStats('20m', true, true, 1 / 12)));
});

test('a constant spot rate scores flat as the window fills', () => {
  // Simulate a page open for 12 vs 48 minutes under a steady 1 spot/min:
  // the score should not climb with coverage.
  const scoreAfter = mins => {
    const { api } = load();
    api.myGrids = new Set(['FN30']);
    const t = Date.now();
    for (let i = 0; i < mins; i++)
      api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000, 'G' + i, 'K2A');
    const b20 = api.BANDS.find(b => b.nm === '20m');
    return api.liveScore(b20, api.liveStats('20m', true, true, mins / 60));
  };
  assert.ok(Math.abs(scoreAfter(12) - scoreAfter(48)) < 0.01,
    `12 min ${scoreAfter(12).toFixed(2)} vs 48 min ${scoreAfter(48).toFixed(2)}`);
});

test('retrieval spots already cover the hour and are not extrapolated', () => {
  const { api } = load();
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - 1000, 'G4X', 'K2A');              // heard live
  api.addSpot('20m', 'FN30', 'JN48', 'FT8', t - 30 * 60000, 'K2A', 'DL1X', 'r');  // via retrieval
  const st = api.liveStats('20m', true, true, 0.25);
  assert.strictEqual(st.wdRx, 4);   // the live spot is scaled to the quarter window
  assert.strictEqual(st.wdTx, 1);   // the retrieval spot counts once
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
  mature.api.liveSince = Date.now() - 60 * 60 * 1000;  // full window
  mature.api.renderBands(CTX);

  // Same spots: the young page extrapolates a higher live score but trusts
  // it less; both must land between the pure model and pure live extremes,
  // and neither may crash. The real assertion is stability across fill.
  assert.ok(Number.isFinite(pct(young)) && Number.isFinite(pct(mature)));
  const spread = Math.abs(pct(young) - pct(mature));
  assert.ok(spread < 25, `blend keeps scores comparable across fill (spread ${spread})`);
});

test('the live line counts the window up while it fills, then retires', () => {
  const { api, el } = load();
  api.liveSince = Date.now() - 12 * 60 * 1000;
  api.setLiveState('live: FN30 + 8 neighbors', 'ok');
  assert.strictEqual(el('liveline').hidden, false, 'shown while filling');
  assert.match(el('mqttState').textContent, /window 12 of 60 min/);
  assert.match(el('mqttState').textContent, /Leaving the page open/);
  api.liveSince = Date.now() - api.LIVE_WINDOW;
  api.renderBands(CTX);   // the 30 s repaint path
  assert.strictEqual(el('liveline').hidden, true, 'hidden once full');
  assert.strictEqual(el('mqttState').textContent, 'live: FN30 + 8 neighbors');
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
  // The same 6 spots over a quarter window are a 4x higher rate than over
  // a full one; the shown deviation must scale accordingly.
  const ratio = dev(15) / dev(60);
  assert.ok(Math.abs(ratio - 4) < 0.4, `quarter-window deviation ~4x full-window (got ${ratio.toFixed(2)})`);
});
