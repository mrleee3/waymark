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

// kumi first: the main .de instance rate-limits shared/cloud IPs (like CI
// runners) aggressively; kumi and private.coffee are far more tolerant.
const MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const UA = "waymark-poi-harvest/1.0 (weekly CI build; github.com/mrleee3/waymark)";

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
  const attempts = MIRRORS.length * 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 200_000);
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const retryAfter = +(res.headers.get("retry-after") ?? 0);
        const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        err.retryAfter = retryAfter;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      const wait = Math.max((e.retryAfter ?? 0) * 1000, 5000 * (attempt + 1));
      console.warn(`  attempt ${attempt + 1}/${attempts} failed (${e.message}); waiting ${wait / 1000}s…`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function harvest(report) {
  if (FIXTURE) {
    console.log(`offline mode: reading ${FIXTURE}`);
    report.push({ band: "fixture", ok: true });
    return { elements: JSON.parse(readFileSync(FIXTURE, "utf8")).elements ?? [], complete: true };
  }
  const all = [];
  let complete = true;
  const step = (NORTH - SOUTH) / BANDS;
  for (let i = 0; i < BANDS; i++) {
    const s = (SOUTH + i * step).toFixed(3);
    const n = (SOUTH + (i + 1) * step).toFixed(3);
    const bbox = `${s},${WEST},${n},${EAST}`;
    const q = `[out:json][timeout:180];(node["amenity"~"^(cafe|pub)$"](${bbox});way["amenity"~"^(cafe|pub)$"](${bbox}););out center tags;`;
    process.stdout.write(`band ${i + 1}/${BANDS} (${s}–${n})… `);
    try {
      const data = await overpass(q);
      const count = data.elements?.length ?? 0;
      console.log(`${count} elements`);
      report.push({ band: `${s}-${n}`, ok: true, count });
      all.push(...(data.elements ?? []));
    } catch (e) {
      console.warn(`band failed: ${e.message}`);
      report.push({ band: `${s}-${n}`, ok: false, error: String(e.message) });
      complete = false;
    }
    if (i < BANDS - 1) await sleep(1500);
  }
  return { elements: all, complete };
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

console.log(`build-pois starting: node ${process.version}, routes=${ROUTES_PATH}, out=${OUT_PATH}`);
const routes = JSON.parse(readFileSync(ROUTES_PATH, "utf8"));
console.log(`routes loaded: ${routes.length}`);
const grid = buildGrid(routes);
const report = [];
const { elements, complete } = await harvest(report);
console.log(`harvested ${elements.length} raw elements (complete: ${complete})`);

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

// The report is committed either way — it's our log channel from CI.
writeFileSync("tools/.pois-report.json", JSON.stringify({
  when: new Date().toISOString(), complete, kept: rows.length, raw: seen.size, bands: report,
}, null, 1));

if (!complete) {
  // A partial file would silently show "no cafés here" on uncovered routes,
  // so keep whatever pois.json is already published and just report.
  console.error("harvest incomplete — pois.json NOT written this run (see tools/.pois-report.json).");
  process.exit(0);
}
const out = { gen: new Date().toISOString().slice(0, 10), count: rows.length, pois: rows };
const json = JSON.stringify(out);
writeFileSync(OUT_PATH, json);
console.log(`pois.json written: ${rows.length} kept of ${seen.size} — ${(json.length / 1024).toFixed(0)} KB raw.`);
