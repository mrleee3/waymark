export function km(v: number): string {
  return v >= 100 ? `${Math.round(v)} km` : `${v.toFixed(v < 10 ? 1 : 0)} km`;
}

export function metres(v: number): string {
  return `${Math.round(v)} m`;
}

export function distanceAway(m: number): string {
  return m < 950 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Easy-pace estimate: 15 km/h on the flat plus ~1 min per 10 m of climbing. */
export function rideTime(lengthKm: number, ascentM: number): string {
  const hours = lengthKm / 15 + ascentM / 600;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}
