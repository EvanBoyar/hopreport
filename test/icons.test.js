'use strict';
// The artwork is drawn once in tools/icons.js and copied into the files
// below by running it. These tests fail when a copy gets edited by hand,
// or when the source changes without a regeneration.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const icons = require('../tools/icons');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the launcher SVG is what the generator draws', () => {
  assert.strictEqual(read('icons/icon.svg'), icons.launcherSvg());
});

test('the round launcher SVG is what the generator draws', () => {
  assert.strictEqual(read('icons/icon-round.svg'), icons.roundSvg());
});

test('the inline favicon is what the generator draws', () => {
  assert.ok(read('index.html').includes(icons.faviconLink()),
    'index.html favicon link differs from tools/icons.js output');
});

test('the masthead mark is what the generator draws', () => {
  assert.ok(read('index.html').includes(icons.markSvg()),
    'index.html masthead mark differs from tools/icons.js output');
});
