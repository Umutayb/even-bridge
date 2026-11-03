import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCwdFor } from "../src/providers/pi/provider.mjs";

let root, phone, bridge, def, home, gone, file;

test.before(() => {
  root = mkdtempSync(join(tmpdir(), "even-bridge-start-cwd-"));
  [phone, bridge, def, home] = ["phone", "bridge", "default", "home"].map((n) => join(root, n));
  for (const d of [phone, bridge, def, home]) mkdirSync(d);
  gone = join(root, "no-such-folder");
  file = join(root, "a-file");
  writeFileSync(file, "x");
});

test.after(() => rmSync(root, { recursive: true, force: true }));

test("the phone's folder, when it exists", () => {
  assert.deepEqual(startCwdFor(phone, bridge, def, home), { cwd: phone });
});

test("no phone folder: the bridge's cwd, then the default", () => {
  assert.deepEqual(startCwdFor(undefined, bridge, def, home), { cwd: bridge });
  assert.deepEqual(startCwdFor(undefined, undefined, def, home), { cwd: def });
});

test("a phone folder that does not exist: the bridge's cwd, and it is named", () => {
  assert.deepEqual(startCwdFor(gone, bridge, def, home), { cwd: bridge, missing: gone });
});

test("a phone folder that is a file: treated as missing", () => {
  assert.deepEqual(startCwdFor(file, bridge, def, home), { cwd: bridge, missing: file });
});

test("missing, and the bridge's cwd missing too: the default, else HOME", () => {
  assert.deepEqual(startCwdFor(gone, join(root, "gone2"), def, home), { cwd: def, missing: gone });
  assert.deepEqual(startCwdFor(gone, undefined, undefined, home), { cwd: home, missing: gone });
});

test("nothing exists: undefined (the spawn falls back to the process cwd)", () => {
  assert.deepEqual(startCwdFor(gone, undefined, undefined, join(root, "gone3")), { cwd: undefined, missing: gone });
});

test("nothing named at all: undefined, nothing missing", () => {
  assert.deepEqual(startCwdFor(undefined, undefined, undefined, home), { cwd: undefined });
});
