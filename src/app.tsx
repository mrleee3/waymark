import { useEffect } from "react";
import { MapView } from "./components/MapView";
import { Panel } from "./components/Panel";
import { actions, useStore } from "./store";
import { loadNetwork } from "./data/loader";
import { watchForUpdates } from "./lib/version";

export function App() {
  const theme = useStore((s) => s.theme);
  const updateId = useStore((s) => s.updateId);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => watchForUpdates((id) => actions.updateAvailable(id)), []);

  useEffect(() => {
    loadNetwork()
      .then((net) => actions.networkLoaded(net))
      .catch((err: unknown) => actions.networkFailed(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="app">
      {updateId && (
        <div className="updatebar" role="status">
          <span>A new version of Waymark is ready.</span>
          <button
            type="button"
            onClick={() => location.replace(`${location.pathname}?v=${updateId}${location.hash}`)}
          >
            Restart
          </button>
        </div>
      )}
      <MapView />
      <Panel />
    </div>
  );
}
