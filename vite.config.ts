import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { telemetryCollector } from "./telemetry-collector";

// https://vite.dev/config/
export default defineConfig({
  // telemetryCollector mounts POST /telemetry on the dev/preview server (same origin,
  // so the HTTPS phone behind the tunnel can beacon to it). It adds nothing to the
  // client bundle and is inert on a real deploy.
  plugins: [react(), telemetryCollector()],
  // bind to 0.0.0.0 so a LAN device / tunnel can reach the dev server
  server: { port: 5173, open: true, host: true },
});
