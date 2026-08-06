import { distanceToRoute } from "./geo";
import type { LngLat, Route } from "../types";

export interface Poi {
  kind: "cafe" | "pub";
  hours?: string;
  website?: string;
  /** postcode or village/town from OSM addr tags — anchors external searches */
  loc?: string;
  name: string;
  lng: number;
  lat: number;
}

const cache = new Map<string, Poi[]>();

/* ------------------------------- sidecar -------------------------------
 * pois.json is harvested weekly in CI (tools/build-pois.mjs) and published
 * next to the app, like network.data. One small download covers every route
 * — after that, showing cafés & pubs is instant and offline-friendly.
 * If it's missing (first week, or a failed harvest) we fall back to asking
 * Overpass live for just the selected route's corridor.
 */

type SidecarRow = [number, number, number, string, string, string, number?];
let sidecar: { status: "unknown" | "missing" } | { status: "ready"; pois: Poi[] } = { status: "unknown" };
let sidecarLoad: Promise<void> | null = null;

function loadSidecar(): Promise<void> {
  if (!sidecarLoad) {
    sidecarLoad = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12_000);
        const res = await fetch("pois.json", { cache: "no-cache", signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { locs?: string[]; pois: SidecarRow[] };
        const locs = data.locs ?? [];
        sidecar = {
          status: "ready",
          pois: data.pois.map(([lng, lat, k, name, hours, website, li]) => ({
            lng, lat,
            kind: k === 1 ? "pub" : "cafe",
            name,
            hours: hours || undefined,
            website: website || undefined,
            loc: li ? locs[li - 1] : undefined,
          })),
        };
      } catch {
        sidecar = { status: "missing" };
      }
    })();
  }
  return sidecarLoad;
}

/** Sample the route every ~700 m for a corridor query, capped for URL sanity. */
function corridor(route: Route, maxPts = 180): LngLat[] {
  const step = Math.max(1, Math.floor(route.coords.length / maxPts));
  const pts: LngLat[] = [];
  for (let i = 0; i < route.coords.length; i += step) pts.push(route.coords[i]);
  pts.push(route.coords[route.coords.length - 1]);
  return pts;
}

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Live fallback: race both public Overpass mirrors, first good answer wins. */
async function fetchOverpass(route: Route): Promise<Poi[]> {
  const line = corridor(route)
    .map(([lng, lat]) => `${lat.toFixed(4)},${lng.toFixed(4)}`)
    .join(",");
  const query = `[out:json][timeout:25];(
nwr["amenity"="cafe"](around:350,${line});
nwr["amenity"="pub"](around:350,${line});
);out center 120;`;

  const ctrls = MIRRORS.map(() => new AbortController());
  const attempt = async (url: string, i: number) => {
    const t = setTimeout(() => ctrls[i].abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: ctrls[i].signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return (await res.json()) as {
        elements: { tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }[];
      };
    } finally {
      clearTimeout(t);
    }
  };

  const data = await Promise.any(MIRRORS.map(attempt));
  ctrls.forEach((c) => c.abort()); // stop the slower mirror

  const pois: Poi[] = [];
  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const amenity = el.tags?.amenity;
    if (amenity !== "cafe" && amenity !== "pub") continue;
    pois.push({
      kind: amenity,
      name: el.tags?.name ?? (amenity === "cafe" ? "Café" : "Pub"),
      hours: el.tags?.opening_hours,
      website: el.tags?.website ?? el.tags?.["contact:website"],
      loc:
        el.tags?.["addr:postcode"] ?? el.tags?.["addr:village"] ??
        el.tags?.["addr:town"] ?? el.tags?.["addr:city"] ?? el.tags?.["addr:suburb"],
      lng: lon,
      lat,
    });
  }
  return pois;
}

/** Cafés and pubs within ~350 m of the route — sidecar first, Overpass fallback. */
export async function fetchPois(route: Route): Promise<Poi[]> {
  const hit = cache.get(route.id);
  if (hit) return hit;

  await loadSidecar();
  let pois: Poi[];
  if (sidecar.status === "ready") {
    const [w, s, e, n] = route.bbox;
    const pad = 0.008;
    pois = sidecar.pois.filter(
      (p) =>
        p.lng >= w - pad && p.lng <= e + pad &&
        p.lat >= s - pad && p.lat <= n + pad &&
        distanceToRoute(route, [p.lng, p.lat]) <= 350
    );
  } else {
    pois = await fetchOverpass(route);
  }
  cache.set(route.id, pois);
  return pois;
}
