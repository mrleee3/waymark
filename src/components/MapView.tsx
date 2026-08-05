import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap, MapLayerMouseEvent, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { COLORS, HOME_BOUNDS, MAP_STYLE_URL } from "../config";
import { actions, getState, subscribe, visibleRoutes } from "../store";
import { mapBus } from "../lib/mapbus";
import { distanceToRoute, nearestFraction, pointAt } from "../lib/geo";
import { fetchStationLink } from "../lib/link";
import { distanceAway } from "../lib/format";
import type { Route, Station } from "../types";

const LINE_LAYERS = ["ncn-casing", "ncn-line"] as const;

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

export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: MAP_STYLE_URL,
      bounds: HOME_BOUNDS,
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, showUserLocation: true }),
      "top-right"
    );
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

    // If the basemap can't load (offline / style outage) the route layers still
    // work — swap to a blank style so MapLibre keeps rendering our overlays.
    map.on("error", (e) => {
      const msg = String((e as { error?: { message?: string } }).error?.message ?? "");
      if (/style|fetch|Failed/i.test(msg) && !map.isStyleLoaded()) {
        map.setStyle({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e8ece9" } }] });
      }
    });

    let loaded = false;
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

    const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

    function ensureLayers(): void {
      if (!loaded || map.getSource("ncn")) return;
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

      // stations near the selected route
      map.addSource("stns", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "stns-circle",
        type: "circle",
        source: "stns",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 13, 6.5],
          "circle-color": "#3b6ea5",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });

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

      const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });
      map.on("click", "stns-circle", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const st: Station = { name: String(f.properties?.name), lat: e.lngLat.lat, lng: e.lngLat.lng };
        const props = f.properties as { name: string; lat: number; lng: number };
        void linkStation({ name: props.name, lat: +props.lat, lng: +props.lng });
        popup.setLngLat([+props.lng, +props.lat]).setText(String(props.name)).addTo(map);
        void st;
      });
      map.on("click", "pois-circle", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties as { name: string; kind: string; lat: number; lng: number };
        popup
          .setLngLat([+props.lng, +props.lat])
          .setText(`${props.kind === "cafe" ? "Café" : "Pub"} · ${props.name}`)
          .addTo(map);
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

    const planMarkers: [Marker, Marker] = [mkPlanStn(), mkPlanStn()];
    function mkPlanStn(): Marker {
      const d = document.createElement("div");
      d.className = "map-plan-stn";
      return new maplibregl.Marker({ element: d, anchor: "bottom" });
    }
    function setPlanStn(m: Marker, st: Station, label: string): void {
      const el = m.getElement();
      el.innerHTML = "";
      const badge = document.createElement("span");
      badge.className = "map-plan-stn__badge";
      badge.textContent = "🚆";
      const name = document.createElement("span");
      name.className = "map-plan-stn__name";
      name.textContent = `${st.name} · ${label}`;
      el.append(badge, name);
      m.setLngLat([st.lng, st.lat]).addTo(map);
    }

    map.on("load", () => {
      loaded = true;
      ensureLayers();
    });

    /* -------- store → map sync (imperative, outside React's render) -------- */

    let prev = { selectedId: null as string | null, clipKey: "", cursor: null as number | null, visKey: "", routesLen: 0, poiCount: -1, linkKey: "", planKey: "" };

    function padding() {
      const desktop = window.matchMedia("(min-width: 768px)").matches;
      return desktop
        ? { top: 40, right: 40, bottom: 40, left: 440 }
        : { top: 24, right: 24, bottom: Math.round(window.innerHeight * 0.5), left: 24 };
    }

    function syncFromStore(force = false): void {
      const s = getState();
      if (!loaded) return;
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
          ? ["case", ["==", ["get", "rid"], s.selectedId], 1, ["case", inVis, 0.16, 0.05]]
          : ["case", inVis, 0.95, 0.08];
        map.setPaintProperty("ncn-line", "line-opacity", lineOpacity);
        map.setPaintProperty("ncn-casing", "line-opacity", s.selectedId
          ? ["case", ["==", ["get", "rid"], s.selectedId], 0.95, 0.1]
          : ["case", inVis, 0.9, 0.06]);
        const width: maplibregl.ExpressionSpecification = s.selectedId
          ? ["case", ["==", ["get", "rid"], s.selectedId],
              ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 6],
              ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 4]]
          : ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 4];
        map.setPaintProperty("ncn-line", "line-width", width);
      }

      // selection change → frame the route
      if (s.selectedId !== prev.selectedId) {
        prev.selectedId = s.selectedId;
        const r = s.routes.find((x) => x.id === s.selectedId);
        if (r) {
          map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], {
            padding: padding(),
            duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900,
            maxZoom: 13,
          });
        }
      }

      // stations corridor for the selected route
      if (s.selectedId !== prev.selectedId || force) {
        const sel = s.routes.find((x) => x.id === s.selectedId);
        const src = map.getSource("stns") as GeoJSONSource | undefined;
        if (src) {
          if (sel) {
            const feats: GeoJSON.Feature[] = [];
            for (const st of s.stations) {
              if (st.lng < sel.bbox[0] - 0.12 || st.lng > sel.bbox[2] + 0.12 || st.lat < sel.bbox[1] - 0.08 || st.lat > sel.bbox[3] + 0.08) continue;
              if (distanceToRoute(sel, [st.lng, st.lat]) > 4000) continue;
              feats.push({ type: "Feature", properties: { name: st.name, lat: st.lat, lng: st.lng }, geometry: { type: "Point", coordinates: [st.lng, st.lat] } });
              if (feats.length >= 60) break;
            }
            src.setData({ type: "FeatureCollection", features: feats });
          } else src.setData(EMPTY);
        }
      }

      // POIs
      if (s.pois.items.length !== prev.poiCount || force) {
        prev.poiCount = s.pois.items.length;
        (map.getSource("pois") as GeoJSONSource | undefined)?.setData({
          type: "FeatureCollection",
          features: s.pois.items.map((p) => ({
            type: "Feature",
            properties: { name: p.name, kind: p.kind, lat: p.lat, lng: p.lng },
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
          })),
        });
      }

      // station link line
      const lk = s.stationLink.link;
      const linkKey = lk ? `${lk.station.name}:${lk.mode}:${Math.round(lk.lengthM)}` : "";
      if (linkKey !== prev.linkKey || force) {
        prev.linkKey = linkKey;
        (map.getSource("link") as GeoJSONSource | undefined)?.setData(
          lk
            ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: lk.coords } }
            : EMPTY
        );
        if (lk) map.setPaintProperty("link-line", "line-dasharray", lk.mode === "bike" ? [2, 1.2] : [0.5, 1.6]);
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

      // linked cursor dot
      if (s.cursor !== prev.cursor) {
        prev.cursor = s.cursor;
        if (s.cursor != null && r) cursorMarker.setLngLat(pointAt(r, s.cursor)).addTo(map);
        else cursorMarker.remove();
      }
    }

    const unsub = subscribe(() => syncFromStore());
    mapBus.onFly((center, zoom) => map.flyTo({ center, zoom: zoom ?? 10, duration: 800 }));

    return () => {
      unsub();
      mapBus.onFly(null);
      mapBus.onLinkStation(null);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return <div ref={el} className="map" role="application" aria-label="Map of National Cycle Network routes" />;
}
