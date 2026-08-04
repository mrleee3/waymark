// Zips the project source (excluding node_modules, dist, caches) to
// waymark-source.zip. Tries `zip`, then PowerShell, then Python — one of the
// three exists on any normal machine.
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const OUT = "waymark-source.zip";
const EXCLUDES = ["node_modules", "dist", ".git", "tools/.ele-cache.json", "network.data", OUT];

if (existsSync(OUT)) rmSync(OUT);

const attempts = [
  {
    name: "zip",
    cmd: `zip -r ${OUT} . -x ${EXCLUDES.map((e) => `"${e}/*" "${e}"`).join(" ")}`,
  },
  {
    name: "PowerShell",
    cmd: `powershell -NoProfile -Command "Get-ChildItem -Force | Where-Object { $_.Name -notin @(${EXCLUDES.map((e) => `'${e}'`).join(",")}) } | Compress-Archive -DestinationPath ${OUT}"`,
  },
  {
    name: "Python",
    cmd: `python3 -c "import zipfile,os;z=zipfile.ZipFile('${OUT}','w',zipfile.ZIP_DEFLATED);[z.write(os.path.join(r,f)) for r,d,fs in os.walk('.') if not any(x in r for x in (${EXCLUDES.map((e) => `'${e}'`).join(",")})) for f in fs if f!='${OUT}']"`,
  },
];

for (const a of attempts) {
  try {
    execSync(a.cmd, { stdio: "pipe" });
    console.log(`${OUT} written (via ${a.name}).`);
    process.exit(0);
  } catch {
    /* try next */
  }
}
console.error("Couldn't create the zip — install `zip`, or archive the folder manually (skip node_modules and dist).");
process.exit(1);
