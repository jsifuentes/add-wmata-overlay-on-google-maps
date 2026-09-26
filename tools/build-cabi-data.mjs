#!/usr/bin/env node
// Builds extension/data/cabi.json from Capital Bikeshare's public GBFS feed (the
// same data behind the map on capitalbikeshare.com).
//
//   node tools/build-cabi-data.mjs
//
// Output shape:
//   { regions: [name, ...],
//     stations: [[name, lat, lng, capacity, regionIndex], ...] }
//
// regionIndex is -1 for stations the feed doesn't assign to a region.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FEED = 'https://gbfs.lyft.com/gbfs/2.3/dca-cabi/en';

const get = async (name) => {
  const res = await fetch(`${FEED}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return (await res.json()).data;
};

const [info, { regions: rawRegions }] = await Promise.all([get('station_information'), get('system_regions')]);

const regions = [];
const regionIdx = new Map();
const regionOf = (id) => {
  const r = rawRegions.find((x) => x.region_id === id);
  if (!r) return -1;
  if (!regionIdx.has(id)) {
    regionIdx.set(id, regions.length);
    regions.push(r.name);
  }
  return regionIdx.get(id);
};

const stations = info.stations
  .map((s) => [s.name.trim().replace(/\s+/g, ' '), +s.lat.toFixed(6), +s.lon.toFixed(6), s.capacity ?? 0, regionOf(s.region_id)])
  .sort((a, b) => a[0].localeCompare(b[0]));

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'data', 'cabi.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({
  source: 'Capital Bikeshare GBFS (gbfs.lyft.com/gbfs/2.3/dca-cabi)',
  generated: new Date().toISOString().slice(0, 10),
  regions,
  stations,
}));
console.log(`wrote ${out}: ${stations.length} stations in ${regions.length} regions`);
