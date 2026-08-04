import { haversine, nearestFraction, pointAt } from "./geo";
import type { LngLat, Route, Station } from "../types";

export interface StationLink {
  station: Station;
  coords: LngLat[];
  lengthM: number;
  /** "bike" = routed by BRouter; "straight" = fallback crow-flies line */
  mode: "bike" | "straight";
}

/**
 * Cycleable link from a station to the nearest point on the route.
 * Uses the public BRouter server (trekking profile); falls back to a straight
 * line if routing is unavailable.
 */
export async function fetchStationLink(route: Route, station: Station): Promise<StationLink> {
  const from: LngLat = [station.lng, station.lat];
  const to = pointAt(route, nearestFraction(route, from));
  try {
    const url =
      `https://brouter.de/brouter?lonlats=${from[0].toFixed(5)},${from[1].toFixed(5)}|${to[0].toFixed(5)},${to[1].toFixed(5)}` +
      `&profile=trekking&alternativeidx=0&format=geojson`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`BRouter ${res.status}`);
    const gj = (await res.json()) as {
      features?: { geometry?: { coordinates?: [number, number, number?][] }; properties?: { "track-length"?: string } }[];
    };
    const f = gj.features?.[0];
    const coords = (f?.geometry?.coordinates ?? []).map(([lng, lat]) => [lng, lat] as LngLat);
    if (coords.length < 2) throw new Error("empty track");
    const lengthM = +(f?.properties?.["track-length"] ?? 0) || lineLen(coords);
    return { station, coords, lengthM, mode: "bike" };
  } catch {
    return { station, coords: [from, to], lengthM: haversine(from, to), mode: "straight" };
  }
}

function lineLen(coords: LngLat[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1], coords[i]);
  return m;
}
