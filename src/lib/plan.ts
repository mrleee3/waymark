import { clipStats, eleAt, haversine, nearestFraction } from "./geo";
import { CRS } from "../data/crs";
import type { Route, Station } from "../types";

/*
 * Day-out planner — MVP1 (train-from-home mode).
 *
 * Everything here is an ESTIMATE from geometry: no timetables are consulted.
 * Rail minutes come from crow-fly distance × a wiggle factor at banded average
 * speeds; ride minutes from surface-weighted speeds plus a climb allowance.
 * Each plan deep-links to live train times so the numbers can be checked in
 * one tap. MVP2 (static timetable ingest) replaces the rail model with real
 * connections, changes and last-bike-train logic.
 */

export type Budget = "half" | "full" | "epic";
export type PlanKind = "simplest" | "best" | "most";
export type RideShape = "any" | "ab" | "oab";

export interface PlanPrefs {
  /** any = let the planner choose; ab = A→B only; oab = out-and-back only */
  shape: RideShape;
  /** ride distance window in km; 0 for either bound means "no limit" */
  kmMin: number;
  kmMax: number;
  /** longest acceptable single train leg in minutes; 0 = no limit */
  maxLegMin: number;
  /** how far to ride between station and route, km; 0 = default 3 km */
  maxLinkKm: number;
}

export const DEFAULT_PLAN_PREFS: PlanPrefs = { shape: "any", kmMin: 0, kmMax: 0, maxLegMin: 0, maxLinkKm: 0 };

export const BUDGET_MIN: Record<Budget, number> = { half: 270, full: 420, epic: 570 };
export const BUDGET_LABEL: Record<Budget, string> = { half: "Half day", full: "Full day", epic: "All day" };

/** Fixed non-riding overhead: tickets, platforms, a coffee, faff. */
const DAY_OVERHEAD_MIN = 40;
/** Stations further than this from the route aren't candidates. */
const MAX_STATION_TO_ROUTE_M = 3000;
/** Plans with less riding than this aren't worth a train ticket. */
const MIN_RIDE_KM = 10;

export interface CandidateStation {
  s: Station;
  /** position along the route, 0–1 */
  frac: number;
  /** crow-fly metres from station to the nearest point of the route */
  toRouteM: number;
}

export interface RailLeg {
  from: string;
  to: string;
  /** door-to-door estimate incl. a wait/board allowance */
  minutes: number;
  crowKm: number;
}

export interface RideTimes {
  fast: number;
  likely: number;
  relaxed: number;
}

export interface Plan {
  kinds: PlanKind[];
  out: CandidateStation;
  back: CandidateStation;
  /** same station both ways → ride out-and-back along the route */
  outAndBack: boolean;
  /** ridden section as route fractions, lo ≤ hi */
  lo: number;
  hi: number;
  /** true when the ride runs hi → lo (towards the route start) */
  reversed: boolean;
  rideKm: number;
  ascentM: number;
  tfPct: number;
  ride: RideTimes;
  /** estimated station↔route link riding, both ends combined (km) */
  linkKm: number;
  railOut: RailLeg;
  railBack: RailLeg;
  /** whole-day estimate at the "likely" pace */
  doorMin: number;
  bailouts: { c: CandidateStation; kmFromStart: number }[];
  why: string;
}

/* ------------------------------ rail estimate ------------------------------ */

function railMinutes(crowKm: number): number {
  if (crowKm < 0.8) return 0; // boarding at the home station itself
  const railKm = crowKm * 1.22; // tracks wiggle
  const speed = crowKm <= 10 ? 36 : crowKm <= 30 ? 48 : crowKm <= 60 ? 60 : crowKm <= 120 ? 72 : 85;
  return Math.round((railKm / speed) * 60 + 12);
}

export function railLeg(from: Station, to: Station): RailLeg {
  const crowKm = haversine([from.lng, from.lat], [to.lng, to.lat]) / 1000;
  return { from: from.name, to: to.name, minutes: railMinutes(crowKm), crowKm };
}

/** Live-times deep link — traintimes.org.uk by CRS, Google transit as fallback. */
export function trainTimesUrl(fromName: string, toName: string): string {
  const f = CRS[fromName];
  const t = CRS[toName];
  if (f && t) return `https://traintimes.org.uk/${f}/${t}`;
  const q = (n: string) => encodeURIComponent(`${n} railway station`);
  return `https://www.google.com/maps/dir/?api=1&origin=${q(fromName)}&destination=${q(toName)}&travelmode=transit`;
}

/* ------------------------------ ride estimate ------------------------------ */

const SPEEDS: Record<keyof RideTimes, { road: number; tf: number; climbPer100m: number }> = {
  fast: { road: 21, tf: 18, climbPer100m: 4 },
  likely: { road: 16.5, tf: 14, climbPer100m: 6.5 },
  relaxed: { road: 13, tf: 11, climbPer100m: 9.5 },
};

/** Traffic-free fraction of the section [lo, hi] from the route's surface spans. */
export function sectionTfFraction(route: Route, lo: number, hi: number): number {
  const spans = route.surf.length ? route.surf : ([[0, 1]] as [number, number][]);
  if (hi <= lo) return 0;
  let tf = 0;
  for (let i = 0; i < spans.length; i++) {
    const s = Math.max(lo, spans[i][0]);
    const e = Math.min(hi, i + 1 < spans.length ? spans[i + 1][0] : 1);
    if (e > s && spans[i][1] === 1) tf += e - s;
  }
  return tf / (hi - lo);
}

export function rideTimes(distKm: number, ascentM: number, tfFrac: number): RideTimes {
  const t = (k: keyof RideTimes) => {
    const sp = SPEEDS[k];
    const speed = sp.tf * tfFrac + sp.road * (1 - tfFrac);
    return Math.round((distKm / speed) * 60 * 1.06 + (ascentM / 100) * sp.climbPer100m);
  };
  return { fast: t("fast"), likely: t("likely"), relaxed: t("relaxed") };
}

/* ------------------------------ candidates ------------------------------ */

export function stationsAlong(route: Route, stations: Station[], maxM = MAX_STATION_TO_ROUTE_M): CandidateStation[] {
  const out: CandidateStation[] = [];
  const seen = new Set<string>();
  for (const s of stations) {
    if (
      s.lng < route.bbox[0] - 0.1 || s.lng > route.bbox[2] + 0.1 ||
      s.lat < route.bbox[1] - 0.07 || s.lat > route.bbox[3] + 0.07
    ) continue;
    let best = Infinity;
    for (let i = 0; i < route.coords.length; i += 2) {
      const d = haversine(route.coords[i], [s.lng, s.lat]);
      if (d < best) best = d;
    }
    if (best > maxM || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ s, frac: nearestFraction(route, [s.lng, s.lat]), toRouteM: best });
  }
  return out.sort((a, b) => a.frac - b.frac);
}

/* ------------------------------ plan search ------------------------------ */

interface Leg {
  lo: number;
  hi: number;
  km: number;
  ascentM: number;
  tfPct: number;
  ride: RideTimes;
}

function legStats(route: Route, lo: number, hi: number, opts: { double?: boolean; reversed?: boolean } = {}): Leg {
  const cs = clipStats(route, lo, hi);
  const tfFrac = sectionTfFraction(route, lo, hi);
  // Climbing depends on direction: riding hi→lo climbs what lo→hi descends.
  const up = cs.ascentM;
  const net = route.hasEle ? eleAt(route, hi) - eleAt(route, lo) : 0;
  const upRev = Math.max(0, Math.round(up - net));
  const km = cs.lengthKm * (opts.double ? 2 : 1);
  const ascent = opts.double ? up + upRev : opts.reversed ? upRev : up;
  return { lo, hi, km, ascentM: ascent, tfPct: Math.round(tfFrac * 100), ride: rideTimes(km, ascent, tfFrac) };
}

/** Station↔route link riding, both ends: crow-fly × 1.35, ~12 km/h + faff. */
function linkKmOf(a: CandidateStation, b: CandidateStation): number {
  return ((a.toRouteM + b.toRouteM) * 1.35) / 1000;
}
function linkMinutes(linkKm: number): number {
  return Math.round((linkKm / 12) * 60 + (linkKm > 0.2 ? 6 : 0));
}

function bailoutsBetween(cands: CandidateStation[], route: Route, plan: { lo: number; hi: number; reversed: boolean; out: CandidateStation; back: CandidateStation }) {
  const startFrac = plan.reversed ? plan.hi : plan.lo;
  const total = route.cum[route.cum.length - 1] / 1000;
  return cands
    .filter((c) => c.frac > plan.lo + 0.01 && c.frac < plan.hi - 0.01 && c !== plan.out && c !== plan.back)
    .map((c) => ({ c, kmFromStart: Math.abs(c.frac - startFrac) * total }))
    .sort((a, b) => a.kmFromStart - b.kmFromStart)
    .slice(0, 5);
}

/**
 * Grow an out-and-back ride from a single station so its "likely" time fills
 * the given ride budget. Direction (towards start or end) is chosen for the
 * better surface mix, then extent found by binary search.
 */
function outAndBackLeg(route: Route, c: CandidateStation, rideBudgetMin: number, kmMax = 0): Leg | null {
  const build = (towardsEnd: boolean, span: number): Leg =>
    towardsEnd ? legStats(route, c.frac, Math.min(1, c.frac + span), { double: true }) : legStats(route, Math.max(0, c.frac - span), c.frac, { double: true });
  const fits = (leg: Leg) => leg.ride.likely <= rideBudgetMin && (kmMax <= 0 || leg.km <= kmMax * 1.02);
  const fit = (towardsEnd: boolean): Leg | null => {
    const maxSpan = towardsEnd ? 1 - c.frac : c.frac;
    if (maxSpan < 0.02) return null;
    let lo = 0.01, hi = maxSpan;
    if (fits(build(towardsEnd, hi))) return build(towardsEnd, hi);
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(build(towardsEnd, mid))) lo = mid;
      else hi = mid;
    }
    return build(towardsEnd, lo);
  };
  const a = fit(true);
  const b = fit(false);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  // prefer more traffic-free; tie-break on distance
  return a.tfPct + a.km * 0.3 >= b.tfPct + b.km * 0.3 ? a : b;
}

export function buildPlans(
  route: Route,
  stations: Station[],
  home: Station,
  budget: Budget,
  prefs: PlanPrefs = DEFAULT_PLAN_PREFS
): { plans: Plan[]; candidates: CandidateStation[] } {
  const candidates = stationsAlong(route, stations, prefs.maxLinkKm > 0 ? prefs.maxLinkKm * 1000 : MAX_STATION_TO_ROUTE_M);
  const budgetMin = BUDGET_MIN[budget];
  const all: Plan[] = [];

  const railTo = new Map<string, RailLeg>();
  const railFrom = new Map<string, RailLeg>();
  for (const c of candidates) {
    railTo.set(c.s.name, railLeg(home, c.s));
    railFrom.set(c.s.name, railLeg(c.s, home));
  }

  const kmFloor = Math.max(MIN_RIDE_KM, prefs.kmMin);
  const push = (p: Omit<Plan, "kinds" | "why" | "bailouts">) => {
    if (prefs.shape === "ab" && p.outAndBack) return;
    if (prefs.shape === "oab" && !p.outAndBack) return;
    if (p.rideKm < kmFloor) return;
    if (prefs.kmMax > 0 && p.rideKm > prefs.kmMax * 1.05) return;
    if (prefs.maxLegMin > 0 && (p.railOut.minutes > prefs.maxLegMin || p.railBack.minutes > prefs.maxLegMin)) return;
    if (p.doorMin > budgetMin * 1.08) return;
    all.push({ ...p, kinds: [], why: "", bailouts: bailoutsBetween(candidates, route, p) });
  };

  // A→B plans: each station pair, ridden in whichever direction descends overall.
  // (Rail estimates are symmetric, so direction is the rider's choice — take the
  // net downhill. Real timetables in MVP2 will make direction a rail question too.)
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const lo = candidates[i], hi = candidates[j];
      if (hi.frac - lo.frac < 0.03) continue;
      const reversed = route.hasEle && eleAt(route, hi.frac) - eleAt(route, lo.frac) > 15;
      const leg = legStats(route, lo.frac, hi.frac, { reversed });
      const out = reversed ? hi : lo;
      const back = reversed ? lo : hi;
      const railOut = railTo.get(out.s.name)!;
      const railBack = railFrom.get(back.s.name)!;
      const linkKm = linkKmOf(out, back);
      const doorMin =
        railOut.minutes + railBack.minutes + leg.ride.likely + linkMinutes(linkKm) + DAY_OVERHEAD_MIN;
      push({
        out, back, outAndBack: false, lo: leg.lo, hi: leg.hi, reversed,
        rideKm: leg.km + linkKm, ascentM: leg.ascentM, tfPct: leg.tfPct, ride: leg.ride,
        linkKm, railOut, railBack, doorMin,
      });
    }
  }

  // out-and-back plans: one station, ride sized to the day
  for (const c of candidates) {
    if (prefs.shape === "ab") break;
    const railOut = railTo.get(c.s.name)!;
    const railBack = railFrom.get(c.s.name)!;
    if (prefs.maxLegMin > 0 && (railOut.minutes > prefs.maxLegMin || railBack.minutes > prefs.maxLegMin)) continue;
    const linkKm = ((c.toRouteM * 2) * 1.35) / 1000;
    const rideBudget = budgetMin - railOut.minutes - railBack.minutes - linkMinutes(linkKm) - DAY_OVERHEAD_MIN;
    if (rideBudget < 45) continue;
    const leg = outAndBackLeg(route, c, rideBudget, prefs.kmMax);
    if (!leg) continue;
    const doorMin = railOut.minutes + railBack.minutes + leg.ride.likely + linkMinutes(linkKm) + DAY_OVERHEAD_MIN;
    push({
      out: c, back: c, outAndBack: true, lo: leg.lo, hi: leg.hi, reversed: false,
      rideKm: leg.km + linkKm, ascentM: leg.ascentM, tfPct: leg.tfPct, ride: leg.ride,
      linkKm, railOut, railBack, doorMin,
    });
  }

  if (!all.length) return { plans: [], candidates };

  /* pick the three answers */
  const railSum = (p: Plan) => p.railOut.minutes + p.railBack.minutes;

  const simplest = [...all].sort(
    (a, b) =>
      railSum(a) + (a.outAndBack ? 0 : 18) + a.linkKm * 3 - a.rideKm * 0.15 -
      (railSum(b) + (b.outAndBack ? 0 : 18) + b.linkKm * 3 - b.rideKm * 0.15)
  )[0];

  const idealRide = Math.max(90, (budgetMin - railSum(simplest)) * 0.62);
  const best = [...all].sort((a, b) => {
    const q = (p: Plan) =>
      p.tfPct - (Math.abs(p.ride.likely - idealRide) / idealRide) * 45 - p.linkKm * 2.5 -
      (prefs.shape === "any" && p.outAndBack ? 4 : 0);
    return q(b) - q(a);
  })[0];

  const most = [...all].sort((a, b) => b.rideKm - a.rideKm || railSum(a) - railSum(b))[0];

  simplest.kinds.push("simplest");
  simplest.why = simplest.outAndBack && simplest.railOut.minutes === 0
    ? `No train at all — roll out from ${simplest.out.s.name} and ride the route from your doorstep.`
    : simplest.outAndBack
    ? `One station, one return ticket — out and back along the route from ${simplest.out.s.name}.`
    : `The least time on trains for a proper ride: ~${simplest.railOut.minutes} min out, ~${simplest.railBack.minutes} min home.`;

  if (!best.kinds.length) best.why = `${best.tfPct}% traffic-free — the best riding this route offers in your day.`;
  best.kinds.push("best");

  if (!most.kinds.length) most.why = `Every rideable kilometre that still gets you home — ${Math.round(most.rideKm)} km door to door.`;
  most.kinds.push("most");

  const dedup: Plan[] = [];
  for (const p of [simplest, best, most]) if (!dedup.includes(p)) dedup.push(p);
  return { plans: dedup, candidates };
}

export function fmtMins(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}
