#!/usr/bin/env node
// Builds extension/data/bus.json from WMATA's official Metrobus GTFS feed
// (public mirror on the Mobility Database, feed mdb-1846). Requires `unzip`.
//
//   node tools/build-bus-data.mjs [path/to/gtfs.zip]
//
// Output shape:
//   { routes: [{ id, name, color, shapes: [encodedPolyline, ...] }],
//     stops: [[code, name, lat, lng, routeIndex, routeIndex, ...], ...] }
//
// Shapes use Google's encoded polyline format (1e-5 precision). Stops list the
// indexes into `routes` of every route with a scheduled trip stopping there.

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const FEED_URL = 'https://files.mobilitydatabase.org/mdb-1846/latest.zip';
const SIMPLIFY_M = 4;       // Douglas-Peucker tolerance for route shapes
const MIN_SHAPE_SHARE = 0.2; // keep shape variants used by >= 20% of a route direction's trips

const work = mkdtempSync(join(tmpdir(), 'wmata-bus-'));
try {
  let zip = process.argv[2];
  if (!zip) {
    zip = join(work, 'gtfs.zip');
    const res = await fetch(FEED_URL);
    if (!res.ok) throw new Error(`${FEED_URL}: ${res.status}`);
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  }
  if (!existsSync(zip)) throw new Error(`no such file: ${zip}`);
  execFileSync('unzip', ['-oq', zip, 'routes.txt', 'trips.txt', 'stops.txt', 'shapes.txt', 'stop_times.txt', 'feed_info.txt', '-d', work]);

  // Minimal CSV reader (GTFS fields here may be quoted, never contain newlines).
  const parseLine = (line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  async function eachRow(file, fn) {
    const rl = createInterface({ input: createReadStream(join(work, file)), crlfDelay: Infinity });
    let header = null;
    for await (const raw of rl) {
      const line = raw.replace(/^﻿/, '');
      if (!line) continue;
      const cols = parseLine(line);
      if (!header) { header = Object.fromEntries(cols.map((c, i) => [c.trim(), i])); continue; }
      fn(cols, header);
    }
  }

  const feed = {};
  await eachRow('feed_info.txt', (c, h) => Object.assign(feed, { version: c[h.feed_version], start: c[h.feed_start_date], end: c[h.feed_end_date] }));

  const routes = [];
  const routeIdx = new Map();
  await eachRow('routes.txt', (c, h) => {
    routeIdx.set(c[h.route_id], routes.length);
    routes.push({ id: c[h.route_short_name] || c[h.route_id], name: c[h.route_long_name], color: `#${c[h.route_color] || '0091c8'}`, shapes: [] });
  });

  const tripRoute = new Map();
  const shapeUse = new Map(); // `${route}|${dir}` -> Map(shape -> trips)
  await eachRow('trips.txt', (c, h) => {
    const r = routeIdx.get(c[h.route_id]);
    tripRoute.set(c[h.trip_id], r);
    const key = `${r}|${c[h.direction_id]}`;
    if (!shapeUse.has(key)) shapeUse.set(key, new Map());
    const m = shapeUse.get(key);
    m.set(c[h.shape_id], (m.get(c[h.shape_id]) || 0) + 1);
  });

  const wantShapes = new Map(); // shape_id -> route index
  for (const [key, m] of shapeUse) {
    const r = +key.split('|')[0];
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const sorted = [...m].sort((a, b) => b[1] - a[1]);
    sorted.forEach(([shape, n], i) => {
      if (shape && (i === 0 || n / total >= MIN_SHAPE_SHARE)) wantShapes.set(shape, r);
    });
  }

  const shapePts = new Map();
  await eachRow('shapes.txt', (c, h) => {
    const id = c[h.shape_id];
    if (!wantShapes.has(id)) return;
    if (!shapePts.has(id)) shapePts.set(id, []);
    shapePts.get(id).push([+c[h.shape_pt_sequence], +c[h.shape_pt_lat], +c[h.shape_pt_lon]]);
  });

  const KX = 111320 * Math.cos((38.9 * Math.PI) / 180), KY = 110540;
  const segDist = (p, a, b) => {
    const ax = a[1] * KX, ay = a[0] * KY, bx = b[1] * KX, by = b[0] * KY, px = p[1] * KX, py = p[0] * KY;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const simplify = (pts) => {
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
      if (best > SIMPLIFY_M) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const encode = (pts) => {
    let out = '', plat = 0, plng = 0;
    const enc = (v) => {
      v = v < 0 ? ~(v << 1) : v << 1;
      let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    };
    for (const [lat, lng] of pts) {
      const ilat = Math.round(lat * 1e5), ilng = Math.round(lng * 1e5);
      out += enc(ilat - plat) + enc(ilng - plng);
      plat = ilat; plng = ilng;
    }
    return out;
  };
  let points = 0;
  for (const [id, pts] of shapePts) {
    pts.sort((a, b) => a[0] - b[0]);
    const simp = simplify(pts.map(([, lat, lng]) => [lat, lng]));
    points += simp.length;
    routes[wantShapes.get(id)].shapes.push(encode(simp));
  }

  const stopRoutes = new Map();
  await eachRow('stop_times.txt', (c, h) => {
    const r = tripRoute.get(c[h.trip_id]);
    if (r === undefined) return;
    const s = c[h.stop_id];
    if (!stopRoutes.has(s)) stopRoutes.set(s, new Set());
    stopRoutes.get(s).add(r);
  });

  const byName = (a, b) => routes[a].id.localeCompare(routes[b].id, 'en', { numeric: true });
  const stops = [];
  await eachRow('stops.txt', (c, h) => {
    const rs = stopRoutes.get(c[h.stop_id]);
    if (!rs) return; // no scheduled service
    stops.push([c[h.stop_code] || c[h.stop_id], c[h.stop_name], +(+c[h.stop_lat]).toFixed(6), +(+c[h.stop_lon]).toFixed(6), ...[...rs].sort(byName)]);
  });

  // Sort routes for display but keep stop indexes valid.
  const order = routes.map((_, i) => i).sort(byName);
  const remap = new Map(order.map((old, i) => [old, i]));
  const outRoutes = order.map((i) => routes[i]);
  for (const s of stops) for (let i = 4; i < s.length; i++) s[i] = remap.get(s[i]);

  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'data', 'bus.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({
    source: `WMATA Metrobus GTFS ${feed.version} (${feed.start}-${feed.end}) via Mobility Database mdb-1846`,
    generated: new Date().toISOString().slice(0, 10),
    routes: outRoutes,
    stops,
  }));
  console.log(`wrote ${out}: ${outRoutes.length} routes, ${shapePts.size} shapes (${points} pts), ${stops.length} stops`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
