import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExternalPi } from "../src/providers/pi/detect.mjs";

function fakePi(proc, pid, cwd, cgroup) {
  const d = join(proc, String(pid));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "comm"), "pi\n");
  writeFileSync(join(d, "stat"), `${pid} (pi) S 1\n`);
  symlinkSync(cwd, join(d, "cwd"));
  if (cgroup !== undefined) writeFileSync(join(d, "cgroup"), cgroup + "\n");
}

test("findExternalPi skips processes in even-lc scopes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-detect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proc = join(dir, "proc");
  const slice = "0::/user.slice/user-1000.slice/user@1000.service/app.slice";
  fakePi(proc, 100, "/w", `${slice}/even-lc-dur-x.scope`);
  fakePi(proc, 101, "/w", `${slice}/run-r1.scope`);
  fakePi(proc, 102, "/w"); // no cgroup file (older fake procs): not skipped
  const hit = await findExternalPi("/w", { procRoot: proc, myPid: 1 });
  assert.deepEqual(hit.sort((a, b) => a.pid - b.pid), [{ pid: 101, cwd: "/w" }, { pid: 102, cwd: "/w" }]);
  const all = await findExternalPi("/w", { procRoot: proc, myPid: 1, skipCgroup: null });
  assert.equal(all.length, 3, "skipCgroup null: no cgroup check");
});
