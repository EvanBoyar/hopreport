'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stamped } = require('../tools/stamp');

test('index.html script stamps match the files on disk', () => {
  const file = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /src="js\/app\.js\?v=[0-9a-f]{8}"/,
    'local scripts carry a version stamp');
  assert.strictEqual(html, stamped(html),
    'a js/ file changed without restamping: run node tools/stamp.js');
});
