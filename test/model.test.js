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

test('scoreBand stays within 0..100 and gates multiply', () => {
  const ctx = { muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, flareMult: 1 };
  for (const b of api.BANDS) {
    const s = api.scoreBand(b, ctx);
    assert.ok(s.score >= 0 && s.score <= 100, `${b.nm}: ${s.score}`);
  }
});
