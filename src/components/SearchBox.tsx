import { useMemo, useRef, useState } from "react";
import { actions, useStore } from "../store";
import { mapBus } from "../lib/mapbus";
import { geocodeUk } from "../lib/geocode";
import { useMyLocation } from "../lib/locate";
import { Waymark } from "./Waymark";

interface Hit {
  kind: "route" | "place" | "station" | "geocode" | "locate";
  id: string;
  label: string;
  sub?: string;
  refNo?: string;
  lng?: number;
  lat?: number;
}

export function SearchBox() {
  const routes = useStore((s) => s.routes);
  const places = useStore((s) => s.places);
  const stations = useStore((s) => s.stations);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    const out: Hit[] = [];
    if (!needle) {
      out.push({ kind: "locate", id: "locate", label: "Routes near me", sub: "Uses your location" });
      return out;
    }
    for (const r of routes) {
      if (`route ${r.ref} ${r.name} ${r.span ?? ""}`.toLowerCase().includes(needle)) {
        out.push({ kind: "route", id: r.id, label: r.name, sub: r.span || r.region, refNo: r.ref });
        if (out.length >= 5) break;
      }
    }
    for (const p of places) {
      if (out.length >= 8) break;
      if (p.name.toLowerCase().startsWith(needle))
        out.push({ kind: "place", id: `p:${p.name}`, label: p.name, sub: "Routes nearby", lng: p.lng, lat: p.lat });
    }
    if (needle.length >= 3) {
      for (const st of stations) {
        if (out.length >= 11) break;
        if (st.name.toLowerCase().startsWith(needle))
          out.push({ kind: "station", id: `s:${st.name}`, label: st.name, sub: "Station · routes nearby", lng: st.lng, lat: st.lat });
      }
      out.push({ kind: "geocode", id: "geo", label: `Find “${q.trim()}” on the map`, sub: "Any UK place" });
    }
    return out;
  }, [q, routes, places, stations]);

  function applyNear(label: string, lng: number, lat: number): void {
    actions.select(null);
    actions.patchFilters({ near: { label, lng, lat }, sort: "nearest" });
    actions.dismissLocPrompt();
    mapBus.fly([lng, lat], 9.5);
  }

  async function choose(h: Hit): Promise<void> {
    if (h.kind === "geocode") {
      setBusy(true);
      const g = await geocodeUk(q.trim());
      setBusy(false);
      setOpen(false);
      setQ("");
      if (g) applyNear(g.label, g.lng, g.lat);
      return;
    }
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
    if (h.kind === "route") actions.select(h.id);
    else if ((h.kind === "place" || h.kind === "station") && h.lng != null && h.lat != null)
      applyNear(h.label, h.lng, h.lat);
    else if (h.kind === "locate") {
      actions.dismissLocPrompt();
      useMyLocation();
    }
  }

  return (
    <div className="search" role="combobox" aria-expanded={open} aria-haspopup="listbox">
      <svg className="search__icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="12.8" y1="12.8" x2="17" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        className="search__input"
        type="search"
        placeholder="Route, station or place…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && hits[active]) { e.preventDefault(); void choose(hits[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
        aria-label="Search routes, stations and places"
      />
      {open && hits.length > 0 && (
        <ul className="search__list" role="listbox">
          {hits.map((h, i) => (
            <li key={h.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={`search__hit ${i === active ? "is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void choose(h)}
                onMouseEnter={() => setActive(i)}
              >
                {h.kind === "route" && h.refNo ? (
                  <Waymark refNo={h.refNo} size="sm" />
                ) : (
                  <span className={`search__glyph search__glyph--${h.kind}`} aria-hidden="true">
                    {h.kind === "locate" ? "◎" : h.kind === "station" ? "🚉" : h.kind === "geocode" ? "🔎" : "▸"}
                  </span>
                )}
                <span className="search__text">
                  <span>{h.kind === "geocode" && busy ? "Searching…" : h.label}</span>
                  {h.sub && <small>{h.sub}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
