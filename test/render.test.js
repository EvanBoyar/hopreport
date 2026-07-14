'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const CTX = { muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, flareMult: 1 };

function seeded() {
  const h = load();
  h.api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 5; i++) h.api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000);
  for (let i = 0; i < 2; i++) h.api.addSpot('20m', 'FN30', 'JN48', 'CW', t - i * 60000 - 2000);
  return h;
}

const row = (el, nm) => el('bands').innerHTML.split('<div class="band">')
  .find(r => r.includes(`>${nm}<`));

test('renderBands blends live and model, shows direction split', () => {
  const { api, el } = seeded();
  api.renderBands(CTX);
  const r = row(el, '20m');
  assert.match(r, /blended live/);
  assert.match(r, /↓5 ↑2/);
  assert.match(r, /7<\/b> spots/);
  assert.match(r, /\(2 CW\)/);
});

test('model off: live-only scores and honest empty states', () => {
  const { api, el, els } = seeded();
  els.incModel.checked = false;
  api.renderBands(CTX);
  assert.match(row(el, '20m'), /live only/);
  assert.match(row(el, '40m'), /quiet/);
  assert.match(row(el, '40m'), /0 of 3 spots/);
});

test('model off with under 3 spots stamps sparse, not a verdict', () => {
  const { api, el, els } = seeded();
  els.incModel.checked = false;
  els.incDigi.checked = false;           // leaves only the 2 CW spots
  api.renderBands(CTX);
  const r = row(el, '20m');
  assert.match(r, /sparse/);
  assert.match(r, /2 of 3 spots/);
});

test('CW annotation disappears when CW spots are excluded', () => {
  const { api, el, els } = seeded();
  els.incCw.checked = false;
  api.renderBands(CTX);
  const r = row(el, '20m');
  assert.doesNotMatch(r, /CW\)/);
  assert.match(r, /5<\/b> spots/);
});

test('all sources off renders every band without a score', () => {
  const { api, el, els } = seeded();
  els.incDigi.checked = els.incCw.checked = els.incModel.checked = false;
  api.renderBands(CTX);
  assert.doesNotMatch(el('bands').innerHTML, /\d+ \/ 100/);
});
