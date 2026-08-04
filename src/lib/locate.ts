import { actions } from "../store";
import { mapBus } from "./mapbus";

/** Ask for the user's position and switch the app to nearest-first around it. */
export function useMyLocation(onDone?: (ok: boolean) => void): void {
  if (!navigator.geolocation) {
    onDone?.(false);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { longitude: lng, latitude: lat } = pos.coords;
      actions.patchFilters({ near: { label: "My location", lng, lat }, sort: "nearest" });
      mapBus.fly([lng, lat], 9.5);
      onDone?.(true);
    },
    () => onDone?.(false),
    { maximumAge: 300000, timeout: 8000 }
  );
}
