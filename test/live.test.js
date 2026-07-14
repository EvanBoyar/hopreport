'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

test('addSpot ages by heard-time and enforces the hour window', () => {
  const { api } = load();
  const now = Date.now();
  api.addSpot('20m', 'FN30', 'IO91', 'CW', now - 50 * 60 * 1000);
  assert.strictEqual(api.spots.length, 1, '50-min-old spot kept');
  assert.strictEqual(api.spots[0].t, now - 50 * 60 * 1000);
  api.addSpot('20m', 'FN30', 'IO91', 'CW', now - 70 * 60 * 1000);
  assert.strictEqual(api.spots.length, 1, '70-min-old spot rejected');
  api.addSpot('20m', 'FN30', 'JN48', 'FT8', now + 120000);
  assert.ok(api.spots[1].t <= Date.now(), 'future timestamp clamped');
  api.addSpot('20m', 'FN30', 'JN58', 'FT8');
  assert.ok(api.spots[2].t <= Date.now(), 'missing timestamp falls back to now');
});

test('addSpot rejects exact duplicates from retrieval re-polls', () => {
  const { api } = load();
  const t = Date.now() - 10 * 60 * 1000;
  api.addSpot('20m', 'FN30', 'IO91', 'CW', t);
  api.addSpot('20m', 'FN30', 'IO91', 'CW', t);
  assert.strictEqual(api.spots.length, 1);
});

test('addSpot drops bad grids and unknown bands', () => {
  const { api } = load();
  api.addSpot('20m', 'ZZZZ', 'IO91', 'FT8');
  api.addSpot('99m', 'FN30', 'IO91', 'FT8');
  assert.strictEqual(api.spots.length, 0);
});

test('direction tagging: rx when our neighborhood heard it', () => {
  const { api } = load();
  api.myGrids = new Set(['FN30', 'FN31', 'FN20']);
  api.addSpot('20m', 'IO91', 'FN30', 'FT8', Date.now() - 1000);      // heard here
  api.addSpot('20m', 'FN31', 'JN48', 'FT8', Date.now() - 2000);      // heard elsewhere
  api.addSpot('20m', 'FN20', 'FN30', 'CW', Date.now() - 3000);       // both local -> rx
  assert.deepStrictEqual(Array.from(api.spots, s => s.rx), [true, false, true]);
});

test('liveStats buckets by mode and direction, honoring the toggles', () => {
  const { api } = load();
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - 1000);
  api.addSpot('20m', 'FN30', 'IO91', 'FT8', t - 2000);
  api.addSpot('20m', 'IO91', 'FN30', 'CW', t - 3000);
  api.addSpot('20m', 'FN30', 'JN48', 'CW', t - 4000);
  const all = api.liveStats('20m', true, true);
  assert.deepStrictEqual(
    { n: all.n, cw: all.cw, dRx: all.dRx, dTx: all.dTx, cRx: all.cRx, cTx: all.cTx },
    { n: 4, cw: 2, dRx: 1, dTx: 1, cRx: 1, cTx: 1 });
  const cwOnly = api.liveStats('20m', false, true);
  assert.strictEqual(cwOnly.n, 2);
  assert.strictEqual(cwOnly.dRx + cwOnly.dTx, 0);
  const digiOnly = api.liveStats('20m', true, false);
  assert.strictEqual(digiOnly.n, 2);
  assert.strictEqual(digiOnly.cw, 0);
});

test('pruneSpots drops spots older than the window', () => {
  const { api } = load();
  api.spots = [
    { t: Date.now() - api.LIVE_WINDOW - 1000, band: '20m', km: 1000, md: 'FT8', rx: true },
    { t: Date.now() - 1000, band: '20m', km: 1000, md: 'FT8', rx: true },
  ];
  api.pruneSpots();
  assert.strictEqual(api.spots.length, 1);
});
