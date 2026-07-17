'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const CTX = { muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, xrayFlux: 4e-7 };

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

test('6m surfaces tropo spots in the facts without scoring them', () => {
  const { api, el } = load();
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 3; i++)
    api.addSpot('6m', 'FN30', 'FN33', 'FT8', t - i * 60000 - 1000, 'K' + i, 'W2X');
  api.renderBands(CTX);
  const r = row(el, '6m');
  assert.match(r, /tropo <b>3<\/b> spots/);
  assert.match(r, /Es dependent/, 'tropo alone earns no sky verdict');
});

test('all sources off renders every band without a score', () => {
  const { api, el, els } = seeded();
  els.incDigi.checked = els.incCw.checked = els.incModel.checked = false;
  api.renderBands(CTX);
  assert.doesNotMatch(el('bands').innerHTML, /\d+ \/ 100/);
});

test('refresh: no blanking; a grid change repaints in place from the model', async () => {
  const { api, el, els } = load();
  els.grid.value = 'FN30';
  // First load: fetches all fail in the sandbox, fallbacks fill in.
  await api.refresh();
  const firstStatus = els.status.innerHTML;
  assert.match(firstStatus, /SFI/);
  assert.match(firstStatus, /73\.0°W/);
  assert.ok(els.bands.innerHTML.includes('20m'), 'bands rendered on first load');

  // Same-grid refresh keeps the old row on screen while fetching: the
  // status row must never pass through the placeholder or go blank.
  els.status.innerHTML = firstStatus;
  const p = api.refresh();
  assert.strictEqual(els.status.innerHTML, firstStatus, 'no wipe during same-grid refresh');
  await p;

  // Seed live spots for the first grid, then move: tiles and bands must
  // repaint immediately (before any fetch answers) with the new
  // position, the old neighborhood's spots gone, and model verdicts up.
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  for (let i = 0; i < 5; i++) api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - i * 60000 - 1000);
  api.renderBands({ muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -73, xrayFlux: 4e-7 });
  assert.match(els.bands.innerHTML, /↓5/, 'seeded spots visible before the move');
  els.grid.value = 'JN48';
  const p2 = api.refresh();
  assert.match(els.status.innerHTML, /9\.0°E/, 'new position painted synchronously');
  assert.match(els.status.innerHTML, /estimated from SFI/, 'sonde claim dropped until refetch');
  assert.ok(!els.bands.innerHTML.includes('↓'), 'old neighborhood spots cleared');
  assert.match(els.bands.innerHTML, /MUF ratio/, 'bands stand on the model meanwhile');
  await p2;
});
