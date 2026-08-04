// Generates src/data/network.ts with SAMPLE route geometry.
// Sample routes are hand-drawn approximations of well-known NCN rides so the
// app works out of the box. They are NOT ride-accurate. Run `npm run build:data`
// to replace them with the full live network from the official open dataset.
//
// Payload spec (v1) — shared with tools/build-data.mjs and src/data/loader.ts:
// {
//   v: 1, sample: boolean, generated: "YYYY-MM-DD", attribution: string,
//   routes: [{ id, ref, name, region, notes, poly, ele[], surf[[frac,cls]] }],
//   stations: [[name, lat, lng], ...],
//   places:   [[name, lat, lng], ...]
// }
// poly  = Google polyline (precision 5)
// ele   = metres, one integer per vertex
// surf  = spans: [startFraction, class] where 1 = traffic-free, 0 = on-road

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------- misc ---------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ------------------------------ geometry synth ----------------------------- */

// Catmull–Rom through control points, resampled roughly every `step` metres,
// with gentle low-frequency lateral wobble so lines don't look ruler-drawn.
function densify(ctrl, step, rand) {
  const pts = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const out = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    const segLen = haversine(p1, p2);
    const n = Math.max(2, Math.round(segLen / step));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      const t2 = t * t, t3 = t2 * t;
      const cr = (a, b, c, d) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  // lateral wobble: ±~12 m, smoothed
  let w = 0;
  return out.map(([lng, lat], i) => {
    w = w * 0.92 + (rand() - 0.5) * 0.35;
    const prev = out[Math.max(0, i - 1)];
    const dx = lng - prev[0], dy = lat - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const off = (w * 12) / 111320; // metres → degrees-ish
    return [
      +(lng + (-dy / len) * off).toFixed(5),
      +(lat + (dx / len) * off / Math.cos(rad(lat))).toFixed(5),
    ];
  });
}

// Elevation curve with per-route character. `features` = gaussian bumps
// [{ at: fraction, h: metres, w: width fraction }] for real landmarks
// (e.g. the Whinlatter climb).
function synthEle(n, { base, amp, seed, features = [] }) {
  const rand = mulberry32(seed);
  const phases = Array.from({ length: 4 }, () => rand() * Math.PI * 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let e =
      base +
      amp * (0.55 * Math.sin(t * 5.1 + phases[0]) + 0.28 * Math.sin(t * 11.7 + phases[1]) + 0.17 * Math.sin(t * 23.3 + phases[2]));
    for (const f of features) e += f.h * Math.exp(-(((t - f.at) / f.w) ** 2));
    e += (rand() - 0.5) * 2.5;
    out.push(Math.max(0, Math.round(e)));
  }
  // light smoothing pass
  return out.map((v, i) => Math.round((v + (out[i - 1] ?? v) + (out[i + 1] ?? v)) / 3));
}

/* ------------------------------ polyline encode ---------------------------- */

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

/* ------------------------------- sample routes ----------------------------- */
// Control points are [lng, lat]. Geometry is approximate — see file header.

const ROUTES = [
  {
    id: "r4-bristol-bath", ref: "4", name: "Bristol & Bath Railway Path",
    region: "South West", span: "Bristol → Bath", via: ["Bath"], seed: 41,
    ele: { base: 20, amp: 12 },
    surf: [[0, 0], [0.04, 1], [0.94, 0]],
    notes: "Britain's original railway path — flat, tarmac all the way, and busy on sunny weekends.",
    ctrl: [
      [-2.5813, 51.4494], [-2.558, 51.46], [-2.527, 51.478], [-2.508, 51.476],
      [-2.492, 51.478], [-2.472, 51.463], [-2.4626, 51.4245], [-2.4623, 51.4076],
      [-2.43, 51.4], [-2.4, 51.39], [-2.357, 51.3775],
    ],
  },
  {
    id: "r32-camel-trail", ref: "32", name: "Camel Trail",
    region: "South West", span: "Padstow → Bodmin Moor", via: ["Wadebridge", "Bodmin"], seed: 32,
    ele: { base: 12, amp: 8 },
    surf: [[0, 1]],
    notes: "Estuary-flat former railway from Padstow to the edge of Bodmin Moor. Hire-bike heaven.",
    ctrl: [
      [-4.937, 50.5426], [-4.91, 50.533], [-4.836, 50.517], [-4.79, 50.51],
      [-4.75, 50.478], [-4.737, 50.48], [-4.71, 50.5], [-4.69, 50.525],
    ],
  },
  {
    id: "r27-tarka-trail", ref: "27", name: "Tarka Trail",
    region: "South West", span: "Braunton → Great Torrington", via: ["Barnstaple", "Bideford"], seed: 27,
    ele: { base: 15, amp: 10 },
    surf: [[0, 1], [0.97, 0]],
    notes: "Long, level miles around the Taw and Torridge estuaries — otter country.",
    ctrl: [
      [-4.16, 51.108], [-4.13, 51.088], [-4.059, 51.078], [-4.118, 51.07],
      [-4.18, 51.056], [-4.206, 51.017], [-4.196, 50.99], [-4.17, 50.97], [-4.144, 50.951],
    ],
  },
  {
    id: "c2c-whitehaven-keswick", ref: "71", name: "C2C: Whitehaven to Keswick",
    region: "North West", span: "Whitehaven → Keswick", via: ["Keswick"], seed: 71,
    ele: { base: 60, amp: 70, features: [{ at: 0.35, h: 120, w: 0.12 }, { at: 0.74, h: 300, w: 0.08 }] },
    surf: [[0, 1], [0.22, 0], [0.55, 1], [0.8, 0]],
    notes: "Opening leg of the Sea to Sea. The Whinlatter climb is the day's big effort — then it's downhill to Keswick.",
    ctrl: [
      [-3.589, 54.548], [-3.53, 54.538], [-3.47, 54.53], [-3.4, 54.548],
      [-3.33, 54.57], [-3.27, 54.59], [-3.226, 54.608], [-3.192, 54.603], [-3.135, 54.601],
    ],
  },
  {
    id: "r69-morecambe-settle", ref: "69", name: "Way of the Roses: Morecambe to Settle",
    region: "North West", span: "Morecambe → Settle", via: ["Lancaster", "Settle"], seed: 69,
    ele: { base: 40, amp: 60, features: [{ at: 0.85, h: 90, w: 0.12 }] },
    surf: [[0, 1], [0.12, 0]],
    notes: "Rolling lanes from the seafront into limestone country. Quiet roads, honest climbing.",
    ctrl: [
      [-2.868, 54.073], [-2.801, 54.048], [-2.757, 54.064], [-2.735, 54.065],
      [-2.637, 54.112], [-2.603, 54.106], [-2.51, 54.115], [-2.392, 54.106],
      [-2.356, 54.098], [-2.279, 54.069],
    ],
  },
  {
    id: "r1-edinburgh-dunbar", ref: "1", name: "Coast & Castles: Edinburgh to Dunbar",
    region: "Scotland", span: "Edinburgh → Dunbar", via: ["Dunbar"], seed: 11,
    ele: { base: 25, amp: 30 },
    surf: [[0, 1], [0.3, 0], [0.5, 1], [0.75, 0]],
    notes: "Firth of Forth views, golf-links flatlands and a sting in the tail past East Linton.",
    ctrl: [
      [-3.189, 55.941], [-3.113, 55.953], [-3.054, 55.942], [-2.986, 55.958],
      [-2.888, 55.976], [-2.857, 56.008], [-2.827, 56.033], [-2.718, 56.058],
      [-2.656, 55.988], [-2.514, 56.003],
    ],
  },
  {
    id: "r8-taff-trail", ref: "8", name: "Taff Trail: Cardiff to Merthyr",
    region: "Wales", span: "Cardiff → Merthyr Tydfil", via: ["Merthyr Tydfil"], seed: 8,
    ele: { base: 10, amp: 20, features: [{ at: 0.9, h: 120, w: 0.25 }] },
    surf: [[0, 1], [0.4, 0], [0.55, 1]],
    notes: "Cardiff Bay to the heads of the Valleys, climbing gently the whole way. Castell Coch marks the gateway.",
    ctrl: [
      [-3.166, 51.464], [-3.185, 51.488], [-3.254, 51.536], [-3.262, 51.543],
      [-3.342, 51.602], [-3.327, 51.645], [-3.32, 51.662], [-3.378, 51.748],
    ],
  },
  {
    id: "r2-exe-estuary", ref: "2", name: "Exe Estuary Trail",
    region: "South West", span: "Exmouth → Dawlish", via: ["Exeter"], seed: 2,
    ele: { base: 8, amp: 6 },
    surf: [[0, 1], [0.45, 0], [0.52, 1]],
    notes: "Both banks of the Exe with a ferry option in the middle — flat, family-friendly, full of wading birds.",
    ctrl: [
      [-3.413, 50.62], [-3.433, 50.647], [-3.445, 50.67], [-3.467, 50.685],
      [-3.527, 50.718], [-3.495, 50.682], [-3.467, 50.653], [-3.447, 50.628],
      [-3.443, 50.605], [-3.466, 50.581],
    ],
  },
  {
    id: "r754-forth-clyde", ref: "754", name: "Forth & Clyde Canal: Glasgow to Falkirk",
    region: "Scotland", span: "Glasgow → Falkirk", via: ["Falkirk"], seed: 754,
    ele: { base: 45, amp: 7 },
    surf: [[0, 1]],
    notes: "Towpath cruising from Speirs Wharf to the Falkirk Wheel. Pancake-flat and impossible to get lost.",
    ctrl: [
      [-4.26, 55.872], [-4.23, 55.89], [-4.205, 55.905], [-4.155, 55.938],
      [-4.1, 55.955], [-4.05, 55.973], [-3.96, 55.99], [-3.89, 55.998], [-3.841, 56.0],
    ],
  },
  {
    id: "r63-rutland-water", ref: "63", name: "Rutland Water Circuit",
    region: "East Midlands", span: "Around Oakham", via: ["Oakham"], seed: 63,
    ele: { base: 85, amp: 22 },
    surf: [[0, 1], [0.85, 0], [0.92, 1]],
    notes: "A lap of England's largest reservoir. Add the Hambleton peninsula if legs allow.",
    ctrl: [
      [-0.723, 52.67], [-0.68, 52.672], [-0.65, 52.668], [-0.61, 52.663],
      [-0.608, 52.652], [-0.635, 52.639], [-0.705, 52.635], [-0.728, 52.652], [-0.723, 52.67],
    ],
  },
];

/* -------------------------------- places list ------------------------------ */

const PLACES = [
  ["London", 51.5072, -0.1276], ["Birmingham", 52.4862, -1.8904], ["Manchester", 53.4808, -2.2426],
  ["Leeds", 53.8008, -1.5491], ["Sheffield", 53.3811, -1.4701], ["Liverpool", 53.4084, -2.9916],
  ["Newcastle upon Tyne", 54.9783, -1.6178], ["Bristol", 51.4545, -2.5879], ["Cardiff", 51.4816, -3.1791],
  ["Edinburgh", 55.9533, -3.1883], ["Glasgow", 55.8642, -4.2518], ["Aberdeen", 57.1497, -2.0943],
  ["Inverness", 57.4778, -4.2247], ["Belfast", 54.5973, -5.9301], ["Nottingham", 52.9548, -1.1581],
  ["Leicester", 52.6369, -1.1398], ["Oxford", 51.752, -1.2577], ["Cambridge", 52.2053, 0.1218],
  ["Norwich", 52.6309, 1.2928], ["York", 53.96, -1.0873], ["Bath", 51.3811, -2.359],
  ["Exeter", 50.7184, -3.5339], ["Plymouth", 50.3755, -4.1427], ["Truro", 50.2632, -5.051],
  ["Brighton", 50.8225, -0.1372], ["Southampton", 50.9097, -1.4044], ["Portsmouth", 50.8198, -1.088],
  ["Bournemouth", 50.7192, -1.8808], ["Reading", 51.4543, -0.9781], ["Swindon", 51.5558, -1.7797],
  ["Gloucester", 51.8642, -2.2431], ["Worcester", 52.1936, -2.22], ["Shrewsbury", 52.7073, -2.7548],
  ["Chester", 53.1934, -2.8916], ["Preston", 53.7632, -2.7013], ["Lancaster", 54.0466, -2.801],
  ["Carlisle", 54.8925, -2.9329], ["Kendal", 54.328, -2.746], ["Keswick", 54.6013, -3.1347],
  ["Penrith", 54.664, -2.75], ["Durham", 54.7761, -1.5766], ["Sunderland", 54.9061, -1.3823],
  ["Middlesbrough", 54.5742, -1.2349], ["Hull", 53.7676, -0.3367], ["Lincoln", 53.2307, -0.5406],
  ["Derby", 52.9225, -1.4746], ["Stoke-on-Trent", 53.0027, -2.1794], ["Wolverhampton", 52.587, -2.1284],
  ["Coventry", 52.4068, -1.5197], ["Northampton", 52.2405, -0.9027], ["Milton Keynes", 52.0406, -0.7594],
  ["Luton", 51.8787, -0.42], ["Ipswich", 52.0567, 1.1555], ["Colchester", 51.8892, 0.901],
  ["Canterbury", 51.2802, 1.0789], ["Dover", 51.1279, 1.3089], ["Hastings", 50.8543, 0.573],
  ["Salisbury", 51.0693, -1.7945], ["Taunton", 51.0146, -3.103], ["Barnstaple", 51.08, -4.06],
  ["Penzance", 50.1188, -5.537], ["St Austell", 50.34, -4.79], ["Bodmin", 50.471, -4.718],
  ["Padstow", 50.5426, -4.937], ["Aberystwyth", 52.4153, -4.082], ["Bangor", 53.227, -4.129],
  ["Swansea", 51.6214, -3.9436], ["Newport", 51.5842, -2.9977], ["Merthyr Tydfil", 51.748, -3.378],
  ["Wrexham", 53.043, -2.9931], ["Stirling", 56.1165, -3.937], ["Perth", 56.395, -3.431],
  ["Dundee", 56.462, -2.9707], ["Fort William", 56.8198, -5.1052], ["Oban", 56.4152, -5.471],
  ["Berwick-upon-Tweed", 55.771, -2.011], ["Morecambe", 54.073, -2.868], ["Settle", 54.069, -2.279],
  ["Skipton", 53.9628, -2.0163], ["Harrogate", 53.9921, -1.5373], ["Scarborough", 54.2831, -0.4009],
  ["Whitby", 54.4863, -0.6206], ["Whitehaven", 54.548, -3.589], ["Oakham", 52.67, -0.729],
  ["Falkirk", 55.9993, -3.7839], ["Dumfries", 55.0709, -3.605], ["Ayr", 55.4586, -4.629],
  ["Newport (IoW)", 50.701, -1.289], ["Guildford", 51.2362, -0.57], ["Maidstone", 51.272, 0.5227],
  ["Chelmsford", 51.7356, 0.4685], ["Peterborough", 52.5695, -0.2405], ["King's Lynn", 52.7517, 0.397],
  ["Great Yarmouth", 52.6083, 1.73], ["Holyhead", 53.309, -4.633], ["Llandudno", 53.324, -3.825],
  ["Machynlleth", 52.592, -3.851], ["Brecon", 51.948, -3.39], ["Hereford", 52.0567, -2.716],
  ["Dunbar", 56.0027, -2.5143], ["Wadebridge", 50.517, -4.836], ["Bideford", 51.017, -4.206],
];

/* --------------------------------- stations -------------------------------- */

function loadStations() {
  const csv = readFileSync(join(here, "stations-raw.csv"), "utf8").trim().split("\n").slice(1);
  const out = [];
  for (const line of csv) {
    // stationName,lat,long,crsCode,iataAirportCode,constituentCountry
    // Names never contain commas in this dataset, so a simple split is fine —
    // but guard anyway.
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const name = parts[0].replace(/^"|"$/g, "");
    const lat = +parts[1], lng = +parts[2];
    if (!name || !isFinite(lat) || !isFinite(lng)) continue;
    out.push([name, +lat.toFixed(4), +lng.toFixed(4)]);
  }
  return out;
}

/* ----------------------------------- main ---------------------------------- */

const routes = ROUTES.map((r) => {
  const rand = mulberry32(r.seed * 7919 + 13);
  const coords = densify(r.ctrl, 160, rand);
  const ele = synthEle(coords.length, { ...r.ele, seed: r.seed });
  return {
    id: r.id, ref: r.ref, name: r.name, region: r.region, span: r.span, via: r.via, notes: r.notes,
    poly: encodePolyline(coords), ele, surf: r.surf,
  };
});

const payload = {
  v: 1,
  sample: true,
  generated: new Date().toISOString().slice(0, 10),
  attribution:
    "Sample geometry (approximate, for demonstration). Stations: davwheat/uk-railway-stations. Basemap © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.",
  routes,
  stations: loadStations(),
  places: PLACES,
};

const json = JSON.stringify(payload);
const gz = gzipSync(Buffer.from(json), { level: 9 });
const b64 = gz.toString("base64");

const ts = `// AUTO-GENERATED — do not edit by hand.
// Regenerate with \`npm run build:sample\` (demo data) or \`npm run build:data\` (live network).
export const NETWORK_B64 =
  "${b64}";
export const NETWORK_INFO = { sample: ${payload.sample}, generated: "${payload.generated}", bytes: ${gz.length} };
`;

writeFileSync(join(here, "..", "src", "data", "network.ts"), ts);
console.log(
  `network.ts written: ${routes.length} routes, ${payload.stations.length} stations, ${PLACES.length} places — ${(json.length / 1024).toFixed(0)} KB json → ${(gz.length / 1024).toFixed(0)} KB gz`
);
