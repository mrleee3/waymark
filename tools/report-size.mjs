import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

try {
  const path = "dist/index.html";
  const raw = statSync(path).size;
  const gz = gzipSync(readFileSync(path)).length;
  console.log(`\ndist/index.html — ${(raw / 1048576).toFixed(2)} MB on disk, ${(gz / 1048576).toFixed(2)} MB if the host gzips.`);
} catch {
  console.log("dist/index.html not found — did the build fail?");
}
