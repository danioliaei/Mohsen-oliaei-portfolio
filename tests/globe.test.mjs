import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Load the real TypeScript math/geometry without a browser or GPU. GPU API calls
// remain inside functions and are not invoked by these geometry regressions.
const cache = new Map();
function load(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  const exports = {};
  cache.set(url.href, exports);
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(outputText, {
    exports,
    require: (path) => load(new URL(path + ".ts", url)),
  });
  return exports;
}
const { globePointerStrength } = load(new URL("../src/gpu/globePointer.ts", import.meta.url));
const { buildFilamentGeometry } = load(new URL("../src/gpu/ridgeline.ts", import.meta.url));

test("pointer influence is local, with a soft rim and no activation outside the globe", () => {
  assert.equal(globePointerStrength(200, 200, 200, 200, 100), 1);
  assert.equal(globePointerStrength(301, 200, 200, 200, 100), 0);
  assert.equal(globePointerStrength(-1, -1, 200, 200, 100), 0);
  assert.equal(globePointerStrength(200, 200, 200, 200, 0), 0);
  const rim = globePointerStrength(291, 200, 200, 200, 100);
  assert.ok(rim > 0 && rim < 1);
});

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"} core has finite surface arcs, never centre-crossing spikes`, () => {
    const geometry = buildFilamentGeometry(phone);
    assert.equal(geometry.length % 14, 0);
    assert.ok(geometry.every(Number.isFinite));
    let arcs = 0;
    for (let i = 0; i < geometry.length; i += 14) {
      const seed = geometry[i + 4], radius = geometry[i + 6];
      if (seed < 2 || radius >= 0.12) continue;
      const dot = geometry[i] * geometry[i + 7] + geometry[i + 1] * geometry[i + 8] + geometry[i + 2] * geometry[i + 9];
      assert.ok(dot > 0.95, "a core chord must stay near its surface, not cut through its centre");
      assert.ok(radius >= 0.07 && radius <= 0.1);
      assert.ok(geometry[i + 5] < 1, "core stroke intensity must stay below the old white-hot sparks");
      arcs++;
    }
    assert.ok(arcs >= 100);
  });
}
