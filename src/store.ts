import { useSyncExternalStore } from "react";
import { DEFAULT_FILTERS } from "./types";
import type { Filters, Place, Route, Station } from "./types";
import { distanceToRoute } from "./lib/geo";
import type { LoadedNetwork } from "./data/loader";
import type { Poi } from "./lib/pois";
import type { StationLink } from "./lib/link";
import { DEFAULT_PLAN_PREFS } from "./lib/plan";
import type { Budget, Plan, PlanPrefs } from "./lib/plan";

export type Theme = "light" | "dark";
export type SheetPos = "peek" | "half" | "full";

export interface State {
  loaded: boolean;
  loadError: string | null;
  sample: boolean;
  attribution: string;
  routes: Route[];
  stations: Station[];
  places: Place[];
  selectedId: string | null;
  /** Section clip as route fractions [a, b]; null = whole route. */
  clip: [number, number] | null;
  clipping: boolean;
  /** Hover position along the selected route (0–1) for the linked cursor. */
  cursor: number | null;
  filters: Filters;
  filtersOpen: boolean;
  shortlist: string[];
  theme: Theme;
  sheet: SheetPos;
  sampleNoticeDismissed: boolean;
  generated: string;
  live: boolean;
  /** false when the payload carries no usable surface data */
  hasSurface: boolean;
  /** map layer visibility (the 🚉 / ☕ buttons on the map) */
  showStations: boolean;
  showPois: boolean;
  locPromptDismissed: boolean;
  /** Cafés & pubs for the selected route. */
  pois: { status: "idle" | "loading" | "ready" | "error"; items: Poi[] };
  /** Bike link from a chosen station to the selected route. */
  stationLink: { status: "idle" | "loading" | "ready"; link: StationLink | null };
  /** Day-out planner. */
  planning: boolean;
  homeStationName: string | null;
  budget: Budget;
  planPrefs: PlanPrefs;
  plan: Plan | null;
}

const LS = {
  shortlist: "waymark.shortlist",
  theme: "waymark.theme",
  notice: "waymark.sampleNoticeDismissed",
  locPrompt: "waymark.locPromptDismissed",
  home: "waymark.homeStation",
  budget: "waymark.budget",
  planPrefs: "waymark.planPrefs",
};

function loadPlanPrefs(): PlanPrefs {
  try {
    const raw = safeGet(LS.planPrefs);
    if (!raw) return { ...DEFAULT_PLAN_PREFS };
    const p = JSON.parse(raw) as Partial<PlanPrefs>;
    return {
      shape: p.shape === "ab" || p.shape === "oab" ? p.shape : "any",
      kmMin: typeof p.kmMin === "number" && p.kmMin > 0 ? p.kmMin : 0,
      kmMax: typeof p.kmMax === "number" && p.kmMax > 0 ? p.kmMax : 0,
      maxLegMin: typeof p.maxLegMin === "number" && p.maxLegMin > 0 ? p.maxLegMin : 0,
      maxLinkKm: typeof p.maxLinkKm === "number" && p.maxLinkKm > 0 ? p.maxLinkKm : 0,
    };
  } catch {
    return { ...DEFAULT_PLAN_PREFS };
  }
}

function initialTheme(): Theme {
  const saved = safeGet(LS.theme);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let state: State = {
  loaded: false,
  loadError: null,
  sample: false,
  attribution: "",
  routes: [],
  stations: [],
  places: [],
  selectedId: null,
  clip: null,
  clipping: false,
  cursor: null,
  filters: { ...DEFAULT_FILTERS },
  filtersOpen: false,
  shortlist: JSON.parse(safeGet(LS.shortlist) ?? "[]"),
  theme: initialTheme(),
  sheet: "half",
  sampleNoticeDismissed: safeGet(LS.notice) === "1",
  generated: "",
  live: false,
  hasSurface: true,
  showStations: true,
  showPois: false,
  locPromptDismissed: safeGet(LS.locPrompt) === "1",
  pois: { status: "idle", items: [] },
  stationLink: { status: "idle", link: null },
  planning: false,
  homeStationName: safeGet(LS.home),
  budget: (["half", "full", "epic"].includes(safeGet(LS.budget) ?? "") ? safeGet(LS.budget) : "full") as Budget,
  planPrefs: loadPlanPrefs(),
  plan: null,
};

const listeners = new Set<() => void>();

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* private mode etc. */ }
}

export function getState(): State {
  return state;
}

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

/* --------------------------------- actions --------------------------------- */

export const actions = {
  networkLoaded(net: LoadedNetwork) {
    set({
      loaded: true,
      routes: net.routes,
      stations: net.stations,
      places: net.places,
      sample: net.sample,
      attribution: net.attribution,
      generated: net.generated,
      live: net.live,
      hasSurface: net.routes.some((r) => r.trafficFreePct > 0),
    });
    applyHash(); // now that routes exist, honour any deep link
  },
  networkFailed(message: string) {
    set({ loadError: message });
  },
  select(id: string | null, opts: { keepClip?: boolean } = {}) {
    const change = () =>
      set({
        selectedId: id,
        clip: opts.keepClip ? state.clip : null,
        clipping: opts.keepClip ? state.clipping : false,
        cursor: null,
        sheet: id ? "half" : state.sheet,
        pois: { status: "idle", items: [] },
        stationLink: { status: "idle", link: null },
        planning: false,
        plan: null,
      });
    // View Transitions API — progressive enhancement for the panel swap.
    const dvt = (document as unknown as { startViewTransition?: (cb: () => void) => void }).startViewTransition;
    if (dvt && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) dvt.call(document, change);
    else change();
    writeHash();
  },
  setClipping(on: boolean) {
    set({ clipping: on, clip: on ? state.clip ?? [0.15, 0.85] : null, plan: on ? state.plan : null });
    writeHash();
  },
  setPlanning(on: boolean) {
    set({ planning: on });
  },
  setHomeStation(name: string | null) {
    if (name) safeSet(LS.home, name);
    else { try { localStorage.removeItem(LS.home); } catch { /* ignore */ } }
    set({ homeStationName: name, plan: null });
  },
  setBudget(budget: Budget) {
    safeSet(LS.budget, budget);
    set({ budget, plan: null });
  },
  setPlanPrefs(patch: Partial<PlanPrefs>) {
    const planPrefs = { ...state.planPrefs, ...patch };
    safeSet(LS.planPrefs, JSON.stringify(planPrefs));
    set({ planPrefs, plan: null });
  },
  choosePlan(plan: Plan | null) {
    if (!plan) { set({ plan: null }); return; }
    set({ plan, clip: [plan.lo, plan.hi], clipping: true, sheet: "peek" });
    writeHash();
  },
  setClip(a: number, b: number) {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    set({ clip: [clamp(a), clamp(b)] });
    writeHashSoon();
  },
  setCursor(t: number | null) {
    set({ cursor: t });
  },
  patchFilters(patch: Partial<Filters>) {
    set({ filters: { ...state.filters, ...patch } });
  },
  resetFilters() {
    set({ filters: { ...DEFAULT_FILTERS } });
  },
  toggleFiltersOpen() {
    set({ filtersOpen: !state.filtersOpen });
  },
  toggleShortlist(id: string) {
    const has = state.shortlist.includes(id);
    const shortlist = has ? state.shortlist.filter((x) => x !== id) : [...state.shortlist, id];
    safeSet(LS.shortlist, JSON.stringify(shortlist));
    set({ shortlist });
  },
  setTheme(theme: Theme) {
    safeSet(LS.theme, theme);
    set({ theme });
  },
  setSheet(sheet: SheetPos) {
    set({ sheet });
  },
  dismissSampleNotice() {
    safeSet(LS.notice, "1");
    set({ sampleNoticeDismissed: true });
  },
  dismissLocPrompt() {
    safeSet(LS.locPrompt, "1");
    set({ locPromptDismissed: true });
  },
  setPois(status: State["pois"]["status"], items: Poi[] = state.pois.items) {
    set({ pois: { status, items } });
  },
  setStationLink(status: State["stationLink"]["status"], link: StationLink | null = state.stationLink.link) {
    set({ stationLink: { status, link } });
  },
  toggleStations() {
    const hiding = state.showStations;
    set({ showStations: !state.showStations, ...(hiding ? { stationLink: { status: "idle" as const, link: null } } : {}) });
  },
  togglePoisVisible() {
    set({ showPois: !state.showPois });
  },
};

/* ------------------------------ derived: results ---------------------------- */

export function visibleRoutes(s: State): Route[] {
  const f = s.filters;
  const q = f.q.trim().toLowerCase();
  let list = s.routes.filter((r) => {
    if (f.shortlistOnly && !s.shortlist.includes(r.id)) return false;
    if (r.lengthKm < f.lenMin || r.lengthKm > f.lenMax) return false;
    if (s.hasSurface && r.trafficFreePct < f.tfMin) return false;
    if (f.circularOnly && !r.circular) return false;
    if (q && !(`${r.ref} ${r.name} ${r.region}`.toLowerCase().includes(q))) return false;
    if (f.near && distanceToRoute(r, [f.near.lng, f.near.lat]) > f.radiusKm * 1000) return false;
    return true;
  });
  const near = f.near;
  list = [...list].sort((a, b) => {
    switch (f.sort) {
      case "longest": return b.lengthKm - a.lengthKm;
      case "shortest": return a.lengthKm - b.lengthKm;
      case "traffic-free": return b.trafficFreePct - a.trafficFreePct;
      case "nearest": {
        if (!near) return a.name.localeCompare(b.name);
        return (
          distanceToRoute(a, [near.lng, near.lat]) - distanceToRoute(b, [near.lng, near.lat])
        );
      }
    }
  });
  return list;
}

export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.lenMin !== DEFAULT_FILTERS.lenMin || f.lenMax !== DEFAULT_FILTERS.lenMax) n++;
  if (f.tfMin !== DEFAULT_FILTERS.tfMin) n++;
  if (f.circularOnly) n++;
  if (f.near) n++;
  return n;
}

/* -------------------------------- URL hash --------------------------------- */
// #r=<routeId>&c=<a>-<b>   e.g.  #r=r4-bristol-bath&c=0.12-0.55

let hashTimer: number | undefined;

function writeHash(): void {
  const p = new URLSearchParams();
  if (state.selectedId) p.set("r", state.selectedId);
  if (state.clip) p.set("c", `${state.clip[0].toFixed(3)}-${state.clip[1].toFixed(3)}`);
  const next = p.toString() ? `#${p.toString()}` : "";
  history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

function writeHashSoon(): void {
  window.clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 250);
}

function applyHash(): void {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return;
  const p = new URLSearchParams(raw);
  const id = p.get("r");
  if (id && state.routes.some((r) => r.id === id)) {
    const c = p.get("c");
    let clip: [number, number] | null = null;
    if (c) {
      const m = c.match(/^([\d.]+)-([\d.]+)$/);
      if (m) clip = [Math.min(1, +m[1]), Math.min(1, +m[2])];
    }
    set({ selectedId: id, clip, clipping: clip != null });
  }
}
