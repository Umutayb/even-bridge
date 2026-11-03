import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "../src/providers/pi/rpc-client.mjs";

// A fake wrapper (also usable as the bin itself): writes its argv and env as JSON, then exits.
function fakeWrapper(dir) {
  const out = join(dir, "wrap.json");
  const script = join(dir, "fake-wrap.mjs");
  writeFileSync(
    script,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
  );
  chmodSync(script, 0o755);
  return { script, out };
}

async function runOnce(client) {
  const exited = new Promise((r) => client.once("exit", r));
  client.start();
  await exited;
}

test("wrap prefixes the spawn and envExact keeps only the given env", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lc-wrap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { script, out } = fakeWrapper(dir);
  await runOnce(new PiRpcClient({ bin: "node", wrap: [process.execPath, script], envExact: true, env: { X: "1" }, extraArgs: ["--sandbox"], cwd: dir }));
  const got = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(got.argv, ["node", "--mode", "rpc", "--sandbox"]);
  assert.equal(got.env.X, "1");
  assert.equal(got.env.HOME, undefined, "envExact: nothing inherited");
});

test("unset wrap and envExact keep the old spawn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lc-wrap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { script, out } = fakeWrapper(dir);
  await runOnce(new PiRpcClient({ bin: script, env: { X: "2" }, cwd: dir }));
  assert.ok(existsSync(out));
  const got = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(got.argv, ["--mode", "rpc"]);
  assert.equal(got.env.X, "2");
  assert.equal(got.env.HOME, process.env.HOME, "process.env is inherited");
});
