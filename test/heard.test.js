'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const CTX = { muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, flareMult: 1 };

test('own receptions are recorded even where scoring drops them', () => {
  const { api } = load();
  api.setCall('k2abc');
  assert.strictEqual(api.mqttCall, 'K2ABC', 'callsign normalized');
  const t = Date.now() - 60000;
  api.addSpot('40m', 'FN30', 'FN31', 'CW', t, 'K2ABC', 'W3SKM');   // ground wave on 40m
  api.addSpot('40m', 'FN30', 'JN48', 'FT8', t - 1000, 'K2ABC', 'DL1X'); // a real hop
  api.addSpot('40m', 'FN30', 'IO91', 'FT8', t - 2000, 'K2XYZ', 'G4X');  // someone else
  assert.strictEqual(api.spots.length, 2, 'ground wave still kept out of the window');
  assert.strictEqual(api.ownHeard.length, 2, 'both own receptions on the heard list');
  assert.deepStrictEqual(Array.from(api.ownHeard, o => o.rx), ['W3SKM', 'DL1X']);
});

test('overlapping grid and callsign subscriptions do not double-count', () => {
  const { api } = load();
  api.setCall('K2ABC');
  const t = Date.now() - 60000;
  api.addSpot('20m', 'FN30', 'JN48', 'FT8', t, 'K2ABC', 'DL1X');
  api.addSpot('20m', 'FN30', 'JN48', 'FT8', t, 'K2ABC', 'DL1X');   // second delivery
  assert.strictEqual(api.ownHeard.length, 1);
});

test('the heard line renders and stays quiet without a callsign', () => {
  const { api, el } = load();
  api.myGrids = new Set(['FN30']);
  api.setCall('K2ABC');
  api.addSpot('40m', 'FN30', 'JN48', 'FT8', Date.now() - 3 * 60000, 'K2ABC', 'DL1X');
  api.renderBands(CTX);
  assert.strictEqual(el('heardNote').textContent, '', 'no callsign in the field, no line');
  el('mycall').value = 'K2ABC';
  api.renderBands(CTX);
  assert.match(el('heardNote').textContent, /heard once in the last 30 min/);
  assert.match(el('heardNote').textContent, /last by DL1X on 40m/);
  assert.match(el('heardNote').textContent, /3 min ago/);
  api.ownHeard = [];
  api.renderBands(CTX);
  assert.strictEqual(el('heardNote').textContent, 'not heard in the last 30 min');
});

test('a fresh reception redraws the heard line without waiting for a tick', () => {
  const { api, el } = load();
  el('mycall').value = 'K2ABC';
  api.setCall('K2ABC');
  api.addSpot('20m', 'FN30', 'JN48', 'FT8', Date.now() - 1000, 'K2ABC', 'DL1X');
  assert.match(el('heardNote').textContent, /heard once .* just now/);
});

test('a successful query answers through the heard line, not a count', () => {
  const { api, el, sandbox } = load();
  el('mycall').value = 'K2ABC';
  api.queryMySpots();
  assert.strictEqual(el('qslNote').textContent, 'querying');
  sandbox.pskrCb({ receptionReport: [{
    frequency: 14074000, senderLocator: 'FN30', receiverLocator: 'JN48',
    mode: 'FT8', flowStartSeconds: (Date.now() - 60000) / 1000,
    senderCallsign: 'K2ABC', receiverCallsign: 'DL1X',
  }] });
  assert.strictEqual(el('qslNote').textContent, '', 'the count note is gone');
  assert.strictEqual(api.ownHeard.length, 1, 'the report landed on the heard list');
  assert.strictEqual(api.ownHeard[0].rx, 'DL1X');
});

test('the heard list survives a reload and ages out with the window', () => {
  const store = {};
  const a = load({ store });
  a.api.connectLive(a.api.parseGrid('FN30'));
  a.api.setCall('K2ABC');
  a.api.addSpot('20m', 'FN30', 'JN48', 'FT8', Date.now() - 5 * 60000, 'K2ABC', 'DL1X');
  a.api.saveSpots();

  const b = load({ store });
  b.api.connectLive(b.api.parseGrid('FN30'));
  assert.strictEqual(b.api.ownHeard.length, 1, 'own reception restored');
  assert.strictEqual(b.api.ownHeard[0].rx, 'DL1X');

  b.api.ownHeard[0].t = Date.now() - b.api.LIVE_WINDOW - 1000;
  b.api.pruneSpots();
  assert.strictEqual(b.api.ownHeard.length, 0, 'aged out with the window');
});
