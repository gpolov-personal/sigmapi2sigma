import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

// Single source of truth for the app version: package.json (bumped by `npm version`).
const pkgVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
).version as string;

export default defineConfig({
  root: path.resolve(__dirname, "web"),
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5174",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "web/dist"),
    emptyOutDir: true,
  },
});
