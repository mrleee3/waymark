import { actions, activeFilterCount, useStore } from "../store";
import { DEFAULT_FILTERS } from "../types";
import type { SortKey } from "../types";

const LEN_STOPS = [0, 10, 20, 30, 50, 80, 120, 200, 999];

export function Filters() {
  const f = useStore((s) => s.filters);
  const open = useStore((s) => s.filtersOpen);
  const count = activeFilterCount(f);

  const lenLabel =
    f.lenMin === 0 && f.lenMax >= 999
      ? "Any length"
      : f.lenMax >= 999
        ? `${f.lenMin} km +`
        : `${f.lenMin}–${f.lenMax} km`;

  return (
    <div className="filters">
      <div className="filters__bar">
        <button
          type="button"
          className={`chip ${count > 0 ? "chip--on" : ""}`}
          aria-expanded={open}
          onClick={() => actions.toggleFiltersOpen()}
        >
          Filters{count > 0 ? ` · ${count}` : ""}
          <svg viewBox="0 0 10 6" className={`chip__caret ${open ? "is-open" : ""}`} aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={`chip ${f.shortlistOnly ? "chip--on" : ""}`}
          onClick={() => actions.patchFilters({ shortlistOnly: !f.shortlistOnly })}
        >
          ★ Shortlist
        </button>
        <label className="filters__sort">
          <span className="visually-hidden">Sort routes</span>
          <select
            value={f.sort}
            onChange={(e) => actions.patchFilters({ sort: e.target.value as SortKey })}
          >
            <option value="nearest">Nearest first</option>
            <option value="longest">Longest first</option>
            <option value="shortest">Shortest first</option>
            <option value="traffic-free">Most traffic-free</option>
          </select>
        </label>
      </div>

      {f.near && (
        <div className="filters__near">
          Near <strong>{f.near.label}</strong> · within {f.radiusKm} km
          <input
            type="range"
            min="10" max="150" step="10"
            value={f.radiusKm}
            onChange={(e) => actions.patchFilters({ radiusKm: +e.target.value })}
            aria-label="Search radius in kilometres"
          />
          <button type="button" className="filters__clear-near" onClick={() => actions.patchFilters({ near: null })}>
            Clear
          </button>
        </div>
      )}

      {open && (
        <div className="filters__sheet">
          <div className="filters__row">
            <span className="filters__label">Length</span>
            <span className="filters__value">{lenLabel}</span>
            <div className="filters__pair">
              <select
                value={f.lenMin}
                onChange={(e) => actions.patchFilters({ lenMin: Math.min(+e.target.value, f.lenMax) })}
                aria-label="Minimum length"
              >
                {LEN_STOPS.slice(0, -1).map((v) => (
                  <option key={v} value={v}>{v === 0 ? "Min" : `${v} km`}</option>
                ))}
              </select>
              <select
                value={f.lenMax}
                onChange={(e) => actions.patchFilters({ lenMax: Math.max(+e.target.value, f.lenMin) })}
                aria-label="Maximum length"
              >
                {LEN_STOPS.slice(1).map((v) => (
                  <option key={v} value={v}>{v === 999 ? "Max" : `${v} km`}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="filters__row">
            <span className="filters__label">Traffic-free</span>
            <span className="filters__value">{f.tfMin === 0 ? "Any" : `≥ ${f.tfMin}%`}</span>
            <input
              type="range" min="0" max="100" step="10"
              value={f.tfMin}
              onChange={(e) => actions.patchFilters({ tfMin: +e.target.value })}
              aria-label="Minimum traffic-free percentage"
            />
          </div>

          <label className="filters__row filters__row--toggle">
            <span className="filters__label">Circular routes only</span>
            <input
              type="checkbox"
              checked={f.circularOnly}
              onChange={(e) => actions.patchFilters({ circularOnly: e.target.checked })}
            />
          </label>

          {(count > 0 || f.sort !== DEFAULT_FILTERS.sort) && (
            <button type="button" className="filters__reset" onClick={() => actions.resetFilters()}>
              Reset filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
