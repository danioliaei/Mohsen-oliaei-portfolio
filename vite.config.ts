import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { telemetryCollector } from "./telemetry-collector";

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves a PROJECT site under /<repo>/ — the deploy workflow sets DEPLOY_BASE to
  // "/Mohsen-oliaei-portfolio/"; local dev/preview and any root-hosted deploy keep "/".
  base: process.env.DEPLOY_BASE ?? "/",
  // telemetryCollector mounts POST /telemetry on the dev/preview server (same origin,
  // so the HTTPS phone behind the tunnel can beacon to it). It adds nothing to the
  // client bundle and is inert on a real deploy.
  plugins: [react(), telemetryCollector()],
  // bind to 0.0.0.0 so a LAN device / tunnel can reach the server, and allow the
  // cloudflared quick-tunnel domain through Vite's Host-header check (otherwise the
  // phone gets "Blocked request. This host is not allowed."). The quick-tunnel
  // subdomain changes each run, so allow the whole *.trycloudflare.com domain.
  server: { port: 5173, open: true, host: true, allowedHosts: [".trycloudflare.com"] },
  preview: { port: 4173, host: true, allowedHosts: [".trycloudflare.com"] },
});
