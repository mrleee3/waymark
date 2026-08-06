import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Everything — JS, CSS, data payload — is inlined into dist/index.html.
// The only runtime network dependency is the basemap tile service.
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? `dev-${Date.now().toString(36)}`),
  },
  plugins: [react(), viteSingleFile()],
  build: {
    rollupOptions: { input: "app.html" },
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8192,
    reportCompressedSize: false,
  },
});
