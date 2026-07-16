'use strict';
// The Hop Report — rendering, refresh, and wiring
// Plain script (not a module) so the page keeps working from file://.

/* ---------- render ---------- */

const $ = id => document.getElementById(id);

const hhmmUTC = d =>
  String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0');

function ledeHTML(rows, ctx) {
  // The report's own headline, written from the same scores the log
  // shows: what is open (contiguous bands collapsed to a range), how far
  // the spots reach, and when the closed half of the spectrum comes
  // back. Empty when nothing has a verdict yet.
  const scored = rows.filter(r => r.score != null);
  if (!scored.length) return '';
  const open = scored.filter(r => r.score >= 75);
  const good = scored.filter(r => r.score >= 50 && r.score < 75);
  let s;
  if (open.length) {
    const reach = Math.max(...open.map(r => r.maxKm || 0));
    s = `<b>${bandRangeList(open.map(r => r.nm))}</b> ${open.length > 1 ? 'are' : 'is'} open` +
      (reach > 0 ? `, with spots heard to <b>${Math.round(reach).toLocaleString()} km</b>` : '') + '.';
  } else if (good.length) {
    s = `Nothing is wide open; <b>${bandRangeList(good.map(r => r.nm))}</b> ` +
      `${good.length > 1 ? 'are' : 'is'} worth a call.`;
  } else {
    s = 'Every band scores low right now.';
  }
  const lows = scored.filter(r => BAND_BY_NAME[r.nm].f < 11);
  const highs = scored.filter(r => BAND_BY_NAME[r.nm].f >= 14);
  if (ctx.sunEl > 0 && ctx.sunSet && lows.length && lows.every(r => r.score < 30))
    s += ` The low bands return near sunset (${hhmmUTC(ctx.sunSet)} UTC).`;
  else if (ctx.sunEl <= 0 && ctx.sunRise && highs.length && highs.every(r => r.score < 30))
    s += ` The high bands return after sunrise (${hhmmUTC(ctx.sunRise)} UTC).`;
  return s;
}

function fieldTile(k, v, unit, srcClass, srcText) {
  return `<div class="field"><div class="lbl">${k}</div>
    <div class="val">${v}${unit ? ` <span class="unit">${unit}</span>` : ''}</div>
    <div class="src ${srcClass}">${srcText}</div></div>`;
}

let baselineData = null;
async function loadBaseline() {
  try { baselineData = await getJSON(BASELINE_URL); }
  catch (e) { /* absent or unreachable: scores fall back to the constant */ }
  if (lastCtx) renderBands(lastCtx);
}

function renderBands(ctx) {
  pruneSpots();
  const inc = id => { const el = $(id); return !!(el && el.checked); };
  const useDigi = inc('incDigi'), useCw = inc('incCw'), useModel = inc('incModel');
  const lat = Number.isFinite(ctx.lat) ? ctx.lat : 0;
  const lon = Number.isFinite(ctx.lon) ? ctx.lon : 0;
  const act = activityFactor(new Date(), lat, lon);
  // The population baseline speaks the default view's language (all
  // sources, both directions), so a filtered view falls back to the
  // universal constant rather than compare unlike quantities.
  const grids = (useDigi && useCw && baselineData) ? neighborGrids({ lat, lon }) : null;
  // How much of the 30 minute window has actually filled: the feed has
  // no history, so counts are extrapolated to a rate by liveScore, and
  // the live share of the blend ramps up with coverage (full weight from
  // 15 minutes on) so thin extrapolations do not get a full vote.
  const fill = windowFill();
  const liveW = 0.6 * Math.min(1, fill / 0.5);
  const summary = [];
  $('bands').innerHTML = BANDS.map(b => {
    const s = scoreBand(b, ctx);
    const st = liveStats(b.nm, useDigi, useCw, fill);
    const bl = grids ? baselineExpected(baselineData, grids, b.nm) : null;
    const lv = (useDigi || useCw) ? liveScore(b, st, act, bl ? bl.ref : null) : null;
    // With the model excluded, a band scores on live spots alone and shows
    // no verdict until it has enough of them.
    const score = useModel
      ? (lv == null ? s.score : Math.round(liveW * lv + (1 - liveW) * s.score))
      : (lv == null ? null : Math.round(lv));
    const [word, cls] = score == null ? [st.n ? 'sparse' : 'quiet', 's-none'] : verdict(score);
    summary.push({ nm: b.nm, score, maxKm: st.max });
    let facts = (b.es && ctx.muf < 40 && !st.n)
      ? `Es dependent. Watch the band, not this number.`
      : `MUF ratio <b>${(b.f / ctx.muf).toFixed(2)}</b> / ` +
        `abs <b>${s.a.toFixed(2)}</b> / geo <b>${s.g.toFixed(2)}</b>`;
    if (st.n) {
      const plural = st.n > 1 ? 's' : '';
      const modeBit = !useDigi
        ? `<b>${st.n}</b> CW spot${plural}`
        : `<b>${st.n}</b> spot${plural}${useCw && st.cw ? ` (${st.cw} CW)` : ''}`;
      const rxN = st.dRx + st.cRx, txN = st.dTx + st.cTx;
      const dirBit = `<span title="heard in your area / your area heard elsewhere">↓${rxN} ↑${txN}</span>`;
      let devBit = '';
      if (bl) {
        // liveStats already scaled the counts to a per-hour rate.
        const dev = normalizedRate(st, act) / bl.expected;
        devBit = ` (<b>${dev >= 10 ? Math.round(dev) : dev.toFixed(1)}×</b> usual)`;
      }
      const tail = lv != null ? (useModel ? 'blended live' : 'live only')
                              : (useModel ? 'model only' : 'needs 3 spots');
      facts += ` / ${modeBit} ${dirBit}${devBit}, max <b>${Math.round(st.max).toLocaleString()}</b> km, ${tail}`;
    }
    // 6m only: the tropo tally rides along for orientation, never scored.
    if (st.tN) {
      facts += ` / tropo <b>${st.tN}</b> spot${st.tN > 1 ? 's' : ''}, ` +
        `max <b>${Math.round(st.tMax).toLocaleString()}</b> km`;
    }
    return `<div class="band">
      <div class="id"><span class="nm">${b.nm}</span><span class="fq">${b.f.toFixed(2)} MHz</span></div>
      <div>
        <div class="track" role="img" aria-label="${b.nm} ${score == null ? 'awaiting live spots' : `score ${score} of 100`}">
          <div class="fill" style="width: ${score == null ? 0 : score}%"></div>
        </div>
        <div class="facts">${facts}</div>
      </div>
      <div class="stampcell"><span class="stamp ${cls}">${word}</span><span class="pct">${score == null ? `${st.n} of 3 spots` : `${score} / 100`}</span></div>
    </div>`;
  }).join('');
  const lede = $('lede');
  lede.innerHTML = ledeHTML(summary, ctx);
  lede.hidden = !lede.innerHTML;
  updateHeardNote();
  saveSpots();
}

async function refresh() {
  const pos = parseGrid($('grid').value);
  const msg = $('msg');
  msg.classList.remove('show');
  if (!pos) {
    msg.textContent = $('grid').value.trim()
      ? 'That does not parse as a Maidenhead locator. Try FN30 or FN30as.'
      : 'No location yet. Enter your Maidenhead grid above, or allow the location prompt and the report fills in on its own.';
    msg.classList.add('show');
    $('clockline').hidden = true;
    return;
  }

  const now = new Date();
  const sunEl = sunElevation(pos.lat, pos.lon, now);
  try { history.replaceState(null, '', '#' + $('grid').value.trim().toUpperCase()); } catch (e) {}
  // Remember the working grid: most stations do not move between visits,
  // and desktop browsers often cannot produce a geolocation fix at all.
  try { localStorage.setItem('hopGrid', $('grid').value.trim().toUpperCase()); } catch (e) {}
  const contest = activeContest(now, pos.lat, pos.lon);
  const sun = nextSunCrossings(pos.lat, pos.lon, now);
  // The dateline carries flags only and hides itself when there is
  // nothing to flag. Greyline: the sun within 6 degrees of the horizon,
  // either side, since the terminator is when the low bands do their
  // best work. A contest weekend gets named because it explains a
  // flooded feed.
  const flags = [];
  if (Math.abs(sunEl) <= 6) flags.push('<span class="grey">greyline</span>');
  if (contest) flags.push(`${contest.nm} weekend`);
  const clock = $('clockline');
  clock.innerHTML = flags.join(' / ');
  clock.hidden = !flags.length;

  // Position and sun are known before any fetch answers; they trail the
  // row (least important) but render from the first paint.
  const posTile = fieldTile('Position',
    `${Math.abs(pos.lat).toFixed(1)}\u00b0${pos.lat >= 0 ? 'N' : 'S'} ` +
    `${Math.abs(pos.lon).toFixed(1)}\u00b0${pos.lon >= 0 ? 'E' : 'W'}`,
    '', 'ok', 'from your grid');
  const sunTile = fieldTile('Sun',
    `${sunEl >= 0 ? '+' : ''}${sunEl.toFixed(0)}\u00b0`, '', 'est',
    sunEl > 0
      ? (sun.set ? `daylight, sets ${hhmmUTC(sun.set)} UTC` : 'daylight around the clock')
      : (sun.rise ? `night, rises ${hhmmUTC(sun.rise)} UTC` : 'night around the clock'));

  $('status').innerHTML =
    fieldTile('Status', '&hellip;', '', 'est', 'fetching space weather') +
    posTile + sunTile;
  $('bands').innerHTML = '';

  const [sfiR, kpR, xrR, ionR, prR] = await Promise.allSettled([
    fetchSFI(), fetchKp(), fetchXray(), fetchIonosonde(pos), fetchProtons()
  ]);

  // Treat "fulfilled but not a finite number" the same as a failed fetch,
  // so one malformed field can never spoil the whole model.
  const sfiOk = sfiR.status === 'fulfilled' && Number.isFinite(sfiR.value);
  const kpOk  = kpR.status  === 'fulfilled' && Number.isFinite(kpR.value);
  const xrOk  = xrR.status  === 'fulfilled' && Number.isFinite(xrR.value?.flux) && xrR.value.flux > 0;
  const ionOk = ionR.status === 'fulfilled' && Number.isFinite(ionR.value?.muf)
             && Number.isFinite(ionR.value?.fof2);

  const sfi = sfiOk ? sfiR.value : 120;
  const kp  = kpOk  ? kpR.value  : 2;
  const xr  = xrOk  ? xrR.value  : { cls: '?', flux: 1e-7 };
  const ion = ionOk ? ionR.value : null;
  // Quiet is assumed when the proton feed is unreachable: the polar
  // term simply drops out, exactly like the pre-proton model.
  const protons = prR.status === 'fulfilled' && Number.isFinite(prR.value?.day)
    ? prR.value : null;

  let muf = ion ? localizeSondeMUF(ion.muf, sfi, kp, now, pos, ion)
                : estimateMUF(sfi, sunEl, kp, pos.lat, now);
  if (!Number.isFinite(muf) || muf <= 0) muf = estimateMUF(120, sunEl, 2, pos.lat, now);
  const luf = estimateLUF(sunEl, xr.flux, protons
    ? { gmLat: geomagLat(pos.lat, pos.lon), kp, protons } : null);

  const tiles = [
    fieldTile('SFI', sfi, 'sfu',
      sfiOk ? 'ok' : 'bad',
      sfiOk ? 'NOAA SWPC' : 'unavailable, assumed 120'),
    fieldTile('Kp', kp.toFixed(1), '',
      kpOk ? 'ok' : 'bad',
      kpOk ? 'NOAA SWPC' : 'unavailable, assumed 2'),
    fieldTile('X-ray', xr.cls, '',
      xrOk ? 'ok' : 'bad',
      xrOk ? 'GOES long band' : 'unavailable, quiet assumed'),
    fieldTile('MUF(3000)', muf.toFixed(1), 'MHz',
      ion ? 'ok' : 'est',
      ion ? `${ion.name}, ${ion.km} km, ${ion.ageMin} min old` +
            (Math.abs(muf / ion.muf - 1) > 0.02 ? ', scaled to your sun' : '')
          : 'estimated from SFI, season, and sun'),
    fieldTile('LUF', luf < 1.8 ? 'below 160m' : luf.toFixed(1),
      luf < 1.8 ? '' : 'MHz',
      'est', 'from sun, X-ray, and proton flux'),
  ];
  if (ion) tiles.push(fieldTile('foF2', ion.fof2.toFixed(1), 'MHz', 'ok', 'NVIS critical freq'));
  tiles.push(posTile, sunTile);
  $('status').innerHTML = tiles.join('');

  if (luf >= muf) {
    msg.textContent =
      `Estimated LUF (${luf.toFixed(1)} MHz) is at or above the MUF (${muf.toFixed(1)} MHz). That is a shortwave fadeout: expect sunlit HF paths to be closed on all bands until the flare subsides.`;
    msg.classList.add('show');
  }

  if (!sfiOk && !kpOk && !xrOk && !ionOk) {
    msg.textContent = 'No data source could be reached. If this is a sandboxed preview, open the page in a normal browser window.';
    msg.classList.add('show');
  }

  lastCtx = { muf, kp, sunEl, lat: pos.lat, lon: pos.lon, xrayFlux: xr.flux,
              protons, sunRise: sun.rise, sunSet: sun.set };
  renderBands(lastCtx);
  connectLive(pos);
}

$('go').addEventListener('click', refresh);
$('grid').addEventListener('keydown', e => { if (e.key === 'Enter') refresh(); });
$('qsl').addEventListener('click', queryMySpots);
$('mycall').addEventListener('keydown', e => { if (e.key === 'Enter') queryMySpots(); });
for (const id of ['incDigi', 'incCw', 'incModel'])
  $(id).addEventListener('change', () => { if (lastCtx) renderBands(lastCtx); });

function applyTheme(dark) {
  // The orb shows the current sky: sun by day at the left of the pill,
  // moon by night at the right; CSS slides it and swaps the icon.
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').setAttribute('aria-checked', String(dark));
  // The browser bars (status, address, bottom) take the paper color of
  // the active theme. Writing the same value into both theme-color
  // metas sidesteps their prefers-color-scheme media queries, which
  // know the OS setting but not this switch.
  const paper = dark ? '#15293f' : '#fcfbf6';
  for (const m of document.querySelectorAll('meta[name="theme-color"]'))
    m.setAttribute('content', paper);
}
let darkMode = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
applyTheme(darkMode);
$('theme').addEventListener('click', () => { darkMode = !darkMode; applyTheme(darkMode); });

// Locator priority: a grid in the URL wins, so a bookmark or shared link
// opens on the right square. Next comes the grid this browser last used,
// since stations rarely move between visits and desktop browsers often
// have no position backend (Firefox on Linux fails even with permission
// granted). Only a first visit on a bare URL asks the browser where we
// are, and a failed fix says so instead of leaving the "no location yet"
// prompt unexplained. There is no default square.
const urlGrid = (new URLSearchParams(location.search).get('grid') ||
                 location.hash.replace(/^#/, '')).trim();
let storedGrid = '';
try { storedGrid = (localStorage.getItem('hopGrid') || '').trim(); } catch (e) {}
if (parseGrid(urlGrid)) {
  $('grid').value = urlGrid.toUpperCase();
} else if (parseGrid(storedGrid)) {
  $('grid').value = storedGrid.toUpperCase();
} else if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(p => {
    if ($('grid').value.trim()) return;   // a typed grid wins over the fix
    $('grid').value = latLonToGrid(p.coords.latitude, p.coords.longitude, 6);
    refresh();
  }, err => {
    if ($('grid').value.trim()) return;
    const msg = $('msg');
    msg.textContent = (err && err.code === 1
      ? 'The location request was denied.'
      : 'The browser could not produce a position fix, which is common on desktops without location services.') +
      ' Enter your Maidenhead grid above (FN30 and FN30as both work); it is remembered for next time.';
    msg.classList.add('show');
  },
  { maximumAge: 10 * 60 * 1000, timeout: 10000 });
}

// The callsign is remembered like the grid, and the reception-report
// query runs by itself on the same cadence PSK Reporter allows: once
// after the first report and every five minutes after, skipping quietly
// whenever the field is blank or the limit has not lapsed. Typing a new
// callsign queries right away rather than waiting out the interval.
let storedCall = '';
try { storedCall = (localStorage.getItem('hopCall') || '').trim(); } catch (e) {}
if (storedCall && !$('mycall').value.trim()) $('mycall').value = storedCall;
setCall($('mycall').value);
$('mycall').addEventListener('change', () => {
  const call = $('mycall').value.trim().toUpperCase();
  try { localStorage.setItem('hopCall', call); } catch (e) {}
  setCall(call);
  if (call) queryMySpots(true);
});
setInterval(() => queryMySpots(true), 5 * 60 * 1000);

// Phones rarely fire unload events; the hidden state is the reliable
// last chance to persist the window before the tab is culled.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSpots();
});

refresh().then(() => queryMySpots(true));
loadBaseline();
setInterval(refresh, 10 * 60 * 1000);                              // space weather
setInterval(() => { if (lastCtx) renderBands(lastCtx); }, 30000);  // live spots
setInterval(loadBaseline, 6 * 60 * 60 * 1000);                     // population baseline
