import type { LngLat } from "../types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildGpx(opts: {
  name: string;
  desc: string;
  coords: LngLat[];
  ele: number[];
}): string {
  const pts = opts.coords
    .map((c, i) => {
      const e = opts.ele[Math.min(i, opts.ele.length - 1)];
      return `      <trkpt lat="${c[1].toFixed(5)}" lon="${c[0].toFixed(5)}"><ele>${Math.round(e)}</ele></trkpt>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Waymark" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(opts.name)}</name>
    <desc>${esc(opts.desc)}</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${esc(opts.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function downloadGpx(filename: string, gpx: string): void {
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
