import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACTORY_ROOT,
  LC_DEFAULT_BIN,
  LC_SCOPE_PREFIX,
  findFactoryRun,
  lcEnv,
  lcLaunch,
  lcMemoryControllerAvailable,
  lcSandboxAvailable,
  lcScopeUnit,
  removeStaleRegistry,
  stopLcScopes,
} from "../src/providers/durable/lc/launch.mjs";

const BASE = {
  sid: "dur-abc",
  cwd: "/home/ay/sandbox/agents/x",
  sessionDir: "/s/lc-sessions/dur-abc",
  name: "x",
  bin: "/home/ay/.local/bin/lets-code",
  guardExt: "/b/src/providers/durable/lc/even-guard.ts",
  caps: { memoryMax: "500M", cpuQuota: "200%" },
  wrapper: "systemd-run",
  sandbox: true,
};

test("constants", () => {
  assert.equal(LC_SCOPE_PREFIX, "even-lc-");
  assert.equal(LC_DEFAULT_BIN, "lets-code");
  assert.equal(FACTORY_ROOT, "~/.pi/agent/lets-code-factory");
  assert.equal(lcScopeUnit("dur-abc"), "even-lc-dur-abc");
});

test("lcLaunch builds the glasses argv and the scope wrapper", () => {
  const l = lcLaunch(BASE);
  assert.equal(l.bin, "/home/ay/.local/bin/lets-code");
  assert.deepEqual(l.wrap, ["systemd-run", "--user", "--scope", "-q", "--unit=even-lc-dur-abc", "-p", "MemoryMax=500M", "-p", "CPUQuota=200%", "--"]);
  assert.deepEqual(l.extraArgs, ["--mandate", "ask", "--subagents", "--sandbox", "--session-dir", "/s/lc-sessions/dur-abc", "-e", "/b/src/providers/durable/lc/even-guard.ts"]);
});

test("lcLaunch without a memory controller omits MemoryMax", () => {
  const l = lcLaunch({ ...BASE, caps: { memoryMax: null, cpuQuota: "200%" } });
  assert.deepEqual(l.wrap, ["systemd-run", "--user", "--scope", "-q", "--unit=even-lc-dur-abc", "-p", "CPUQuota=200%", "--"]);
});

test("lcLaunch defaults the bin to lets-code", () => {
  const { bin, ...rest } = BASE;
  assert.equal(lcLaunch(rest).bin, "lets-code");
});

test("lcLaunch without the sandbox passes --no-sandbox", () => {
  assert.equal(lcLaunch({ ...BASE, sandbox: false }).extraArgs[3], "--no-sandbox");
});

test("lcLaunch without systemd-run has no wrap; a model goes in lets-code id form", () => {
  const l = lcLaunch({ ...BASE, wrapper: "none", model: "lets-code/qwen-other" });
  assert.deepEqual(l.wrap, []);
  assert.deepEqual(l.extraArgs.slice(-2), ["--model", "qwen-other"]);
});

test("lcEnv keeps pi in the scope and drops secrets", () => {
  const e = lcEnv({ PATH: "/usr/bin", HOME: "/home/ay", BRIDGE_TOKEN: "b", LETS_CODE_TOKEN: "t", ANTHROPIC_API_KEY: "k", LETS_CODE_EXPERTS_ON: "1" }, { cwd: "/w" });
  assert.equal(e.BRIDGE_TOKEN, undefined);
  assert.equal(e.LETS_CODE_TOKEN, undefined);
  assert.equal(e.ANTHROPIC_API_KEY, undefined);
  assert.equal(e.LETS_CODE_MEM_WATCH, "false");
  assert.equal(e.LETS_CODE_MEM_GUARD, "false");
  assert.equal(e.LETS_CODE_EXPERTS_ON, undefined);
  assert.equal(e.LETS_CODE_SUBAGENT_CONCURRENCY, "1");
  assert.equal(e.PI_TELEMETRY, "0");
  assert.equal(e.EVEN_GUARD_CWD, "/w");
  assert.equal(e.PATH, "/usr/bin");
});

test("lcMemoryControllerAvailable reads cgroup.controllers", () => {
  assert.equal(lcMemoryControllerAvailable({ readFile: () => "cpuset cpu io pids\n" }), false);
  assert.equal(lcMemoryControllerAvailable({ readFile: () => "cpuset cpu io memory pids\n" }), true);
  assert.equal(lcMemoryControllerAvailable({ readFile: () => { throw new Error("ENOENT"); } }), false);
});

test("stopLcScopes stops only the given sids", () => {
  const calls = [];
  stopLcScopes(["dur-a", "dur-b"], { run: (argv) => (calls.push(argv), { status: 0 }) });
  assert.deepEqual(calls, [["systemctl", "--user", "stop", "even-lc-dur-a.scope", "even-lc-dur-b.scope"]]);
  stopLcScopes([], { run: (argv) => (calls.push(argv), { status: 0 }) });
  assert.equal(calls.length, 1, "no sids: no call");
});

test("lcSandboxAvailable needs bwrap and socat", () => {
  assert.equal(lcSandboxAvailable({ which: () => true }), true);
  assert.equal(lcSandboxAvailable({ which: (b) => b === "bwrap" }), false);
  assert.equal(lcSandboxAvailable({ which: (b) => b === "socat" }), false);
});

test("findFactoryRun picks the newest running or waiting ledger of the cwd", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lc-factory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = (id, repo, status, updated) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "ledger.json"), JSON.stringify({ v: 1, id, repo, status, updated }));
  };
  ledger("20261103-0900-aaaa", "/w", "done", 1);
  ledger("20261103-0901-bbbb", "/w", "waiting", 2);
  ledger("20261103-0902-cccc", "/w", "stopped", 3);
  ledger("20261103-0903-dddd", "/other", "waiting", 4);
  assert.equal(findFactoryRun("/w", root), "20261103-0901-bbbb");
  ledger("20261103-0904-eeee", "/w/sub", "running", 5);
  assert.equal(findFactoryRun("/w", root), "20261103-0904-eeee", "a repo under the cwd counts");
  assert.equal(findFactoryRun("/nowhere", root), null);
  assert.equal(findFactoryRun("/w", join(root, "missing")), null);
});

test("removeStaleRegistry deletes the file of a dead pid only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "lc-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = join(root, "4242.json");
  writeFileSync(f, "{}");
  assert.equal(removeStaleRegistry(4242, { root, alive: () => true }), false);
  assert.ok(existsSync(f));
  assert.equal(removeStaleRegistry(4242, { root, alive: () => false }), true);
  assert.ok(!existsSync(f));
  assert.equal(removeStaleRegistry(null, { root, alive: () => false }), false);
});
