// pi sessions start through lets-code when it is installed (its modules turn
// on only in a pi it launched), a bare pi otherwise; EVEN_BRIDGE_PI_BIN and
// --pi-bin still decide. lets-code's --model is a model id on its server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { defaultPiBin, isLetsCode, launcherModel, resolvePiConfig } from "../src/providers/pi/provider.mjs";

function binDir(names) {
  const d = mkdtempSync(join(tmpdir(), "pi-launcher-"));
  for (const n of names) { writeFileSync(join(d, n), "#!/bin/sh\n"); chmodSync(join(d, n), 0o755); }
  return d;
}

test("lets-code on PATH: pi starts through it", () => {
  const d = binDir(["lets-code", "pi"]);
  try { assert.equal(defaultPiBin({ PATH: [d, "/usr/bin"].join(delimiter) }), "lets-code"); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test("no lets-code: a bare pi", () => {
  const d = binDir(["pi"]);
  try { assert.equal(defaultPiBin({ PATH: d }), "pi"); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test("a lets-code that is not executable is not used", () => {
  const d = binDir([]);
  writeFileSync(join(d, "lets-code"), "x"); chmodSync(join(d, "lets-code"), 0o644);
  try { assert.equal(defaultPiBin({ PATH: d }), "pi"); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test("EVEN_BRIDGE_PI_BIN and --pi-bin still decide", () => {
  const was = process.env.EVEN_BRIDGE_PI_BIN;
  process.env.EVEN_BRIDGE_PI_BIN = "pi";
  try {
    assert.equal(resolvePiConfig({}).bin, "pi");
    assert.equal(resolvePiConfig({ piBin: "/opt/pi" }).bin, "/opt/pi");
  } finally {
    if (was === undefined) delete process.env.EVEN_BRIDGE_PI_BIN; else process.env.EVEN_BRIDGE_PI_BIN = was;
  }
});

test("the model for lets-code: an id on its server", () => {
  assert.equal(isLetsCode("lets-code"), true);
  assert.equal(isLetsCode("/home/u/.local/bin/lets-code"), true);
  assert.equal(isLetsCode("pi"), false);
  assert.equal(launcherModel("lets-code", "lets-code/qwen3.8-27b"), "qwen3.8-27b");
  assert.equal(launcherModel("lets-code", "qwen3.8-27b"), "qwen3.8-27b");
  assert.equal(launcherModel("pi", "lets-code/qwen3.8-27b"), "lets-code/qwen3.8-27b");
  assert.equal(launcherModel("lets-code", ""), "");
});
