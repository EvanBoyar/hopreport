'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { trim, MAX_AGE_MIN } = require('../tools/fetch-ionosondes.js');

const NOW = Date.parse('2026-07-16T19:00:00Z');
const iso = minAgo => new Date(NOW - minAgo * 60000).toISOString().replace(/\.\d+Z$/, '');
const row = (over = {}) => ({
  time: iso(10), mufd: 16.6, fof2: 4.9, md: 3.4, foE: 2.1,
  station: { name: 'X', latitude: 43.8, longitude: -112.7, code: 'IDA' },
  ...over,
});

test('trim keeps fresh complete rows and only the fields the page reads', () => {
  const out = trim([row()], NOW);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], {
    time: iso(10), mufd: 16.6, fof2: 4.9,
    station: { name: 'X', latitude: 43.8, longitude: -112.7 },
  });
});

test('trim drops rows the page could never use', () => {
  assert.strictEqual(trim([row({ mufd: null })], NOW).length, 0, 'no MUF');
  assert.strictEqual(trim([row({ fof2: null })], NOW).length, 0, 'no foF2');
  assert.strictEqual(trim([row({ time: null })], NOW).length, 0, 'no timestamp');
  assert.strictEqual(trim([row({ station: null })], NOW).length, 0, 'no station');
  const noPos = row(); noPos.station = { name: 'X', latitude: null, longitude: null };
  assert.strictEqual(trim([noPos], NOW).length, 0, 'no position');
});

test('trim reads zoneless stamps as UTC and drops the stale', () => {
  assert.strictEqual(trim([row({ time: iso(MAX_AGE_MIN - 5) })], NOW).length, 1, 'inside window');
  assert.strictEqual(trim([row({ time: iso(MAX_AGE_MIN + 5) })], NOW).length, 0, 'aged out');
  assert.strictEqual(trim([row({ time: iso(10) + 'Z' })], NOW).length, 1, 'explicit Z passes');
});

test('trim survives junk feeds', () => {
  assert.deepStrictEqual(trim(null, NOW), []);
  assert.deepStrictEqual(trim({ not: 'an array' }, NOW), []);
  assert.deepStrictEqual(trim([null, 42, 'x'], NOW), []);
});
