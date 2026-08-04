# Waymark

Explore the UK National Cycle Network: filter routes by length, climbing and how traffic-free they are, clip the section you actually want to ride, see which stations can bring you home, and download the GPX.

Deploys as **one `index.html`** you upload by hand (phone-friendly), plus a small **`network.data`** file that a GitHub workflow keeps fresh automatically. At startup the app fetches `network.data` from alongside itself and falls back to a bundled sample if it isn't there — so the app file and the route data update independently, and you never run a local build to refresh routes.

## Quick start

```bash
npm install
npm run dev        # local dev server
npm run build      # → dist/index.html (the whole app, one file)
npm run package    # → waymark-source.zip (source, no node_modules)
```

Open `dist/index.html` from any static host — GitHub Pages, SharePoint, a network share. No server logic, no API keys.

## The ships-with data is a sample

Out of the box the app carries **10 approximate, hand-drawn sample routes** so everything works immediately. They are labelled as such in the app and in exported GPX files, and are **not for navigation**.

### Loading the full live network

The real network is published by Sustrans / Walk Wheel Cycle Trust on their open-data portal (refreshed every Sunday):

1. Visit `data-sustrans-uk.opendata.arcgis.com` → **National Cycle Network (Public)** → Download → **GeoJSON**.
2. ```bash
   npm run build:data -- --src path/to/downloaded.geojson
   ```
   This writes `network.data` — publish it next to your deployed `index.html` (the workflow below does this for you) and the running app picks it up. No app rebuild needed.

`build:data` chains the segments into continuous routes, simplifies the geometry, classifies traffic-free vs on-road, fetches real elevations from OpenTopoData (cached in `tools/.ele-cache.json`; add `--skip-elevation` for a fast pass), refreshes the station list, and rewrites `src/data/network.ts`.

If the portal's attribute names have changed, run once with `--inspect` to list the fields, then pass `--ref-field` / `--name-field` / `--surface-field`. The surface class is auto-detected by *values* (it looks for a field containing "Traffic Free"/"On Road"-style entries), so renames like `Desc` → `Desc_` are handled. Unnumbered link fragments (ref `0`) are excluded (`--keep-links` keeps them), and scattered chains of the same route are merged, bridging gaps up to `--join-gap` metres (default 8000) with straight connectors that are declared in the route synopsis.

### Automatic weekly refresh (recommended)

The dataset updates every Sunday. `.github/workflows/refresh-data.yml` re-downloads it every Monday 04:00, processes it with cached elevations, and commits a fresh `network.data` — the deployed app loads it at runtime, so routes stay current with **zero rebuilds and zero uploads**. Setup once: push this repo to the GitHub repo your Pages site serves from, allow Actions to write (Settings → Actions → Workflow permissions → read and write), then run the workflow manually once from the Actions tab to publish the first payload. New app versions are just a fresh `index.html` uploaded over the old one; the data file is untouched.

## Configuration

`src/config.ts` — basemap style URL (default: OpenFreeMap `positron`, keyless), UK home bounds, route colours.

## Features

Full-bleed MapLibre map · routes coloured traffic-free green / on-road amber · search by route number, name or place · "routes near me" · filters (length, traffic-free %, circular, radius) with sensible sorts · shortlist saved locally · elevation profile with a cursor linked to the map · drag handles (chart or map) to clip a section, with live stats · GPX export (whole route or clip, with elevation) · nearest stations to each end for the train home · shareable URLs (selection + clip live in the hash) · light/dark · keyboard and reduced-motion friendly.

## Data & licences

- **NCN geometry** (when built from the live dataset): © Sustrans / Walk Wheel Cycle Trust, [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/); contains Ordnance Survey data © Crown copyright and database right.
- **Stations**: [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations).
- **Basemap**: © [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, © OpenStreetMap contributors.

Attribution is shown on the map control and embedded in exported GPX metadata.
