import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { actions, useStore } from "../store";
import { eleAt } from "../lib/geo";
import { km, metres } from "../lib/format";
import type { Route } from "../types";

const W = 640;
const H = 168;
const PAD = { top: 14, right: 10, bottom: 20, left: 40 };

export function ElevationProfile({ route }: { route: Route }) {
  const clip = useStore((s) => s.clip);
  const clipping = useStore((s) => s.clipping);
  const cursor = useStore((s) => s.cursor);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<0 | 1 | null>(null);

  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;

  // Downsample to ~320 points and build the area path.
  const { areaPath, linePath, lo, hi } = useMemo(() => {
    const n = Math.min(320, route.ele.length);
    const lo = Math.floor(route.minEle / 10) * 10;
    const hi = Math.max(lo + 40, Math.ceil(route.maxEle / 10) * 10);
    const y = (e: number) => PAD.top + ih - ((e - lo) / (hi - lo)) * ih;
    const x = (t: number) => PAD.left + t * iw;
    let line = "";
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      line += `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(eleAt(route, t)).toFixed(1)}`;
    }
    const area = `${line}L${x(1).toFixed(1)},${(PAD.top + ih).toFixed(1)}L${x(0).toFixed(1)},${(PAD.top + ih).toFixed(1)}Z`;
    return { areaPath: area, linePath: line, lo, hi };
  }, [route, ih, iw]);

  const xOf = (t: number) => PAD.left + t * iw;
  const yOf = (e: number) => PAD.top + ih - ((e - lo) / (hi - lo)) * ih;

  const tFromEvent = (e: ReactPointerEvent<SVGSVGElement>): number => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    return Math.min(1, Math.max(0, (px - PAD.left) / iw));
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!clipping || !clip) return;
    const t = tFromEvent(e);
    // grab the nearer handle
    dragging.current = Math.abs(t - clip[0]) <= Math.abs(t - clip[1]) ? 0 : 1;
    svgRef.current?.setPointerCapture(e.pointerId);
    moveHandle(t);
  };

  const moveHandle = (t: number) => {
    if (dragging.current == null || !clip) return;
    const next: [number, number] = [...clip];
    next[dragging.current] = t;
    actions.setClip(next[0], next[1]);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const t = tFromEvent(e);
    if (dragging.current != null) moveHandle(t);
    else actions.setCursor(t);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragging.current != null) {
      dragging.current = null;
      svgRef.current?.releasePointerCapture(e.pointerId);
    }
  };

  const [a, b] = clip ? [Math.min(...clip), Math.max(...clip)] : [0, 1];

  const kmTicks = useMemo(() => {
    const total = route.lengthKm;
    const step = total > 120 ? 50 : total > 60 ? 20 : total > 24 ? 10 : 5;
    const ticks: number[] = [];
    for (let d = step; d < total; d += step) ticks.push(d / total);
    return { ticks, step };
  }, [route.lengthKm]);

  return (
    <figure className="profile" aria-label="Elevation profile">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={clipping ? "profile__svg profile__svg--clipping" : "profile__svg"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (dragging.current == null) actions.setCursor(null);
        }}
        role="img"
      >
        <defs>
          <linearGradient id="eleFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--tf)" stopOpacity="0.45" />
            <stop offset="1" stopColor="var(--tf)" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* y gridlines */}
        {[0.5].map((f) => (
          <line
            key={f}
            x1={PAD.left} x2={W - PAD.right}
            y1={PAD.top + ih * f} y2={PAD.top + ih * f}
            className="profile__grid"
          />
        ))}

        <path d={areaPath} fill="url(#eleFill)" />
        <path d={linePath} className="profile__line" />

        {/* dim outside the clip */}
        {clip && (
          <>
            <rect x={PAD.left} y={PAD.top} width={Math.max(0, xOf(a) - PAD.left)} height={ih} className="profile__dim" />
            <rect x={xOf(b)} y={PAD.top} width={Math.max(0, W - PAD.right - xOf(b))} height={ih} className="profile__dim" />
            {([a, b] as const).map((t, i) => (
              <g key={i} className="profile__handle" transform={`translate(${xOf(t)},0)`}>
                <line y1={PAD.top - 4} y2={PAD.top + ih + 4} />
                <circle cy={PAD.top - 4} r="7" />
                <circle cy={PAD.top + ih + 4} r="7" />
              </g>
            ))}
          </>
        )}

        {/* linked cursor */}
        {cursor != null && (
          <g transform={`translate(${xOf(cursor)},0)`} className="profile__cursor">
            <line y1={PAD.top} y2={PAD.top + ih} />
            <circle cy={yOf(eleAt(route, cursor))} r="4.5" />
            <text x={cursor > 0.82 ? -8 : 8} y={PAD.top + 10} textAnchor={cursor > 0.82 ? "end" : "start"}>
              {km(cursor * route.lengthKm)} · {metres(eleAt(route, cursor))}
            </text>
          </g>
        )}

        {/* axes labels */}
        <text x={PAD.left - 6} y={PAD.top + 8} className="profile__axis" textAnchor="end">{hi} m</text>
        <text x={PAD.left - 6} y={PAD.top + ih} className="profile__axis" textAnchor="end">{lo} m</text>
        {kmTicks.ticks.map((t, i) => (
          <text key={t} x={xOf(t)} y={H - 6} className="profile__axis" textAnchor="middle">
            {(i + 1) * kmTicks.step}
          </text>
        ))}
        <text x={W - PAD.right} y={H - 6} className="profile__axis" textAnchor="end">km</text>
      </svg>
      {clipping && <figcaption className="profile__hint">Drag the handles to choose your section — on the chart or on the map.</figcaption>}
    </figure>
  );
}
