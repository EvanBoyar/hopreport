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
  assert.ok(Math.abs(b.api.windowFill() - 10 / 60) < 0.02,
    `ten minutes of coverage preserved (fill ${b.api.windowFill().toFixed(3)})`);
});

test('a closed-tab gap counts as uncovered time, clamped to the window', () => {
  const now = Date.now();
  const probe = load();
  const key = keyFor(probe.api, 'FN30');
  // Old session: 40 min of coverage that ended 30 min ago. Only 30 min of
  // it still overlaps the rolling hour.
  const store = {
    hopSpots: JSON.stringify({
      gridKey: key, savedAt: now - 30 * 60000, liveSince: now - 70 * 60000,
      spots: [
        { t: now - 35 * 60000, band: '20m', km: 5570, md: 'FT8', rx: true, who: 'G4X>K2A', tp: false, src: 'm' },
        { t: now - 65 * 60000, band: '20m', km: 5570, md: 'FT8', rx: true, who: 'G4Y>K2A', tp: false, src: 'm' },
      ],
    }),
  };
  const h = load({ store });
  h.api.connectLive(h.api.parseGrid('FN30'));
  assert.strictEqual(h.api.spots.length, 1, 'the 65-minute-old spot aged out');
  assert.ok(Math.abs(h.api.liveSince - (now - 30 * 60000)) < 2000,
    'coverage clamped to the 30 min still inside the window');
});

test('a stale or foreign window is not restored', () => {
  const now = Date.now();
  const probe = load();
  const key = keyFor(probe.api, 'FN30');
  const payload = gapMin => JSON.stringify({
    gridKey: key, savedAt: now - gapMin * 60000, liveSince: now - (gapMin + 10) * 60000,
    spots: [{ t: now - (gapMin + 1) * 60000, band: '20m', km: 5570, md: 'FT8', rx: true, who: 'G>K', tp: false, src: 'm' }],
  });
  const stale = load({ store: { hopSpots: payload(61) } });
  stale.api.connectLive(stale.api.parseGrid('FN30'));
  assert.strictEqual(stale.api.spots.length, 0, 'an hour-old save has nothing to offer');
  assert.strictEqual(stale.api.liveSince, 0);

  const moved = load({ store: { hopSpots: payload(5) } });
  moved.api.connectLive(moved.api.parseGrid('IO91'));
  assert.strictEqual(moved.api.spots.length, 0, 'a different grid discards the save');
});

test('renderBands persists the window as it renders', () => {
  const store = {};
  const h = load({ store });
  h.api.connectLive(h.api.parseGrid('FN30'));
  h.api.addSpot('20m', 'IO91', 'FN30', 'FT8', Date.now() - 1000, 'G4X', 'K2A');
  h.api.renderBands({ muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, flareMult: 1 });
  const saved = JSON.parse(store.hopSpots);
  assert.strictEqual(saved.spots.length, 1);
  assert.strictEqual(saved.gridKey, keyFor(h.api, 'FN30'));
});
