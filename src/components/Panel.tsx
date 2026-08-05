import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { actions, useStore } from "../store";
import type { SheetPos } from "../store";
import { useMyLocation } from "../lib/locate";
import { SearchBox } from "./SearchBox";
import { Filters } from "./Filters";
import { RouteList } from "./RouteList";
import { RouteDetail } from "./RouteDetail";
import { Planner } from "./Planner";

const ORDER: SheetPos[] = ["peek", "half", "full"];

/** Sheet snap heights in px, measured from the bottom of the viewport. */
function snapHeights(): Record<SheetPos, number> {
  const h = window.innerHeight;
  return { peek: 136, half: Math.round(h * 0.52), full: Math.round(h * 0.94) };
}

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const fn = () => setDesktop(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return desktop;
}

export function Panel() {
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const selectedId = useStore((s) => s.selectedId);
  const route = useStore((s) => s.routes.find((r) => r.id === s.selectedId));
  const planning = useStore((s) => s.planning);
  const sample = useStore((s) => s.sample);
  const noticeDismissed = useStore((s) => s.sampleNoticeDismissed);
  const generated = useStore((s) => s.generated);
  const live = useStore((s) => s.live);
  const near = useStore((s) => s.filters.near);
  const locPromptDismissed = useStore((s) => s.locPromptDismissed);
  const [locating, setLocating] = useState(false);
  const theme = useStore((s) => s.theme);
  const sheet = useStore((s) => s.sheet);
  const desktop = useIsDesktop();

  /* -------- mobile sheet: drag from the grab zone only; content scrolls -------- */
  const panelRef = useRef<HTMLDivElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number; startY: number; startH: number; fromSheet: SheetPos; dragging: boolean;
  } | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);
  const suppressClick = useRef(false);

  function onZoneDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (desktop) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = {
      id: e.pointerId,
      startY: e.clientY,
      startH: panelRef.current?.getBoundingClientRect().height ?? snapHeights()[sheet],
      fromSheet: sheet,
      dragging: false,
    };
  }
  function onZoneMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.startY;
    if (!d.dragging) {
      if (Math.abs(dy) < 6) return; // let taps through
      d.dragging = true;
      zoneRef.current?.setPointerCapture(d.id);
    }
    const snaps = snapHeights();
    setDragH(Math.min(snaps.full, Math.max(96, d.startH - dy)));
    e.preventDefault();
  }
  function onZoneUp(): void {
    const d = drag.current;
    drag.current = null;
    if (!d?.dragging) return;
    suppressClick.current = true;
    const h = dragH ?? snapHeights()[d.fromSheet];
    setDragH(null);
    const snaps = snapHeights();
    const moved = h - d.startH;
    let next: SheetPos;
    if (Math.abs(moved) > 48) {
      // a definite flick: step one level in the direction of travel
      const i = ORDER.indexOf(d.fromSheet);
      next = ORDER[Math.min(ORDER.length - 1, Math.max(0, i + (moved > 0 ? 1 : -1)))];
    } else {
      next = ORDER.reduce((a, b) => (Math.abs(snaps[a] - h) < Math.abs(snaps[b] - h) ? a : b));
    }
    actions.setSheet(next);
  }

  const style = desktop ? undefined : dragH != null ? { height: `${dragH}px` } : undefined;

  return (
    <div
      ref={panelRef}
      className={`panel ${desktop ? "panel--rail" : `panel--sheet is-${sheet}`} ${dragH != null ? "is-dragging" : ""}`}
      style={style}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      <div
        ref={zoneRef}
        className="panel__dragzone"
        onPointerDown={onZoneDown}
        onPointerMove={onZoneMove}
        onPointerUp={onZoneUp}
        onPointerCancel={onZoneUp}
      >
        <button
          type="button"
          className="panel__grab"
          aria-expanded={sheet !== "peek"}
          aria-label={sheet === "full" ? "Collapse route list" : "Expand route list"}
          onClick={() => {
            if (desktop) return;
            actions.setSheet(sheet === "peek" ? "half" : sheet === "half" ? "full" : "peek");
          }}
        >
          <span className="panel__grab-bar" />
        </button>

        <header className="panel__head">
          <h1 className="wordmark">
            <span className="wordmark__patch" aria-hidden="true">W</span>
            Waymark
          </h1>
          <button
            type="button"
            className="theme-toggle"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => actions.setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" /><g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="12" y1="2.5" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="21.5" /><line x1="2.5" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="21.5" y2="12" /><line x1="5.3" y1="5.3" x2="7" y2="7" /><line x1="17" y1="17" x2="18.7" y2="18.7" /><line x1="5.3" y1="18.7" x2="7" y2="17" /><line x1="17" y1="7" x2="18.7" y2="5.3" /></g></svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" fill="currentColor" /></svg>
            )}
          </button>
        </header>
      </div>

      {sample && !noticeDismissed && loaded && (
        <div className="notice">
          <p>
            Showing <strong>sample routes</strong> (approximate). Publish live data once — run the
            "Refresh route data" workflow in your GitHub repo — and the app updates itself from then on.
          </p>
          <button type="button" aria-label="Dismiss" onClick={() => actions.dismissSampleNotice()}>×</button>
        </div>
      )}

      {loaded && !near && !locPromptDismissed && !selectedId && (
        <div className="locprompt">
          <p>Sort routes by distance from you?</p>
          <div className="locprompt__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={locating}
              onClick={() => {
                setLocating(true);
                useMyLocation((ok) => {
                  setLocating(false);
                  actions.dismissLocPrompt();
                  if (!ok) actions.patchFilters({ sort: "longest" });
                });
              }}
            >
              {locating ? "Locating…" : "Use my location"}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                actions.dismissLocPrompt();
                actions.patchFilters({ sort: "longest" });
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <div className="panel__scroll">
        {loadError ? (
          <div className="empty">
            <p>The route data couldn't be unpacked.</p>
            <p>{loadError}</p>
          </div>
        ) : !loaded ? (
          <div className="skeleton" aria-label="Loading routes">
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton__card" />)}
          </div>
        ) : route && planning ? (
          <Planner route={route} />
        ) : route ? (
          <RouteDetail route={route} />
        ) : (
          <>
            <SearchBox />
            <Filters />
            <RouteList />
            {generated && (
              <p className="panel__foot">
                {sample ? "Sample data" : live ? "Live network" : "Bundled network"} · updated {generated}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
