#!/usr/bin/env node
/* =========================================================================
   read-telemetry.mjs — one-glance summary of a perf run.

   Parses telemetry.jsonl (JSONL: one beacon per line), keeps the LAST record
   per runId (it's a superset — cumulative stats + the full window list), and
   prints the numbers Phase D cares about: render path, frame-time tail, budget
   overruns, draw cost, longtask blocking, and the per-5s window trend with a
   thermal-throttling verdict.

   Usage:  node read-telemetry.mjs [path-to-telemetry.jsonl]
   ========================================================================= */

import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "telemetry.jsonl";

let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(`! cannot read ${file} — run a ?perf=1 session first, or pass the path.`);
  process.exit(1);
}

const rows = text
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (rows.length === 0) {
  console.error(`! ${file} has no valid records yet.`);
  process.exit(1);
}

// keep the last (most complete) record per runId, in first-seen order
const byRun = new Map();
for (const r of rows) byRun.set(r.runId, r);

const bar = (ms, budget = 16.7, width = 24) => {
  const n = Math.max(0, Math.min(width, Math.round((ms / (budget * 3)) * width)));
  return "█".repeat(n) + "·".repeat(width - n);
};
const f = (x, d = 1) => (typeof x === "number" ? x.toFixed(d) : "—");

for (const run of byRun.values()) {
  const s = run.scene;
  const live = run.path === "webgpu";
  console.log("\n" + "═".repeat(70));
  console.log(`run ${run.runId}   phase=${run.phase}   ${f(run.elapsedS, 0)}s   ${run.frames} frames`);
  console.log("═".repeat(70));

  if (!live) {
    const why =
      run.path === "webgpu-failed"
        ? "navigator.gpu present but the device/adapter FAILED to initialise"
        : run.path === "webgpu-starting"
          ? "only the startup was captured (no frame sampled yet) — re-run a longer session"
          : "no navigator.gpu — almost always an INSECURE HTTP context";
    console.log(`  ❌ path = ${run.path}  → ${why}`);
    console.log(`     secureContext=${run.device?.secureContext}  hasNavigatorGpu=${run.device?.hasNavigatorGpu}`);
    if (run.path !== "webgpu-starting") {
      console.log(`     Fix the HTTPS tunnel (see TELEMETRY.md) and re-run.`);
    }
    continue;
  }

  const fm = run.frameMs ?? {};
  const ob = run.overBudget ?? {};
  console.log(`  path     ✅ webgpu   dpr=${f(s?.dpr, 2)} (raw ${f(run.device?.rawDpr, 2)})   render ${s?.renderW}×${s?.renderH}  ss${f(s?.supersample, 2)}`);
  console.log(`  draws    ${s?.drawCalls} draw / ${((s?.triangles ?? 0) / 1000).toFixed(0)}k tri${s?.lines ? ` / ${s.lines} ln` : ""}   f16=${s?.hasF16} timestamp=${s?.hasTimestamp}`);
  console.log(`  frameMs  p50 ${f(fm.p50)}   p95 ${f(fm.p95)}   p99 ${f(fm.p99)}   max ${f(fm.max)}   mean ${f(fm.mean)}`);
  console.log(`  budget   over 16.7ms: ${f(ob.over16Pct)}%   over 33ms: ${f(ob.over33Pct)}%`);
  const lt = run.longtask ?? {};
  console.log(`  longtask ${lt.supported ? `${lt.count} tasks / ${f(lt.totalBlockingMs)}ms blocking` : "n/a (unsupported — e.g. iOS Safari)"}`);

  const w = (run.windows ?? []).filter((x) => x.frames >= 3); // ignore tiny edge buckets
  if (w.length >= 2) {
    console.log(`  per-5s windows (p50 frame-time, throttling trend):`);
    for (const win of w) {
      console.log(`    w${String(win.i).padStart(2)}  ${f(win.p50).padStart(6)}ms  p95 ${f(win.p95).padStart(6)}ms  ${bar(win.p50)}`);
    }
    // verdict: compare the mean p50 of the first third vs the last third of windows
    const k = Math.max(1, Math.floor(w.length / 3));
    const head = w.slice(0, k);
    const tail = w.slice(-k);
    const avg = (a) => a.reduce((s2, x) => s2 + x.p50, 0) / a.length;
    const h = avg(head);
    const t = avg(tail);
    const drift = t - h;
    const pct = h > 0 ? (drift / h) * 100 : 0;
    let verdict;
    if (drift > 2 && pct > 15) verdict = `⚠ THROTTLING — late windows +${f(drift)}ms (+${f(pct, 0)}%) vs early`;
    else if (drift > 1) verdict = `~ mild upward drift +${f(drift)}ms (+${f(pct, 0)}%) — watch a longer soak`;
    else verdict = `✓ stable — no material drift (${f(drift)}ms) across the run`;
    console.log(`  verdict  ${verdict}`);
  } else {
    console.log(`  (need a longer run for a window trend — soak ~3–5 min)`);
  }
}

console.log("");
