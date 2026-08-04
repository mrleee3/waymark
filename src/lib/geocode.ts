export interface GeocodeHit {
  label: string;
  lng: number;
  lat: number;
}

/** Geocode a UK place name via Nominatim (used only when the bundled lists miss). */
export async function geocodeUk(q: string): Promise<GeocodeHit | null> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=gb&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
  const hit = data[0];
  if (!hit?.lat || !hit.lon) return null;
  return { label: hit.display_name?.split(",")[0] ?? q, lng: +hit.lon, lat: +hit.lat };
}
