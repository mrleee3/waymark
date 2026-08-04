import { useEffect, useMemo, useState } from "react";
import { actions, useStore } from "../store";
import { clipGeometry, clipStats, haversine, pointAt } from "../lib/geo";
import { distanceAway, km, metres, rideTime } from "../lib/format";
import { buildGpx, downloadGpx } from "../lib/gpx";
import { fetchPois } from "../lib/pois";
import { mapBus } from "../lib/mapbus";
import { ElevationProfile } from "./ElevationProfile";
import { Waymark } from "./Waymark";
import type { LngLat, Route, Station } from "../types";

function nearestStations(stations: Station[], p: LngLat, n: number, maxM = 25000): { s: Station; d: number }[] {
  const out: { s: Station; d: number }[] = [];
  for (const s of stations) {
    if (Math.abs(s.lat - p[1]) > 0.6 || Math.abs(s.lng - p[0]) > 1) continue;
    out.push({ s, d: haversine([s.lng, s.lat], p) });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, n).filter((x) => x.d < maxM);
}

function StationRow({ s, d, note }: { s: Station; d: number; note?: string }) {
  return (
    <li>
      <button
        type="button"
        className="stations__row"
        onClick={() => {
          mapBus.fly([s.lng, s.lat], 12.5);
          mapBus.linkStation(s);
        }}
        title="Show on map and draw a bike link to the route"
      >
        <span className="stations__name">{s.name}</span>
        <span className="stations__d">{note ?? distanceAway(d)}</span>
      </button>
    </li>
  );
}

export function RouteDetail({ route }: { route: Route }) {
  const stations = useStore((s) => s.stations);
  const clip = useStore((s) => s.clip);
  const clipping = useStore((s) => s.clipping);
  const shortlisted = useStore((s) => s.shortlist.includes(route.id));
  const sample = useStore((s) => s.sample);
  const attribution = useStore((s) => s.attribution);
  const pois = useStore((s) => s.pois);
  const link = useStore((s) => s.stationLink);
  const [shared, setShared] = useState(false);
  const [moreStations, setMoreStations] = useState(false);

  useEffect(() => setMoreStations(false), [route.id]);

  const section = clipping && clip ? clipStats(route, clip[0], clip[1]) : null;

  const endpoints = useMemo(() => {
    const a = clipping && clip ? pointAt(route, Math.min(...clip)) : route.coords[0];
    const b = clipping && clip ? pointAt(route, Math.max(...clip)) : route.coords[route.coords.length - 1];
    return { start: nearestStations(stations, a, 2), end: nearestStations(stations, b, 2) };
  }, [route, stations, clipping, clip?.[0], clip?.[1]]);

  const alongRoute = useMemo(() => {
    if (!moreStations) return [];
    const seen = new Set([...endpoints.start, ...endpoints.end].map((x) => x.s.name));
    const out: { s: Station; d: number }[] = [];
    for (const s of stations) {
      if (seen.has(s.name)) continue;
      if (s.lng < route.bbox[0] - 0.1 || s.lng > route.bbox[2] + 0.1 || s.lat < route.bbox[1] - 0.07 || s.lat > route.bbox[3] + 0.07) continue;
      let best = Infinity;
      for (let i = 0; i < route.coords.length; i += 4) {
        const d = haversine(route.coords[i], [s.lng, s.lat]);
        if (d < best) best = d;
      }
      if (best < 3000) out.push({ s, d: best });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, 8);
  }, [moreStations, route, stations, endpoints]);

  function exportGpx(): void {
    const isClip = clipping && clip;
    const geo = isClip && clip ? clipGeometry(route, clip[0], clip[1]) : { coords: route.coords, ele: route.ele };
    const name = isClip ? `${route.name} (section)` : route.name;
    const warn = sample
      ? "SAMPLE geometry — approximate demonstration data, not for navigation. Rebuild with the live network via npm run build:data. "
      : "";
    downloadGpx(
      `waymark-${route.id}${isClip ? "-clip" : ""}.gpx`,
      buildGpx({ name, desc: `${warn}NCN Route ${route.ref}. ${attribution}`, coords: geo.coords, ele: geo.ele })
    );
  }

  async function share(): Promise<void> {
    const url = location.href;
    const data = { title: `${route.name} — Waymark`, text: `NCN ${route.ref}: ${route.name}`, url };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(url);
        setShared(true);
        setTimeout(() => setShared(false), 1800);
      }
    } catch {
      /* user cancelled */
    }
  }

  async function togglePois(): Promise<void> {
    if (pois.status === "ready") {
      actions.setPois("idle", []);
      return;
    }
    actions.setPois("loading", []);
    try {
      actions.setPois("ready", await fetchPois(route));
    } catch {
      actions.setPois("error", []);
    }
  }

  const est = section
    ? rideTime(section.lengthKm, section.ascentM)
    : rideTime(route.lengthKm, route.ascentM);
  const cafes = pois.items.filter((p) => p.kind === "cafe").length;
  const pubs = pois.items.filter((p) => p.kind === "pub").length;

  return (
    <div className="detail">
      <div className="detail__top">
        <button type="button" className="detail__back" onClick={() => actions.select(null)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          All routes
        </button>
        <button
          type="button"
          className={`star star--lg ${shortlisted ? "star--on" : ""}`}
          aria-pressed={shortlisted}
          aria-label={shortlisted ? "Remove from shortlist" : "Add to shortlist"}
          onClick={() => actions.toggleShortlist(route.id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z" />
          </svg>
        </button>
      </div>

      <header className="detail__head">
        <Waymark refNo={route.ref} size="lg" />
        <div>
          <h2 className="detail__name">{route.name}</h2>
          <p className="detail__meta">
            {route.span || route.region}
            {(route.span || route.region) && " · "}
            {route.circular ? "Loop" : "Point to point"}
          </p>
        </div>
      </header>

      {route.notes && <p className="detail__notes">{route.notes}</p>}

      <dl className="statgrid">
        <div><dt>Length</dt><dd>{km(route.lengthKm)}</dd></div>
        {route.hasEle && <div><dt>Ascent</dt><dd>↑ {metres(route.ascentM)}</dd></div>}
        <div><dt>Traffic-free</dt><dd>{route.trafficFreePct}%</dd></div>
        <div><dt>Easy pace</dt><dd>~{est}</dd></div>
      </dl>

      <div className="surfkey">
        <span className="surfbar surfbar--lg" style={{ ["--tf-pct" as string]: `${route.trafficFreePct}%` }} />
        <span className="surfkey__legend">
          <i className="surfkey__dot surfkey__dot--tf" /> traffic-free
          <i className="surfkey__dot surfkey__dot--road" /> on-road
        </span>
      </div>

      {route.hasEle ? (
        <ElevationProfile route={route} />
      ) : (
        <p className="detail__noele">
          Built without elevation data — rerun <code>npm run build:data</code> without <code>--skip-elevation</code> to add climb profiles.
        </p>
      )}

      <div className="cliprow">
        <label className="cliprow__toggle">
          <input
            type="checkbox"
            checked={clipping}
            onChange={(e) => actions.setClipping(e.target.checked)}
          />
          Clip a section
        </label>
        {section && clip && (
          <span className="cliprow__stats">
            {km(section.lengthKm)}{route.hasEle ? ` · ↑ ${metres(section.ascentM)}` : ""} · ~{est}
            <button type="button" className="cliprow__reset" onClick={() => actions.setClip(0.15, 0.85)}>
              Reset
            </button>
          </span>
        )}
      </div>

      <div className="poirow">
        <button type="button" className={`chip ${pois.status === "ready" ? "chip--on" : ""}`} onClick={() => void togglePois()}>
          {pois.status === "loading" ? "Finding cafés & pubs…" : pois.status === "ready" ? `☕ ${cafes} cafés · 🍺 ${pubs} pubs` : "Show cafés & pubs"}
        </button>
        {pois.status === "error" && <span className="poirow__err">Couldn't reach the places service — try again.</span>}
        {pois.status === "ready" && <span className="poirow__hint">Tap a dot on the map for its name.</span>}
      </div>

      {(endpoints.start.length > 0 || endpoints.end.length > 0) && (
        <section className="stations">
          <h3 className="stations__title">Train back</h3>
          <div className="stations__cols">
            <div>
              <h4>{clipping ? "Near A" : "Near the start"}</h4>
              {endpoints.start.length ? (
                <ul>{endpoints.start.map(({ s, d }) => <StationRow key={s.name} s={s} d={d} />)}</ul>
              ) : <p className="stations__none">No station within 25 km.</p>}
            </div>
            <div>
              <h4>{clipping ? "Near B" : "Near the end"}</h4>
              {endpoints.end.length ? (
                <ul>{endpoints.end.map(({ s, d }) => <StationRow key={s.name} s={s} d={d} />)}</ul>
              ) : <p className="stations__none">No station within 25 km.</p>}
            </div>
          </div>

          {moreStations && alongRoute.length > 0 && (
            <div className="stations__more">
              <h4>Along the route</h4>
              <ul>{alongRoute.map(({ s, d }) => <StationRow key={s.name} s={s} d={d} />)}</ul>
            </div>
          )}

          <div className="stations__foot">
            <button type="button" className="stations__morebtn" onClick={() => setMoreStations((v) => !v)}>
              {moreStations ? "Fewer stations" : "More stations along the route"}
            </button>
            <span className="stations__note">
              {link.status === "loading"
                ? "Finding a bike route from the station…"
                : link.status === "ready" && link.link
                  ? `${link.link.station.name} → route: ${distanceAway(link.link.lengthM)} ${link.link.mode === "bike" ? "by bike" : "straight line (routing unavailable)"}`
                  : "Tap a station to draw its bike link to the route."}
            </span>
          </div>
        </section>
      )}

      <div className="detail__actions">
        <button type="button" className="btn btn--primary" onClick={exportGpx}>
          Download GPX{clipping && clip ? " (section)" : ""}
        </button>
        <button type="button" className="btn" onClick={() => void share()}>
          {shared ? "Link copied" : "Share"}
        </button>
      </div>

      {sample && (
        <p className="detail__sample">
          Sample geometry — approximate, not for navigation. Run <code>npm run build:data</code> for the full live network.
        </p>
      )}
    </div>
  );
}
