import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvText, startEnvFile } from "../src/env-file.mjs";

test("parseEnvText handles comments, quotes, export", () => {
  assert.deepEqual(
    parseEnvText('# c\nA=1\nexport B="two words"\nC=x # note\n\nbad line\nD=\'q\'\nE=\n'),
    { A: "1", B: "two words", C: "x", D: "q", E: "" },
  );
});

test("env file overrides, reloads, and reverts removed keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "envf-"));
  const path = join(dir, "bridge.env");
  const env = { EVEN_BRIDGE_NEW_SESSION_PROVIDER: "pi", KEEP: "k" };
  writeFileSync(path, "EVEN_BRIDGE_NEW_SESSION_PROVIDER=claude\nEVEN_BRIDGE_CC_MODEL=claude-opus-5-5\n");
  const h = startEnvFile({ path, env, log: () => {}, watch: false });
  assert.equal(env.EVEN_BRIDGE_NEW_SESSION_PROVIDER, "claude");
  assert.equal(env.EVEN_BRIDGE_CC_MODEL, "claude-opus-5-5");
  writeFileSync(path, "EVEN_BRIDGE_CC_MODEL=sonnet\n");
  h.reload();
  assert.equal(env.EVEN_BRIDGE_NEW_SESSION_PROVIDER, "pi");
  assert.equal(env.EVEN_BRIDGE_CC_MODEL, "sonnet");
  writeFileSync(path, "");
  h.reload();
  assert.equal("EVEN_BRIDGE_CC_MODEL" in env, false);
  assert.equal(env.KEEP, "k");
});

test("missing file is a no-op", () => {
  const env = { A: "1" };
  startEnvFile({ path: "/nonexistent/bridge.env", env, log: () => {}, watch: false });
  assert.deepEqual(env, { A: "1" });
});
