#!/usr/bin/env node
// Builds extension/data/wmata.json from DC Open Data (DC GIS) Metro layers.
//
//   node tools/build-wmata-data.mjs
//
// Output shape:
//   { lines: [{ id, name, color, coords: [[lng, lat, off], ...] }],
//     stations: [{ name, lines: [id...], lng, lat }] }
//
// `off` is a per-vertex parallel offset (in "line widths") used by the renderer so
// that segments where several lines share track are drawn side by side instead of
// on top of each other.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Transportation_Rail_Bus_WebMercator/MapServer';
const LINES_LAYER = 58;    // Metro Lines (Regional)
const STATIONS_LAYER = 51; // Metro Stations (Regional)

// Official WMATA colors. Order also decides side-by-side ordering on shared track.
const LINES = [
  { id: 'red', name: 'Red', color: '#BF0D3E' },
  { id: 'blue', name: 'Blue', color: '#009CDE' },
  { id: 'orange', name: 'Orange', color: '#ED8B00' },
  { id: 'silver', name: 'Silver', color: '#919D9D' },
  { id: 'yellow', name: 'Yellow', color: '#FFD100' },
  { id: 'green', name: 'Green', color: '#00B140' },
];
const ORDER = LINES.map((l) => l.id);

const SIMPLIFY_M = 3;  // Douglas-Peucker tolerance
const SHARED_M = 45;   // lines closer than this (and running parallel) share track
const DENSIFY_M = 100; // max vertex spacing, so offsets change close to where sharing starts/ends

const query = async (layer) => {
  const url = `${BASE}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()).features;
};

// Local equirectangular projection to meters around DC.
const LAT0 = 38.9;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110540;
const toM = ([lng, lat]) => [lng * KX, lat * KY];

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > best) { best = d; bi = k; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Nearest segment of `line` to point p: { dist, dir: unit vector of that segment }.
function nearest(p, line) {
  let best = { dist: Infinity, dir: [1, 0] };
  for (let i = 1; i < line.length; i++) {
    const d = segDist(p, line[i - 1], line[i]);
    if (d < best.dist) {
      const dx = line[i][0] - line[i - 1][0], dy = line[i][1] - line[i - 1][1];
      const l = Math.hypot(dx, dy) || 1;
      best = { dist: d, dir: [dx / l, dy / l] };
    }
  }
  return best;
}

function dirAt(line, i) {
  const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

const [lineFeats, stationFeats] = await Promise.all([query(LINES_LAYER), query(STATIONS_LAYER)]);

// id -> simplified coords (lng/lat) and meter coords
const geo = {};
for (const f of lineFeats) {
  const id = f.properties.NAME.toLowerCase().trim();
  if (!ORDER.includes(id)) continue;
  const coords = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates;
  const m = coords.map(toM);
  const idx = new Map(m.map((p, i) => [p, i]));
  const simp = simplify(m, SIMPLIFY_M);
  const dense = [simp[0]];
  for (let i = 1; i < simp.length; i++) {
    const a = simp[i - 1], b = simp[i];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / DENSIFY_M);
    for (let k = 1; k <= n; k++) dense.push(k === n ? b : [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  geo[id] = { ll: dense.map((p) => idx.has(p) ? coords[idx.get(p)] : [p[0] / KX, p[1] / KY]), m: dense };
}

// Orient lines so that lines sharing track run in the same direction (keeps the
// left/right assignment stable across corridors). Greedy: repeatedly orient the
// line with the most (parallel) overlap with the already-oriented set.
const parallelOverlap = (id, others) => {
  let score = 0;
  geo[id].m.forEach((p, i) => {
    const d = dirAt(geo[id].m, i);
    for (const o of others) {
      const n = nearest(p, geo[o].m);
      const dot = d[0] * n.dir[0] + d[1] * n.dir[1];
      if (n.dist < SHARED_M && Math.abs(dot) > 0.7) score += Math.sign(dot);
    }
  });
  return score;
};
const oriented = new Set();
const ids = ORDER.filter((id) => geo[id]);
while (oriented.size < ids.length) {
  const todo = ids.filter((id) => !oriented.has(id));
  const scored = todo.map((id) => [id, parallelOverlap(id, oriented)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const [id, score] = scored[0];
  if (score < 0) { geo[id].m.reverse(); geo[id].ll.reverse(); }
  oriented.add(id);
}

const lines = LINES.filter((l) => geo[l.id]).map((l) => {
  const { ll, m } = geo[l.id];
  const coords = m.map((p, i) => {
    const d = dirAt(m, i);
    const shared = ORDER.filter((o) => {
      if (o === l.id) return true;
      if (!geo[o]) return false;
      const n = nearest(p, geo[o].m);
      return n.dist < SHARED_M && Math.abs(d[0] * n.dir[0] + d[1] * n.dir[1]) > 0.7;
    });
    const off = shared.indexOf(l.id) - (shared.length - 1) / 2;
    return [+ll[i][0].toFixed(6), +ll[i][1].toFixed(6), off];
  });
  return { ...l, coords };
});

const stations = stationFeats.map((f) => ({
  name: f.properties.NAME,
  lines: f.properties.LINE.split(',').map((s) => s.trim().toLowerCase()).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)),
  lng: +f.geometry.coordinates[0].toFixed(6),
  lat: +f.geometry.coordinates[1].toFixed(6),
})).sort((a, b) => a.name.localeCompare(b.name));

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'data', 'wmata.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({
  source: 'DC Open Data (DC GIS): Metro Lines Regional / Metro Stations Regional',
  generated: new Date().toISOString().slice(0, 10),
  lines,
  stations,
}));
console.log(`wrote ${out}: ${lines.map((l) => `${l.id}=${l.coords.length}`).join(' ')}, ${stations.length} stations`);
