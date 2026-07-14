'use strict';
// The Hop Report — propagation model, data sources, activity model
// Plain script (not a module) so the page keeps working from file://.

const BANDS = [
  { nm: '160m', f: 1.9,   es: false },
  { nm: '80m',  f: 3.65,  es: false },
  { nm: '40m',  f: 7.1,   es: false },
  { nm: '30m',  f: 10.12, es: false },
  { nm: '20m',  f: 14.15, es: false },
  { nm: '17m',  f: 18.1,  es: false },
  { nm: '15m',  f: 21.2,  es: false },
  { nm: '12m',  f: 24.95, es: false },
  { nm: '10m',  f: 28.4,  es: false },
  { nm: '6m',   f: 50.3,  es: true  },
];
const BAND_BY_NAME = Object.fromEntries(BANDS.map(b => [b.nm, b]));
const REF_DIST = { '160m': 1500, '80m': 2000, '40m': 3500, '30m': 4000,
                   '20m': 6000, '17m': 6000, '15m': 6000, '12m': 6000,
                   '10m': 6000, '6m': 2000 };

const BAND_EDGES = [
  ['160m', 1.8, 2.0], ['80m', 3.5, 4.0], ['40m', 7.0, 7.3],
  ['30m', 10.1, 10.15], ['20m', 14.0, 14.35], ['17m', 18.068, 18.168],
  ['15m', 21.0, 21.45], ['12m', 24.89, 24.99], ['10m', 28.0, 29.7],
  ['6m', 50.0, 54.0],
];
function bandFromHz(hz) {
  const f = +hz / 1e6;
  for (const [nm, lo, hi] of BAND_EDGES) if (f >= lo && f <= hi) return nm;
  return null;
}

/* ---------- data sources ---------- */

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function fetchSFI() {
  const d = await getJSON('https://services.swpc.noaa.gov/json/f107_cm_flux.json');
  d.sort((a, b) => a.time_tag < b.time_tag ? -1 : 1);
  for (let i = d.length - 1; i >= 0; i--) {
    const v = +d[i].flux;
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  throw new Error('no numeric flux in feed');
}

async function fetchKp() {
  // Primary: 1-minute estimated Kp (clean JSON objects).
  try {
    const d = await getJSON('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json');
    for (let i = d.length - 1; i >= 0; i--) {
      const v = +(d[i].estimated_kp ?? d[i].kp_index);
      if (Number.isFinite(v)) return v;
    }
  } catch (e) { /* fall through to product feed */ }
  // Fallback: product feed. Locate the Kp column from the header row and
  // walk back past any null or blank rows.
  const d = await getJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
  const header = (d[0] || []).map(h => String(h).toLowerCase());
  let col = header.findIndex(h => h === 'kp' || h.includes('kp'));
  if (col === -1) col = 1;
  for (let i = d.length - 1; i >= 1; i--) {
    const v = parseFloat(d[i][col]);
    if (Number.isFinite(v)) return v;
  }
  throw new Error('no numeric Kp in feed');
}

async function fetchXray() {
  const d = await getJSON('https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json');
  const longband = d.filter(e => e.energy === '0.1-0.8nm');
  const flux = +longband[longband.length - 1].flux;
  let cls, mult;
  if (flux >= 1e-4)      { cls = 'X' + (flux / 1e-4).toFixed(1); mult = 9; }
  else if (flux >= 1e-5) { cls = 'M' + (flux / 1e-5).toFixed(1); mult = 3.5; }
  else if (flux >= 1e-6) { cls = 'C' + (flux / 1e-6).toFixed(1); mult = 1.4; }
  else if (flux >= 1e-7) { cls = 'B' + (flux / 1e-7).toFixed(1); mult = 1; }
  else                   { cls = 'A'; mult = 1; }
  return { cls, mult };
}

async function fetchIonosonde(pos) {
  const d = await getJSON('https://prop.kc2g.com/api/stations.json');
  const now = Date.now();
  const fresh = d.filter(s =>
    s.mufd != null && s.fof2 != null && s.time &&
    (now - Date.parse(s.time)) < 100 * 60 * 1000 &&
    s.station && s.station.latitude != null
  );
  let best = null, bestKm = Infinity;
  for (const s of fresh) {
    const km = kmBetween(pos, { lat: +s.station.latitude, lon: +s.station.longitude });
    if (km < bestKm) { bestKm = km; best = s; }
  }
  if (!best || bestKm > 3500) throw new Error('no fresh ionosonde nearby');
  return {
    muf: +best.mufd, fof2: +best.fof2,
    name: best.station.name, km: Math.round(bestKm),
    ageMin: Math.round((now - Date.parse(best.time)) / 60000)
  };
}

/* ---------- model ---------- */

function estimateMUF(sfi, sunEl, kp) {
  const day = 8 + 0.155 * sfi;
  const night = 0.45 * day + 3.5;
  const rad = Math.PI / 180;
  const dayFrac = Math.min(1, Math.max(0, (Math.sin(sunEl * rad) + 0.12) / 0.62));
  let muf = night + (day - night) * Math.pow(dayFrac, 0.7);
  muf *= Math.max(0.7, 1 - 0.05 * Math.max(0, kp - 3));
  return muf;
}

function estimateLUF(sunEl, flareMult) {
  // Derived from the absorption gate, not modeled separately: the frequency
  // where daytime D-layer loss alone would pull a band below fair (gate 0.3).
  // Solving exp(-0.25 * s * (10/f)^2 * F) = 0.3 gives f = 4.56 * sqrt(s * F).
  if (sunEl <= 0) return 0;
  const s = Math.pow(Math.sin(sunEl * Math.PI / 180), 0.75);
  return 4.56 * Math.sqrt(s * flareMult);
}

function scoreBand(band, ctx) {
  const rad = Math.PI / 180;

  // 1. MUF gate
  const r = band.f / ctx.muf;
  const m = r <= 0.82 ? 1 : Math.exp(-Math.pow((r - 0.82) / 0.16, 2));

  // 2. D-layer absorption gate
  let a = 1;
  if (ctx.sunEl > 0) {
    const sun = Math.pow(Math.sin(ctx.sunEl * rad), 0.75);
    a = Math.exp(-0.25 * sun * Math.pow(10 / band.f, 2) * ctx.flareMult);
  }

  // 3. Geomagnetic gate
  const latFactor = Math.min(1, Math.max(0.1, (Math.abs(ctx.lat) - 25) / 35));
  const kpPenalty = Math.min(1, Math.max(0, (ctx.kp - 2) / 6));
  const g = 1 - 0.55 * kpPenalty * latFactor * (band.f >= 14 ? 1 : 0.6);

  // 4. Season gate (summer static on low bands, hemisphere-aware)
  const month = new Date().getUTCMonth() + 1;
  const summer = ctx.lat >= 0 ? (month >= 6 && month <= 8) : (month === 12 || month <= 2);
  const n = (band.f < 11 && summer) ? 0.85 : 1;

  let score = 100 * m * a * g * n;
  if (band.es && ctx.muf < 40) score *= 0.25; // 6m: F2 closed, Es unknowable from indices
  if (!Number.isFinite(score)) score = 0;

  return { score: Math.max(0, Math.min(100, Math.round(score))), m, a, g, n };
}

function verdict(score) {
  if (score >= 75) return ['OPEN', 's-open'];
  if (score >= 50) return ['GOOD', 's-good'];
  if (score >= 30) return ['FAIR', 's-fair'];
  if (score >= 12) return ['POOR', 's-poor'];
  return ['CLOSED', 's-closed'];
}

// Spot volume tracks who is awake and keying up, not just the ionosphere:
// the reporting networks bottom out in the small hours of local night and
// peak in the evening, and weekends run hotter (contests live there). The
// public statistics (ft8spots.com day-of-week plots, PSK Reporter's hourly
// report counts) show the cycle plainly but publish no hard ratios, so this
// curve is a documented estimate: trough ~0.15 of peak near 04 local,
// daytime plateau ~0.7, peak 19-21 local, weekends x1.35.
const DIURNAL = [0.55, 0.35, 0.22, 0.16, 0.15, 0.18, 0.28, 0.42,
                 0.55, 0.65, 0.70, 0.72, 0.72, 0.70, 0.68, 0.68,
                 0.72, 0.80, 0.90, 1.00, 1.00, 0.95, 0.85, 0.70];

// The big-contest weekends are computed from their date rules instead of
// fetched: the rules (nth or last full weekend of a month) have been stable
// for decades, and the canonical calendar (WA7BNM) sends no CORS headers,
// so a rule table is strictly more durable than any feed this page could
// reach. Only majors that flood the spot networks are listed; the SSB-only
// majors are absent on purpose, since phone barely reaches this feed. cw
// and digi say how many times hotter than a normal weekday evening each
// side of the feed runs; na marks events that matter only in the Americas.
const CONTESTS = [
  { nm: 'ARRL RTTY Roundup',    m: 0,  wk: 1,  cw: 1,   digi: 2, na: false },
  { nm: 'ARRL DX CW',           m: 1,  wk: 3,  cw: 3,   digi: 1, na: false },
  { nm: 'CQ WPX CW',            m: 4,  wk: -1, cw: 3.5, digi: 1, na: false },
  { nm: 'ARRL Field Day',       m: 5,  wk: 4,  cw: 3,   digi: 2, na: true  },
  { nm: 'IARU HF Championship', m: 6,  wk: 2,  cw: 2.5, digi: 1, na: false },
  { nm: 'World Wide Digi DX',   m: 7,  wk: -1, cw: 1,   digi: 2, na: false },
  { nm: 'CQ WW RTTY',           m: 8,  wk: -1, cw: 1,   digi: 2, na: false },
  { nm: 'ARRL Sweepstakes CW',  m: 10, wk: 1,  cw: 2.5, digi: 1, na: true  },
  { nm: 'CQ WW CW',             m: 10, wk: -1, cw: 4,   digi: 1, na: false },
];

function nthFullWeekendSat(year, month, nth) {
  // Day-of-month of the Saturday of the nth full weekend (Sat and Sun both
  // inside the month); nth = -1 means the last one.
  const sats = [];
  const first = new Date(Date.UTC(year, month, 1));
  for (let day = 1 + (6 - first.getUTCDay() + 7) % 7; ; day += 7) {
    const sun = new Date(Date.UTC(year, month, day + 1));
    if (new Date(Date.UTC(year, month, day)).getUTCMonth() !== month) break;
    if (sun.getUTCMonth() === month) sats.push(day);
    else break;
  }
  return nth === -1 ? sats[sats.length - 1] : sats[nth - 1];
}

function activeContest(date, lat, lon) {
  const inNA = lon > -170 && lon < -50 && lat > 12;
  const y = date.getUTCFullYear(), m = date.getUTCMonth(), t = date.getTime();
  let best = null;
  for (const c of CONTESTS) {
    if (c.m !== m || (c.na && !inNA)) continue;
    const sat = nthFullWeekendSat(y, c.m, c.wk);
    if (!sat) continue;
    const start = Date.UTC(y, c.m, sat);           // 0000Z Saturday
    if (t < start || t >= start + 48 * 3600000) continue;
    if (!best || c.cw + c.digi > best.cw + best.digi) best = c;
  }
  return best;
}

function activityFactor(date, lat, lon) {
  // Mean solar time stands in for the operators' clocks. That is exactly
  // right for the tx side (the transmitters are your neighbors) and only
  // partly right for the rx side: what your monitors hear comes from a
  // mostly-regional pool spread over several time zones, so its diurnal
  // swing is real but shallower — the square root halves the swing while
  // keeping the correlation. Weekend and contest surges are global and
  // apply in full to both sides.
  const h = ((date.getTime() / 3600000 + lon / 15) % 24 + 24) % 24;
  const i = Math.floor(h) % 24, f = h - Math.floor(h);
  const base = DIURNAL[i] * (1 - f) + DIURNAL[(i + 1) % 24] * f;
  const flat = Math.sqrt(base);
  const dow = new Date(date.getTime() + (lon / 15) * 3600000).getUTCDay();
  const wk = (dow === 0 || dow === 6) ? 1.35 : 1;
  const c = activeContest(date, lat, lon);
  const bd = Math.max(wk, c ? c.digi : 1), bc = Math.max(wk, c ? c.cw : 1);
  return {
    digi: base * bd, cw: base * bc,        // expected activity, tx side
    rxDigi: flat * bd, rxCw: flat * bc,    // expected activity, rx side
    contest: c,
  };
}

function normalizedRate(st, act) {
  // The direction- and mode-weighted spot count. Heard volume (rx)
  // outranks sent volume (tx): the local monitors are a fixed, always-on
  // instrument while local transmitters come and go on whim, so tx
  // silence says little. Each bucket is divided by its expected operator
  // activity first, making the result a peak-equivalent rate.
  const a = act || { digi: 1, cw: 1, rxDigi: 1, rxCw: 1 };
  const TX_WEIGHT = 0.6;
  const rxN = st.dRx / a.rxDigi + st.cRx / a.rxCw;
  const txN = st.dTx / a.digi + st.cTx / a.cw;
  return (rxN + TX_WEIGHT * txN) / ((1 + TX_WEIGHT) / 2);
}

/* ---------- population baseline ---------- */

// Raw spot volume mostly measures how many operators live near a grid: a
// city square out-spots a rural one on every band, open or closed. The
// baseline workflow (.github/workflows/baseline.yml) samples the whole
// feed on quiet days, corrects each square by the same diurnal curve used
// above, and publishes per-square median rates plus each band's median
// 9-square neighborhood rate as the reference. Scoring against the ratio
// of the two cancels what population and climate share: a solar minimum
// lowers every neighborhood and the reference together, so a dead 10m
// still reads dead, while a Manhattan-sized spot pile reads as normal.
// raw.githubusercontent.com sends CORS headers, so the file is readable
// from anywhere the page runs, including file://.
const BASELINE_URL =
  'https://raw.githubusercontent.com/EvanBoyar/hopreport/data/baseline.json';

function baselineExpected(data, grids, bandName) {
  // Expected peak-equivalent spots/hour for this 9-square neighborhood
  // plus the scoring denominator, or null when the baseline has nothing
  // useful to say about the area.
  const b = data && data.bands && data.bands[bandName];
  if (!b || !b.ref || !b.squares) return null;
  let sum = 0, hits = 0;
  for (const g of grids) {
    const v = b.squares[g];
    if (v != null) { sum += v; hits++; }
  }
  if (!hits || sum <= 0) return null;
  // Clamped so a degenerate baseline can never pin a band open or shut.
  return { expected: sum, ref: 40 * Math.min(6, Math.max(0.2, sum / b.ref)) };
}

function liveScore(band, st, act = null, ref = null, fill = 1) {
  // Needs a few spots before we trust it, then activity plus reach, normalized
  // per band. 1500 km on 160m is a great night; on 15m it is nothing.
  // Counts are normalized per mode and per direction by expected operator
  // activity before they are scored: 6 spots at 04 local outrank 20 at 20
  // local, and a pile of CW spots during CQ WW CW is business as usual,
  // not an opening. Reach is left alone; max distance is propagation's
  // doing, not the operators'. The denominator is the population-scaled
  // reference when the baseline knows the area, else the universal 40:
  // 40 normalized spots/hour at evening peak reads the same as 10 spots
  // did over the old 15 minute window.
  //
  // fill is the filled fraction of the hour window (the feed has no
  // history, so a fresh page has only minutes of spots). Counts scale to
  // a per-hour rate so bands do not appear to improve as the window
  // fills; the floor caps the extrapolation at x12 (5 minutes of data).
  if (st.n < 3) return null;
  const nEff = normalizedRate(st, act) / Math.max(1 / 12, Math.min(1, fill));
  const activity = 1 - Math.exp(-nEff / (ref || 40));
  const reach = Math.min(1, st.max / (REF_DIST[band.nm] || 5000));
  return 100 * (0.45 * activity + 0.55 * reach);
}
