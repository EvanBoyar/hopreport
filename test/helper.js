'use strict';
// Loads the app's four classic scripts into a vm sandbox with a stub DOM,
// mirroring how the browser shares one global scope across script tags.
// Run the suite with:  node --test test/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const els = {};
  const el = id => els[id] ??= {
    id, value: '', checked: true, innerHTML: '', textContent: '',
    className: '', style: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, dataset: {}, setAttribute() {},
    querySelector: sel => el(id + ' ' + sel),
  };
  const sandbox = {
    console,
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {},
    fetch: async () => { throw new Error('no network in tests'); },
    URLSearchParams,
    document: {
      getElementById: el,
      createElement: () => el('x' + Math.random()),
      body: { appendChild() {} },
      documentElement: { dataset: {} },
    },
    location: { protocol: 'file:', search: '', hash: '' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    navigator: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const src = ['geo.js', 'model.js', 'live.js', 'app.js']
    .map(f => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'))
    .join('\n;\n');
  // Classic-script top-level let/const live in the global lexical scope, so
  // expose what tests need through closures appended to the same source.
  const expose = `
    this.__api = {
      parseGrid, latLonToGrid, sunElevation, kmBetween, neighborGrids,
      bandFromHz, estimateMUF, estimateLUF, scoreBand, verdict,
      nthFullWeekendSat, activeContest, activityFactor,
      liveScore, liveStats, addSpot, pruneSpots, renderBands,
      normalizedRate, baselineExpected,
      BANDS, LIVE_WINDOW,
      get spots() { return spots; },
      set spots(v) { spots = v; },
      get myGrids() { return myGrids; },
      set myGrids(v) { myGrids = v; },
      get baselineData() { return baselineData; },
      set baselineData(v) { baselineData = v; },
    };`;
  vm.runInContext(src + '\n;\n' + expose, sandbox, { filename: 'app-concat.js' });
  return { api: sandbox.__api, el, els, sandbox };
}

module.exports = { load };
