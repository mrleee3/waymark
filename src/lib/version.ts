/** Build identity + "new version deployed" detection.
 *
 * The build embeds __BUILD_ID__ (the git sha in CI, a dev stamp locally).
 * CI also publishes version.json alongside the app with the same id.
 * Comparing the two — every few minutes and whenever the app returns to the
 * foreground — tells us a newer build has been deployed since this one loaded.
 */
declare const __BUILD_ID__: string;

export const BUILD_ID = __BUILD_ID__;

export function watchForUpdates(onUpdate: (id: string) => void): () => void {
  let stopped = false;
  let announced = false;

  async function check(): Promise<void> {
    try {
      // Unique query per probe: GitHub Pages' CDN keys its edge cache on the
      // full URL, so this always reaches a fresh copy instead of waiting out
      // the ~10-minute edge TTL.
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const v = (await res.json()) as { id?: string };
      if (!stopped && !announced && v.id && v.id !== BUILD_ID) {
        announced = true;
        onUpdate(v.id);
      }
    } catch {
      /* offline or first deploy without version.json — fine */
    }
  }

  const iv = window.setInterval(() => void check(), 5 * 60_000);
  const onVis = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVis);
  const t = window.setTimeout(() => void check(), 20_000);

  return () => {
    stopped = true;
    window.clearInterval(iv);
    window.clearTimeout(t);
    document.removeEventListener("visibilitychange", onVis);
  };
}
