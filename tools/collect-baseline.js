'use strict';
// Samples the PSK Reporter MQTT feed one band at a time and writes a tally
// of per-square tx/rx counts: node tools/collect-baseline.js out.json
//
// Politeness: the broker asks clients to subscribe filtered, so instead of
// drinking the firehose this cycles a band-filtered subscription through
// the ten bands for SAMPLE_SECS each (~13 minutes total by default).
//
// The sample is gated on quiet space weather (no M-class flare, Kp under
// 5) and on the big-contest calendar, because flares hit only the sunlit
// hemisphere and contests hit only some modes: spatially or modally
// lopsided events would masquerade as population. A skipped window writes
// {skipped} so the workflow succeeds without folding anything in.
const fs = require('fs');
const lib = require('./lib');
const mqtt = require('mqtt');

const SAMPLE_SECS = +(process.env.SAMPLE_SECS || 75);
const OUT = process.argv[2] || 'sample.json';
const MQTT_URLS = ['mqtt://mqtt.pskreporter.info:1883',
                   'wss://mqtt.pskreporter.info:1886'];

function write(obj) {
  fs.writeFileSync(OUT, JSON.stringify(obj));
  console.log(OUT, JSON.stringify(obj).length, 'bytes');
}

async function spaceWeather() {
  const xr = await fetch('https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json')
    .then(r => r.json());
  const long = xr.filter(e => e.energy === '0.1-0.8nm');
  const flux = +long[long.length - 1].flux;
  const kpj = await fetch('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json')
    .then(r => r.json());
  const last = kpj[kpj.length - 1];
  const kp = +(last.estimated_kp ?? last.kp_index);
  return { flux, kp, quiet: flux < 1e-5 && kp < 5 };
}

function contestNow() {
  const now = new Date();
  // One global probe plus one from mid-North-America for the na-only events.
  return lib.activeContest(now, 0, 0) || lib.activeContest(now, 40, -100);
}

function connect() {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= MQTT_URLS.length) return reject(new Error('no broker reachable'));
      const url = MQTT_URLS[i++];
      const c = mqtt.connect(url, {
        clientId: 'hopreport_baseline_' + Math.random().toString(16).slice(2, 8),
        connectTimeout: 20000, reconnectPeriod: 0,
      });
      c.once('connect', () => { console.log('connected', url); resolve(c); });
      c.once('error', () => { c.end(true); tryNext(); });
    };
    tryNext();
  });
}

async function main() {
  const sw = await spaceWeather();
  const contest = contestNow();
  if (!sw.quiet || contest) {
    write({ t: new Date().toISOString(), skipped: contest ? `contest: ${contest.nm}` : `disturbed: flux ${sw.flux}, Kp ${sw.kp}` });
    return;
  }

  const client = await connect();
  const bands = {};
  let current = null;

  client.on('message', (topic, payload) => {
    if (!current) return;
    try {
      const m = JSON.parse(payload.toString());
      let b = bands[current];
      const gs = String(m.sl || '').slice(0, 4).toUpperCase();
      const gr = String(m.rl || '').slice(0, 4).toUpperCase();
      const ps = lib.parseGrid(gs), pr = lib.parseGrid(gr);
      // Same rule the page applies in addSpot: pairs inside the band's
      // ground-wave radius are not propagation, and the baseline must
      // count the same population the page counts. On 6m the annulus
      // between line of sight and the Es floor is the tropo pseudo-band's
      // population, tallied into its own bucket during the same window —
      // no extra subscription time, just spots no longer thrown away.
      if (ps && pr) {
        const km = lib.kmBetween(ps, pr);
        if (km < lib.MIN_SKY_KM[current]) {
          if (current !== '6m' || km < lib.LOS_KM) return;
          b = bands['6m-tropo'];
        }
      }
      b.global++;
      if (ps) (b.squares[gs] ??= [0, 0])[0]++;
      if (pr) (b.squares[gr] ??= [0, 0])[1]++;
    } catch (e) { /* malformed spot, skip */ }
  });

  for (const { nm } of lib.BANDS) {
    const topic = `pskr/filter/v2/${nm}/+/+/+/+/+/+/+`;
    bands[nm] = { global: 0, squares: {} };
    if (nm === '6m') bands['6m-tropo'] = { global: 0, squares: {} };
    await new Promise((res, rej) => client.subscribe(topic, e => e ? rej(e) : res()));
    current = nm;
    await new Promise(res => setTimeout(res, SAMPLE_SECS * 1000));
    current = null;
    await new Promise(res => client.unsubscribe(topic, () => res()));
    console.log(nm, bands[nm].global, 'spots,', Object.keys(bands[nm].squares).length, 'squares');
    if (nm === '6m') console.log('6m-tropo', bands['6m-tropo'].global, 'spots,',
      Object.keys(bands['6m-tropo'].squares).length, 'squares');
  }
  client.end(true);

  write({ t: new Date().toISOString(), secs: SAMPLE_SECS, bands });
}

main().catch(e => { console.error(e); process.exit(1); });
