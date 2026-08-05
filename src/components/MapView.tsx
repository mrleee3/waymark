import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { COLORS, HOME_BOUNDS, MAP_STYLES } from "../config";
import type { BasemapKind } from "../config";
import { actions, getState, subscribe, visibleRoutes } from "../store";
import { mapBus } from "../lib/mapbus";
import { distanceToRoute, nearestFraction, pointAt } from "../lib/geo";
import { fetchStationLink } from "../lib/link";
import { fetchPois } from "../lib/pois";
import type { Route, Station } from "../types";

const LINE_LAYERS = ["ncn-casing", "ncn-line"] as const;
const BASEMAP_LS = "waymark.basemap";

/** Split each route into per-surface-span features. */
function networkGeojson(routes: Route[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const r of routes) {
    const spans = r.surf.length ? r.surf : [[0, 1] as [number, number]];
    for (let i = 0; i < spans.length; i++) {
      const from = Math.round(spans[i][0] * (r.coords.length - 1));
      const to = i + 1 < spans.length ? Math.round(spans[i + 1][0] * (r.coords.length - 1)) : r.coords.length - 1;
      if (to - from < 1) continue;
      features.push({
        type: "Feature",
        properties: { rid: r.id, cls: spans[i][1] },
        geometry: { type: "LineString", coordinates: r.coords.slice(from, to + 1) },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!el.current) return;

    let basemap: BasemapKind = "detail";
    try {
      if (localStorage.getItem(BASEMAP_LS) === "muted") basemap = "muted";
    } catch { /* private mode */ }
    const styleUrl = () => MAP_STYLES[basemap];

    let map: MLMap;
    try {
      map = new maplibregl.Map({
        container: el.current,
        style: styleUrl(),
        bounds: HOME_BOUNDS,
        fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch {
      setFailed(true);
      return;
    }
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, showUserLocation: true });
    map.addControl(geo, "top-right");
    // Nearest-first follows the blue dot.
    geo.on("geolocate", (e) => {
      const c = (e as GeolocationPosition).coords;
      actions.patchFilters({ near: { label: "My location", lng: c.longitude, lat: c.latitude }, sort: "nearest" });
      actions.dismissLocPrompt();
    });

    // Basemap detail/muted toggle.
    map.addControl({
      onAdd() {
        const wrap = document.createElement("div");
        wrap.className = "maplibregl-ctrl maplibregl-ctrl-group";
        const b = document.createElement("button");
        b.type = "button";
        b.className = "basemap-toggle";
        b.title = "Toggle map detail";
        b.setAttribute("aria-label", "Toggle map detail");
        b.innerHTML =
          '<svg viewBox="0 0 22 22" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M11 3l8 4.5-8 4.5-8-4.5z"/><path d="M3 12l8 4.5 8-4.5"/></g></svg>';
        b.addEventListener("click", () => {
          basemap = basemap === "detail" ? "muted" : "detail";
          try { localStorage.setItem(BASEMAP_LS, basemap); } catch { /* ignore */ }
          map.setStyle(styleUrl()); // overlays re-added on style.load below
        });
        wrap.appendChild(b);
        return wrap;
      },
      onRemove() { /* noop */ },
    }, "top-right");

    // Stations / cafés-and-pubs layer toggles, kept in sync with the store.
    const toggleBtns: HTMLButtonElement[] = [];
    map.addControl({
      onAdd() {
        const wrap = document.createElement("div");
        wrap.className = "maplibregl-ctrl maplibregl-ctrl-group";
        const add = (glyph: string, label: string, onClick: () => void) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "layer-toggle";
          b.title = label;
          b.setAttribute("aria-label", label);
          b.textContent = glyph;
          b.addEventListener("click", onClick);
          wrap.appendChild(b);
          toggleBtns.push(b);
        };
        add("🚉", "Show stations near the route", () => actions.toggleStations());
        add("☕", "Show cafés & pubs along the route", () => actions.togglePoisVisible());
        return wrap;
      },
      onRemove() { /* noop */ },
    }, "top-right");

    function syncToggleButtons(): void {
      const s = getState();
      const hasRoute = !!s.selectedId;
      toggleBtns.forEach((b, i) => {
        const on = i === 0 ? s.showStations : s.showPois && hasRoute;
        b.classList.toggle("is-on", on);
        b.classList.toggle("is-idle", i === 1 && !hasRoute);
        if (i === 1 && s.pois.status === "loading") b.classList.add("is-busy");
        else b.classList.remove("is-busy");
      });
    }

    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

    // If the basemap can't load (offline / style outage) the route layers still
    // work — swap to a blank style so MapLibre keeps rendering our overlays.
    map.on("error", (e) => {
      const msg = String((e as { error?: { message?: string } }).error?.message ?? "");
      if (/style|fetch|Failed/i.test(msg) && !map.isStyleLoaded()) {
        map.setStyle({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e8ece9" } }] });
      }
    });

    let styleReady = false;
    let handlersBound = false;
    const cursorMarker = mkDot("map-cursor-dot");
    const handles: [Marker, Marker] = [mkHandle(0), mkHandle(1)];
    let rafPending = false;

    function mkDot(cls: string): Marker {
      const d = document.createElement("div");
      d.className = cls;
      return new maplibregl.Marker({ element: d });
    }
    function mkHandle(which: 0 | 1): Marker {
      const d = document.createElement("div");
      d.className = "map-clip-handle";
      d.textContent = which === 0 ? "A" : "B";
      const m = new maplibregl.Marker({ element: d, draggable: true });
      m.on("drag", () => {
        const s = getState();
        const r = s.routes.find((x) => x.id === s.selectedId);
        if (!r || !s.clip) return;
        const ll = m.getLngLat();
        const t = nearestFraction(r, [ll.lng, ll.lat]);
        const next: [number, number] = [...s.clip];
        next[which] = t;
        actions.setClip(next[0], next[1]);
      });
      m.on("dragend", () => syncFromStore(true));
      return m;
    }

    const planMarkers: [Marker, Marker] = [mkPlanStn(), mkPlanStn()];
    function mkPlanStn(): Marker {
      const d = document.createElement("div");
      d.className = "map-plan-stn";
      return new maplibregl.Marker({ element: d, anchor: "bottom" });
    }
    function setPlanStn(m: Marker, st: Station, label: string): void {
      const elx = m.getElement();
      elx.innerHTML = "";
      const badge = document.createElement("span");
      badge.className = "map-plan-stn__badge";
      badge.textContent = "🚆";
      const name = document.createElement("span");
      name.className = "map-plan-stn__name";
      name.textContent = `${st.name} · ${label}`;
      elx.append(badge, name);
      m.setLngLat([st.lng, st.lat]).addTo(map);
    }

    const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

    function ensureLayers(): void {
      if (!styleReady || map.getSource("ncn")) return;
      map.addSource("ncn", { type: "geojson", data: networkGeojson(getState().routes) });
      map.addLayer({
        id: "ncn-casing",
        type: "line",
        source: "ncn",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 7],
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "ncn-line",
        type: "line",
        source: "ncn",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["match", ["get", "cls"], 1, COLORS.trafficFree, COLORS.onRoad],
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 4],
        },
      });
      // station→route link line (under the markers, above the network)
      map.addSource("link", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "link-line",
        type: "line",
        source: "link",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": "#3b6ea5",
          "line-width": 3,
          "line-dasharray": [0.5, 1.6],
        },
      });

      // stations (all of them until a route is selected, then its corridor)
      map.addSource("stns", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "stns-circle",
        type: "circle",
        source: "stns",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 13, 8],
          "circle-color": "#3b6ea5",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5,
        },
      });
      if (map.getStyle()?.glyphs) {
        map.addLayer({
          id: "stns-label",
          type: "symbol",
          source: "stns",
          minzoom: 10.5,
          layout: {
            "text-field": ["get", "name"],
            "text-size": 11,
            "text-anchor": "top",
            "text-offset": [0, 0.9],
            "text-optional": true,
          },
          paint: {
            "text-color": "#2a4a6e",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.4,
          },
        });
      }

      // cafés & pubs along the selected route
      map.addSource("pois", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "pois-circle",
        type: "circle",
        source: "pois",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3, 13, 5.5],
          "circle-color": ["match", ["get", "kind"], "cafe", "#b06a2e", "#7b5ea7"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

      if (handlersBound) {
        syncFromStore(true);
        return;
      }
      handlersBound = true;

      const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });

      map.on("click", "stns-circle", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties as { name: string; lat: number; lng: number };
        const linked = getState().stationLink.link;
        if (linked && linked.station.name === props.name) {
          // second tap on the linked station clears the link
          actions.setStationLink("idle", null);
          popup.remove();
          return;
        }
        if (getState().selectedId) void linkStation({ name: props.name, lat: +props.lat, lng: +props.lng });
        popup.setLngLat([+props.lng, +props.lat]).setText(String(props.name)).addTo(map);
      });

      map.on("click", "pois-circle", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties as { name: string; kind: string; lat: number; lng: number; hours?: string; website?: string };
        let html = `<strong>${esc(String(props.name))}</strong><br><span class="poi-popup__kind">${props.kind === "cafe" ? "Café" : "Pub"}</span>`;
        if (props.hours) html += `<br><span class="poi-popup__hours">${esc(String(props.hours))}</span>`;
        if (props.website) {
          const url = String(props.website);
          if (/^https?:\/\//.test(url)) html += `<br><a href="${esc(url)}" target="_blank" rel="noopener">Website</a>`;
        }
        popup.setLngLat([+props.lng, +props.lat]).setHTML(`<div class="poi-popup">${html}</div>`).addTo(map);
      });

      for (const layer of ["stns-circle", "pois-circle"]) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }

      map.on("click", "ncn-line", onRouteClick);
      map.on("click", "ncn-casing", onRouteClick);
      map.on("mouseenter", "ncn-line", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "ncn-line", () => {
        map.getCanvas().style.cursor = "";
        actions.setCursor(null);
      });
      map.on("mousemove", "ncn-line", onRouteHover);
      syncFromStore(true);
    }

    function onRouteClick(e: MapLayerMouseEvent): void {
      const rid = e.features?.[0]?.properties?.rid as string | undefined;
      if (rid) actions.select(rid);
    }

    function onRouteHover(e: MapLayerMouseEvent): void {
      const s = getState();
      if (!s.selectedId) return;
      const rid = e.features?.[0]?.properties?.rid as string | undefined;
      if (rid !== s.selectedId) return;
      const r = s.routes.find((x) => x.id === rid);
      if (!r || rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        actions.setCursor(nearestFraction(r, [e.lngLat.lng, e.lngLat.lat]));
      });
    }

    async function linkStation(st: Station): Promise<void> {
      const s = getState();
      const r = s.routes.find((x) => x.id === s.selectedId);
      if (!r) return;
      actions.setStationLink("loading", null);
      const link = await fetchStationLink(r, st);
      actions.setStationLink("ready", link);
    }
    mapBus.onLinkStation((st) => void linkStation(st));
    mapBus.onFit((b) =>
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: padding(), duration: 700, maxZoom: 12.5 })
    );

    // style.load fires on initial load AND after every setStyle — re-add overlays.
    map.on("style.load", () => {
      styleReady = true;
      ensureLayers();
    });

    /* -------- store → map sync (imperative, outside React's render) -------- */

    let prev = { selectedId: null as string | null, clipKey: "", cursor: null as number | null, visKey: "", routesLen: 0, poiCount: -1, linkKey: "", planKey: "", stnKey: "" };

    function padding() {
      const desktop = window.matchMedia("(min-width: 768px)").matches;
      return desktop
        ? { top: 40, right: 40, bottom: 40, left: 440 }
        : { top: 24, right: 24, bottom: Math.round(window.innerHeight * 0.5), left: 24 };
    }

    function syncFromStore(force = false): void {
      const s = getState();
      if (!styleReady) return;
      if (s.routes.length && s.routes.length !== prev.routesLen) {
        prev.routesLen = s.routes.length;
        ensureLayers();
        (map.getSource("ncn") as GeoJSONSource | undefined)?.setData(networkGeojson(s.routes));
      }
      if (!map.getLayer("ncn-line")) return;

      // visibility + selection dimming
      const vis = visibleRoutes(s).map((r) => r.id);
      const visKey = `${vis.join(",")}|${s.selectedId ?? ""}`;
      if (force || visKey !== prev.visKey) {
        prev.visKey = visKey;
        const inVis: maplibregl.ExpressionSpecification = ["in", ["get", "rid"], ["literal", vis]];
        const lineOpacity: maplibregl.ExpressionSpecification = s.selectedId
          ? ["case", ["==", ["get", "rid"], s.selectedId], 1, ["case", inVis, 0.18, 0]]
          : ["case", inVis, 1, 0];
        for (const id of LINE_LAYERS) map.setPaintProperty(id, "line-opacity", lineOpacity);
        const lineWidth: maplibregl.ExpressionSpecification = s.selectedId
          ? ["case", ["==", ["get", "rid"], s.selectedId],
              ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 6],
              ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 4]]
          : ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 4];
        map.setPaintProperty("ncn-line", "line-width", lineWidth);
      }

      const selChanged = s.selectedId !== prev.selectedId;
      if (selChanged) {
        const r = s.routes.find((x) => x.id === s.selectedId);
        if (r) {
          map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], {
            padding: padding(),
            duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900,
            maxZoom: 13,
          });
        }
      }

      // stations: whole network until a route is selected, then its corridor
      const stnKey = `${s.selectedId ?? "all"}:${s.stations.length}`;
      if ((selChanged || force || stnKey !== prev.stnKey) && map.getSource("stns")) {
        prev.stnKey = stnKey;
        const r = s.routes.find((x) => x.id === s.selectedId);
        const src = map.getSource("stns") as GeoJSONSource;
        const feat = (st: Station): GeoJSON.Feature => ({
          type: "Feature",
          properties: { name: st.name, lat: st.lat, lng: st.lng },
          geometry: { type: "Point", coordinates: [st.lng, st.lat] },
        });
        if (r) {
          const features: GeoJSON.Feature[] = [];
          for (const st of s.stations) {
            if (st.lng < r.bbox[0] - 0.12 || st.lng > r.bbox[2] + 0.12 || st.lat < r.bbox[1] - 0.08 || st.lat > r.bbox[3] + 0.08) continue;
            if (distanceToRoute(r, [st.lng, st.lat]) > 4000) continue;
            features.push(feat(st));
            if (features.length >= 60) break;
          }
          src.setData({ type: "FeatureCollection", features });
        } else {
          src.setData({ type: "FeatureCollection", features: s.stations.map(feat) });
        }
      }
      const stnVis = s.showStations ? "visible" : "none";
      for (const id of ["stns-circle", "stns-label"]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", stnVis);
      }

      // cafés & pubs: fetch lazily when shown, gate visibility on selection
      if (map.getLayer("pois-circle")) {
        map.setLayoutProperty("pois-circle", "visibility", s.showPois && s.selectedId ? "visible" : "none");
      }
      if (s.showPois && s.selectedId && s.pois.status === "idle") {
        const r = s.routes.find((x) => x.id === s.selectedId);
        if (r) {
          actions.setPois("loading", []);
          fetchPois(r).then(
            (items) => { if (getState().selectedId === r.id) actions.setPois("ready", items); },
            () => actions.setPois("error", [])
          );
        }
      }
      if (s.pois.items.length !== prev.poiCount || force) {
        prev.poiCount = s.pois.items.length;
        (map.getSource("pois") as GeoJSONSource | undefined)?.setData({
          type: "FeatureCollection",
          features: s.pois.items.map((p) => ({
            type: "Feature",
            properties: { name: p.name, kind: p.kind, lat: p.lat, lng: p.lng, hours: p.hours, website: p.website },
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
          })),
        });
      }

      // station link line
      const lk = s.stationLink.link;
      const linkKey = lk ? `${lk.station.name}:${lk.mode}:${Math.round(lk.lengthM)}` : "";
      if (linkKey !== prev.linkKey) {
        prev.linkKey = linkKey;
        (map.getSource("link") as GeoJSONSource | undefined)?.setData(
          lk
            ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: lk.coords } }
            : EMPTY
        );
        if (lk) {
          map.setPaintProperty("link-line", "line-dasharray", lk.mode === "bike" ? [2, 1.2] : [0.5, 1.6]);
          let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
          for (const [lng, lat] of lk.coords) {
            if (lng < w) w = lng; if (lng > e) e = lng;
            if (lat < so) so = lat; if (lat > n) n = lat;
          }
          map.fitBounds([[w, so], [e, n]], { padding: 90, maxZoom: 15, duration: 700 });
        }
      }

      // day-plan station markers
      const p = s.plan;
      const planKey = p ? `${p.out.s.name}:${p.back.s.name}:${p.lo.toFixed(3)}:${p.hi.toFixed(3)}` : "";
      if (planKey !== prev.planKey) {
        prev.planKey = planKey;
        if (p) {
          setPlanStn(planMarkers[0], p.out.s, p.outAndBack ? "out & back from here" : "board here");
          if (p.outAndBack) planMarkers[1].remove();
          else setPlanStn(planMarkers[1], p.back.s, "home from here");
        } else {
          planMarkers[0].remove();
          planMarkers[1].remove();
        }
      }

      // clip handles
      const r = s.routes.find((x) => x.id === s.selectedId);
      const clipKey = s.clipping && s.clip && r ? `${r.id}:${s.clip[0].toFixed(3)}:${s.clip[1].toFixed(3)}` : "";
      if (clipKey !== prev.clipKey) {
        prev.clipKey = clipKey;
        if (s.clipping && s.clip && r) {
          handles[0].setLngLat(pointAt(r, s.clip[0])).addTo(map);
          handles[1].setLngLat(pointAt(r, s.clip[1])).addTo(map);
        } else {
          handles[0].remove();
          handles[1].remove();
        }
      }

      // hover cursor
      if (s.cursor !== prev.cursor) {
        prev.cursor = s.cursor;
        if (s.cursor != null && r) cursorMarker.setLngLat(pointAt(r, s.cursor)).addTo(map);
        else cursorMarker.remove();
      }

      prev.selectedId = s.selectedId;
      syncToggleButtons();
    }

    const unsub = subscribe(() => syncFromStore());
    mapBus.onFly((center, zoom) => map.flyTo({ center, zoom: zoom ?? 10, duration: 800 }));

    return () => {
      unsub();
      mapBus.onFly(null);
      mapBus.onLinkStation(null);
      mapBus.onFit(null);
      map.remove();
    };
  }, []);

  if (failed) {
    return (
      <div className="map map--failed">
        <p>The map couldn't start on this device — the route list and planner still work below.</p>
      </div>
    );
  }
  return <div ref={el} className="map" />;
}
