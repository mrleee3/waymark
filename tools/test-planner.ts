/* Headless smoke test: decode network.data, run the planner, print the answers. */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { enrichRoute } from "../src/lib/geo";
import { buildPlans, fmtMins, trainTimesUrl, stationsAlong, DEFAULT_PLAN_PREFS } from "../src/lib/plan";
import type { PlanPrefs } from "../src/lib/plan";
import type { Budget } from "../src/lib/plan";
import type { NetworkPayload, Station } from "../src/types";

const b64 = readFileSync("network.data", "utf8").trim();
const payload = JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString()) as NetworkPayload;
const routes = payload.routes.map(enrichRoute);
const stations: Station[] = payload.stations.map(([name, lat, lng]) => ({ name, lat, lng }));
console.log(`live network: ${routes.length} routes, ${stations.length} stations, generated ${payload.generated}\n`);

function station(name: string): Station {
  const s = stations.find((x) => x.name === name);
  if (!s) throw new Error(`no station named ${name}`);
  return s;
}

function show(routeQuery: string, homeName: string, budget: Budget, prefs: Partial<PlanPrefs> = {}): void {
  const route =
    routes.find((r) => r.name.toLowerCase().includes(routeQuery.toLowerCase())) ??
    routes.find((r) => r.ref === routeQuery);
  if (!route) { console.log(`--- no route matching "${routeQuery}"`); return; }
  const home = station(homeName);
  const t0 = performance.now();
  const { plans, candidates } = buildPlans(route, stations, home, budget, { ...DEFAULT_PLAN_PREFS, ...prefs });
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`=== [${JSON.stringify(prefs)}] ${route.ref} · ${route.name} (${route.lengthKm.toFixed(0)} km, ${route.trafficFreePct}% tf) — from ${homeName}, ${budget} [${candidates.length} candidate stns, ${ms} ms]`);
  if (!plans.length) { console.log("    no plans fit\n"); return; }
  for (const p of plans) {
    console.log(`  [${p.kinds.join("+")}] ${p.why}`);
    console.log(`    out:  ${p.railOut.from} -> ${p.railOut.to}  ~${fmtMins(p.railOut.minutes)} (${p.railOut.crowKm.toFixed(0)} km crow)  ${trainTimesUrl(p.railOut.from, p.railOut.to)}`);
    console.log(`    ride: ${p.rideKm.toFixed(1)} km ${p.outAndBack ? "(out & back)" : p.reversed ? "(reversed)" : ""} up ${p.ascentM} m, ${p.tfPct}% tf — fast ${fmtMins(p.ride.fast)} / likely ${fmtMins(p.ride.likely)} / relaxed ${fmtMins(p.ride.relaxed)}  [frac ${p.lo.toFixed(2)}-${p.hi.toFixed(2)}]`);
    console.log(`    back: ${p.railBack.from} -> ${p.railBack.to}  ~${fmtMins(p.railBack.minutes)}`);
    console.log(`    door ≈ ${fmtMins(p.doorMin)}; bailouts: ${p.bailouts.map((b) => `${b.c.s.name} @${b.kmFromStart.toFixed(0)}km`).join(", ") || "none"}`);
  }
  console.log();
}

// Coverage snapshot: how many routes have usable stations at all?
let withStns = 0;
for (const r of routes) if (stationsAlong(r, stations).length >= 1) withStns++;
console.log(`${withStns}/${routes.length} routes have at least one station within 3 km\n`);

show("Hastings → London", "Tonbridge", "full");
show("Hastings → London", "Tonbridge", "full", { shape: "ab" });
show("Hastings → London", "Tonbridge", "full", { shape: "ab", kmMin: 30, kmMax: 55 });
show("Hastings → London", "Tonbridge", "full", { maxLegMin: 45 });
show("Cardiff → London", "Bristol Temple Meads", "full", { shape: "ab", kmMax: 60 });

// reversed-plan sanity: any plan riding hi -> lo must still report lo <= hi
import("../src/lib/plan").then(() => {});
let reversedSeen = 0, bad = 0;
for (const r of routes.slice(0, 120)) {
  const cands = stationsAlong(r, stations);
  if (cands.length < 2) continue;
  const { plans } = buildPlans(r, stations, station("Tonbridge"), "epic");
  for (const p of plans) {
    if (p.reversed) reversedSeen++;
    if (p.lo > p.hi || p.lo < 0 || p.hi > 1) bad++;
    if (p.doorMin > 570 * 1.09) bad++;
  }
}
console.log(`sweep: reversed plans seen ${reversedSeen}, invariant violations ${bad}`);
