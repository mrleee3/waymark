/**
 * build-pois.mjs — harvest cafés & pubs along the NCN, weekly, in CI.
 *
 * Reads the plain routes file emitted by build-data.mjs (--routes-json),
 * downloads every cafe/pub in Great Britain from Overpass in latitude bands
 * (two mirrors, retries), keeps only those within MAX_DIST of any route,
 * and writes a compact `pois.json` the app lazy-loads at runtime — so the
 * phone never has to query Overpass at all.
 *
 *   node tools/build-pois.mjs --routes /tmp/routes-plain.json --out pois.json
 *
 * Offline test mode (no network): --overpass-file fixture.json
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const ROUTES_PATH = opt("routes", "");
const OUT_PATH = opt("out", "pois.json");
const FIXTURE = opt("overpass-file", "");
const MAX_DIST = +opt("max-dist", "450"); // metres to the nearest route point

if (!ROUTES_PATH) {
  console.error("Usage: node tools/build-pois.mjs --routes routes-plain.json --out pois.json");
  process.exit(1);
}

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Great Britain, in latitude bands so no single query is huge.
const WEST = -8.7, EAST = 1.8, SOUTH = 49.8, NORTH = 61.0, BANDS = 12;

const R = 6371000;
function haversine(a, b) {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 200_000);
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.warn(`  attempt ${attempt + 1} failed (${e.message}); backing off…`);
      await sleep(4000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function harvest() {
  if (FIXTURE) {
    console.log(`offline mode: reading ${FIXTURE}`);
    return JSON.parse(readFileSync(FIXTURE, "utf8")).elements ?? [];
  }
  const all = [];
  const step = (NORTH - SOUTH) / BANDS;
  for (let i = 0; i < BANDS; i++) {
    const s = (SOUTH + i * step).toFixed(3);
    const n = (SOUTH + (i + 1) * step).toFixed(3);
    const bbox = `${s},${WEST},${n},${EAST}`;
    const q = `[out:json][timeout:180];(node["amenity"~"^(cafe|pub)$"](${bbox});way["amenity"~"^(cafe|pub)$"](${bbox}););out center tags;`;
    process.stdout.write(`band ${i + 1}/${BANDS} (${s}–${n})… `);
    const data = await overpass(q);
    console.log(`${data.elements?.length ?? 0} elements`);
    all.push(...(data.elements ?? []));
    if (i < BANDS - 1) await sleep(1500);
  }
  return all;
}

/* ------------------------- spatial index of routes ------------------------- */

const CELL = 0.008; // ~890 m of latitude; ±2 cells searched
const key = (lng, lat) => `${Math.floor(lng / CELL)}:${Math.floor(lat / CELL)}`;

function buildGrid(routes) {
  const grid = new Map();
  let pts = 0;
  for (const r of routes) {
    for (const c of r.coords) {
      const k = key(c[0], c[1]);
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(c);
      pts++;
    }
  }
  console.log(`grid: ${grid.size} cells, ${pts} route points`);
  return grid;
}

function nearAnyRoute(grid, lng, lat) {
  const cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const arr = grid.get(`${cx + dx}:${cy + dy}`);
      if (!arr) continue;
      for (const p of arr) {
        if (haversine(p, [lng, lat]) <= MAX_DIST) return true;
      }
    }
  }
  return false;
}

/* --------------------------------- main --------------------------------- */

const routes = JSON.parse(readFileSync(ROUTES_PATH, "utf8"));
const grid = buildGrid(routes);
const elements = await harvest();
console.log(`harvested ${elements.length} raw elements`);

const seen = new Set();
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) : s || "");
const rows = [];
for (const el of elements) {
  const id = `${el.type}/${el.id}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) continue;
  if (!nearAnyRoute(grid, lng, lat)) continue;
  const kind = el.tags?.amenity === "pub" ? 1 : 0;
  const name = clip(el.tags?.name, 48) || (kind ? "Pub" : "Café");
  const hours = clip(el.tags?.opening_hours, 64);
  let website = el.tags?.website ?? el.tags?.["contact:website"] ?? "";
  if (!/^https?:\/\//.test(website) || website.length > 80) website = "";
  rows.push([+lng.toFixed(5), +lat.toFixed(5), kind, name, hours, website]);
}

const out = { gen: new Date().toISOString().slice(0, 10), count: rows.length, pois: rows };
const json = JSON.stringify(out);
writeFileSync(OUT_PATH, json);
console.log(`pois.json written: ${rows.length} kept of ${seen.size} — ${(json.length / 1024).toFixed(0)} KB raw.`);
