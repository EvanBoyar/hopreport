'use strict';
// The Hop Report — rendering, refresh, and wiring
// Plain script (not a module) so the page keeps working from file://.

/* ---------- render ---------- */

const $ = id => document.getElementById(id);

function fieldTile(k, v, unit, srcClass, srcText) {
  return `<div class="field"><div class="lbl">${k}</div>
    <div class="val">${v}${unit ? ` <span class="unit">${unit}</span>` : ''}</div>
    <div class="src ${srcClass}">${srcText}</div></div>`;
}

function renderBands(ctx) {
  pruneSpots();
  const inc = id => { const el = $(id); return !!(el && el.checked); };
  const useDigi = inc('incDigi'), useCw = inc('incCw'), useModel = inc('incModel');
  const act = activityFactor(new Date(),
    Number.isFinite(ctx.lat) ? ctx.lat : 0, Number.isFinite(ctx.lon) ? ctx.lon : 0);
  $('bands').innerHTML = BANDS.map(b => {
    const s = scoreBand(b, ctx);
    const st = liveStats(b.nm, useDigi, useCw);
    const lv = (useDigi || useCw) ? liveScore(b, st, act) : null;
    // With the model excluded, a band scores on live spots alone and shows
    // no verdict until it has enough of them.
    const score = useModel
      ? (lv == null ? s.score : Math.round(0.6 * lv + 0.4 * s.score))
      : (lv == null ? null : Math.round(lv));
    const [word, cls] = score == null ? [st.n ? 'sparse' : 'quiet', 's-none'] : verdict(score);
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
      const tail = lv != null ? (useModel ? 'blended live' : 'live only')
                              : (useModel ? 'model only' : 'needs 3 spots');
      facts += ` / ${modeBit} ${dirBit}, max <b>${Math.round(st.max).toLocaleString()}</b> km, ${tail}`;
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
    $('clockline').textContent = 'awaiting a location';
    return;
  }

  const now = new Date();
  const sunEl = sunElevation(pos.lat, pos.lon, now);
  try { history.replaceState(null, '', '#' + $('grid').value.trim().toUpperCase()); } catch (e) {}
  const contest = activeContest(now, pos.lat, pos.lon);
  $('clockline').textContent =
    `${now.toUTCString().slice(5, 22)} UTC / ${pos.lat.toFixed(1)}\u00b0, ${pos.lon.toFixed(1)}\u00b0 / sun ${sunEl >= 0 ? '+' : ''}${sunEl.toFixed(0)}\u00b0 (${sunEl > 0 ? 'day' : 'night'})` +
    (contest ? ` / ${contest.nm} weekend` : '');

  $('status').innerHTML = fieldTile('Status', '&hellip;', '', 'est', 'fetching space weather');
  $('bands').innerHTML = '';

  const [sfiR, kpR, xrR, ionR] = await Promise.allSettled([
    fetchSFI(), fetchKp(), fetchXray(), fetchIonosonde(pos)
  ]);

  // Treat "fulfilled but not a finite number" the same as a failed fetch,
  // so one malformed field can never spoil the whole model.
  const sfiOk = sfiR.status === 'fulfilled' && Number.isFinite(sfiR.value);
  const kpOk  = kpR.status  === 'fulfilled' && Number.isFinite(kpR.value);
  const xrOk  = xrR.status  === 'fulfilled' && Number.isFinite(xrR.value?.mult);
  const ionOk = ionR.status === 'fulfilled' && Number.isFinite(ionR.value?.muf)
             && Number.isFinite(ionR.value?.fof2);

  const sfi = sfiOk ? sfiR.value : 120;
  const kp  = kpOk  ? kpR.value  : 2;
  const xr  = xrOk  ? xrR.value  : { cls: '?', mult: 1 };
  const ion = ionOk ? ionR.value : null;

  let muf = ion ? ion.muf : estimateMUF(sfi, sunEl, kp);
  if (!Number.isFinite(muf) || muf <= 0) muf = estimateMUF(120, sunEl, 2);
  const luf = estimateLUF(sunEl, xr.mult);

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
      ion ? `${ion.name}, ${ion.km} km, ${ion.ageMin} min old`
          : 'estimated from SFI and sun'),
    fieldTile('LUF', luf < 1.8 ? 'below 160m' : luf.toFixed(1),
      luf < 1.8 ? '' : 'MHz',
      'est', 'from sun and X-ray flux'),
  ];
  if (ion) tiles.push(fieldTile('foF2', ion.fof2.toFixed(1), 'MHz', 'ok', 'NVIS critical freq'));
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

  lastCtx = { muf, kp, sunEl, lat: pos.lat, lon: pos.lon, flareMult: xr.mult };
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
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').textContent = dark ? 'Day mode' : 'Night mode';
}
let darkMode = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
applyTheme(darkMode);
$('theme').addEventListener('click', () => { darkMode = !darkMode; applyTheme(darkMode); });

// Locator priority: a grid in the URL wins, so a bookmark or shared link
// opens on the right square. On a bare URL we ask the browser where we are
// and fill the empty field once a fix arrives. There is no default square:
// if geolocation is denied, unavailable, or off-https, the report waits
// until a grid is typed.
const urlGrid = (new URLSearchParams(location.search).get('grid') ||
                 location.hash.replace(/^#/, '')).trim();
if (parseGrid(urlGrid)) {
  $('grid').value = urlGrid.toUpperCase();
} else if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(p => {
    if ($('grid').value.trim()) return;   // a typed grid wins over the fix
    $('grid').value = latLonToGrid(p.coords.latitude, p.coords.longitude, 6);
    refresh();
  }, () => { /* denied or unavailable: the "no location yet" prompt stands */ },
  { maximumAge: 10 * 60 * 1000, timeout: 10000 });
}

refresh();
setInterval(refresh, 10 * 60 * 1000);                              // space weather
setInterval(() => { if (lastCtx) renderBands(lastCtx); }, 30000);  // live spots
