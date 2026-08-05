export type LngLat = [number, number];

/** Raw payload shapes (see tools/make-sample-data.mjs header for the spec). */
export interface RawRoute {
  id: string;
  ref: string;
  name: string;
  region: string;
  span?: string;
  via?: string[];
  notes?: string;
  poly: string;
  /** straight-line connectors joined into the chain (data quality hint) */
  gaps?: number;
  ele: number[];
  surf: [number, number][]; // [startFraction, class] — 1 traffic-free, 0 on-road
}

export interface NetworkPayload {
  v: number;
  sample: boolean;
  generated: string;
  attribution: string;
  routes: RawRoute[];
  stations: [string, number, number][];
  places: [string, number, number][];
}

/** Route enriched with everything derived at load time. */
export interface Route extends RawRoute {
  coords: LngLat[];
  /** cumulative distance in metres, per vertex */
  cum: number[];
  lengthKm: number;
  ascentM: number;
  trafficFreePct: number; // 0–100
  circular: boolean;
  bbox: [number, number, number, number]; // w, s, e, n
  minEle: number;
  maxEle: number;
  /** false when the payload was built with --skip-elevation */
  hasEle: boolean;
}

export interface Station {
  name: string;
  lat: number;
  lng: number;
}

export interface Place {
  name: string;
  lat: number;
  lng: number;
}

export type SortKey = "nearest" | "longest" | "shortest" | "traffic-free";

export interface Filters {
  q: string;
  lenMin: number; // km
  lenMax: number; // km
  tfMin: number; // %
  circularOnly: boolean;
  near: { label: string; lng: number; lat: number } | null;
  radiusKm: number;
  sort: SortKey;
  shortlistOnly: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  q: "",
  lenMin: 0,
  lenMax: 999,
  tfMin: 0,
  circularOnly: false,
  near: null,
  radiusKm: 60,
  sort: "nearest",
  shortlistOnly: false,
};
