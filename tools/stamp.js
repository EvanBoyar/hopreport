'use strict';
// Stamps cache-busting versions onto the local script tags in index.html:
// each src gets ?v=<8 hex chars of the file's sha1>, so GitHub Pages'
// 10-minute cache can never pair a fresh index.html with a stale script
// from before the deploy (a mixed pair once froze the whole render loop
// on a ReferenceError). Content-hashed, so an untouched file keeps its
// stamp and only real changes invalidate. Run after editing any js/ file:
//   node tools/stamp.js
// The suite (test/stamp.test.js) fails when a stamp is stale, so a
// forgotten run cannot reach a green commit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');

function stampOf(rel) {
  return crypto.createHash('sha1')
    .update(fs.readFileSync(path.join(root, rel)))
    .digest('hex').slice(0, 8);
}

function stamped(html) {
  return html.replace(/(src|href)="(js\/[\w.-]+\.js)(?:\?v=[0-9a-f]*)?"/g,
    (m, attr, rel) => `${attr}="${rel}?v=${stampOf(rel)}"`);
}

if (require.main === module) {
  const file = path.join(root, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const out = stamped(html);
  if (out === html) { console.log('stamps already current'); return; }
  fs.writeFileSync(file, out);
  console.log('stamped index.html');
}

module.exports = { stampOf, stamped };
