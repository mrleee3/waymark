import { useMemo, useState } from "react";
import { actions, useStore } from "../store";
import { haversine, pointAt } from "../lib/geo";
import { km, metres } from "../lib/format";
import { mapBus } from "../lib/mapbus";
import {
  BUDGET_LABEL, buildPlans, fmtMins, trainTimesUrl,
} from "../lib/plan";
import type { Budget, Plan, PlanKind } from "../lib/plan";
import type { Route, Station } from "../types";

const KIND_LABEL: Record<PlanKind, string> = {
  simplest: "Simplest day",
  best: "Best ride",
  most: "Most riding",
};

function titleFor(kinds: PlanKind[]): string {
  return kinds.map((k) => KIND_LABEL[k]).join(" · ");
}

/* ------------------------- home station picker ------------------------- */

function HomePicker({ stations, onPick }: { stations: Station[]; onPick: (s: Station) => void }) {
  const [q, setQ] = useState("");
  const [locating, setLocating] = useState(false);
  const [locErr, setLocErr] = useState(false);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const starts = stations.filter((s) => s.name.toLowerCase().startsWith(t));
    const contains = stations.filter((s) => !s.name.toLowerCase().startsWith(t) && s.name.toLowerCase().includes(t));
    return [...starts, ...contains].slice(0, 6);
  }, [q, stations]);

  function useLocation(): void {
    setLocating(true);
    setLocErr(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const p: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        let best: Station | null = null, bestD = Infinity;
        for (const s of stations) {
          const d = haversine([s.lng, s.lat], p);
          if (d < bestD) { bestD = d; best = s; }
        }
        if (best) onPick(best);
      },
      () => { setLocating(false); setLocErr(true); },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  }

  return (
    <div className="homepick">
      <label className="homepick__label" htmlFor="homepick-input">Which station do you start from?</label>
      <input
        id="homepick-input"
        className="homepick__input"
        type="search"
        placeholder="Type your home station…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
        autoCorrect="off"
      />
      {matches.length > 0 && (
        <ul className="homepick__list">
          {matches.map((s) => (
            <li key={s.name}>
              <button type="button" onClick={() => onPick(s)}>{s.name}</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn--sm homepick__loc" disabled={locating} onClick={useLocation}>
        {locating ? "Finding nearest station…" : "Use my location"}
      </button>
      {locErr && <p className="homepick__err">Couldn't get a location — type the station name instead.</p>}
      <p className="homepick__note">Saved on this device, used for every plan.</p>
    </div>
  );
}

/* ------------------------------ plan card ------------------------------ */

function PlanCard({ plan, home, route }: { plan: Plan; home: Station; route: Route }) {
  const active = useStore((s) => s.plan === plan);

  function show(): void {
    actions.choosePlan(plan);
    const a = pointAt(route, plan.lo);
    const b = pointAt(route, plan.hi);
    const pts = [a, b, [plan.out.s.lng, plan.out.s.lat], [plan.back.s.lng, plan.back.s.lat]] as [number, number][];
    mapBus.fit([
      Math.min(...pts.map((p) => p[0])),
      Math.min(...pts.map((p) => p[1])),
      Math.max(...pts.map((p) => p[0])),
      Math.max(...pts.map((p) => p[1])),
    ]);
  }

  return (
    <article className={`plancard ${active ? "plancard--on" : ""}`}>
      <header className="plancard__head">
        <h4>{titleFor(plan.kinds)}</h4>
        <span className="plancard__door">≈ {fmtMins(plan.doorMin)} door to door</span>
      </header>
      <p className="plancard__why">{plan.why}</p>

      <ol className="plancard__legs">
        {plan.railOut.minutes > 0 && (
          <li className="plancard__leg">
            <span className="plancard__ico" aria-hidden="true">🚆</span>
            <span className="plancard__what">{home.name} → {plan.out.s.name}</span>
            <a className="plancard__time" href={trainTimesUrl(home.name, plan.out.s.name)} target="_blank" rel="noopener">
              ~{fmtMins(plan.railOut.minutes)} ↗
            </a>
          </li>
        )}
        <li className="plancard__leg">
          <span className="plancard__ico" aria-hidden="true">🚴</span>
          <span className="plancard__what">
            {plan.outAndBack
              ? `From ${plan.out.s.name}, out & back · ${km(plan.rideKm)}`
              : `${plan.out.s.name} → ${plan.back.s.name} · ${km(plan.rideKm)}`}
            {route.hasEle ? ` · ↑ ${metres(plan.ascentM)}` : ""} · {plan.tfPct}% traffic-free
          </span>
          <span className="plancard__time">~{fmtMins(plan.ride.likely)}</span>
        </li>
        <li className="plancard__paces">fast {fmtMins(plan.ride.fast)} · relaxed {fmtMins(plan.ride.relaxed)}</li>
        {plan.railBack.minutes > 0 && (
          <li className="plancard__leg">
            <span className="plancard__ico" aria-hidden="true">🚆</span>
            <span className="plancard__what">{plan.back.s.name} → {home.name}</span>
            <a className="plancard__time" href={trainTimesUrl(plan.back.s.name, home.name)} target="_blank" rel="noopener">
              ~{fmtMins(plan.railBack.minutes)} ↗
            </a>
          </li>
        )}
      </ol>

      {plan.bailouts.length > 0 && (
        <p className="plancard__bail">
          Bail out at{" "}
          {plan.bailouts.map(({ c, kmFromStart }, i) => (
            <span key={c.s.name}>
              {i > 0 && ", "}
              <button
                type="button"
                className="plancard__bailstn"
                onClick={() => mapBus.fly([c.s.lng, c.s.lat], 12.5)}
                title="Show on map"
              >
                {c.s.name}
              </button>{" "}
              ({Math.round(kmFromStart)} km)
            </span>
          ))}
        </p>
      )}

      <div className="plancard__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={show}>
          {active ? "Shown on map" : "Show on map"}
        </button>
      </div>
    </article>
  );
}

/* -------------------------------- planner -------------------------------- */

export function Planner({ route }: { route: Route }) {
  const stations = useStore((s) => s.stations);
  const homeName = useStore((s) => s.homeStationName);
  const budget = useStore((s) => s.budget);
  const [changingHome, setChangingHome] = useState(false);

  const home = useMemo(
    () => (homeName ? stations.find((s) => s.name === homeName) ?? null : null),
    [homeName, stations]
  );

  const result = useMemo(
    () => (home ? buildPlans(route, stations, home, budget) : null),
    [route, stations, home, budget]
  );

  const needsHome = !home || changingHome;

  return (
    <div className="detail planner">
      <div className="detail__top">
        <button type="button" className="detail__back" onClick={() => actions.setPlanning(false)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Route details
        </button>
      </div>

      <header className="planner__head">
        <h2>Plan a day out</h2>
        <p className="planner__route">{route.name}</p>
      </header>

      <div className="planner__modes" role="group" aria-label="How are you getting there?">
        <span className="chip chip--on">🚆 Train from home</span>
        <span className="chip chip--soon" title="Coming next">🚗 Drive to a station</span>
        <span className="chip chip--soon" title="Coming next">🚴 Ride from home</span>
      </div>

      {needsHome ? (
        <HomePicker
          stations={stations}
          onPick={(s) => { actions.setHomeStation(s.name); setChangingHome(false); }}
        />
      ) : (
        <>
          <div className="planner__from">
            From <strong>{home.name}</strong>
            <button type="button" className="planner__change" onClick={() => setChangingHome(true)}>change</button>
          </div>

          <div className="planner__budget" role="group" aria-label="How long do you want to be out?">
            {(["half", "full", "epic"] as Budget[]).map((b) => (
              <button
                key={b}
                type="button"
                className={`chip ${budget === b ? "chip--on" : ""}`}
                onClick={() => actions.setBudget(b)}
              >
                {BUDGET_LABEL[b]}
              </button>
            ))}
          </div>

          {result && result.candidates.length === 0 ? (
            <div className="empty">
              <p>No stations within 3 km of this route.</p>
              <p>Try another route — or the drive-to-a-station mode, coming next.</p>
            </div>
          ) : result && result.plans.length === 0 ? (
            <div className="empty">
              <p>Nothing fits in a {BUDGET_LABEL[budget].toLowerCase()} from {home.name}.</p>
              <p>Try a longer day, or a route closer to home.</p>
            </div>
          ) : result ? (
            <div className="planner__plans">
              {result.plans.map((p) => (
                <PlanCard key={`${p.out.s.name}-${p.back.s.name}-${p.lo.toFixed(3)}`} plan={p} home={home} route={route} />
              ))}
            </div>
          ) : null}

          <p className="planner__note">
            Train times are rough estimates from distance — tap a train leg for live times before you set off.
            Bike space rules vary by operator; peak services can refuse bikes.
          </p>
        </>
      )}
    </div>
  );
}
