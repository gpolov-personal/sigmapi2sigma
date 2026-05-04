import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "web"),
  plugins: [react()],
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
