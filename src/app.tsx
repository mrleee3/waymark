import { useEffect } from "react";
import { MapView } from "./components/MapView";
import { Panel } from "./components/Panel";
import { actions, useStore } from "./store";
import { loadNetwork } from "./data/loader";

export function App() {
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    loadNetwork()
      .then((net) => actions.networkLoaded(net))
      .catch((err: unknown) => actions.networkFailed(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="app">
      <MapView />
      <Panel />
    </div>
  );
}
