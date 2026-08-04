import { actions, useStore, visibleRoutes } from "../store";
import { km, metres } from "../lib/format";
import { Waymark } from "./Waymark";
import type { Route } from "../types";

function SurfaceBar({ route }: { route: Route }) {
  return (
    <span
      className="surfbar"
      role="img"
      aria-label={`${route.trafficFreePct}% traffic-free`}
      style={{ ["--tf-pct" as string]: `${route.trafficFreePct}%` }}
    />
  );
}

function Star({ id }: { id: string }) {
  const on = useStore((s) => s.shortlist.includes(id));
  return (
    <button
      type="button"
      className={`star ${on ? "star--on" : ""}`}
      aria-pressed={on}
      aria-label={on ? "Remove from shortlist" : "Add to shortlist"}
      onClick={(e) => {
        e.stopPropagation();
        actions.toggleShortlist(id);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z" />
      </svg>
    </button>
  );
}

export function RouteCard({ route }: { route: Route }) {
  return (
    <li>
      <article
        className="card"
        tabIndex={0}
        role="button"
        aria-label={`${route.name}, ${km(route.lengthKm)}`}
        onClick={() => actions.select(route.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            actions.select(route.id);
          }
        }}
      >
        <Waymark refNo={route.ref} />
        <div className="card__body">
          <h3 className="card__name">{route.name}</h3>
          <p className="card__meta">
            {route.span || route.region}
            {(route.span || route.region) && " · "}
            {route.circular ? "Loop" : "Point to point"}
          </p>
          <p className="card__stats">
            <span>{km(route.lengthKm)}</span>
            {route.hasEle && <span>↑ {metres(route.ascentM)}</span>}
            <span>{route.trafficFreePct}% traffic-free</span>
          </p>
          <SurfaceBar route={route} />
        </div>
        <Star id={route.id} />
      </article>
    </li>
  );
}

export function RouteList() {
  const state = useStore((s) => s);
  const routes = visibleRoutes(state);
  const shortlistOnly = state.filters.shortlistOnly;

  if (!routes.length) {
    return (
      <div className="empty">
        {shortlistOnly ? (
          <>
            <p>Nothing on your shortlist yet.</p>
            <p>Tap the star on any route to save it here.</p>
          </>
        ) : (
          <>
            <p>No routes match.</p>
            <p>Widen the length range, lower the traffic-free minimum, or increase the search radius.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <p className="list-count" aria-live="polite">
        {routes.length} route{routes.length === 1 ? "" : "s"}
      </p>
      <ul className="route-list">
        {routes.map((r) => (
          <RouteCard key={r.id} route={r} />
        ))}
      </ul>
    </>
  );
}
