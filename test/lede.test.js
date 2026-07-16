'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const { api } = load();

test('bandRangeList collapses three or more contiguous bands', () => {
  assert.strictEqual(
    api.bandRangeList(['40m', '30m', '20m', '17m', '15m', '12m']), '12m-40m');
  assert.strictEqual(api.bandRangeList(['20m', '17m']), '20m and 17m');
  assert.strictEqual(api.bandRangeList(['10m']), '10m');
  assert.strictEqual(
    api.bandRangeList(['160m', '40m', '30m', '20m']), '160m and 20m-40m');
  assert.strictEqual(
    api.bandRangeList(['20m', '40m', '30m']), '20m-40m', 'input order ignored');
  assert.strictEqual(api.bandRangeList([]), '');
});

test('ledeHTML names the open bands and the reach', () => {
  const rows = [
    { nm: '40m', score: 80, maxKm: 1850 },
    { nm: '30m', score: 78, maxKm: 0 },
    { nm: '20m', score: 88, maxKm: 6213 },
    { nm: '10m', score: 5, maxKm: 0 },
  ];
  const s = api.ledeHTML(rows, { sunEl: 30 });
  assert.match(s, /<b>20m-40m<\/b> are open/);
  assert.match(s, /spots heard to <b>6,213 km<\/b>/);
});

test('ledeHTML points at sunset when the low bands are down by day', () => {
  const rows = [
    { nm: '160m', score: 4 }, { nm: '80m', score: 11 }, { nm: '40m', score: 22 },
    { nm: '20m', score: 88, maxKm: 6213 },
  ];
  const sunSet = new Date(Date.UTC(2026, 6, 15, 19, 7));
  const s = api.ledeHTML(rows, { sunEl: 30, sunSet });
  assert.match(s, /low bands return near sunset \(1907 UTC\)/);
  const night = api.ledeHTML(
    [{ nm: '17m', score: 8 }, { nm: '15m', score: 5 }, { nm: '40m', score: 80, maxKm: 900 }],
    { sunEl: -20, sunRise: new Date(Date.UTC(2026, 6, 16, 9, 42)) });
  assert.match(night, /high bands return after sunrise \(0942 UTC\)/);
});

test('ledeHTML degrades honestly without verdicts or openings', () => {
  assert.strictEqual(api.ledeHTML([{ nm: '20m', score: null }], { sunEl: 0 }), '');
  const modest = api.ledeHTML([{ nm: '40m', score: 60 }], { sunEl: 0 });
  assert.match(modest, /Nothing is wide open; <b>40m<\/b> is worth a call/);
  const dead = api.ledeHTML([{ nm: '40m', score: 10 }, { nm: '20m', score: 12 }], { sunEl: 50 });
  assert.match(dead, /Every band scores low/);
});

test('renderBands fills and reveals the lede', () => {
  const h = load();
  h.api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 12; i++)
    h.api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000, 'G' + i, 'K2A');
  h.api.renderBands({ muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, xrayFlux: 4e-7 });
  assert.strictEqual(h.els.lede.hidden, false);
  assert.match(h.els.lede.innerHTML, /open/);
});

test('nextSunCrossings finds London midsummer within a few minutes', () => {
  const { rise, set } = api.nextSunCrossings(51.5, 0, new Date(Date.UTC(2025, 5, 21, 0, 0)));
  assert.ok(rise && set, 'both crossings found');
  const riseMin = rise.getUTCHours() * 60 + rise.getUTCMinutes();
  const setMin = set.getUTCHours() * 60 + set.getUTCMinutes();
  assert.ok(Math.abs(riseMin - (3 * 60 + 43)) < 20, `sunrise ~0343 UTC, got ${rise.toISOString()}`);
  assert.ok(Math.abs(setMin - (20 * 60 + 21)) < 20, `sunset ~2021 UTC, got ${set.toISOString()}`);
});

test('nextSunCrossings returns nulls in polar day', () => {
  const { rise, set } = api.nextSunCrossings(78, 15, new Date(Date.UTC(2025, 5, 21, 12, 0)));
  assert.strictEqual(rise, null);
  assert.strictEqual(set, null);
});
