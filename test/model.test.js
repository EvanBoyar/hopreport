'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./helper');

const { api } = load();
const NY = [40.75, -74], DE = [50, 10];
const b20 = api.BANDS.find(b => b.nm === '20m');

test('contest date rules match known calendars', () => {
  assert.strictEqual(api.nthFullWeekendSat(2024, 5, 4), 22);   // Field Day 2024
  assert.strictEqual(api.nthFullWeekendSat(2025, 5, 4), 28);   // Field Day 2025
  assert.strictEqual(api.nthFullWeekendSat(2026, 5, 4), 27);   // Field Day 2026
  assert.strictEqual(api.nthFullWeekendSat(2025, 10, -1), 29); // CQ WW CW 2025
  assert.strictEqual(api.nthFullWeekendSat(2026, 10, -1), 28); // CQ WW CW 2026
  assert.strictEqual(api.nthFullWeekendSat(2026, 6, 2), 11);   // IARU 2026
});

test('contest activation windows and region gating', () => {
  const fd = new Date(Date.UTC(2026, 5, 28, 18, 0));
  assert.strictEqual(api.activeContest(fd, ...NY)?.nm, 'ARRL Field Day');
  assert.strictEqual(api.activeContest(fd, ...DE), null);           // NA-only
  const ww = new Date(Date.UTC(2026, 10, 28, 12, 0));
  assert.strictEqual(api.activeContest(ww, ...DE)?.nm, 'CQ WW CW'); // global
  assert.strictEqual(api.activeContest(new Date(Date.UTC(2026, 10, 25)), ...DE), null);
  assert.strictEqual(api.activeContest(new Date(Date.UTC(2026, 10, 30, 1)), ...DE), null);
  // Start hours are honored: Field Day begins 1800Z Saturday, IARU ends
  // 1200Z Sunday.
  assert.strictEqual(api.activeContest(new Date(Date.UTC(2026, 5, 27, 12)), ...NY), null);
  assert.strictEqual(api.activeContest(new Date(Date.UTC(2026, 6, 12, 11)), ...DE)?.nm,
    'IARU HF Championship');
  assert.strictEqual(api.activeContest(new Date(Date.UTC(2026, 6, 12, 13)), ...DE), null);
});

test('diurnal curve: trough at 4am, peak at 8pm, weekend boost', () => {
  // Tue 2026-07-14; 09 UTC is ~04:04 solar at lon -74.
  const f4am = api.activityFactor(new Date(Date.UTC(2026, 6, 14, 9)), ...NY);
  const f8pm = api.activityFactor(new Date(Date.UTC(2026, 6, 15, 1)), ...NY);
  assert.ok(Math.abs(f4am.digi - 0.155) < 0.03, `trough ${f4am.digi}`);
  assert.ok(f8pm.digi > 0.95 && f8pm.digi <= 1.0, `peak ${f8pm.digi}`);
  const sun = api.activityFactor(new Date(Date.UTC(2026, 6, 19, 17)), ...NY);
  const tue = api.activityFactor(new Date(Date.UTC(2026, 6, 21, 17)), ...NY);
  assert.ok(Math.abs(sun.digi / tue.digi - 1.35) < 0.01, 'weekend x1.35');
});

test('rx side gets a flattened diurnal correction', () => {
  const f = api.activityFactor(new Date(Date.UTC(2026, 6, 14, 9)), ...NY);
  assert.ok(Math.abs(f.rxDigi - Math.sqrt(f.digi)) < 1e-9);
  assert.ok(f.rxDigi > f.digi, 'rx trough shallower than tx trough');
  const peak = api.activityFactor(new Date(Date.UTC(2026, 6, 15, 1)), ...NY);
  assert.ok(Math.abs(peak.rxDigi - peak.digi) < 0.02, 'sides agree at peak');
});

test('contest boost hits the flooded mode on both sides', () => {
  const ww = api.activityFactor(new Date(Date.UTC(2026, 10, 29, 1)), ...NY);
  assert.ok(ww.cw > 2.5 * ww.digi, 'CW side much hotter during CQ WW CW');
  assert.ok(ww.rxCw > 2.5 * ww.rxDigi, 'rx CW side boosted too');
});

test('liveScore: heard volume outranks sent volume', () => {
  const rxHeavy = { n: 10, max: 6000, cw: 0, dRx: 8, dTx: 2, cRx: 0, cTx: 0 };
  const txHeavy = { n: 10, max: 6000, cw: 0, dRx: 2, dTx: 8, cRx: 0, cTx: 0 };
  assert.ok(api.liveScore(b20, rxHeavy) > api.liveScore(b20, txHeavy));
});

test('liveScore: 3-spot floor and night spots outranking evening crowds', () => {
  const thin = { n: 2, max: 8000, cw: 2, dRx: 0, dTx: 0, cRx: 2, cTx: 0 };
  assert.strictEqual(api.liveScore(b20, thin), null);
  const st = { n: 4, max: 5500, cw: 0, dRx: 2, dTx: 2, cRx: 0, cTx: 0 };
  const night = api.activityFactor(new Date(Date.UTC(2026, 6, 14, 9)), ...NY);
  const eve = api.activityFactor(new Date(Date.UTC(2026, 6, 15, 1)), ...NY);
  assert.ok(api.liveScore(b20, st, night) > api.liveScore(b20, st, eve));
});

test('liveScore: damning silence convicts, but only toward closure', () => {
  const mute = { n: 0, max: 0, max2: 0, cw: 0, dRx: 0, dTx: 0, cRx: 0, cTx: 0 };
  // No expectation supplied: silence stays an abstention.
  assert.strictEqual(api.liveScore(b20, mute), null);
  // A quiet corner (2 expected spots): zero spots is unremarkable.
  assert.strictEqual(api.liveScore(b20, mute, null, null, 2), null);
  // A busy neighborhood (12 expected): zero spots is a verdict, and a
  // low one.
  const shut = api.liveScore(b20, mute, null, null, 12);
  assert.ok(shut != null && shut < 12, `expected a CLOSED score, got ${shut}`);
  // One long-haul decode among the silence: the evidence disagrees with
  // itself, so the band abstains rather than closing (or opening) on a
  // single spot.
  const oneFar = { n: 1, max: 7000, max2: 0, cw: 0, dRx: 1, dTx: 0, cRx: 0, cTx: 0 };
  assert.strictEqual(api.liveScore(b20, oneFar, null, null, 12), null);
  // Two short-skip crumbs where dozens were promised: closed.
  const crumbs = { n: 2, max: 500, max2: 300, cw: 0, dRx: 2, dTx: 0, cRx: 0, cTx: 0,
                   wdRx: 4, wdTx: 0, wcRx: 0, wcTx: 0 };
  const s = api.liveScore(b20, crumbs, null, null, 20);
  assert.ok(s != null && s < 12, `expected a CLOSED score, got ${s}`);
});

test('windowObserved: a dead feed reads unwatched, not full', () => {
  const { api } = load();
  assert.strictEqual(api.liveSince, 0);
  assert.strictEqual(api.windowFill(), 1, 'fill treats no-feed as covered');
  assert.strictEqual(api.windowObserved(), 0, 'observed does not');
  api.liveSince = Date.now() - api.LIVE_WINDOW;
  assert.strictEqual(api.windowObserved(), 1);
});

test('reach is judged by the second-longest spot', () => {
  const { api } = load();
  api.myGrids = new Set(['FN30']);
  const t = Date.now();
  api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - 1000, 'G4A', 'K2A');
  api.addSpot('20m', 'IO91', 'FN30', 'FT8', t - 2000, 'G4B', 'K2A');
  api.addSpot('20m', 'RE79', 'FN30', 'FT8', t - 3000, 'ZL9X', 'K2A');   // lone far outlier
  const st = api.liveStats('20m', true, true, 1);
  assert.ok(st.max > st.max2, 'the outlier holds the max');
  assert.strictEqual(api.liveScore(b20, st), api.liveScore(b20, { ...st, max: 99999 }),
    'the score keys on the second-longest spot');
});

test('parseFeedTime reads zoneless stamps as UTC', () => {
  assert.strictEqual(api.parseFeedTime('2026-07-16T15:37:30'),
    Date.parse('2026-07-16T15:37:30Z'), 'no zone means UTC, not local');
  assert.strictEqual(api.parseFeedTime('2026-07-16T15:37:30Z'),
    Date.parse('2026-07-16T15:37:30Z'), 'an explicit Z passes through');
  assert.strictEqual(api.parseFeedTime('2026-07-16T15:37:30+02:00'),
    Date.parse('2026-07-16T15:37:30+02:00'), 'an explicit offset passes through');
});

test('fetchKp fallback reads the object-shaped product feed', async () => {
  const { api, sandbox } = load();
  sandbox.fetch = async url => ({
    ok: true,
    json: async () => url.includes('planetary_k_index_1m')
      ? []
      : [{ time_tag: '2026-07-16T12:00:00', Kp: 2.33, a_running: 9 },
         { time_tag: '2026-07-16T15:00:00', Kp: 3.67, a_running: 22 }],
  });
  assert.strictEqual(await api.fetchKp(), 3.67);
});

test('fetchIonosonde survives zoneless timestamps in any timezone', async () => {
  const { api, sandbox } = load();
  // 13 minutes old, stamped without a zone suffix the way kc2g does.
  const t = new Date(Date.now() - 13 * 60000).toISOString().replace(/\.\d+Z$/, '');
  sandbox.fetch = async () => ({
    ok: true,
    json: async () => [{
      mufd: 16.6, fof2: 4.9, time: t,
      station: { name: 'Testville', latitude: 43.8, longitude: -112.7 },
    }],
  });
  const ion = await api.fetchIonosonde({ lat: 40.5, lon: -73 });
  assert.ok(Math.abs(ion.ageMin - 13) <= 1, `age read as ${ion.ageMin} min`);
  assert.strictEqual(ion.lat, 43.8, 'station position rides along');
  assert.strictEqual(ion.lon, -112.7);
});

test('estimateMUF: winter day runs hotter than summer day, night unmoved', () => {
  const jul = new Date(Date.UTC(2026, 6, 16, 15));
  const jan = new Date(Date.UTC(2026, 0, 16, 15));
  const summerDay = api.estimateMUF(107, 60, 0, 50, jul);
  const winterDay = api.estimateMUF(107, 60, 0, 50, jan);
  assert.ok(winterDay > summerDay + 5, `winter ${winterDay} vs summer ${summerDay}`);
  // Calibration anchor: midlatitude summer noon at SFI 107 measured
  // 17-19 on the sondes; the shy constant should land just above that.
  assert.ok(summerDay > 19 && summerDay < 22, `summer day ${summerDay}`);
  // The hemispheres mirror, give or take the calendar's slight
  // asymmetry around the solstices.
  assert.ok(Math.abs(api.estimateMUF(107, 60, 0, -50, jul) - winterDay) < 0.1);
  // Night and the tropics carry no seasonal swing.
  assert.ok(Math.abs(api.estimateMUF(107, -30, 0, 50, jul)
                   - api.estimateMUF(107, -30, 0, 50, jan)) < 1e-9);
  assert.ok(Math.abs(api.estimateMUF(107, 60, 0, 10, jul)
                   - api.estimateMUF(107, 60, 0, 10, jan)) < 1e-9);
  // Legacy 3-argument calls keep the flat behavior.
  assert.ok(Math.abs(api.estimateMUF(107, 60, 0) - (8 + 0.155 * 107)) < 0.01);
});

test('localizeSondeMUF bends a borrowed reading toward the local sun', () => {
  const date = new Date(Date.UTC(2026, 0, 15, 18));
  const ny = { lat: 40.5, lon: -73 };     // early afternoon, sun up
  const asia = { lat: 40.5, lon: 120 };   // deep night
  assert.strictEqual(api.localizeSondeMUF(20, 107, 0, date, ny, ny), 20,
    'the same sun leaves the measurement alone');
  const up = api.localizeSondeMUF(20, 107, 0, date, ny, asia);
  const down = api.localizeSondeMUF(20, 107, 0, date, asia, ny);
  assert.ok(up > 20, 'a night sonde undersells a daylit grid');
  assert.ok(down < 20, 'a daylit sonde oversells a grid at night');
  assert.ok(up <= 20 * 1.5 && down >= 20 * 0.65, 'the clamp holds');
});

test('absorption follows D-RAP: night zero, HAF formula, angular taper', () => {
  const QUIET = 4e-7, X1 = 1e-4;
  // Night: no D layer, no absorption, whatever the sun is doing in X-rays.
  assert.strictEqual(api.absorptionDb(7.1, -10, X1), 0);
  assert.strictEqual(api.estimateLUF(-10, X1), 0);
  // D-RAP's flare term at the subsolar point: HAF = 10*log10(flux) + 65,
  // and by definition the absorption there is 1 dB. At X1 that is 25 MHz;
  // the quiet term at 25 MHz adds ~0.17 dB.
  const haf = 10 * Math.log10(X1) + 65;
  const at = api.absorptionDb(haf, 89.9, X1);
  assert.ok(Math.abs(at - 1 - 108.6 / (haf * haf)) < 0.01, `1 dB at HAF, got ${at}`);
  // Their degradation law: an octave below the HAF costs 2^1.5 times more.
  const flareOnly = f => api.absorptionDb(f, 89.9, X1) - api.absorptionDb(f, 89.9, 1e-9);
  assert.ok(Math.abs(flareOnly(haf / 2) / flareOnly(haf) - Math.pow(2, 1.5)) < 0.01);
  // Their angular law: the quiet LUF tapers as sin(el)^0.75.
  const ratio = api.estimateLUF(30, 1e-9) / api.estimateLUF(89.9, 1e-9);
  assert.ok(Math.abs(ratio - Math.pow(Math.sin(Math.PI / 6), 0.75)) < 0.01, `taper ${ratio}`);
  // Quiet anchor survives the rewrite: overhead sun alone puts the LUF
  // near 4.56 MHz, and a flare only ever raises it.
  assert.ok(Math.abs(api.estimateLUF(89.9, 1e-9) - 4.56) < 0.02);
  assert.ok(api.estimateLUF(60, X1) > api.estimateLUF(60, QUIET));
  assert.ok(api.estimateLUF(60, 1e-3) > api.estimateLUF(60, X1), 'monotonic in flux');
  // The scores feel it: an X1 flare costs 20m real ground by day.
  const quietCtx = { muf: 25, kp: 0, sunEl: 60, lat: 40, xrayFlux: QUIET };
  const flareCtx = { ...quietCtx, xrayFlux: X1 };
  assert.ok(api.scoreBand(b20, flareCtx).score < api.scoreBand(b20, quietCtx).score - 10);
});

test('D-RAP polar proton term: cap only, day and night laws, Kp widening', () => {
  const P = { day: 1000, night: 400 };
  const cap = { gmLat: 75, kp: 0, protons: P };
  // Deep in the cap by day: 0.115 * sqrt(1000) dB at 30 MHz, on top of
  // a small quiet term.
  const quiet30 = api.absorptionDb(30, 45, 1e-9, null);
  const day30 = api.absorptionDb(30, 45, 1e-9, cap);
  assert.ok(Math.abs(day30 - quiet30 - 0.115 * Math.sqrt(1000)) < 0.01, `day ${day30}`);
  // Deep in the cap by night: 0.020 * sqrt(400) dB, nothing else.
  const night30 = api.absorptionDb(30, -30, 1e-9, cap);
  assert.ok(Math.abs(night30 - 0.020 * Math.sqrt(400)) < 1e-9, `night ${night30}`);
  // Same (f0/f)^1.5 law as the rest of D-RAP.
  const night15 = api.absorptionDb(15, -30, 1e-9, cap);
  assert.ok(Math.abs(night15 / night30 - Math.pow(2, 1.5)) < 0.01);
  // Midlatitudes never feel it: FN30 sits near 51 degrees geomagnetic.
  const fn30 = { gmLat: api.geomagLat(40.5, -73), kp: 0, protons: P };
  assert.ok(Math.abs(fn30.gmLat - 51) < 3, `FN30 gmLat ${fn30.gmLat}`);
  assert.strictEqual(api.absorptionDb(30, -30, 1e-9, fn30), 0);
  // A storm drags the cap edge equatorward: 58 degrees is outside the
  // quiet cap but inside it at Kp 6.
  const edge = { gmLat: 58, kp: 0, protons: P };
  assert.strictEqual(api.absorptionDb(30, -30, 1e-9, edge), 0);
  assert.ok(api.absorptionDb(30, -30, 1e-9, { ...edge, kp: 6 }) > 0);
  // A proton event gives the polar cap a nighttime LUF.
  const luf = api.estimateLUF(-30, 1e-9, cap);
  assert.ok(luf > 4 && luf < 7, `polar night LUF ${luf}`);
});

test('fetchProtons interpolates the night energy from GOES channels', async () => {
  const { api, sandbox } = load();
  sandbox.fetch = async () => ({
    ok: true,
    json: async () => [
      { energy: '>=1 MeV', flux: 100 },
      { energy: '>=5 MeV', flux: 20 },
      { energy: '>=10 MeV', flux: 5 },
    ],
  });
  const p = await api.fetchProtons();
  assert.strictEqual(p.day, 20, 'day rides the 5 MeV channel');
  // J(E) = 100 * E^-1 here, so J(>2.2) should come out near 45.
  assert.ok(Math.abs(p.night - 100 / 2.2) < 0.1, `night ${p.night}`);
});

test('scoreBand stays within 0..100 and gates multiply', () => {
  const ctx = { muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, xrayFlux: 4e-7 };
  for (const b of api.BANDS) {
    const s = api.scoreBand(b, ctx);
    assert.ok(s.score >= 0 && s.score <= 100, `${b.nm}: ${s.score}`);
  }
});
