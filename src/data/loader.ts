import { NETWORK_B64 } from "./network";
import { enrichRoute } from "../lib/geo";
import type { NetworkPayload, Place, Route, Station } from "../types";

export interface LoadedNetwork {
  routes: Route[];
  stations: Station[];
  places: Place[];
  sample: boolean;
  generated: string;
  attribution: string;
  /** true when the payload came from the network.data sidecar, not the embed */
  live: boolean;
}

async function decode(b64: string): Promise<NetworkPayload> {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser is too old to run Waymark (no DecompressionStream).");
  }
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"));
  const json = await new Response(stream).text();
  const payload = JSON.parse(json) as NetworkPayload;
  if (payload.v !== 1 || !Array.isArray(payload.routes)) throw new Error("Unrecognised payload");
  return payload;
}

function toNetwork(payload: NetworkPayload, live: boolean): LoadedNetwork {
  return {
    routes: payload.routes.map(enrichRoute),
    stations: payload.stations.map(([name, lat, lng]) => ({ name, lat, lng })),
    places: payload.places.map(([name, lat, lng]) => ({ name, lat, lng })),
    sample: payload.sample,
    generated: payload.generated,
    attribution: payload.attribution,
    live,
  };
}

/**
 * Load the network. Preference order:
 *   1. `network.data` fetched from alongside the app — the file the weekly
 *      GitHub workflow keeps fresh, so a deployed index.html updates itself.
 *   2. The payload embedded at build time (sample data out of the box).
 */
export async function loadNetwork(): Promise<LoadedNetwork> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("network.data", { cache: "no-cache", signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text.length > 100 && !text.startsWith("<")) {
        return toNetwork(await decode(text), true);
      }
    }
  } catch {
    /* offline, file:// or no sidecar published yet — use the embed */
  }
  return toNetwork(await decode(NETWORK_B64), false);
}
