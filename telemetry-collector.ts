/* =========================================================================
   Telemetry collector — a tiny Vite plugin that mounts a same-origin endpoint
   on the SAME dev/preview server (one origin → no CORS, no mixed content, and
   the HTTPS phone behind the one tunnel can POST straight to it):

     POST /telemetry        → append the JSON body as one line to telemetry.jsonl
     POST /telemetry/reset  → truncate telemetry.jsonl (call at each run's start)

   It runs only on the local dev/preview server and contributes nothing to the
   client bundle. The file lands at <cwd>/telemetry.jsonl (gitignored).
   ========================================================================= */

import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";

const MAX_BODY = 2_000_000; // 2 MB hard cap per POST — defends the dev box

export function telemetryCollector(options: { file?: string } = {}): Plugin {
  const file = path.resolve(process.cwd(), options.file ?? "telemetry.jsonl");

  const handler: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
    const url = (req.url || "").split("?")[0];
    if (url !== "/telemetry" && url !== "/telemetry/reset") return next();

    // Reflect the request origin rather than a blanket "*": the beacon is same-origin in
    // practice (the phone loads the app and beacons to the same tunnel origin), but a
    // cloudflared tunnel briefly exposes this endpoint publicly, so don't advertise it to
    // arbitrary origins. Falls back to "*" only when no Origin header is present.
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "POST") return next();

    if (url === "/telemetry/reset") {
      writeFile(file, "")
        .then(() => {
          res.statusCode = 204;
          res.end();
        })
        .catch((e: unknown) => {
          res.statusCode = 500;
          res.end(String(e));
        });
      return;
    }

    // /telemetry — drain the body, validate it's JSON, append exactly one line. Byte-capped
    // (count Buffer bytes, not string chars) and timeout-guarded against an oversized or
    // slow-loris client, since the tunnel makes this endpoint briefly reachable.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = (code: number, msg: string) => {
      if (aborted) return;
      aborted = true;
      clearTimeout(timer);
      res.statusCode = code;
      res.end(msg);
      req.pause();
      req.destroy();
    };
    timer = setTimeout(() => abort(408, "request timeout"), 10_000);
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY) return abort(413, "payload too large");
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      clearTimeout(timer);
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        obj._rcv = new Date().toISOString(); // server receive time (clock-skew check)
        appendFile(file, JSON.stringify(obj) + "\n")
          .then(() => {
            res.statusCode = 204;
            res.end();
          })
          .catch((e: unknown) => {
            res.statusCode = 500;
            res.end(String(e));
          });
      } catch {
        res.statusCode = 400;
        res.end("bad json");
      }
    });
    req.on("error", () => abort(400, "stream error"));
  };

  const mount = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(handler);
    // eslint-disable-next-line no-console
    console.log(`\n  [telemetry] POST /telemetry → ${file}\n`);
  };

  return {
    name: "telemetry-collector",
    configureServer(server) {
      mount(server);
    },
    configurePreviewServer(server) {
      mount(server);
    },
  };
}
