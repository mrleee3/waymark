import type { LngLat, Route } from "../types";

export interface Poi {
  kind: "cafe" | "pub";
  hours?: string;
  website?: string;
  name: string;
  lng: number;
  lat: number;
}

const cache = new Map<string, Poi[]>();

/** Sample the route every ~700 m for a corridor query, capped for URL sanity. */
function corridor(route: Route, maxPts = 180): LngLat[] {
  const step = Math.max(1, Math.floor(route.coords.length / maxPts));
  const pts: LngLat[] = [];
  for (let i = 0; i < route.coords.length; i += step) pts.push(route.coords[i]);
  pts.push(route.coords[route.coords.length - 1]);
  return pts;
}

/** Cafés and pubs within ~350 m of the route. Public Overpass API; may be slow. */
export async function fetchPois(route: Route): Promise<Poi[]> {
  const hit = cache.get(route.id);
  if (hit) return hit;
  const line = corridor(route)
    .map(([lng, lat]) => `${lat.toFixed(4)},${lng.toFixed(4)}`)
    .join(",");
  const query = `[out:json][timeout:25];(
nwr["amenity"="cafe"](around:350,${line});
nwr["amenity"="pub"](around:350,${line});
);out center 120;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = (await res.json()) as {
    elements: { tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }[];
  };
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
      lng: lon,
      lat,
    });
  }
  cache.set(route.id, pois);
  return pois;
}
