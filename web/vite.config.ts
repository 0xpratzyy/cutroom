import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const target = `http://127.0.0.1:${process.env.CUTROOM_PORT ?? 4321}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/media": { target, changeOrigin: true },
      "/exports": { target, changeOrigin: true },
      "/ws": { target: target.replace("http", "ws"), ws: true, changeOrigin: true },
    },
  },
});
