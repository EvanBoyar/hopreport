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

test('scoreBand stays within 0..100 and gates multiply', () => {
  const ctx = { muf: 20, kp: 2, sunEl: 30, lat: 40.5, lon: -74, flareMult: 1 };
  for (const b of api.BANDS) {
    const s = api.scoreBand(b, ctx);
    assert.ok(s.score >= 0 && s.score <= 100, `${b.nm}: ${s.score}`);
  }
});
