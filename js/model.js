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

// A pair closer than this is treated as ground wave rather than an
// ionospheric hop, and never enters any sky count. Surface wave
// attenuation grows with frequency, so the radius shrinks up the bands.
// The 6m figure is the sporadic-E floor instead: nothing under it is
// surface wave, but nothing under it is the sky either. Distances are
// between 4-char square centers (the same square reads as 0 km, each of
// the 8 neighbors under ~222 km), so the values carry about a square of
// quantization slack. Shared by the live layer and the baseline
// collector, which must agree.
const MIN_SKY_KM = { '160m': 350, '80m': 300, '40m': 250, '30m': 250,
                     '20m': 200, '17m': 200, '15m': 150, '12m': 150,
                     '10m': 150, '6m': 500 };
// 6m only: under LOS_KM a spot is line of sight and dropped; between
// LOS_KM and the band's MIN_SKY_KM it is troposphere, kept apart from
// the sky counts and tallied on its own, because a tropo opening is
// real news on 6m even though it says nothing about the ionosphere.
const LOS_KM = 150;

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

function parseFeedTime(s) {
  // Some feeds (kc2g stations.json among them) stamp UTC times with no
  // zone suffix, and Date.parse reads a zoneless string as local time.
  // That slides every age test by the viewer's UTC offset: west of
  // Greenwich the freshness gate quietly loosens by hours, east of it
  // a minutes-old reading gets rejected as stale. A stamp without an
  // explicit zone is read as the UTC it actually is.
  s = String(s);
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
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
  // Fallback: the product feed, which has shipped two shapes so far.
  // It began as rows-under-a-header-row and changed in 2026 to one
  // object per synoptic period, so both are handled and either way the
  // walk runs back past any null or blank entries.
  const d = await getJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
  if (d.length && !Array.isArray(d[0])) {
    for (let i = d.length - 1; i >= 0; i--) {
      const v = +(d[i].Kp ?? d[i].kp_index ?? d[i].kp);
      if (Number.isFinite(v)) return v;
    }
  } else {
    const header = (d[0] || []).map(h => String(h).toLowerCase());
    let col = header.findIndex(h => h === 'kp' || h.includes('kp'));
    if (col === -1) col = 1;
    for (let i = d.length - 1; i >= 1; i--) {
      const v = parseFloat(d[i][col]);
      if (Number.isFinite(v)) return v;
    }
  }
  throw new Error('no numeric Kp in feed');
}

async function fetchXray() {
  const d = await getJSON('https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json');
  const longband = d.filter(e => e.energy === '0.1-0.8nm');
  const flux = +longband[longband.length - 1].flux;
  let cls;
  if (flux >= 1e-4)      cls = 'X' + (flux / 1e-4).toFixed(1);
  else if (flux >= 1e-5) cls = 'M' + (flux / 1e-5).toFixed(1);
  else if (flux >= 1e-6) cls = 'C' + (flux / 1e-6).toFixed(1);
  else if (flux >= 1e-7) cls = 'B' + (flux / 1e-7).toFixed(1);
  else                   cls = 'A';
  return { cls, flux };
}

async function fetchProtons() {
  // GOES integral proton flux, the input to D-RAP's polar cap term.
  // The energies its formulas want (above 5.2 MeV by day, 2.2 MeV by
  // night) are not GOES channels: the 5 MeV channel stands in for the
  // first, and the second is interpolated between the 1 and 5 MeV
  // channels assuming a power-law spectrum.
  const d = await getJSON('https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json');
  const latest = {};
  for (const r of d) latest[r.energy] = +r.flux;
  const j1 = latest['>=1 MeV'], j5 = latest['>=5 MeV'];
  if (!Number.isFinite(j1) || !Number.isFinite(j5) || j5 <= 0) throw new Error('no proton flux in feed');
  const gamma = Math.max(0, Math.log(j1 / j5) / Math.log(5));
  return { day: j5, night: j1 * Math.pow(2.2, -gamma) };
}

async function fetchIonosonde(pos) {
  // Read through the repo's data branch, not prop.kc2g.com directly:
  // kc2g sends no CORS headers (and GIRO upstream pins access to its
  // own origin), so no browser can read the source. A workflow
  // (.github/workflows/ionosondes.yml) relays a trimmed copy every
  // half hour, and raw.githubusercontent.com serves it with CORS open.
  const d = await getJSON('https://raw.githubusercontent.com/EvanBoyar/hopreport/data/ionosondes.json');
  const now = Date.now();
  const fresh = d.filter(s =>
    s.mufd != null && s.fof2 != null && s.time &&
    (now - parseFeedTime(s.time)) < 100 * 60 * 1000 &&
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
    lat: +best.station.latitude, lon: +best.station.longitude,
    ageMin: Math.round((now - parseFeedTime(best.time)) / 60000)
  };
}

async function fetchRefractivity(pos) {
  // The tropo line's model term. Tropo is weather, so it comes from a
  // weather model: Open-Meteo (CORS-open, keyless) serves forecast
  // temperature, humidity, and geopotential height on pressure levels
  // for any coordinates, plus a screen reading 2 m above ground with
  // its own surface pressure. The 2 m rung is what sees nocturnal
  // radiation inversions, which form below the lowest pressure level;
  // the ladder runs on to 750 hPa so high terrain (Denver sits above
  // the 900 hPa surface) still gets usable levels. A grid above
  // ~2.5 km outruns the ladder entirely and falls back to the tally,
  // which is the honest answer there anyway. Only the current hour is
  // asked for. Heights need care: geopotential levels arrive above sea
  // level and the 2 m point above ground, so the surface rung is
  // lifted to elevation + 2 for the math, and the winning span is
  // reported back above ground, the frame an operator stands in.
  const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750];
  const vars = LEVELS.flatMap(p => [`temperature_${p}hPa`,
    `relative_humidity_${p}hPa`, `geopotential_height_${p}hPa`])
    .concat(['temperature_2m', 'relative_humidity_2m', 'surface_pressure']);
  const d = await getJSON('https://api.open-meteo.com/v1/forecast' +
    `?latitude=${pos.lat.toFixed(3)}&longitude=${pos.lon.toFixed(3)}` +
    `&hourly=${vars.join(',')}&forecast_hours=1&timeformat=unixtime`);
  const elev = +d.elevation || 0;
  const prof = [];
  const sfc = { p: +d.hourly.surface_pressure?.[0],
                t: +d.hourly.temperature_2m?.[0],
                rh: +d.hourly.relative_humidity_2m?.[0], z: elev + 2 };
  if ([sfc.p, sfc.t, sfc.rh].every(Number.isFinite)) prof.push(sfc);
  for (const p of LEVELS) {
    const t = +d.hourly[`temperature_${p}hPa`]?.[0];
    const rh = +d.hourly[`relative_humidity_${p}hPa`]?.[0];
    const z = +d.hourly[`geopotential_height_${p}hPa`]?.[0];
    // A level under the model's own ground (1000 hPa at Denver) is an
    // extrapolation into rock and says nothing about the air; one much
    // past 2 km above it describes weather a ground station's tropo
    // paths never touch.
    if (Number.isFinite(t) && Number.isFinite(rh) && Number.isFinite(z) &&
        z > elev && z <= elev + 2000) prof.push({ p, t, rh, z });
  }
  const g = refractivityBest(prof);
  if (!g) throw new Error('no usable profile');
  return { ...g, z: Math.max(0, g.z - Math.round(elev)),
           top: g.top - Math.round(elev) };
}

/* ---------- model ---------- */

function estimateMUF(sfi, sunEl, kp, lat = 0, date = new Date()) {
  // Daytime F2 runs cooler in the summer hemisphere and hotter in the
  // winter one (the winter anomaly). Checked against every fresh kc2g
  // ionosonde on 2026-07-16 (SFI 107): a flat day term read 5 to 8 MHz
  // high across summer midlatitudes and 6 MHz low at winter ones, while
  // the night term read unbiased, so only the day term is scaled. The
  // cosine peaks at the solstices; the weight ramps in from 30 to 55
  // degrees because the tropics showed no such swing (their misses are
  // equatorial-anomaly physics this estimate does not attempt). The
  // 0.22 sits deliberately under the single-epoch best fit of 0.33,
  // pending a winter sample. Callers that pass no position get the old
  // flat behavior.
  const doy = (date - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000;
  const summer = Math.cos(2 * Math.PI * (doy - 172) / 365.25) * (lat >= 0 ? 1 : -1);
  const anomaly = 1 - 0.22 * summer * Math.min(1, Math.max(0, (Math.abs(lat) - 30) / 25));
  const base = 8 + 0.155 * sfi;
  const day = base * anomaly;
  const night = 0.45 * base + 3.5;
  const rad = Math.PI / 180;
  const dayFrac = Math.min(1, Math.max(0, (Math.sin(sunEl * rad) + 0.12) / 0.62));
  let muf = night + (day - night) * Math.pow(dayFrac, 0.7);
  muf *= Math.max(0.7, 1 - 0.05 * Math.max(0, kp - 3));
  return muf;
}

function localizeSondeMUF(muf, sfi, kp, date, here, there) {
  // The sonde search radius spans three time zones, so a borrowed
  // reading can describe a different part of the day: Idaho's morning
  // ionosphere is not New York's noon, and a sonde still in daylight
  // says little about a grid past sunset. The measurement is bent by
  // the model's own diurnal and seasonal shape evaluated at both ends,
  // so the sonde anchors the level and the model steers the local
  // correction. Similar suns leave the reading untouched; the clamp
  // keeps the shape, itself an estimate, from ever overruling the
  // measurement by more than half.
  const at = p => estimateMUF(sfi, sunElevation(p.lat, p.lon, date), kp, p.lat, date);
  return muf * Math.min(1.5, Math.max(0.65, at(here) / at(there)));
}

function geomagLat(lat, lon) {
  // Centered-dipole geomagnetic latitude (IGRF pole near 80.7 N,
  // 72.7 W). Coarse next to D-RAP's invariant-latitude machinery, but
  // the polar term only needs to know roughly how deep inside the cap
  // a point sits.
  const rad = Math.PI / 180;
  const s = Math.sin(lat * rad) * Math.sin(80.7 * rad) +
            Math.cos(lat * rad) * Math.cos(80.7 * rad) * Math.cos((lon + 72.7) * rad);
  return Math.asin(Math.max(-1, Math.min(1, s))) / rad;
}

function absorptionDb(f, sunEl, xrayFlux, polar) {
  // D-layer loss in dB at f MHz, vertical round trip, three components.
  // The quiet-day term is ours: 108.6 * sin(el)^1.5 / f^2, anchored so
  // overhead sun alone pulls the LUF to 4.56 MHz (about 30 dB at
  // 1.9 MHz, the textbook quiet midday figure). NOAA D-RAP models no
  // quiet component, but its angular law is adopted as ground truth:
  // degraded frequencies taper as cos(chi)^0.75, so absorption under a
  // 1/f^2 law must carry the square of that taper.
  // The flare term is D-RAP's, verbatim: the highest affected frequency
  // (1 dB) is 10*log10(flux) + 65 at the subsolar point, tapers as
  // cos(chi)^0.75, and other frequencies degrade as (HAF/f)^1.5.
  // Checked against their published global grid on 2026-07-16.
  let a = 0;
  if (sunEl > 0) {
    const s = Math.pow(Math.sin(sunEl * Math.PI / 180), 0.75);
    a = 108.6 * s * s / (f * f);
    const haf = (10 * Math.log10(xrayFlux > 0 ? xrayFlux : 1e-9) + 65) * s;
    if (haf > 0) a += Math.pow(haf / f, 1.5);
  }
  // The polar cap proton term, also D-RAP's: at 30 MHz the day side
  // absorbs 0.115 * sqrt(J > 5.2 MeV) dB and the night side
  // 0.020 * sqrt(J > 2.2 MeV), with the same (f0/f)^1.5 law across
  // frequency. Day and night blend through twilight, since the D region
  // neither appears nor vanishes at the geometric horizon. The cap
  // boundary is a Kp-widened dipole-latitude gate standing in for
  // D-RAP's cutoff-energy model: full effect deep in the cap, fading
  // to nothing across five degrees at the edge, which sits near 64
  // degrees geomagnetic when quiet and pushes equatorward as Kp rises.
  if (polar && polar.protons) {
    const edge = 64 - 1.2 * Math.min(9, polar.kp || 0);
    const w = Math.min(1, Math.max(0, (Math.abs(polar.gmLat) - (edge - 2.5)) / 5));
    if (w > 0) {
      const dayW = Math.min(1, Math.max(0, (sunEl + 8) / 16));
      const a30 = dayW * 0.115 * Math.sqrt(Math.max(0, polar.protons.day)) +
                  (1 - dayW) * 0.020 * Math.sqrt(Math.max(0, polar.protons.night));
      a += w * a30 * Math.pow(30 / f, 1.5);
    }
  }
  return a;
}

function estimateLUF(sunEl, xrayFlux, polar) {
  // Derived from the absorption gate, not modeled separately: the
  // frequency where D-layer loss alone pulls a band below fair (gate
  // 0.3, which is 5.23 dB). The terms mix 1/f^2 and 1/f^1.5, so there
  // is no closed form; bisection converges to more precision than the
  // display uses in far fewer than 40 rounds. Nonzero at night only
  // inside the polar cap during a proton event.
  const target = -10 * Math.log10(0.3);
  let lo = 0.1, hi = 60;
  if (absorptionDb(hi, sunEl, xrayFlux, polar) >= target) return hi;
  if (absorptionDb(lo, sunEl, xrayFlux, polar) < target) return 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (absorptionDb(mid, sunEl, xrayFlux, polar) >= target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function scoreBand(band, ctx) {
  // 1. MUF gate
  const r = band.f / ctx.muf;
  const m = r <= 0.82 ? 1 : Math.exp(-Math.pow((r - 0.82) / 0.16, 2));

  // 2. D-layer absorption gate (quiet term, D-RAP's flare term, and
  // D-RAP's polar proton term when a proton reading is on hand)
  const polar = ctx.protons
    ? { gmLat: geomagLat(ctx.lat, ctx.lon || 0), kp: ctx.kp, protons: ctx.protons }
    : null;
  const a = Math.pow(10, -absorptionDb(band.f, ctx.sunEl, ctx.xrayFlux, polar) / 10);

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

function bandRangeList(names) {
  // Names a set of bands the way an operator would: three or more
  // contiguous bands collapse to a range with the shortest wavelength
  // first (12m-40m), pairs and singles are listed. Input order and
  // duplicates do not matter.
  const idx = [...new Set(names.map(nm => BANDS.findIndex(b => b.nm === nm)))]
    .filter(i => i >= 0).sort((a, b) => a - b);
  const out = [];
  for (let s = 0, i = 1; i <= idx.length; i++) {
    if (i === idx.length || idx[i] !== idx[i - 1] + 1) {
      const run = idx.slice(s, i);
      if (run.length >= 3) out.push(`${BANDS[run[run.length - 1]].nm}-${BANDS[run[0]].nm}`);
      else out.push(...run.map(j => BANDS[j].nm));
      s = i;
    }
  }
  return out.length > 1
    ? out.slice(0, -1).join(', ') + ' and ' + out[out.length - 1]
    : (out[0] || '');
}

function verdict(score) {
  if (score >= 75) return ['OPEN', 's-open'];
  if (score >= 50) return ['GOOD', 's-good'];
  if (score >= 30) return ['FAIR', 's-fair'];
  if (score >= 12) return ['POOR', 's-poor'];
  return ['CLOSED', 's-closed'];
}

/* ---------- 6m tropo ---------- */

// Past -157 N/km a ray bends more than the earth curves and follows it:
// a duct. Super-refraction starts near -79; standard atmosphere ~ -40.
const DUCT_GRAD = -157;
// A duct traps only waves short enough for its depth (lambda_max ≈
// 2.5e-3 · d^1.5, both in meters), so 50 MHz needs about 180 m of
// layer. Thinner inversions super-refract 6m; they cannot duct it.
const TRAP_M = 180;

function refractivityBest(profile) {
  // Radio refractivity N = 77.6 P/T + 3.73e5 e/T^2 (P and vapor
  // pressure e in hPa, T in kelvin), e from the Magnus formula. Every
  // contiguous span of the profile is scored — the gradient's ladder
  // score weighted by min(1, depth/TRAP_M) — and the best span wins:
  // steep air counts only insofar as it is deep enough to matter at
  // 50 MHz, which keeps the routine midnight surface inversion a nudge
  // instead of an alarm. Spanning whole runs also credits a duct that
  // straddles two pressure rungs, which per-layer scoring chopped into
  // diluted slices. The duct flag needs one span that is both
  // duct-grade and trapping-deep. Null under two usable levels.
  const pts = profile.map(l => {
    const T = l.t + 273.15;
    const e = (l.rh / 100) * 6.112 * Math.exp(17.62 * l.t / (243.12 + l.t));
    return { z: l.z, n: 77.6 * l.p / T + 3.73e5 * e / (T * T) };
  }).sort((a, b) => a.z - b.z);
  let best = null, duct = false;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dm = pts[j].z - pts[i].z;
      if (dm < 50) continue;
      const grad = (pts[j].n - pts[i].n) / (dm / 1000);
      const score = tropoModelScore(grad) * Math.min(1, dm / TRAP_M);
      if (grad <= DUCT_GRAD && dm >= TRAP_M) duct = true;
      if (!best || score > best.score) {
        best = { grad, z: Math.round(pts[i].z), top: Math.round(pts[j].z), score };
      }
    }
  }
  return best && { ...best, duct };
}

function tropoModelScore(grad) {
  // The gradient mapped onto the verdict ladder at its physical rungs:
  // the standard atmosphere (-40 N/km) is mid-NORMAL — the everyday is
  // normal, not a deficit — sub-refraction falls off into FLAT, the
  // super-refraction onset (-79) lands exactly on the ENHANCED line,
  // and the ducting threshold on the 75 line, running on to 100 for
  // deep ducts.
  const PTS = [[0, 0], [-40, 35], [-79, 50], [DUCT_GRAD, 75], [-235, 100]];
  if (grad >= 0) return 0;
  for (let i = 1; i < PTS.length; i++) {
    const [g1, s1] = PTS[i - 1], [g2, s2] = PTS[i];
    if (grad >= g2) return s1 + (s2 - s1) * (grad - g1) / (g2 - g1);
  }
  return 100;
}

// The annulus reads fully busy near 20 normalized spots/hour when no
// baseline knows the area — the universal fallback, the tropo twin of
// the bands' 40, and a documented estimate.
const TROPO_REF = 20;

function tropoRate(st, act = null) {
  // The annulus tally, fed to normalizedRate the way it reads a band:
  // the tropo counts ride the digi buckets (the tally is FT8-dominated,
  // so the digi curves normalize both modes) and the CW buckets ride
  // empty.
  return normalizedRate({ wdRx: st.wtRx, wdTx: st.wtTx, wcRx: 0, wcTx: 0 }, act);
}

function tropoLiveScore(st, act = null, ref = null, expWin = null) {
  // The live half of the tropo verdict, shaped like liveScore: rate
  // against expected operator activity plus reach across the 150-500 km
  // annulus, reach judged by the second-longest spot so one mangled
  // locator cannot call an opening. The denominator is the population-
  // scaled reference when the baseline knows the annulus, else the
  // universal TROPO_REF.
  const activity = 1 - Math.exp(-tropoRate(st, act) / (ref || TROPO_REF));
  const reachOf = km => Math.min(1, Math.max(0,
    (km - LOS_KM) / (MIN_SKY_KM['6m'] - LOS_KM)));
  const score = 100 * (0.45 * activity + 0.55 * reachOf(st.tMax2));
  if (st.tN >= 3) return score;
  // Damning silence, annulus edition: a watched window in a neighborhood
  // whose tropo baseline promised traffic, and almost nothing came. The
  // shared silence gate and the same generous-reading guard as
  // liveScore, with the tropo ladder's floor standing in for CLOSED:
  // silence only ever testifies toward FLAT, and a lone far-edge spot
  // that contradicts the silence makes the line abstain instead.
  if (!silenceConvicts(st.tN, expWin)) return null;
  const generous = 100 * (0.45 * activity + 0.55 * reachOf(st.tMax));
  return tropoVerdict(Math.round(generous), false)[0] === 'FLAT' ? score : null;
}

function tropoVerdict(score, duct) {
  // Tropo is never closed, only flat — even a standard atmosphere
  // carries weak-signal work across everyday annulus ranges, so the
  // floor claims "nothing beyond the ordinary", not "unworkable" — and
  // the ladder has its own words and its own rungs. DUCTING needs
  // gradient evidence (a spot capped at the 500 km Es floor cannot
  // prove a duct) and is the only green on the line: spots alone top
  // out at ENHANCED in yellow-green.
  if (score >= 75) return duct ? ['DUCTING', 's-open'] : ['ENHANCED', 's-good'];
  if (score >= 50) return ['ENHANCED', 's-yellow'];
  if (score >= 30) return ['NORMAL', 's-fair'];
  return ['FLAT', 's-poor'];
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
// h is the start hour UTC on the Saturday and len the length in hours,
// both from each contest's published rules.
const CONTESTS = [
  { nm: 'ARRL RTTY Roundup',    m: 0,  wk: 1,  h: 18, len: 30, cw: 1,   digi: 2, na: false },
  { nm: 'ARRL DX CW',           m: 1,  wk: 3,  h: 0,  len: 48, cw: 3,   digi: 1, na: false },
  { nm: 'CQ WPX CW',            m: 4,  wk: -1, h: 0,  len: 48, cw: 3.5, digi: 1, na: false },
  { nm: 'ARRL Field Day',       m: 5,  wk: 4,  h: 18, len: 27, cw: 3,   digi: 2, na: true  },
  { nm: 'IARU HF Championship', m: 6,  wk: 2,  h: 12, len: 24, cw: 2.5, digi: 1, na: false },
  { nm: 'World Wide Digi DX',   m: 7,  wk: -1, h: 12, len: 24, cw: 1,   digi: 2, na: false },
  { nm: 'CQ WW RTTY',           m: 8,  wk: -1, h: 0,  len: 48, cw: 1,   digi: 2, na: false },
  { nm: 'ARRL Sweepstakes CW',  m: 10, wk: 1,  h: 21, len: 30, cw: 2.5, digi: 1, na: true  },
  { nm: 'CQ WW CW',             m: 10, wk: -1, h: 0,  len: 48, cw: 4,   digi: 1, na: false },
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
    const start = Date.UTC(y, c.m, sat) + c.h * 3600000;
    if (t < start || t >= start + c.len * 3600000) continue;
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
  // The direction- and mode-weighted spots-per-hour rate. Heard volume
  // (rx) outranks sent volume (tx): the local monitors are a fixed,
  // always-on instrument while local transmitters come and go on whim,
  // so tx silence says little. The coverage-weighted counts from
  // liveStats (already extrapolated per source) are preferred; raw
  // counts stand in when a caller supplies only those. Each bucket is
  // divided by its expected operator activity, making the result a
  // peak-equivalent rate.
  const a = act || { digi: 1, cw: 1, rxDigi: 1, rxCw: 1 };
  const TX_WEIGHT = 0.6;
  const rxN = (st.wdRx ?? st.dRx) / a.rxDigi + (st.wcRx ?? st.cRx) / a.rxCw;
  const txN = (st.wdTx ?? st.dTx) / a.digi + (st.wcTx ?? st.cTx) / a.cw;
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

function baselineExpected(data, grids, bandName, scale = 40) {
  // Expected peak-equivalent spots/hour for this 9-square neighborhood
  // plus the scoring denominator, or null when the baseline has nothing
  // useful to say about the area. scale is the universal reference the
  // population ratio multiplies: 40 for the bands, TROPO_REF for the
  // 6m annulus.
  const b = data && data.bands && data.bands[bandName];
  if (!b || !b.ref || !b.squares) return null;
  let sum = 0, hits = 0;
  for (const g of grids) {
    const v = b.squares[g];
    if (v != null) { sum += v; hits++; }
  }
  if (!hits || sum <= 0) return null;
  // Clamped so a degenerate baseline can never pin a band open or shut.
  return { expected: sum, ref: scale * Math.min(6, Math.max(0.2, sum / b.ref)) };
}

function silenceConvicts(n, expWin) {
  // The damning-silence gate, shared by the bands and the tropo line:
  // with expWin raw spots promised over the watched window, is seeing
  // only n of them a sub-1% Poisson accident? expWin == null means
  // nothing was promised, and nothing convicts.
  if (expWin == null) return false;
  let p = Math.exp(-expWin), term = p;
  for (let k = 1; k <= n; k++) { term *= expWin / k; p += term; }
  return p < 0.01;
}

function liveScore(band, st, act = null, ref = null, expWin = null) {
  // Needs a few spots before we trust it, then activity plus reach, normalized
  // per band. 1500 km on 160m is a great night; on 15m it is nothing.
  // Counts arrive coverage-weighted from liveStats (a partial window is
  // extrapolated to a per-hour rate there, per source) and are normalized
  // per mode and per direction by expected operator activity before they
  // are scored: 6 spots at 04 local outrank 20 at 20 local, and a pile
  // of CW spots during CQ WW CW is business as usual, not an opening.
  // Reach is left alone otherwise; distance is propagation's doing, not
  // the operators'. It is judged by the second-longest spot so a single
  // mangled locator in the feed cannot hold a band open all window long.
  // The denominator is the population-scaled reference when the baseline
  // knows the area, else the universal 40: 40 normalized spots/hour at
  // evening peak reads the same as 10 spots did over the old 15 minute
  // window.
  const nEff = normalizedRate(st, act);
  const activity = 1 - Math.exp(-nEff / (ref || 40));
  const reach = Math.min(1, (st.max2 ?? st.max) / (REF_DIST[band.nm] || 5000));
  const score = 100 * (0.45 * activity + 0.55 * reach);
  if (st.n >= 3) return score;
  // Under three spots the score is normally withheld, but well-watched
  // silence where the baseline promised traffic is evidence in its own
  // right, not the absence of it. expWin is the raw spot count expected
  // over the watched part of the window (the caller owns that unit
  // conversion); when the silence gate finds the trickle inexplicable,
  // it is allowed to testify — and only toward closure.
  if (!silenceConvicts(st.n, expWin)) return null;
  // Even then the conviction must survive the most generous reading of
  // the crumbs: reach judged on the longest spot, since the usual
  // second-longest guard has nothing to stand on under three. A lone
  // long-haul decode is counter-evidence, and the band stays sparse on
  // it rather than closing on a verdict the spot itself contradicts.
  const generous = 100 * (0.45 * activity +
    0.55 * Math.min(1, st.max / (REF_DIST[band.nm] || 5000)));
  return verdict(Math.round(generous))[0] === 'CLOSED' ? score : null;
}
