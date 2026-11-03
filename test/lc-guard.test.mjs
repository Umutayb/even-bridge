import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDecision, trustsProject } from "../src/providers/durable/lc/guard-core.mjs";

const ID = "20261103-093221-c129";

function sandbox(t, repo) {
  const root = mkdtempSync(join(tmpdir(), "lc-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(home, "sandbox", "agents", "w");
  const factoryRoot = join(home, ".pi", "agent", "lets-code-factory");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(factoryRoot, ID, "work"), { recursive: true });
  writeFileSync(join(factoryRoot, ID, "ledger.json"), JSON.stringify({ v: 1, id: ID, repo: repo ?? cwd, status: "waiting", updated: 1 }));
  return { home, cwd, factoryRoot, work: join(factoryRoot, ID, "work") };
}

test("a write in the cwd passes", (t) => {
  const s = sandbox(t);
  assert.equal(guardDecision("write", { path: join(s.cwd, "a.txt"), content: "x" }, s), undefined);
  assert.equal(guardDecision("edit", { path: "a.txt" }, s), undefined);
  assert.equal(guardDecision("bash", { command: "echo hi > a.txt && ls -la" }, s), undefined);
});

test("a write in ~/.pi/agent is blocked", (t) => {
  const s = sandbox(t);
  const d = guardDecision("write", { path: join(s.home, ".pi", "agent", "settings.json"), content: "{}" }, s);
  assert.equal(d.block, true);
  assert.match(d.reason, /^even-guard: /);
  assert.match(d.reason, /\.pi is off limits/);
  assert.equal(guardDecision("read", { path: "~/.ssh/id_ed25519" }, s).block, true);
});

test("the factory worktree of this cwd's run is allowed", (t) => {
  const s = sandbox(t);
  assert.equal(guardDecision("write", { path: join(s.work, "a.txt"), content: "x" }, s), undefined);
  assert.equal(guardDecision("read", { path: join(s.work, "src", "b.js") }, s), undefined);
  assert.equal(guardDecision("bash", { command: `cd ${s.work} && git status` }, s), undefined);
  assert.equal(guardDecision("bash", { command: `ls ~/.pi/agent/lets-code-factory/${ID}/work` }, s), undefined);
});

test("the factory worktree of another repo is blocked", (t) => {
  const s = sandbox(t, "/other");
  assert.equal(guardDecision("write", { path: join(s.work, "a.txt"), content: "x" }, s).block, true);
  assert.equal(guardDecision("bash", { command: `cat ${s.work}/a.txt` }, s).block, true);
});

test("a bash command with a ~/.pi path outside the worktree is blocked", (t) => {
  const s = sandbox(t);
  const d = guardDecision("bash", { command: "cat ~/.pi/agent/models.json" }, s);
  assert.equal(d.block, true);
  assert.match(d.reason, /^even-guard: /);
  assert.equal(guardDecision("bash", { command: `cd ${s.work} && cat ../ledger.json ~/.pi/agent/auth.json` }, s).block, true);
});

test("a write outside the project is left to the mandate; RULES still block", (t) => {
  const s = sandbox(t);
  assert.equal(guardDecision("write", { path: join(s.home, "tmp", "ovs-outside.txt"), content: "hi" }, s), undefined);
  assert.equal(guardDecision("bash", { command: "echo hi > ~/tmp/ovs-outside.txt" }, s), undefined);
  assert.equal(guardDecision("bash", { command: "git push --force origin main" }, s).block, true);
  assert.equal(guardDecision("unknown_tool", { path: "~/.pi/x" }, s), undefined);
});

test("even-guard.ts is a thin adapter over guardDecision", () => {
  const src = readFileSync(new URL("../src/providers/durable/lc/even-guard.ts", import.meta.url), "utf8");
  assert.match(src, /from "\.\/guard-core\.mjs"/);
  assert.match(src, /pi\.on\("tool_call"/);
  assert.match(src, /EVEN_GUARD_CWD/);
});

test("guard-core loads no pi-durable (it runs inside every lets-code child)", () => {
  for (const f of ["../src/providers/durable/lc/guard-core.mjs", "../src/providers/durable/guard.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /from "@earendil-works\//, f);
  }
});

test("the project's .pi dir (the project-local guard) cannot be written or named in bash", (t) => {
  const s = sandbox(t);
  for (const [tool, input] of [
    ["write", { path: join(s.cwd, ".pi", "extensions", "even-guard.ts"), content: "" }],
    ["edit", { path: ".pi/extensions/even-guard.ts" }],
    ["write", { path: ".pi/settings.json", content: "{}" }],
    ["bash", { command: "rm -rf .pi" }],
    ["bash", { command: "mv .pi/extensions x" }],
    ["bash", { command: `echo > ${s.cwd}/.pi/extensions/even-guard.ts` }],
  ]) {
    const d = guardDecision(tool, input, s);
    assert.equal(d?.block, true, `${tool} ${JSON.stringify(input)}`);
    assert.match(d.reason, /^even-guard: /);
  }
  assert.equal(guardDecision("write", { path: join(s.cwd, ".pinned.txt"), content: "x" }, s), undefined, "a name starting with .pi is fine");
  assert.equal(guardDecision("bash", { command: "cat app.pid && ls .pids" }, s), undefined);
});

test("the guard trusts exactly its session's project, and only with the project guard in place", (t) => {
  const s = sandbox(t);
  assert.equal(trustsProject(s.cwd, s.cwd, { home: s.home }), false, "no project guard yet");
  mkdirSync(join(s.cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(s.cwd, ".pi", "extensions", "even-guard.ts"), "x");
  assert.equal(trustsProject(s.cwd, s.cwd, { home: s.home }), true);
  assert.equal(trustsProject(join(s.cwd, "sub"), s.cwd, { home: s.home }), false, "another dir");
  assert.equal(trustsProject(s.cwd, undefined, { home: s.home }), false, "no EVEN_GUARD_CWD: never");
  assert.equal(trustsProject(s.home, s.home, { home: s.home }), false, "never the home dir");
});

test("even-guard.ts answers project_trust through trustsProject", () => {
  const src = readFileSync(new URL("../src/providers/durable/lc/even-guard.ts", import.meta.url), "utf8");
  assert.match(src, /pi\.on\("project_trust"/);
  assert.match(src, /trustsProject\(/);
  assert.match(src, /remember: true/);
  assert.match(src, /trusted: "undecided"/);
});

// -- Task 3 fix round 2: no .pi plant in an own worktree or a nested dir (C-new-1) --
test("a factory worktree's .pi cannot be written: a planted extension or an edit of its guard", (t) => {
  const s = sandbox(t);
  for (const [tool, path] of [
    ["write", join(s.work, ".pi", "extensions", "evil.ts")],
    ["edit", join(s.work, ".pi", "extensions", "even-guard.ts")],
    ["write", join(s.work, ".pi", "settings.json")],
    ["write", join(s.work, "sub", ".pi", "extensions", "evil.ts")],
  ]) {
    const d = guardDecision(tool, { path, content: "x" }, s);
    assert.equal(d?.block, true, path);
    assert.match(d.reason, /the project's \.pi dir/);
  }
  // the rest of the worktree stays the project
  assert.equal(guardDecision("write", { path: join(s.work, "src", "a.js"), content: "x" }, s), undefined);
  assert.equal(guardDecision("write", { path: join(s.work, "pi", "a.js"), content: "x" }, s), undefined);
});

test("a nested .pi in the project (sub/.pi) cannot be written, also through a symlink", (t) => {
  const s = sandbox(t);
  assert.equal(guardDecision("write", { path: "sub/.pi/extensions/evil.ts", content: "x" }, s)?.block, true);
  assert.equal(guardDecision("edit", { path: join(s.cwd, "a", "b", ".pi", "x.ts") }, s)?.block, true);
  mkdirSync(join(s.cwd, ".pi", "extensions"), { recursive: true });
  symlinkSync(join(s.cwd, ".pi", "extensions"), join(s.cwd, "ext"));
  assert.equal(guardDecision("write", { path: join(s.cwd, "ext", "evil.ts"), content: "x" }, s)?.block, true);
  assert.equal(guardDecision("write", { path: join(s.cwd, "src", "pi.ts"), content: "x" }, s), undefined);
  assert.equal(guardDecision("read", { path: join(s.cwd, "sub", ".pi", "x") }, s), undefined, "reads are not the risk");
});
