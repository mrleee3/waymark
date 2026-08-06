import type { LngLat, RawRoute, Route } from "../types";

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function decodePolyline(str: string): LngLat[] {
  const coords: LngLat[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1] as const) {
      let result = 0, shift = 0, b: number;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

/** Smoothed positive-delta sum — avoids counting sensor/synth noise as climbing. */
export function ascent(ele: number[]): number {
  let up = 0;
  let anchor = ele[0] ?? 0;
  for (let i = 1; i < ele.length; i++) {
    const d = ele[i] - anchor;
    if (d >= 3) { up += d; anchor = ele[i]; }
    else if (d < 0) anchor = ele[i];
  }
  return Math.round(up);
}

export function enrichRoute(raw: RawRoute): Route {
  const coords = decodePolyline(raw.poly);
  const cum: number[] = [0];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    if (lng < w) w = lng; if (lng > e) e = lng;
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (i > 0) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  }
  const lengthM = cum[cum.length - 1];
  // traffic-free % from surface spans
  const spans = raw.surf.length ? raw.surf : ([[0, 1]] as [number, number][]);
  let tf = 0;
  for (let i = 0; i < spans.length; i++) {
    const start = spans[i][0];
    const end = i + 1 < spans.length ? spans[i + 1][0] : 1;
    if (spans[i][1] === 1) tf += end - start;
  }
  const circular = lengthM > 5000 && haversine(coords[0], coords[coords.length - 1]) < 1200;
  return {
    ...raw,
    coords,
    cum,
    lengthKm: lengthM / 1000,
    ascentM: ascent(raw.ele),
    trafficFreePct: Math.round(tf * 100),
    circular,
    bbox: [w, s, e, n],
    minEle: Math.min(...raw.ele),
    maxEle: Math.max(...raw.ele),
    hasEle: raw.ele.some((v) => v > 0),
  };
}

/** Position along the route (0–1) → interpolated coordinate. */
export function pointAt(route: Route, t: number): LngLat {
  const target = t * route.cum[route.cum.length - 1];
  const i = lowerBound(route.cum, target);
  if (i <= 0) return route.coords[0];
  if (i >= route.coords.length) return route.coords[route.coords.length - 1];
  const seg = route.cum[i] - route.cum[i - 1] || 1;
  const f = (target - route.cum[i - 1]) / seg;
  const a = route.coords[i - 1], b = route.coords[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Elevation at fraction t (linear between samples). */
export function eleAt(route: Route, t: number): number {
  const x = t * (route.ele.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = route.ele[Math.min(i, route.ele.length - 1)];
  const b = route.ele[Math.min(i + 1, route.ele.length - 1)];
  return a + (b - a) * f;
}

/** Nearest fraction (0–1) along the route to an arbitrary point. */
export function nearestFraction(route: Route, p: LngLat): number {
  let best = 0, bestD = Infinity;
  // vertex-level is plenty at our sampling density (~160 m)
  for (let i = 0; i < route.coords.length; i++) {
    const d = haversine(route.coords[i], p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return route.cum[best] / route.cum[route.cum.length - 1];
}

/** Shortest distance (m) from a point to the route (vertex approximation). */
export function distanceToRoute(route: Route, p: LngLat): number {
  let bestD = Infinity;
  for (let i = 0; i < route.coords.length; i += 2) {
    const d = haversine(route.coords[i], p);
    if (d < bestD) bestD = d;
  }
  return bestD;
}

/** Stats for a clipped section [a, b] of the route (fractions). */
export function clipStats(route: Route, a: number, b: number) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const total = route.cum[route.cum.length - 1];
  const lengthKm = ((hi - lo) * total) / 1000;
  const i0 = Math.round(lo * (route.ele.length - 1));
  const i1 = Math.round(hi * (route.ele.length - 1));
  const ele = route.ele.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
  return { lengthKm, ascentM: ascent(ele) };
}

/** Coordinates + elevations for a clipped section, for GPX export. */
export function clipGeometry(route: Route, a: number, b: number): { coords: LngLat[]; ele: number[] } {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const total = route.cum[route.cum.length - 1];
  const from = lo * total, to = hi * total;
  const coords: LngLat[] = [pointAt(route, lo)];
  const ele: number[] = [Math.round(eleAt(route, lo))];
  for (let i = 0; i < route.coords.length; i++) {
    if (route.cum[i] > from && route.cum[i] < to) {
      coords.push(route.coords[i]);
      ele.push(route.ele[Math.min(i, route.ele.length - 1)]);
    }
  }
  coords.push(pointAt(route, hi));
  ele.push(Math.round(eleAt(route, hi)));
  return { coords, ele };
}

function lowerBound(arr: number[], v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A view of the route ridden the other way: geometry, elevation, surface
 *  spans and the name's arrow all flipped. Same id, so caches still match. */
export function reverseRoute(r: Route): Route {
  const coords = [...r.coords].reverse();
  const ele = [...r.ele].reverse();
  const n = r.cum.length;
  const total = r.cum[n - 1];
  const cum = new Array<number>(n);
  for (let i = 0; i < n; i++) cum[i] = total - r.cum[n - 1 - i];
  const spans = r.surf.length ? r.surf : ([[0, 1]] as [number, number][]);
  const segs = spans.map((sp, i) => ({ b: i + 1 < spans.length ? spans[i + 1][0] : 1, cls: sp[1] }));
  const surf = segs.reverse().map((g) => [Number((1 - g.b).toFixed(6)), g.cls] as [number, number]);
  const flip = (t: string) => (t.includes("→") ? t.split("→").map((x) => x.trim()).reverse().join(" → ") : t);
  const span = r.span ? flip(r.span) : r.span;
  const name =
    r.span && span && r.name.includes(r.span) ? r.name.replace(r.span, span) : flip(r.name);
  return { ...r, coords, ele, cum, surf, span, name, ascentM: ascent(ele) };
}
