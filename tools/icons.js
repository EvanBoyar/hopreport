'use strict';
// Single source for the site artwork. The scene (two stations trading a
// hop off the ionosphere) is drawn once as data below, and everything
// that shows it is generated from here:
//
//   index.html            the inline favicon (day and night via a media
//                         query) and the masthead mark (painted with the
//                         page's CSS variables, so it follows the theme
//                         switch live)
//   icons/icon.svg        the launcher icon, night palette only
//   icons/icon-round.svg  the same art cut to a disc, for launchers that
//                         crop the plain icon to their own tile shape
//   icons/*.png           renders of the two SVGs for the manifest and iOS
//
// Rewrite them all with:  node tools/icons.js
// The PNGs need inkscape on the PATH; everything else regenerates
// without it. test/icons.test.js fails when a copy is edited by hand
// or the source changes without a rerun.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// One palette per sky. The mark paints with CSS variables instead, so a
// theme change never needs a regeneration.
// Stars sit in the space band, which stays dark in both palettes, so one
// pale value serves day, night, and the mark alike.
const DAY = {
  sky: '#fcfbf6', space: '#1c2434', iono: '#2c5697', ocean: '#2a6a9b',
  land: '#2e7c4f', hop: '#23211c', station: '#be3b2e', star: '#dce8f2',
};
const NIGHT = {
  sky: '#15293f', space: '#060b12', iono: '#7fa8dc', ocean: '#3d7fb5',
  land: '#6fbe8b', hop: '#dce8f2', station: '#e0685c', star: '#dce8f2',
};
const VARS = {
  sky: 'var(--paper)', space: 'var(--icon-space)', iono: 'var(--blue)',
  ocean: 'var(--icon-ocean)', land: 'var(--green)', hop: 'var(--ink)',
  station: 'var(--red)', star: '#dce8f2',
};
// Single-letter class names keep the favicon data URI small.
const CLASSES = { sky: 'k', space: 'v', iono: 'o', ocean: 'w', land: 'g', hop: 'h', station: 's', star: 't' };

// The favicon and the mark share the original square composition. The
// launcher art is tighter: stations in and up, ground raised to meet
// them, hop rescaled so its apex still kisses the layer above. That
// keeps everything that matters inside the maskable safe zone (a
// centered circle 80% of the width), so a circular launcher mask crops
// only sky and ocean.
const STARS = [[15, 9.5, '1.0', 0.85], [26, 4.5, '1.2', 1], [38, 7, '0.9', 0.7], [47, 10.5, '1.1', 0.9]];
const TILE = {
  corner: 10,
  lower: 'M 0 38 Q 32 28 64 38 L 64 41 Q 32 31 0 41 Z',
  earth: 'M 0 56 Q 32 47 64 56 L 64 64 L 0 64 Z',
  land: [[13, 58], [51, 58]],
  hop: 'M 12 53 Q 32 -12 52 53',
  stations: [[12, 53], [52, 53]],
  stars: STARS,
};
const LAUNCHER = {
  corner: 0,
  lower: 'M 0 37 Q 32 28 64 37 L 64 40 Q 32 31 0 40 Z',
  earth: 'M 0 52 Q 32 44 64 52 L 64 64 L 0 64 Z',
  land: [[15, 54], [49, 54]],
  hop: 'M 14 48 Q 32 -9 50 48',
  stations: [[14, 48], [50, 48]],
  stars: STARS,
};
const SPACE = 'M 0 0 L 64 0 L 64 18 Q 32 8 0 18 Z';
const IONO = 'M 0 18 Q 32 8 64 18 L 64 22 Q 32 12 0 22 Z';

// The color attribute for a role: a class reference, or a fill (stroke
// for the hop) from the palette the mode names.
function paint(mode, role, attr) {
  if (mode === 'class') return `class="${CLASSES[role]}"`;
  const pal = { day: DAY, night: NIGHT, vars: VARS }[mode];
  return `${attr || (role === 'hop' ? 'stroke' : 'fill')}="${pal[role]}"`;
}

// The scene as a list of pieces, top of the sky to the stations. A piece
// is a single line or a group with children; comments ride along for the
// renderings that keep them.
function scene(mode, layout, ids) {
  const p = role => paint(mode, role);
  const items = [
    { line: `<rect ${p('sky')} width="64" height="64"/>` },
    { line: `<path ${p('space')} d="${SPACE}"/>` },
    { line: `<path ${p('iono')} d="${IONO}"/>` },
    { comment: 'lower layer: the hop pierces this one and reflects off the one above',
      line: `<path ${p('iono')} opacity="0.55" d="${layout.lower}"/>` },
    { comment: 'earth: two continents under the stations, open ocean between them',
      line: `<path ${p('ocean')} d="${layout.earth}"/>` },
    { open: `<g clip-path="url(#${ids}e)">`,
      kids: layout.land.map(([x, y]) => `<ellipse ${p('land')} cx="${x}" cy="${y}" rx="12" ry="9"/>`),
      close: '</g>' },
  ];
  if (layout.stars.length)
    items.push({ comment: 'a few stars in the dark band above the ionosphere',
                 open: `<g ${paint(mode, 'star')}>`,
                 kids: layout.stars.map(([x, y, r, o]) =>
                   `<circle cx="${x}" cy="${y}" r="${r}"${o === 1 ? '' : ` opacity="${o}"`}/>`),
                 close: '</g>' });
  items.push(
    { comment: 'the hop, apex kissing the underside of the curved layer',
      line: `<path ${p('hop')} d="${layout.hop}" fill="none" stroke-width="5.5" stroke-linecap="round"/>` },
    ...layout.stations.map(([x, y]) => ({ line: `<circle ${p('station')} cx="${x}" cy="${y}" r="5.5"/>` })),
  );
  return items;
}

function clips(layout, ids) {
  const c = [];
  if (layout.corner)
    c.push(`<clipPath id="${ids}r"><rect width="64" height="64" rx="${layout.corner}"/></clipPath>`);
  c.push(`<clipPath id="${ids}e"><path d="${layout.earth}"/></clipPath>`);
  return c;
}

// Everything on one line, comments dropped: the data URI form.
function flat(items) {
  return items.map(i => i.line || i.open + i.kids.join('') + i.close).join('');
}

// One piece per line at the given indent, children a step deeper.
function pretty(items, ind, comments) {
  const out = [];
  for (const i of items) {
    if (comments && i.comment) out.push(`${ind}<!-- ${i.comment} -->`);
    if (i.line) out.push(ind + i.line);
    else out.push(ind + i.open, ...i.kids.map(k => ind + '  ' + k), ind + i.close);
  }
  return out;
}

// The favicon link for index.html: the day palette in a style block, the
// night palette behind a media query, both riding one data URI.
function faviconLink() {
  // The media block only restates the roles night actually changes.
  const rules = (pal, base) => Object.entries(CLASSES)
    .filter(([role]) => !base || pal[role] !== base[role])
    .map(([role, cls]) => `.${cls}{${role === 'hop' ? 'stroke' : 'fill'}:${pal[role]}}`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<style>${rules(DAY)}@media(prefers-color-scheme:dark){${rules(NIGHT, DAY)}}</style>` +
    clips(TILE, '').join('') +
    `<g clip-path="url(#r)">` + flat(scene('class', TILE, '')) + `</g></svg>`;
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,` +
    `${svg.replace(/"/g, "'").replace(/#/g, '%23')}">`;
}

// The masthead mark for index.html, indented to sit inside the header.
function markSvg() {
  return [
    '        <svg viewBox="0 0 64 64" width="38" height="38" aria-hidden="true">',
    ...clips(TILE, 'm').map(c => '          ' + c),
    '          <g clip-path="url(#mr)">',
    ...pretty(scene('vars', TILE, 'm'), '            ', false),
    '          </g>',
    '          <rect width="64" height="64" rx="10" fill="none" stroke="var(--card-edge)" stroke-width="2"/>',
    '        </svg>',
  ].join('\n');
}

// The launcher icon source the maskable and iOS PNGs are rendered from.
function launcherSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '  <!-- Generated by tools/icons.js; edit the scene there, not here.',
    '       Night palette throughout, since a launcher icon cannot follow the',
    '       OS color scheme the way the inline favicon does, and the night art',
    '       is the better looking of the two. -->',
    ...clips(LAUNCHER, '').map(c => '  ' + c),
    ...pretty(scene('night', LAUNCHER, ''), '  ', true),
    '</svg>',
  ].join('\n') + '\n';
}

// The same art cut to a disc, for the manifest entries without the
// maskable hint. Launchers that ignore that hint (Firefox on Android is
// one) crop the plain icon to their own tile shape; a disc with
// transparent corners stays a circle under any of them.
function roundSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '  <!-- Generated by tools/icons.js; edit the scene there, not here.',
    '       The launcher art as a disc with transparent corners, for the',
    '       manifest entries without the maskable hint, so launchers that',
    '       crop the plain icon to their own tile shape still show a circle. -->',
    '  <clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath>',
    ...clips(LAUNCHER, '').map(c => '  ' + c),
    '  <g clip-path="url(#c)">',
    ...pretty(scene('night', LAUNCHER, ''), '    ', true),
    '  </g>',
    '</svg>',
  ].join('\n') + '\n';
}

function main() {
  fs.writeFileSync(path.join(ROOT, 'icons', 'icon.svg'), launcherSvg());
  fs.writeFileSync(path.join(ROOT, 'icons', 'icon-round.svg'), roundSvg());
  console.log('wrote icons/icon.svg and icons/icon-round.svg');

  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/^<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,.*$/m,
    () => faviconLink());
  const open = html.indexOf('        <svg viewBox="0 0 64 64" width="38" height="38" aria-hidden="true">');
  if (open < 0) throw new Error('masthead mark not found in index.html');
  const close = html.indexOf('</svg>', open) + '</svg>'.length;
  html = html.slice(0, open) + markSvg() + html.slice(close);
  fs.writeFileSync(htmlPath, html);
  console.log('wrote index.html (favicon link and masthead mark)');

  const jobs = [
    ['icon-round.svg', 192, 'icon-192.png'],
    ['icon-round.svg', 512, 'icon-512.png'],
    ['icon.svg', 192, 'icon-maskable-192.png'],
    ['icon.svg', 512, 'icon-maskable-512.png'],
    ['icon.svg', 180, 'apple-touch-icon.png'],
  ];
  for (const [src, px, name] of jobs) {
    const out = path.join(ROOT, 'icons', name);
    try {
      execFileSync('inkscape',
        [path.join(ROOT, 'icons', src), '-w', String(px), '-h', String(px), '-o', out],
        { stdio: 'pipe' });
      console.log(`wrote icons/${name}`);
    } catch (e) {
      console.log(`skipped icons/${name}: ${String(e.message).split('\n')[0]}`);
    }
  }
}

if (require.main === module) main();
module.exports = { faviconLink, markSvg, launcherSvg, roundSvg };
