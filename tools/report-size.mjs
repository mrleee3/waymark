import { readFileSync, statSync, renameSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";

try {
  // The build entry is app.html (the deploy target index.html would be
  // consumed as input otherwise) — publish the output under its real name.
  if (existsSync("dist/app.html")) renameSync("dist/app.html", "dist/index.html");
  const path = "dist/index.html";
  const raw = statSync(path).size;
  const gz = gzipSync(readFileSync(path)).length;
  console.log(`\ndist/index.html — ${(raw / 1048576).toFixed(2)} MB on disk, ${(gz / 1048576).toFixed(2)} MB if the host gzips.`);
} catch {
  console.log("dist/index.html not found — did the build fail?");
}
