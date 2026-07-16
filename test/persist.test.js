'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

// The neighborhood key connectLive computes for FN30, straight from the api.
const keyFor = (api, grid) => api.neighborGrids(api.parseGrid(grid)).join(',');

test('spots and coverage survive a straight reload', async () => {
  const store = {};
  const a = load({ store });
  a.api.connectLive(a.api.parseGrid('FN30'));   // no mqtt lib in tests: sets the key, bails
  a.api.liveSince = Date.now() - 10 * 60 * 1000;
  a.api.addSpot('20m', 'IO91', 'FN30', 'FT8', Date.now() - 1000, 'G4X', 'K2A');
  a.api.saveSpots();
  assert.ok(store.hopSpots, 'window serialized');

  const b = load({ store });
  b.api.connectLive(b.api.parseGrid('FN30'));
  assert.strictEqual(b.api.spots.length, 1, 'spot restored');
  const s = b.api.spots[0];
  assert.strictEqual(s.band, '20m');
  assert.strictEqual(s.who, 'G4X>K2A');
  assert.strictEqual(s.src, 'm');
  assert.ok(Math.abs(b.api.windowFill() - 10 / 30) < 0.02,
    `ten minutes of coverage preserved (fill ${b.api.windowFill().toFixed(3)})`);
});

// The compact row a v2 save carries: age in whole seconds from savedAt,
// band ordinal (20m is BANDS[4]), km, mode, rx, pair, tp, src.
const row = (savedAt, t, who) =>
  [Math.round((savedAt - t) / 1000), 4, 5570, 'FT8', 1, who, 0, 0];

test('a closed-tab gap counts as uncovered time, clamped to the window', () => {
  const now = Date.now();
  const probe = load();
  const key = keyFor(probe.api, 'FN30');
  // Old session: 20 min of coverage that ended 15 min ago. Only 15 min of
  // it still overlaps the rolling window.
  const savedAt = now - 15 * 60000;
  const store = {
    hopSpots: JSON.stringify({
      v: 2, gridKey: key, savedAt, liveSince: now - 35 * 60000,
      spots: [
        row(savedAt, now - 18 * 60000, 'G4X>K2A'),
        row(savedAt, now - 33 * 60000, 'G4Y>K2A'),
      ],
    }),
  };
  const h = load({ store });
  h.api.connectLive(h.api.parseGrid('FN30'));
  assert.strictEqual(h.api.spots.length, 1, 'the 33-minute-old spot aged out');
  assert.ok(Math.abs(h.api.liveSince - (now - 15 * 60000)) < 2000,
    'coverage clamped to the 15 min still inside the window');
});

test('a stale, foreign, or old-format window is not restored', () => {
  const now = Date.now();
  const probe = load();
  const key = keyFor(probe.api, 'FN30');
  const payload = gapMin => {
    const savedAt = now - gapMin * 60000;
    return JSON.stringify({
      v: 2, gridKey: key, savedAt, liveSince: now - (gapMin + 10) * 60000,
      spots: [row(savedAt, now - (gapMin + 1) * 60000, 'G>K')],
    });
  };
  const stale = load({ store: { hopSpots: payload(31) } });
  stale.api.connectLive(stale.api.parseGrid('FN30'));
  assert.strictEqual(stale.api.spots.length, 0, 'a window-old save has nothing to offer');
  assert.strictEqual(stale.api.liveSince, 0);

  const moved = load({ store: { hopSpots: payload(5) } });
  moved.api.connectLive(moved.api.parseGrid('IO91'));
  assert.strictEqual(moved.api.spots.length, 0, 'a different grid discards the save');

  // A save from before the compact format carries keyed objects and no v.
  const old = load({ store: { hopSpots: JSON.stringify({
    gridKey: key, savedAt: now - 60000, liveSince: now - 5 * 60000,
    spots: [{ t: now - 2 * 60000, band: '20m', km: 5570, md: 'FT8', rx: true, who: 'G>K', tp: false, src: 'm' }],
  }) } });
  old.api.connectLive(old.api.parseGrid('FN30'));
  assert.strictEqual(old.api.spots.length, 0, 'an old-format save is discarded');
});

test('renderBands persists the window as it renders', () => {
  const store = {};
  const h = load({ store });
  h.api.connectLive(h.api.parseGrid('FN30'));
  h.api.addSpot('20m', 'IO91', 'FN30', 'FT8', Date.now() - 1000, 'G4X', 'K2A');
  h.api.renderBands({ muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, xrayFlux: 4e-7 });
  const saved = JSON.parse(store.hopSpots);
  assert.strictEqual(saved.v, 2);
  assert.strictEqual(saved.spots.length, 1);
  assert.ok(Array.isArray(saved.spots[0]), 'spots are stored as compact rows');
  assert.strictEqual(saved.gridKey, keyFor(h.api, 'FN30'));
});
