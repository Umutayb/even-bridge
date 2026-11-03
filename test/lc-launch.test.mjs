import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  resetFailedScope,
  expertsEnabled,
  FACTORY_EXPERTS,
  installProjectGuard,
  projectGuardSource,
  LC_PROJECT_GUARD,
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
  assert.deepEqual(l.wrap, ["systemd-run", "--user", "--scope", "-q", "--collect", "--unit=even-lc-dur-abc", "-p", "MemoryMax=500M", "-p", "MemorySwapMax=0", "-p", "CPUQuota=200%", "--"]);
  assert.deepEqual(l.extraArgs, ["--mandate", "ask", "--subagents", "--sandbox", "--session-dir", "/s/lc-sessions/dur-abc", "-e", "/b/src/providers/durable/lc/even-guard.ts"]);
});

test("lcLaunch without a memory controller omits MemoryMax", () => {
  const l = lcLaunch({ ...BASE, caps: { memoryMax: null, cpuQuota: "200%" } });
  assert.deepEqual(l.wrap, ["systemd-run", "--user", "--scope", "-q", "--collect", "--unit=even-lc-dur-abc", "-p", "CPUQuota=200%", "--"]);
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

test("resetFailedScope forgets a failed scope of the session only", () => {
  const calls = [];
  resetFailedScope("dur-a", { run: (argv) => (calls.push(argv), { status: 1 }) });
  assert.deepEqual(calls, [["systemctl", "--user", "reset-failed", "even-lc-dur-a.scope"]]);
});

test("expertsEnabled reads lets-code's state file and never writes it", () => {
  const all = Object.fromEntries(FACTORY_EXPERTS.map((n) => [n, true]));
  assert.deepEqual(expertsEnabled({ readFile: () => JSON.stringify({ experts: all }) }), { ok: true, missing: [] });
  assert.deepEqual(expertsEnabled({ readFile: () => JSON.stringify({ experts: { ...all, tester: false } }) }), { ok: false, missing: ["tester"] });
  assert.deepEqual(expertsEnabled({ readFile: () => { throw new Error("ENOENT"); } }).missing, [...FACTORY_EXPERTS]);
});

test("the project-local guard imports guard-core by absolute URL and is rewritten atomically", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lc-pguard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = projectGuardSource();
  assert.match(src, /import \{ guardDecision \} from "file:\/\/\/.+\/lc\/guard-core\.mjs";/);
  assert.match(src, /pi\.on\("tool_call"/);
  const f = installProjectGuard(dir);
  assert.equal(f, join(dir, LC_PROJECT_GUARD));
  writeFileSync(f, "tampered");
  installProjectGuard(dir);
  assert.equal(readFileSync(f, "utf8"), src, "every spawn overwrites it");
});


// ── Task 3 fix round: trust store, git exclude, factory worktrees ─────────────
import { excludeProjectGuard, factoryWorktrees, updateTrust } from "../src/providers/durable/lc/launch.mjs";
import { execFileSync } from "node:child_process";
import { realpathSync as realpath3 } from "node:fs";

test("updateTrust sets and removes entries in pi's format and releases its lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-trust-"));
  try {
    const file = join(dir, "trust.json");
    writeFileSync(file, JSON.stringify({ "/z": true, "/a": false }));
    const w = join(dir, "work");
    mkdirSync(w);
    assert.deepEqual(await updateTrust([w], true, { file }), [realpath3(w)]);
    assert.deepEqual(await updateTrust([w], true, { file }), [], "idempotent");
    const text = readFileSync(file, "utf8");
    assert.equal(text, JSON.stringify({ "/a": false, [realpath3(w)]: true, "/z": true }, null, 2) + "\n");
    assert.ok(!existsSync(`${file}.lock`));
    assert.deepEqual(await updateTrust([w, "/nope"], null, { file }), [realpath3(w)]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "/a": false, "/z": true });
    // a lock held by pi (fresh) makes it wait and give up; a stale one is taken over
    mkdirSync(`${file}.lock`);
    // the wait is asynchronous: a timer keeps firing meanwhile (the event loop is not blocked)
    let ticks = 0;
    const iv = setInterval(() => ticks++, 5);
    await assert.rejects(updateTrust([w], true, { file, tries: 10, delayMs: 20 }), /locked/);
    clearInterval(iv);
    assert.ok(ticks >= 5, `timers ran during the wait (${ticks})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("excludeProjectGuard keeps the guard out of git, also in a worktree; not a repo: false", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-excl-"));
  const git = (args, cwd) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(["init", "-q"], repo);
    git(["commit", "-q", "--allow-empty", "-m", "first"], repo);
    const wt = join(dir, "wt");
    git(["worktree", "add", "-q", "-b", "run", wt], repo);
    assert.equal(excludeProjectGuard(wt), true);
    assert.equal(excludeProjectGuard(wt), true);
    const ex = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.equal(ex.split("\n").filter((l) => l === "/.pi/extensions/even-guard.ts").length, 1);
    mkdirSync(join(wt, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(wt, ".pi", "extensions", "even-guard.ts"), "x");
    git(["add", "-A"], wt);
    assert.equal(git(["status", "--porcelain"], wt).trim(), "");
    const plain = join(dir, "plain");
    mkdirSync(plain);
    assert.equal(excludeProjectGuard(plain, { git: () => { throw new Error("not a repo"); } }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factoryWorktrees lists running/waiting runs of this cwd with an existing worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "lc-fwt-"));
  try {
    const mk = (id, repo, status, work = true) => {
      mkdirSync(join(root, id), { recursive: true });
      if (work) mkdirSync(join(root, id, "work"));
      writeFileSync(join(root, id, "ledger.json"), JSON.stringify({ v: 1, id, repo, status, work: join(root, id, "work") }));
    };
    mk("a", "/w/proj", "waiting");
    mk("b", "/w/proj", "stopped");
    mk("c", "/w/other", "running");
    mk("d", "/w/proj/sub", "running");
    mk("e", "/w/proj", "running", false);
    assert.deepEqual(factoryWorktrees("/w/proj", root).map((x) => x.id).sort(), ["a", "d"]);
    assert.deepEqual(factoryWorktrees("", root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


import { sealProjectPi } from "../src/providers/durable/lc/launch.mjs";
import { lstatSync as lstat3, readdirSync as readdir3, symlinkSync as symlink3 } from "node:fs";

test("sealProjectPi keeps .pi to the bridge's guard: restores it, quarantines everything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-seal-"));
  try {
    const proj = join(dir, "proj");
    const q = join(dir, "quarantine");
    mkdirSync(join(proj, ".pi", "extensions"), { recursive: true });
    // first seal: installs the guard
    assert.deepEqual(sealProjectPi(proj, { quarantine: q }), { restored: false, removed: [] });
    const g = join(proj, ".pi", "extensions", "even-guard.ts");
    assert.equal(readFileSync(g, "utf8"), projectGuardSource());
    assert.deepEqual(sealProjectPi(proj, { quarantine: q }), { restored: false, removed: [] }, "unchanged: nothing to do");
    // plants and a tampered guard
    writeFileSync(join(proj, ".pi", "extensions", "evil.ts"), "export default () => {}");
    writeFileSync(join(proj, ".pi", "settings.json"), "{}");
    mkdirSync(join(proj, ".pi", "skills"));
    writeFileSync(g, "// nothing");
    const r = sealProjectPi(proj, { quarantine: q });
    assert.equal(r.restored, true);
    assert.deepEqual(r.removed.sort(), [".pi/extensions/evil.ts", ".pi/settings.json", ".pi/skills"]);
    assert.equal(readFileSync(g, "utf8"), projectGuardSource());
    assert.deepEqual(readdir3(join(proj, ".pi")), ["extensions"]);
    assert.deepEqual(readdir3(join(proj, ".pi", "extensions")), ["even-guard.ts"]);
    assert.equal(readdir3(q).length, 3, "moved to the quarantine, not deleted");
    // a symlinked guard and a symlinked extensions dir are replaced, never followed
    const outside = join(dir, "outside.ts");
    writeFileSync(outside, "keep me");
    rmSync(g);
    symlink3(outside, g);
    const r2 = sealProjectPi(proj, { quarantine: q });
    assert.deepEqual(r2.removed, [".pi/extensions/even-guard.ts"]);
    assert.ok(lstat3(g).isFile() && !lstat3(g).isSymbolicLink());
    assert.equal(readFileSync(outside, "utf8"), "keep me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factoryWorktrees ignores a ledger whose work is not its own <root>/<id>/work", () => {
  const root = mkdtempSync(join(tmpdir(), "lc-fwt2-"));
  try {
    mkdirSync(join(root, "x", "work"), { recursive: true });
    writeFileSync(join(root, "x", "ledger.json"), JSON.stringify({ v: 1, id: "x", repo: "/w/p", status: "running", work: "/home/ay/elsewhere" }));
    mkdirSync(join(root, "y", "work"), { recursive: true });
    writeFileSync(join(root, "y", "ledger.json"), JSON.stringify({ v: 1, id: "y", repo: "/w/p", status: "running" }));
    assert.deepEqual(factoryWorktrees("/w/p", root).map((x) => x.id), ["y"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


import { tracksDotPi } from "../src/providers/durable/lc/launch.mjs";

test("tracksDotPi: a repo tracking .pi (top or nested) is found; untracked or no repo is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-tracks-"));
  const git = (args, cwd) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".pi"), { recursive: true });
    git(["init", "-q"], repo);
    writeFileSync(join(repo, "a.txt"), "x");
    writeFileSync(join(repo, ".pi", "x.ts"), "x"); // untracked
    git(["add", "a.txt"], repo);
    git(["commit", "-q", "-m", "a"], repo);
    assert.equal(tracksDotPi(repo), false);
    mkdirSync(join(repo, "sub", ".pi"), { recursive: true });
    writeFileSync(join(repo, "sub", ".pi", "s.json"), "{}");
    git(["add", "sub"], repo);
    git(["commit", "-q", "-m", "nested"], repo);
    assert.equal(tracksDotPi(repo), true);
    const plain = join(dir, "plain");
    mkdirSync(plain);
    assert.equal(tracksDotPi(plain), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracksDotPi fails closed: not a repo is false, any other git error refuses (true) with a log line", () => {
  const warned = [];
  const log = { warn: (l) => warned.push(l) };
  const throwing = (props) => () => {
    throw Object.assign(new Error(props.message ?? "Command failed: git ls-files"), props);
  };
  assert.equal(tracksDotPi("/x", { git: throwing({ stderr: "fatal: not a git repository (or any of the parent directories): .git\n", status: 128 }), log }), false);
  assert.equal(warned.length, 0);
  assert.equal(tracksDotPi("/x", { git: throwing({ code: "ETIMEDOUT", signal: "SIGTERM" }), log }), true, "a timeout refuses");
  assert.equal(tracksDotPi("/x", { git: throwing({ code: "ENOENT", message: "spawnSync git ENOENT" }), log }), true, "git missing refuses");
  assert.equal(tracksDotPi("/x", { git: throwing({ stderr: "fatal: detected dubious ownership in repository at '/x'", status: 128 }), log }), true);
  assert.equal(tracksDotPi("/x", { git: throwing({ stderr: "error: index file corrupt", status: 128 }), log }), true);
  assert.equal(warned.length, 4);
  assert.match(warned[0], /refusing/);
});
