import test from "node:test";
import assert from "node:assert/strict";
import { isLetsCode, launcherModel } from "../src/providers/pi/provider.mjs";

test("isLetsCode accepts lets-code and pi-inference", () => {
  assert.equal(isLetsCode("/home/ay/.local/bin/lets-code"), true);
  assert.equal(isLetsCode("lets-code"), true);
  assert.equal(isLetsCode("pi-inference"), true);
  assert.equal(isLetsCode("/home/ay/.local/bin/pi-inference"), true);
  assert.equal(isLetsCode("pi"), false);
  assert.equal(isLetsCode("lets-code-x"), false);
  assert.equal(launcherModel("/home/ay/.local/bin/pi-inference", "lets-code/qwen3.8-27b"), "qwen3.8-27b");
});
