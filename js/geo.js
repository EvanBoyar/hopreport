'use strict';
// The Hop Report — grid squares, sun, and distances
// Plain script (not a module) so the page keeps working from file://.

/* ---------- geometry ---------- */

function parseGrid(s) {
  s = (s || '').trim();
  if (!/^[A-Ra-r]{2}([0-9]{2}([A-Xa-x]{2})?)?$/.test(s)) return null;
  s = s.toUpperCase();
  let lon = (s.charCodeAt(0) - 65) * 20 - 180;
  let lat = (s.charCodeAt(1) - 65) * 10 - 90;
  if (s.length >= 4) {
    lon += (+s[2]) * 2;
    lat += (+s[3]) * 1;
    if (s.length === 6) {
      lon += (s.charCodeAt(4) - 65) * (2 / 24) + (1 / 24);
      lat += (s.charCodeAt(5) - 65) * (1 / 24) + (0.5 / 24);
    } else { lon += 1; lat += 0.5; }
  } else { lon += 10; lat += 5; }
  return { lat, lon };
}

function sunElevation(lat, lon, date) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const doy = (date.getTime() - start) / 86400000;
  const decl = 23.44 * Math.sin(2 * Math.PI * (284 + doy) / 365.25);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarTime = utcHours + lon / 15;
  const hourAngle = (solarTime - 12) * 15;
  const el = Math.asin(
    Math.sin(lat * rad) * Math.sin(decl * rad) +
    Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(hourAngle * rad)
  ) / rad;
  return el;
}

function kmBetween(a, b) {
  const rad = Math.PI / 180, R = 6371;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function latLonToGrid(lat, lon, chars = 4) {
  lat = Math.min(89.999, Math.max(-89.999, lat));
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  const A = 'ABCDEFGHIJKLMNOPQR', SUB = 'abcdefghijklmnopqrstuvwx';
  const lo = lon + 180, la = lat + 90;
  let g = A[Math.floor(lo / 20)] + A[Math.floor(la / 10)] +
          Math.floor((lo % 20) / 2) + Math.floor(la % 10);
  if (chars === 6)
    g += SUB[Math.floor((lo % 2) * 12)] + SUB[Math.floor((la % 1) * 24)];
  return g;
}

function neighborGrids(pos) {
  // The user's own 4-char square first, then its 8 neighbors.
  const set = new Set();
  for (const dLat of [0, -1, 1])
    for (const dLon of [0, -2, 2])
      set.add(latLonToGrid(pos.lat + dLat, pos.lon + dLon));
  return [...set];
}
