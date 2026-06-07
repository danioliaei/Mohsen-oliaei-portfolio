import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Production builds (GitHub Pages) are served from /Mohsen-oliaei-portfolio/.
  // The dev server (incl. `npm run dev -- --host` for phone-over-LAN) stays at /.
  base: command === "build" ? "/Mohsen-oliaei-portfolio/" : "/",
  server: { port: 5173, open: true },
}));
