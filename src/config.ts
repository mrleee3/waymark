// The basemap is the app's only runtime network dependency.
// OpenFreeMap is free, keyless and MapLibre-native. Swap the URL for a
// MapTiler/Stadia style (with your key) if you prefer their cartography.
export const MAP_STYLES = {
  /** labelled, detailed cartography — the default */
  detail: "https://tiles.openfreemap.org/styles/liberty",
  /** muted, minimal — lets the route colours pop */
  muted: "https://tiles.openfreemap.org/styles/positron",
} as const;
export type BasemapKind = keyof typeof MAP_STYLES;

/** Whole-UK starting view. */
export const HOME_BOUNDS: [[number, number], [number, number]] = [
  [-8.4, 49.8],
  [1.9, 59.2],
];

export const COLORS = {
  trafficFree: "#0e8a5f",
  onRoad: "#e08a00",
};
