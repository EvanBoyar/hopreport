'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const settle = () => new Promise(r => setTimeout(r, 25));

test('a geolocation fix fills the grid and renders the report', async () => {
  const { els, sandbox } = load();
  assert.ok(sandbox.__geo, 'a bare URL asks the browser for a location');
  assert.match(els.msg.textContent, /No location yet/);
  sandbox.__geo.ok({ coords: { latitude: 40.76, longitude: -73.98 } });
  assert.strictEqual(els.grid.value, 'FN30as');
  await settle();
  assert.match(els.clockline.innerHTML, /^issued \d{1,2} [A-Z][a-z]{2} \d{4} \d{4} UTC/);
  assert.ok(els.bands.innerHTML.includes('20m'), 'band log rendered');
});

test('a failed fix explains itself instead of the bare prompt', () => {
  const { els, sandbox } = load();
  sandbox.__geo.err({ code: 2 });
  assert.match(els.msg.textContent, /could not produce a position fix/);
  const denied = load();
  denied.sandbox.__geo.err({ code: 1 });
  assert.match(denied.els.msg.textContent, /request was denied/);
});

test('the last working grid is remembered and reused on the next visit', async () => {
  const store = {};
  const first = load({ store });
  first.sandbox.__geo.ok({ coords: { latitude: 40.76, longitude: -73.98 } });
  await settle();
  assert.strictEqual(store.hopGrid, 'FN30AS', 'grid saved after a good report');
  const second = load({ store });
  assert.strictEqual(second.els.grid.value, 'FN30AS', 'grid prefilled');
  assert.strictEqual(second.sandbox.__geo, undefined, 'no location request needed');
  await settle();
  assert.ok(second.els.bands.innerHTML.includes('20m'), 'report rendered without a prompt');
});
