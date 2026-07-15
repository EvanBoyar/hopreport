'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');
const agg = require('../tools/aggregate-baseline');

const GRIDS = ['FN30', 'FN20', 'FN31', 'FN21', 'FN40', 'FM39', 'FM29', 'FN41', 'FM49'];
const DATA = { bands: { '20m': { ref: 30, squares: { FN30: 20, FN31: 10 } } } };

test('baselineExpected sums the neighborhood and scales the reference', () => {
  const { api } = load();
  const b = api.baselineExpected(DATA, GRIDS, '20m');
  assert.strictEqual(b.expected, 30);
  assert.strictEqual(b.ref, 40);                       // 30/30 -> exactly typical
  const sparse = api.baselineExpected(
    { bands: { '20m': { ref: 30, squares: { FN30: 3 } } } }, GRIDS, '20m');
  assert.strictEqual(sparse.expected, 3);
  assert.strictEqual(sparse.ref, 8);                   // clamped at 0.2x
  const dense = api.baselineExpected(
    { bands: { '20m': { ref: 30, squares: { FN30: 900 } } } }, GRIDS, '20m');
  assert.strictEqual(dense.ref, 240);                  // clamped at 6x
});

test('baselineExpected declines unknown areas and bands', () => {
  const { api } = load();
  assert.strictEqual(api.baselineExpected(DATA, ['IO91', 'IO92'], '20m'), null);
  assert.strictEqual(api.baselineExpected(DATA, GRIDS, '40m'), null);
  assert.strictEqual(api.baselineExpected(null, GRIDS, '20m'), null);
});

test('a populous baseline demands more; a sparse one demands less', () => {
  const { api } = load();
  const b20 = api.BANDS.find(b => b.nm === '20m');
  const st = { n: 30, max: 5000, cw: 0, dRx: 20, dTx: 10, cRx: 0, cTx: 0 };
  const city = api.liveScore(b20, st, null, 160);
  const plain = api.liveScore(b20, st, null, null);
  const rural = api.liveScore(b20, st, null, 12);
  assert.ok(city < plain && plain < rural,
    `city ${Math.round(city)} < plain ${Math.round(plain)} < rural ${Math.round(rural)}`);
});

test('renderBands shows deviation from local normal when the baseline knows the area', () => {
  const { api, el } = load();
  api.baselineData = { bands: { '20m': { ref: 10, squares: { FN30: 10 } } } };
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 16; i++) api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000);
  api.renderBands({ muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -73.5, flareMult: 1 });
  const row = el('bands').innerHTML.split('<div class="band">').find(r => r.includes('>20m<'));
  assert.match(row, /×<\/b> usual/);
  const bare = el('bands');
  api.baselineData = null;
  api.renderBands({ muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -73.5, flareMult: 1 });
  assert.doesNotMatch(bare.innerHTML, /usual/);
});

test('aggregator folds quiet samples, skips gated and thin ones', () => {
  const sample = (t, secs, g) => ({
    t, secs, bands: { '20m': { global: g, squares: { FN30: [10, 20], IO91: [4, 4] } } },
  });
  let state = agg.fold({}, sample('2026-07-14T20:00:00Z', 600, 5000));
  assert.strictEqual(state.reservoirs['20m'].FN30.length, 1);
  state = agg.fold(state, { t: '2026-07-14T23:00:00Z', skipped: 'disturbed' });
  assert.strictEqual(state.reservoirs['20m'].FN30.length, 1, 'skipped sample not folded');
  state = agg.fold(state, sample('2026-07-15T02:00:00Z', 600, 50));
  assert.strictEqual(state.reservoirs['20m'].FN30.length, 1, 'thin global count not folded');
  assert.strictEqual(state.nSamples, 3);
});

test('aggregator publishes medians only after enough samples', () => {
  let state = {};
  for (let i = 0; i < agg.MIN_SAMPLES; i++)
    state = agg.fold(state, {
      t: `2026-07-${10 + i}T20:00:00Z`, secs: 600,
      bands: { '20m': { global: 5000, squares: { FN30: [10, 20 + i], IO91: [1, 1] } } },
    });
  const out = agg.publish(state);
  assert.ok(out.bands['20m'].squares.FN30 > 0, 'FN30 published');
  assert.ok(out.bands['20m'].ref > 0, 'reference computed');
  // one sample short: nothing published
  const short = agg.publish(agg.fold({}, {
    t: '2026-07-14T20:00:00Z', secs: 600,
    bands: { '20m': { global: 5000, squares: { FN30: [10, 20] } } },
  }));
  assert.strictEqual(short.bands['20m'], undefined);
});

test('a units version bump flushes stale reservoirs', () => {
  let state = { v: 1, reservoirs: { '20m': { FN30: [9, 9, 9] } } };
  state = agg.fold(state, {
    t: '2026-07-14T20:00:00Z', secs: 600,
    bands: { '20m': { global: 5000, squares: { FN30: [10, 20] } } },
  });
  assert.strictEqual(state.v, agg.STATE_V);
  assert.strictEqual(state.reservoirs['20m'].FN30.length, 1, 'old units dropped');
});

test('aggregator reservoir is bounded and median resists outliers', () => {
  assert.strictEqual(agg.median([1, 2, 100]), 2);
  assert.strictEqual(agg.median([1, 2, 3, 4]), 2.5);
  let state = {};
  for (let i = 0; i < agg.RESERVOIR + 10; i++)
    state = agg.fold(state, {
      t: '2026-07-14T20:00:00Z', secs: 600,
      bands: { '20m': { global: 5000, squares: { FN30: [10, 20] } } },
    });
  assert.strictEqual(state.reservoirs['20m'].FN30.length, agg.RESERVOIR);
});
