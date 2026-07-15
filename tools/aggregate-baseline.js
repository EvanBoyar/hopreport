'use strict';
// Folds a collector sample into the running state and publishes the
// baseline: node tools/aggregate-baseline.js state.json sample.json baseline.json
//
// Each square's sample is the direction-weighted rate (rx + 0.6 tx, the
// same weights the page scores with), each direction divided by the same
// diurnal curve the page divides it by (rx by the flattened one) at that
// square's longitude and scaled to spots/hour, making samples from
// different hours comparable. State keeps a short reservoir per
// square/band and the published value is its MEDIAN, so a lone odd window
// that slipped past the collector's gates gets shrugged off rather than
// averaged in. The published reference per band is the median 9-square
// neighborhood sum across published squares — the page scores against the
// ratio to it, which is what cancels the solar cycle: climate moves every
// neighborhood and the reference together, population does not.
const fs = require('fs');
const lib = require('./lib');

const RESERVOIR = 15;      // samples kept per square/band (~2 days at 8/day)
const MIN_SAMPLES = 6;     // seen this often before a square is published
const MIN_GLOBAL = 100;    // spots a band needs in a window to be usable
const TX_WEIGHT = 0.6;
// Bumped whenever the units of a reservoir sample change (the ground-wave
// filter and the split rx/tx normalization both did); stale reservoirs in
// old units are dropped rather than averaged against new ones.
const STATE_V = 2;

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fold(state, sample) {
  state.reservoirs ??= {};
  if (state.v !== STATE_V) { state.reservoirs = {}; state.v = STATE_V; }
  state.nSamples = (state.nSamples || 0) + 1;
  state.updated = sample.t;
  if (sample.skipped) return state;
  const when = new Date(sample.t);
  for (const [band, data] of Object.entries(sample.bands)) {
    if (data.global < MIN_GLOBAL) continue;
    const res = state.reservoirs[band] ??= {};
    for (const [sq, [tx, rx]] of Object.entries(data.squares)) {
      const pos = lib.parseGrid(sq);
      if (!pos) continue;
      // lat 0 keeps the na-only contest branch out; contests are already
      // excluded at collection, so only diurnal and weekend remain. The
      // split is the same one the page's normalizedRate applies: rx by
      // the flattened curve, tx by the full one. Samples are contest
      // gated, so the digi curve stands in for every mode.
      const act = lib.activityFactor(when, 0, pos.lon);
      const norm = (rx / act.rxDigi + TX_WEIGHT * (tx / act.digi)) / ((1 + TX_WEIGHT) / 2);
      const r = res[sq] ??= [];
      r.push(Math.round(norm * 3600 / sample.secs * 10) / 10);
      if (r.length > RESERVOIR) r.shift();
    }
  }
  return state;
}

function publish(state) {
  const out = { updated: state.updated, nSamples: state.nSamples, bands: {} };
  for (const [band, res] of Object.entries(state.reservoirs || {})) {
    const squares = {};
    for (const [sq, r] of Object.entries(res))
      if (r.length >= MIN_SAMPLES) squares[sq] = Math.round(median(r) * 10) / 10;
    if (!Object.keys(squares).length) continue;
    // Reference: the median 9-square neighborhood rate among neighborhoods
    // that produce spots at all — the "typical active area" this band's
    // population factors are measured against.
    const sums = Object.keys(squares).map(sq => {
      const grids = lib.neighborGrids(lib.parseGrid(sq));
      return grids.reduce((s, g) => s + (squares[g] || 0), 0);
    });
    out.bands[band] = { ref: Math.round(median(sums) * 10) / 10, squares };
  }
  return out;
}

function main() {
  const [stateFile, sampleFile, outFile] = process.argv.slice(2);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
  const sample = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
  state = fold(state, sample);
  const baseline = publish(state);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(outFile, JSON.stringify(baseline));
  const nb = Object.keys(baseline.bands).length;
  console.log(`sample ${sample.skipped ? 'skipped (' + sample.skipped + ')' : 'folded'};`,
    `${nb} bands published, state ${JSON.stringify(state).length} bytes`);
}

if (require.main === module) main();
module.exports = { fold, publish, median, RESERVOIR, MIN_SAMPLES, MIN_GLOBAL, STATE_V };
