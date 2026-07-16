'use strict';
// Relays the ionosonde station list to the data branch: node
// tools/fetch-ionosondes.js out.json
//
// The page cannot read prop.kc2g.com directly: kc2g sends no CORS
// headers and GIRO, the upstream consortium, pins access to its own
// origin, so no browser anywhere may read either feed. This runner can,
// and raw.githubusercontent.com serves the republished copy with CORS
// open. The array shape is kept identical to the source so the page's
// fetchIonosonde treats the relay exactly like the original; rows are
// trimmed to the fields it reads and to stations recent enough to
// possibly pass its freshness gate, which stays the sole arbiter.
const fs = require('fs');

const SOURCE = 'https://prop.kc2g.com/api/stations.json';
const MAX_AGE_MIN = 180;

function trim(stations, now = Date.now()) {
  const out = [];
  for (const s of Array.isArray(stations) ? stations : []) {
    if (!s || !s.station || s.station.latitude == null || s.station.longitude == null) continue;
    if (s.mufd == null || s.fof2 == null || !s.time) continue;
    // kc2g stamps UTC with no zone suffix; read it as the UTC it is.
    const t = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(String(s.time)) ? s.time : s.time + 'Z');
    if (!Number.isFinite(t) || now - t > MAX_AGE_MIN * 60000) continue;
    out.push({
      time: s.time, mufd: s.mufd, fof2: s.fof2,
      station: {
        name: s.station.name,
        latitude: s.station.latitude,
        longitude: s.station.longitude,
      },
    });
  }
  return out;
}

async function main() {
  const r = await fetch(SOURCE);
  if (!r.ok) throw new Error(`${SOURCE} answered ${r.status}`);
  const trimmed = trim(await r.json());
  // An empty result means the whole network looks stale from here; fail
  // loudly so the run shows red instead of publishing an empty file the
  // page would silently treat as "no sonde anywhere".
  if (!trimmed.length) throw new Error('no usable stations in the feed');
  const out = process.argv[2] || 'ionosondes.json';
  fs.writeFileSync(out, JSON.stringify(trimmed));
  console.log(out, trimmed.length, 'stations,', JSON.stringify(trimmed).length, 'bytes');
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { trim, MAX_AGE_MIN };
