'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

test('addSpot ages by heard-time and enforces the 30 minute window', () => {
  const { api } = load();
  const now = Date.now();
  api.addSpot('20m', 'FN30', 'IO91', 'CW', now - 25 * 60 * 1000);
  assert.strictEqual(api.spots.length, 1, '25-min-old spot kept');
  assert.strictEqual(api.spots[0].t, now - 25 * 60 * 1000);
  api.addSpot('20m', 'FN30', 'IO91', 'CW', now - 35 * 60 * 1000);
  assert.strictEqual(api.spots.length, 1, '35-min-old spot rejected');
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
  assert.deepStrictEqual(Array.from(api.spots, s => s.rx), [true, false]);
});

test('ground wave never enters the window, with a per-band radius', () => {
  const { api } = load();
  api.myGrids = new Set(['FN30']);
  const t = Date.now() - 1000;
  api.addSpot('10m', 'FN30', 'FN30', 'FT8', t);        // same square, 0 km
  api.addSpot('10m', 'FN30', 'FN31', 'FT8', t);        // ~111 km, inside every radius
  api.addSpot('10m', 'FN30as', 'FN30ax', 'FT8', t);    // 6-char grids collapse to 4
  api.addSpot('40m', 'FN30', 'FN32', 'FT8', t);        // ~222 km, ground wave on 40m
  api.addSpot('160m', 'FN30', 'FN33', 'CW', t);        // ~334 km, ground wave on 160m
  assert.strictEqual(api.spots.length, 0);
  api.addSpot('10m', 'FN30', 'FN32', 'FT8', t);        // ~222 km, a hop on 10m
  api.addSpot('40m', 'FN30', 'FN33', 'FT8', t);        // ~334 km, a hop on 40m
  api.addSpot('160m', 'FN30', 'FN34', 'CW', t);        // ~445 km, a hop on 160m
  assert.strictEqual(api.spots.length, 3);
  assert.ok(api.spots.every(s => s.km >= api.MIN_SKY_KM[s.band]));
});

test('6m splits its near field: line of sight dropped, tropo kept apart', () => {
  const { api } = load();
  api.myGrids = new Set(['FN30']);
  const t = Date.now() - 1000;
  api.addSpot('6m', 'FN30', 'FN30', 'FT8', t);    // same square, line of sight
  api.addSpot('6m', 'FN30', 'FN31', 'FT8', t);    // ~111 km, line of sight
  api.addSpot('6m', 'FN30', 'FN33', 'FT8', t);    // ~334 km, tropo
  api.addSpot('6m', 'FN32', 'FN30', 'FT8', t);    // ~223 km, tropo, heard here
  api.addSpot('6m', 'FN30', 'FN55', 'FT8', t);    // ~640 km, sky (Es)
  assert.strictEqual(api.spots.length, 3);
  const st = api.liveStats('6m', true, true, 1);
  assert.strictEqual(st.n, 1, 'only the Es spot counts as sky');
  assert.ok(st.max > 500, 'sky reach comes from the Es spot');
  assert.strictEqual(st.tN, 2, 'the tropo spots ride their own tally');
  assert.ok(st.tMax > 250 && st.tMax < 500);
  assert.ok(st.tMax2 > 150 && st.tMax2 < st.tMax, 'second-longest guard tracked');
  assert.ok(st.wtRx > 0 && st.wtTx > 0, 'tropo rates split by direction');
});

test('callsigns keep same-second spots from different stations apart', () => {
  const { api } = load();
  const t = Date.now() - 60000;
  api.addSpot('20m', 'FN30', 'IO91', 'FT8', t, 'K2A', 'G4X');
  api.addSpot('20m', 'FN30', 'IO91', 'FT8', t, 'K2B', 'G4X');   // different tx, same squares
  api.addSpot('20m', 'FN30', 'IO91', 'FT8', t, 'K2A', 'G4X');   // a true duplicate
  assert.strictEqual(api.spots.length, 2);
});

test('retrieval flows dedup fuzzily against spots heard live', () => {
  const { api } = load();
  const t = Date.now() - 20 * 60 * 1000;
  api.addSpot('20m', 'FN30', 'IO91', 'FT8', t, 'K2A', 'G4X');
  api.addSpot('20m', 'FN30', 'IO91', 'FT8', t + 4 * 60000, 'K2A', 'G4X', 'r'); // same flow, offset clock
  api.addSpot('20m', 'FN30', 'IO91', 'FT8', t + 4 * 60000, 'K2A', 'G4Y', 'r'); // different receiver
  assert.strictEqual(api.spots.length, 2);
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
