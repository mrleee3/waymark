// Builds src/data/network.ts from the OFFICIAL National Cycle Network dataset.
//
// The dataset is published by Sustrans / Walk Wheel Cycle Trust on their open
// data portal (updated every Sunday, Open Government Licence, contains OS data
// © Crown copyright). This machine-independent script cannot ship with a
// hard-coded download URL because the portal's dataset IDs change — so:
//
//   1. Open https://data-sustrans-uk.opendata.arcgis.com and find
//      "National Cycle Network (Public)".
//   2. Download → GeoJSON.
//   3. Run:  npm run build:data -- --src path/to/that.geojson
//
// (You can also pass a URL straight to --src.)
//
// First run on a fresh dataset?  Add --inspect to see the attribute fields, then
// pass --ref-field / --name-field / --surface-field if the auto-detection
// guesses wrong.
//
// Elevations come from OpenTopoData (EU-DEM 25 m), batched and cached in
// tools/.ele-cache.json. Use --skip-elevation for a fast build without them.
//
// NOTE: written and reviewed but not executed against the live portal from the
// authoring environment (no network access to it) — the --inspect flow exists
// precisely so the first real run is transparent.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLACES } from "./places.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/* --------------------------------- options --------------------------------- */

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const SRC = opt("src");
const INSPECT = has("inspect");
const SKIP_ELE = has("skip-elevation");
const SIMPLIFY_TOL = +(opt("simplify", "0.00008")); // ≈ 8 m
const MAX_PARTS = +(opt("max-parts", "8"));
const MIN_LEN = +(opt("min-length", "8000"));
const ELE_DATASET = opt("ele-dataset", "eudem25m");

if (!SRC) {
  console.error("Usage: npm run build:data -- --src <path-or-url> [--inspect] [--ref-field F] [--name-field F] [--surface-field F] [--traffic-free-values \"a,b\"] [--skip-elevation]");
  process.exit(1);
}

/* ---------------------------------- load ----------------------------------- */

async function loadGeojson(src) {
  if (/^https?:\/\//.test(src)) {
    console.log(`Fetching ${src} …`);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching source`);
    return await res.json();
  }
  return JSON.parse(readFileSync(src, "utf8"));
}

const gj = await loadGeojson(SRC);
const features = gj.features ?? [];
console.log(`${features.length} features loaded.`);
if (!features.length) process.exit(1);

/* --------------------------------- inspect --------------------------------- */

const distinct = (field, cap = 12) => {
  const set = new Map();
  for (const f of features) {
    const v = f.properties?.[field];
    if (v == null) continue;
    set.set(String(v), (set.get(String(v)) ?? 0) + 1);
    if (set.size > 400) break;
  }
  return [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap);
};

if (INSPECT) {
  const props = features[0].properties ?? {};
  console.log("\nFields on first feature:");
  for (const k of Object.keys(props)) {
    const sample = distinct(k, 6).map(([v, n]) => `${v} (${n})`).join(", ");
    console.log(`  ${k}: ${sample}`);
  }
  process.exit(0);
}

/* ------------------------------ field detection ----------------------------- */

function detectField(candidates, flag) {
  const forced = opt(flag);
  if (forced) return forced;
  const keys = Object.keys(features[0].properties ?? {});
  for (const c of candidates) {
    const hit = keys.find((k) => k.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

const REF_FIELD = detectField(["Ref", "RouteNo", "Route_No", "NCN_Ref", "Route", "Number", "Label"], "ref-field");
const NAME_FIELD = detectField(["Name", "RouteName", "Route_Name", "Title"], "name-field");

if (!REF_FIELD) {
  console.error("Couldn't find a route-number field. Run with --inspect, then pass --ref-field <FieldName>.");
  process.exit(1);
}

const TF_VALUES = (opt("traffic-free-values", "traffic free,traffic-free,off road,off-road,path,greenway,towpath,railway path,segregated"))
  .split(",").map((s) => s.trim().toLowerCase());

// Surface classification. Values like "Traffic Free", "On Road - Minor",
// "Segregated cycle track", "Towpath" etc. — matched per value, any field.
const TF_RE = /traffic.?free|off.?road|path|track|greenway|towpath|bridleway|shared.?use|canal|railway|promenade|segregated|trail|cycle.?way/i;
const ROAD_RE = /on.?road|road|street|lane|carriageway|highway|quiet.?way|minor|major|a.?road|b.?road/i;
const classifyValue = (v) => (TF_RE.test(v) ? 1 : ROAD_RE.test(v) ? 0 : null);

function detectSurfaceField() {
  const forced = opt("surface-field");
  if (forced) return forced;
  const keys = Object.keys(features[0].properties ?? {});
  let best = null;
  for (const k of keys) {
    const vals = distinct(k, 60);
    if (!vals.length) continue;
    let total = 0, classified = 0, tf = 0, road = 0;
    for (const [v, n] of vals) {
      total += n;
      const c = classifyValue(v);
      if (c != null) { classified += n; if (c === 1) tf += n; else road += n; }
    }
    if (!tf || !road) continue; // need both classes present
    const score = classified / total;
    if (score >= 0.5 && (!best || score > best.score)) best = { field: k, score };
  }
  // fall back to conventional names even if value-scoring failed
  if (!best) {
    const named = ["Desc", "Desc_", "DESC_", "Type", "Surface", "OnRoad", "On_Road", "RoadType", "Category"]
      .map((c) => keys.find((k) => k.toLowerCase() === c.toLowerCase()))
      .find(Boolean);
    return named ?? null;
  }
  return best.field;
}
const SURF_FIELD = detectSurfaceField();
console.log(`Fields → ref: ${REF_FIELD}, name: ${NAME_FIELD ?? "(none)"}, surface: ${SURF_FIELD ?? "(NONE — surface data will be marked unavailable; run --inspect and pass --surface-field)"}`);
if (SURF_FIELD) console.log(`  surface values seen: ${distinct(SURF_FIELD, 12).map(([v, n]) => `"${v}" (${n})`).join(", ")}`);

const isTrafficFree = (props) => {
  if (!SURF_FIELD) return 0; // marked unavailable app-side when everything is 0
  const v = String(props?.[SURF_FIELD] ?? "");
  if (!v) return 0;
  const extra = TF_VALUES.some((t) => v.toLowerCase().includes(t));
  return (classifyValue(v) ?? (extra ? 1 : 0));
};

/* ------------------------------ geometry helpers ---------------------------- */

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const haversine = (a, b) => {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

function segmentsOf(feature) {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  return [];
}

function lineLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1], coords[i]);
  return m;
}

/** Douglas–Peucker in degrees (fine at UK latitudes for display purposes). */
function simplify(coords, tol) {
  if (coords.length < 3) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = coords[a], [bx, by] = coords[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = coords[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      const d = Math.sqrt(qx * qx + qy * qy);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/**
 * Greedy chain: start from the longest segment, repeatedly attach the segment
 * whose endpoint is nearest to either end of the chain (reversing as needed),
 * while the gap is under 2 km. Returns [{ coords, srcSegs }] chains.
 */
function chainSegments(segs) {
  const pool = segs.map((s) => ({ coords: s.coords, cls: s.cls, used: false, len: lineLength(s.coords) }));
  pool.sort((a, b) => b.len - a.len);
  const chains = [];
  for (;;) {
    const seed = pool.find((p) => !p.used);
    if (!seed) break;
    seed.used = true;
    let chain = [...seed.coords];
    const parts = [{ cls: seed.cls, len: seed.len }];
    let extended = true;
    while (extended) {
      extended = false;
      const head = chain[0], tail = chain[chain.length - 1];
      let best = null;
      for (const p of pool) {
        if (p.used) continue;
        const a = p.coords[0], b = p.coords[p.coords.length - 1];
        const options = [
          { d: haversine(tail, a), where: "tail", rev: false },
          { d: haversine(tail, b), where: "tail", rev: true },
          { d: haversine(head, b), where: "head", rev: false },
          { d: haversine(head, a), where: "head", rev: true },
        ];
        for (const o of options) {
          if (o.d < 2000 && (!best || o.d < best.d)) best = { ...o, p };
        }
      }
      if (best) {
        best.p.used = true;
        const c = best.rev ? [...best.p.coords].reverse() : best.p.coords;
        if (best.where === "tail") {
          chain = chain.concat(c);
          parts.push({ cls: best.p.cls, len: best.p.len });
        } else {
          chain = c.concat(chain);
          parts.unshift({ cls: best.p.cls, len: best.p.len });
        }
        extended = true;
      }
    }
    chains.push({ coords: chain, parts });
  }
  return chains;
}

/** Surface spans [[frac, cls]] from the ordered parts of a chain. */
function spansFromParts(parts) {
  const total = parts.reduce((s, p) => s + p.len, 0) || 1;
  const spans = [];
  let acc = 0;
  for (const p of parts) {
    const frac = acc / total;
    if (!spans.length || spans[spans.length - 1][1] !== p.cls) spans.push([+frac.toFixed(4), p.cls]);
    acc += p.len;
  }
  return spans;
}

/* ------------------------------- polyline enc ------------------------------- */

function encodePolyline(coords) {
  let out = "", pLat = 0, pLng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * 1e5), iLng = Math.round(lng * 1e5);
    out += enc(iLat - pLat) + enc(iLng - pLng);
    pLat = iLat; pLng = iLng;
  }
  return out;
}

/* -------------------------------- elevations -------------------------------- */

const CACHE_PATH = join(here, ".ele-cache.json");
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
const ckey = (lat, lng) => `${lat.toFixed(4)},${lng.toFixed(4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function elevations(coords) {
  if (SKIP_ELE) return coords.map(() => 0);
  const need = [];
  for (const [lng, lat] of coords) {
    const k = ckey(lat, lng);
    if (!(k in cache)) need.push([lat, lng]);
  }
  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100);
    const locations = batch.map(([lat, lng]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join("|");
    const url = `https://api.opentopodata.org/v1/${ELE_DATASET}?locations=${locations}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenTopoData HTTP ${res.status} — try --skip-elevation or later`);
    const data = await res.json();
    data.results.forEach((r, j) => {
      const [lat, lng] = batch[j];
      cache[ckey(lat, lng)] = r.elevation == null ? 0 : Math.round(r.elevation);
    });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
    process.stdout.write(`  elevations ${Math.min(i + 100, need.length)}/${need.length}\r`);
    await sleep(1100); // polite: 1 req/s
  }
  return coords.map(([lng, lat]) => cache[ckey(lat, lng)] ?? 0);
}

/* ----------------------------------- main ----------------------------------- */

const byRef = new Map(); // ref → { segs: [], names: Map<string, count> }
let skipped = 0, linkRoutes = 0;
const KEEP_LINKS = has("keep-links");
const JOIN_GAP = +(opt("join-gap", "3000")); // bridge chain gaps up to this (m)
for (const f of features) {
  const ref = String(f.properties?.[REF_FIELD] ?? "").trim();
  if (!ref) { skipped++; continue; }
  if (/^0+$/.test(ref) && !KEEP_LINKS) { linkRoutes++; continue; } // ref "0" = unnumbered links
  const cls = isTrafficFree(f.properties);
  const entry = byRef.get(ref) ?? { segs: [], names: new Map() };
  for (const coords of segmentsOf(f)) if (coords.length > 1) entry.segs.push({ coords, cls });
  if (NAME_FIELD) {
    const n = String(f.properties?.[NAME_FIELD] ?? "").trim();
    if (n) entry.names.set(n, (entry.names.get(n) ?? 0) + 1);
  }
  byRef.set(ref, entry);
}
if (skipped) console.log(`${skipped} features without a route number skipped.`);
if (linkRoutes) console.log(`${linkRoutes} unnumbered link features (ref 0) excluded — pass --keep-links to keep them.`);

/** Nearest place name to a point, or null beyond maxKm. */
function nearestPlace(p, maxKm = 30) {
  let best = null, bestD = maxKm * 1000;
  for (const [name, lat, lng] of PLACES) {
    const d = haversine(p, [lng, lat]);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/** Places the line passes within `corridorKm`, in route order (excluding ends). */
function placesAlong(coords, corridorKm = 3, max = 4) {
  const hits = [];
  for (const [name, lat, lng] of PLACES) {
    const p = [lng, lat];
    let bestD = Infinity, bestI = 0;
    for (let i = 0; i < coords.length; i += 3) {
      const d = haversine(coords[i], p);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestD < corridorKm * 1000) hits.push({ name, at: bestI });
  }
  hits.sort((a, b) => a.at - b.at);
  const inner = hits.slice(1, -1).length ? hits.slice(1, -1) : hits;
  return inner.slice(0, max).map((h) => h.name);
}

/**
 * Merge chains of the same ref into as few lines as possible: repeatedly
 * attach the chain whose endpoint lies nearest to the working chain's ends,
 * bridging gaps up to JOIN_GAP with a straight connector (classed on-road).
 */
function mergeChains(chains) {
  const pool = chains.map((c) => ({ ...c, used: false }));
  pool.sort((a, b) => b.len - a.len);
  const merged = [];
  for (;;) {
    const seed = pool.find((p) => !p.used);
    if (!seed) break;
    seed.used = true;
    let coords = seed.coords;
    let parts = [...seed.parts];
    let bridges = 0;
    let extended = true;
    while (extended) {
      extended = false;
      const head = coords[0], tail = coords[coords.length - 1];
      let best = null;
      for (const p of pool) {
        if (p.used) continue;
        const a = p.coords[0], b = p.coords[p.coords.length - 1];
        for (const o of [
          { d: haversine(tail, a), where: "tail", rev: false },
          { d: haversine(tail, b), where: "tail", rev: true },
          { d: haversine(head, b), where: "head", rev: false },
          { d: haversine(head, a), where: "head", rev: true },
        ]) if (o.d < JOIN_GAP && (!best || o.d < best.d)) best = { ...o, p };
      }
      if (best) {
        best.p.used = true;
        const c = best.rev ? [...best.p.coords].reverse() : best.p.coords;
        const bridgePart = { cls: 0, len: best.d };
        if (best.d > 50) bridges++;
        if (best.where === "tail") {
          coords = coords.concat(c);
          parts.push(bridgePart, ...best.p.parts);
        } else {
          coords = c.concat(coords);
          parts.unshift(...best.p.parts, bridgePart);
        }
        extended = true;
      }
    }
    merged.push({ coords, parts, bridges, len: parts.reduce((s, x) => s + x.len, 0) });
  }
  return merged;
}

const routes = [];
for (const [ref, entry] of [...byRef.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
  const nameHint = entry.names.size
    ? [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;
  const chains = mergeChains(
    chainSegments(entry.segs).map((c) => ({ ...c, len: lineLength(c.coords) }))
  )
    .filter((c) => c.len > MIN_LEN) // drop crumbs
    .sort((a, b) => b.len - a.len)
    .slice(0, MAX_PARTS);
  chains.forEach((chain, i) => {
    const simple = simplify(chain.coords, SIMPLIFY_TOL);
    const start = simple[0], end = simple[simple.length - 1];
    const circular = chain.len > 5000 && haversine(start, end) < 1200;
    const from = nearestPlace(start), to = nearestPlace(end);
    const span = circular || (from && from === to)
      ? (from ? `Around ${from}` : "")
      : from && to ? `${from} → ${to}` : from ?? "";
    const via = placesAlong(simple).filter((v) => v !== from && v !== to);
    const base = nameHint || `Route ${ref}`;
    const name = chains.length > 1 ? `${base} · ${span || `part ${i + 1}`}` : base;
    const lenKm = chain.len / 1000;
    const tfLen = chain.parts.filter((p) => p.cls === 1).reduce((s, p) => s + p.len, 0);
    const tfPct = Math.round((tfLen / chain.len) * 100);
    const surfaceWord = tfPct >= 80 ? "almost entirely traffic-free" : tfPct >= 55 ? "mostly traffic-free" : tfPct >= 30 ? "a mix of paths and quiet roads" : "mostly on-road";
    const viaText = via.length ? ` Passes ${via.length > 1 ? via.slice(0, -1).join(", ") + " and " + via[via.length - 1] : via[0]}.` : "";
    const bridgeText = chain.bridges > 0 ? ` Includes ${chain.bridges} unsigned linking ${chain.bridges === 1 ? "section" : "sections"} drawn as straight lines.` : "";
    routes.push({
      gaps: chain.bridges ?? 0,
      id: `ncn-${ref.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${chains.length > 1 ? `-${i + 1}` : ""}`,
      ref,
      name,
      region: "",
      span,
      via,
      notes: `${Math.round(lenKm)} km, ${surfaceWord} (${tfPct}%).${viaText}${bridgeText}`,
      _coords: simple,
      surf: spansFromParts(chain.parts),
    });
  });
}
// De-duplicate identical display names within a ref by appending a compass
// direction relative to the group's centroid (e.g. two "Around Peterborough"
// parts become "· N" and "· S").
{
  const byName = new Map();
  for (const r of routes) {
    const k = r.name;
    (byName.get(k) ?? byName.set(k, []).get(k)).push(r);
  }
  const octant = (dx, dy) => {
    const a = (Math.atan2(dy, dx) * 180) / Math.PI; // dx east, dy north
    const dirs = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
    return dirs[Math.round(((a + 360) % 360) / 45) % 8];
  };
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const mids = group.map((r) => {
      const c = r._coords[Math.floor(r._coords.length / 2)];
      return { r, x: c[0], y: c[1] };
    });
    const cx = mids.reduce((s, m) => s + m.x, 0) / mids.length;
    const cy = mids.reduce((s, m) => s + m.y, 0) / mids.length;
    for (const m of mids) {
      const dir = octant(m.x - cx, m.y - cy);
      m.r.name = `${m.r.name} · ${dir}`;
      if (m.r.span) m.r.span = `${m.r.span} (${dir})`;
    }
  }
}
console.log(`${routes.length} routes from ${byRef.size} numbered refs (join-gap ${JOIN_GAP} m, min ${MIN_LEN / 1000} km — tune with --join-gap / --min-length).`);

for (const r of routes) {
  // sample elevation at ~every 4th vertex to keep API volume sane, then expand
  const sampleIdx = [];
  for (let i = 0; i < r._coords.length; i += 4) sampleIdx.push(i);
  if (sampleIdx[sampleIdx.length - 1] !== r._coords.length - 1) sampleIdx.push(r._coords.length - 1);
  const sampled = await elevations(sampleIdx.map((i) => r._coords[i]));
  const ele = new Array(r._coords.length);
  for (let s = 0; s < sampleIdx.length; s++) {
    const from = sampleIdx[s];
    const to = s + 1 < sampleIdx.length ? sampleIdx[s + 1] : from;
    for (let i = from; i <= to; i++) {
      const f = to === from ? 0 : (i - from) / (to - from);
      ele[i] = Math.round(sampled[s] + (sampled[Math.min(s + 1, sampled.length - 1)] - sampled[s]) * f);
    }
  }
  r.poly = encodePolyline(r._coords);
  r.ele = ele;
  delete r._coords;
  console.log(`  ${r.id}: ${(lineLengthFromPoly(r.poly) / 1000).toFixed(0)} km`);
}

function lineLengthFromPoly(poly) {
  // decode quickly for the log line
  let index = 0, lat = 0, lng = 0, prev = null, m = 0;
  while (index < poly.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = poly.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    const cur = [lng / 1e5, lat / 1e5];
    if (prev) m += haversine(prev, cur);
    prev = cur;
  }
  return m;
}

/* --------------------------------- stations --------------------------------- */

console.log("Refreshing stations …");
let stations = [];
try {
  const res = await fetch("https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.csv");
  const csv = (await res.text()).trim().split("\n").slice(1);
  for (const line of csv) {
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const name = parts[0].replace(/^"|"$/g, "");
    const lat = +parts[1], lng = +parts[2];
    if (name && isFinite(lat) && isFinite(lng)) stations.push([name, +lat.toFixed(4), +lng.toFixed(4)]);
  }
} catch (e) {
  console.warn("Station refresh failed — reusing the copy in tools/stations-raw.csv");
  const csv = readFileSync(join(here, "stations-raw.csv"), "utf8").trim().split("\n").slice(1);
  for (const line of csv) {
    const parts = line.split(",");
    if (parts.length >= 3) stations.push([parts[0], +(+parts[1]).toFixed(4), +(+parts[2]).toFixed(4)]);
  }
}
console.log(`${stations.length} stations.`);

/* ---------------------------------- write ----------------------------------- */

const payload = {
  v: 1,
  sample: false,
  generated: new Date().toISOString().slice(0, 10),
  attribution:
    "National Cycle Network data © Sustrans / Walk Wheel Cycle Trust, Open Government Licence; contains Ordnance Survey data © Crown copyright and database right. Stations: davwheat/uk-railway-stations. Basemap © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.",
  routes: routes.map(({ id, ref, name, region, span, via, notes, poly, ele, surf }) => ({ id, ref, name, region, span, via, notes, poly, ele, surf })),
  stations,
  places: PLACES,
};

const json = JSON.stringify(payload);
const gz = gzipSync(Buffer.from(json), { level: 9 });
const ts = `// AUTO-GENERATED — do not edit by hand.
// Regenerate with \`npm run build:data\` (live network) or \`npm run build:sample\` (demo data).
export const NETWORK_B64 =
  "${gz.toString("base64")}";
export const NETWORK_INFO = { sample: false, generated: "${payload.generated}", bytes: ${gz.length} };
`;
writeFileSync(join(here, "..", "src", "data", "network.ts"), ts);
writeFileSync(join(here, "..", "network.data"), gz.toString("base64"));
const routesJsonPath = opt("routes-json", "");
if (routesJsonPath) {
  writeFileSync(routesJsonPath, JSON.stringify(routes.map((r) => ({ id: r.id, coords: r._coords }))));
  console.log(`routes-json written: ${routesJsonPath}`);
}
console.log(`network.ts + network.data written: ${routes.length} routes — ${(json.length / 1048576).toFixed(1)} MB json → ${(gz.length / 1048576).toFixed(1)} MB gz.`);
console.log("Publish network.data next to your deployed index.html and the app loads it at runtime — no rebuild needed.");
