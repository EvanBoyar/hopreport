'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const { api } = load();

test('parseGrid accepts 2, 4 and 6 char locators', () => {
  assert.ok(api.parseGrid('FN'));
  assert.ok(api.parseGrid('FN30'));
  assert.ok(api.parseGrid('fn30as'));
  assert.strictEqual(api.parseGrid('ZZ99'), null);
  assert.strictEqual(api.parseGrid('FN3'), null);
  assert.strictEqual(api.parseGrid(''), null);
});

test('parseGrid returns square centers', () => {
  const p = api.parseGrid('FN30as');
  assert.ok(Math.abs(p.lat - 40.77) < 0.03, `lat ${p.lat}`);
  assert.ok(Math.abs(p.lon - (-73.96)) < 0.05, `lon ${p.lon}`);
});

test('latLonToGrid round-trips known locators', () => {
  assert.strictEqual(api.latLonToGrid(40.76, -73.98, 6), 'FN30as');   // Manhattan
  assert.strictEqual(api.latLonToGrid(51.5, -0.12, 6), 'IO91wm');     // London
  assert.strictEqual(api.latLonToGrid(-33.86, 151.2, 6), 'QF56od');   // Sydney
  assert.strictEqual(api.latLonToGrid(40.76, -73.98), 'FN30');
});

test('latLonToGrid clamps poles and wraps the date line', () => {
  assert.strictEqual(api.latLonToGrid(89.99, 179.99), 'RR99');
  assert.strictEqual(api.latLonToGrid(-89.99, -179.99), 'AA00');
  assert.strictEqual(api.latLonToGrid(40, 186), api.latLonToGrid(40, -174));
});

test('neighborGrids returns own square first plus 8 neighbors', () => {
  const g = api.neighborGrids(api.parseGrid('FN30'));
  assert.strictEqual(g.length, 9);
  assert.strictEqual(g[0], 'FN30');
  assert.ok(g.includes('FN20') && g.includes('FM39') && g.includes('FN41'));
});

test('bandFromHz maps edges correctly', () => {
  assert.strictEqual(api.bandFromHz(14074000), '20m');
  assert.strictEqual(api.bandFromHz(7074000), '40m');
  assert.strictEqual(api.bandFromHz(5357000), null);   // 60m not tracked
});
