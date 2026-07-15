'use strict';
// Loads the page's own geo/model scripts into a vm sandbox and re-exports
// what the baseline pipeline needs. The collector and the page must agree
// on grids, the diurnal curve, and the contest calendar to the digit, so
// there is exactly one copy of each: js/geo.js and js/model.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console };
vm.createContext(sandbox);
const src = ['geo.js', 'model.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'))
  .join('\n;\n');
vm.runInContext(src + `
;this.__x = { parseGrid, latLonToGrid, neighborGrids, kmBetween, MIN_SKY_KM,
              activityFactor, activeContest, BANDS };`, sandbox, { filename: 'page-js.js' });

module.exports = sandbox.__x;
