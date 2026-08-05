import type { LngLat, Station } from "../types";

type FlyHandler = (center: LngLat, zoom?: number) => void;
type LinkHandler = (station: Station) => void;
type FitHandler = (bounds: [number, number, number, number]) => void;

let flyHandler: FlyHandler | null = null;
let linkHandler: LinkHandler | null = null;
let fitHandler: FitHandler | null = null;

export const mapBus = {
  onFly(h: FlyHandler | null): void {
    flyHandler = h;
  },
  fly(center: LngLat, zoom?: number): void {
    flyHandler?.(center, zoom);
  },
  onLinkStation(h: LinkHandler | null): void {
    linkHandler = h;
  },
  linkStation(station: Station): void {
    linkHandler?.(station);
  },
  onFit(h: FitHandler | null): void {
    fitHandler = h;
  },
  fit(bounds: [number, number, number, number]): void {
    fitHandler?.(bounds);
  },
};
