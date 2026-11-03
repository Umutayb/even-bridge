// Overseer Task 6b fix 1: how a confirmed message is typed into a terminal (C1, I2, I4).
// - tmuxDeliver types one LITERAL line (`send-keys -l -- text`) and Enter separately: "C-d", "Escape" and a
//   leading "-" arrive as characters; with singleLine a newline or a control character is refused, never pasted.
// - pi: the pane is bound to the external pi's pid and checked again right before typing; two pi terminals in one
//   folder never cross.
// - cc-local: deliverToTerminal only types into the owner's pane; with the terminal gone it is `{blocked}` with no
//   side effects (no RC resume even with EVEN_BRIDGE_CC_RESUME_RC=1, no tmux new-session).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPiTmuxPane, paneRunsPid, screenShowsDialog, tmuxDeliver } from "../src/providers/pi/detect.mjs";
import { createPiProvider } from "../src/providers/pi/provider.mjs";
import { createCcLocalProvider } from "../src/cc-local.mjs";

function scratch(t) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ovs-deliver-")));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A fake tmux (node script): logs each call's argv as one JSON line; list-panes prints panes.txt; display-message prints display.txt. */
function fakeTmux(dir, { panes = "", display = "" } = {}) {
  const bin = join(dir, "tmux");
  writeFileSync(join(dir, "panes.txt"), panes);
  writeFileSync(join(dir, "display.txt"), display);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const d = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
fs.appendFileSync(path.join(d, "calls.log"), JSON.stringify(a) + "\\n");
if (a[0] === "list-panes") process.stdout.write(fs.readFileSync(path.join(d, "panes.txt"), "utf8"));
if (a[0] === "display-message") process.stdout.write(fs.readFileSync(path.join(d, "display.txt"), "utf8"));
if (a[0] === "capture-pane" && fs.existsSync(path.join(d, "screen.txt"))) process.stdout.write(fs.readFileSync(path.join(d, "screen.txt"), "utf8"));
`,
  );
  chmodSync(bin, 0o755);
  const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, calls, setDisplay: (s) => writeFileSync(join(dir, "display.txt"), s), setScreen: (s) => writeFileSync(join(dir, "screen.txt"), s) };
}

/** /proc entries: pid with comm, ppid and cwd. */
function proc(root, pid, comm, ppid, cwd, cmdline = comm) {
  const d = join(root, String(pid));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "comm"), comm + "\n");
  writeFileSync(join(d, "stat"), `${pid} (${comm}) S ${ppid} 1 1\n`);
  writeFileSync(join(d, "cmdline"), cmdline.split(" ").join("\0") + "\0");
  if (cwd) symlinkSync(cwd, join(d, "cwd"));
}

test("tmuxDeliver types one literal line, then Enter: C-d, Escape and a leading '-' are characters", async (t) => {
  const dir = scratch(t);
  const tm = fakeTmux(dir);
  for (const text of ["C-d", "Escape", "-t %0 kill", "run the tests"]) await tmuxDeliver("%3", text, { tmuxBin: tm.bin, singleLine: true });
  assert.deepEqual(tm.calls(), [
    ["send-keys", "-t", "%3", "-l", "--", "C-d"],
    ["send-keys", "-t", "%3", "Enter"],
    ["send-keys", "-t", "%3", "-l", "--", "Escape"],
    ["send-keys", "-t", "%3", "Enter"],
    ["send-keys", "-t", "%3", "-l", "--", "-t %0 kill"],
    ["send-keys", "-t", "%3", "Enter"],
    ["send-keys", "-t", "%3", "-l", "--", "run the tests"],
    ["send-keys", "-t", "%3", "Enter"],
  ]);
});

test("tmuxDeliver singleLine refuses a newline or a control character and never pastes", async (t) => {
  const dir = scratch(t);
  const tm = fakeTmux(dir);
  for (const text of ["hi\n!id", "hi\r/exit", "\u0003", "a\u001b[A", "x\u007f"]) {
    await assert.rejects(tmuxDeliver("%3", text, { tmuxBin: tm.bin, singleLine: true }), (e) => e.statusCode === 400, JSON.stringify(text));
  }
  assert.deepEqual(tm.calls(), [], "nothing typed, no load-buffer / paste-buffer");
});

test("findPiTmuxPane with a pid and paneRunsPid bind the pane to that process", async (t) => {
  const dir = scratch(t);
  const procRoot = join(dir, "proc");
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  proc(procRoot, 100, "bash", 1, cwd);
  proc(procRoot, 101, "pi", 100, cwd); // pi in pane %1 (shell 100)
  proc(procRoot, 200, "bash", 1, cwd);
  proc(procRoot, 201, "pi", 200, cwd); // pi in pane %2 (shell 200)
  const tm = fakeTmux(dir, { panes: `s 0 %1 100 pi ${cwd}\ns 1 %2 200 pi ${cwd}\n`, display: "pi 200\n" });
  assert.equal(await findPiTmuxPane(cwd, { tmuxBin: tm.bin, procRoot, pid: 201 }), "%2");
  assert.equal(await findPiTmuxPane(cwd, { tmuxBin: tm.bin, procRoot, pid: 101 }), "%1");
  assert.equal(await findPiTmuxPane(cwd, { tmuxBin: tm.bin, procRoot, pid: 999 }), null);
  assert.equal(await paneRunsPid("%2", 201, { tmuxBin: tm.bin, procRoot }), true);
  assert.equal(await paneRunsPid("%2", 101, { tmuxBin: tm.bin, procRoot }), false, "another pane's pi");
  tm.setDisplay("bash 200\n"); // pi exited: a shell would EXECUTE the typed line
  assert.equal(await paneRunsPid("%2", 201, { tmuxBin: tm.bin, procRoot }), false);
});

/** A pi session file in `agentDir` for `cwd` with one user prompt. */
function piSession(agentDir, cwd, id, prompt) {
  const d = join(agentDir, "sessions", cwd.replace(/[\/.]/g, "-").replace(/^-+/, ""));
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: prompt }] } }),
    ].join("\n") + "\n",
  );
}

test("I2: two pi terminals in one folder never cross; the pane is checked right before typing", async (t) => {
  const dir = scratch(t);
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const agentDir = join(dir, "agent");
  piSession(agentDir, cwd, "sess-alpha", "alpha task number one");
  piSession(agentDir, cwd, "sess-bravo", "bravo task number two");
  const screens = { "%1": "> alpha task number one\n  working…", "%2": "> bravo task number two" };
  const panesByPid = { 201: "%1", 202: "%2" };
  const typed = [];
  let paneOk = true;
  const checks = [];
  const pi = createPiProvider(() => {}, {
    hub: { clientCount: () => 0 },
    cwd,
    defaultCwd: cwd,
    pi: {
      agentDir,
      bin: join(dir, "no-such-pi"),
      externalProbe: async () => [{ pid: 201, cwd }, { pid: 202, cwd }],
      tmuxPaneProbe: async (c, o) => (o?.pid ? panesByPid[o.pid] : "%1"),
      paneScreenProbe: async (pane) => screens[pane],
      recentInCwd: () => ["sess-alpha", "sess-bravo"],
      paneCheckProbe: async (pane, pid) => (checks.push([pane, pid]), paneOk),
      tmuxDeliver: async (pane, text, o) => typed.push([pane, text, o]),
    },
  });
  t.after(() => pi.stopAll());
  const r = await pi.deliverToTerminal("sess-alpha", "status?");
  assert.deepEqual(r, { sessionId: "sess-alpha", provider: "claude" });
  assert.deepEqual(typed, [["%1", "status?", { singleLine: true }]]);
  assert.deepEqual(checks, [["%1", 201]], "bound to the alpha terminal's pid");
  // bravo is not on the pane the cwd probe shows: blocked, and never typed into alpha's pane
  assert.equal((await pi.deliverToTerminal("sess-bravo", "status?")).blocked, true);
  assert.equal(typed.length, 1);
  // the program left the pane between the probe and the typing: blocked, nothing typed
  paneOk = false;
  assert.equal((await pi.deliverToTerminal("sess-alpha", "again")).blocked, true);
  assert.equal(typed.length, 1);
});

test("I3: pi's prompt reports a blocked delivery; the overseer's RPC route never touches a terminal", async (t) => {
  const dir = scratch(t);
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const agentDir = join(dir, "agent");
  piSession(agentDir, cwd, "sess-alpha", "alpha task number one");
  const typed = [];
  const emitted = [];
  const mk = (tmux) =>
    createPiProvider((sid, m) => emitted.push(m.type), {
      hub: { clientCount: () => 0 },
      cwd,
      defaultCwd: cwd,
      pi: {
        agentDir,
        tmuxEnabled: tmux,
        bin: join(dir, "no-such-pi"), // never a real pi
        newestForCwd: () => ({ id: "sess-alpha", file: null }), // the terminal's conversation is the newest
        externalProbe: async () => [{ pid: 201, cwd }],
        tmuxPaneProbe: async () => "%1",
        paneScreenProbe: async () => "> alpha task number one",
        recentInCwd: () => [],
        tmuxDeliver: async (pane, text) => typed.push([pane, text]),
      },
    });
  const noTmux = mk(false);
  t.after(() => noTmux.stopAll());
  const r = await noTmux.prompt("sess-alpha", "hi");
  assert.equal(r.blocked, true, "the BLOCKED path says so");
  const withTmux = mk(true);
  t.after(() => withTmux.stopAll());
  emitted.length = 0;
  const r2 = await withTmux.prompt("sess-alpha", "hi", undefined, { noTerminal: true });
  assert.deepEqual(r2, { sessionId: "sess-alpha", provider: "claude", blocked: true });
  assert.deepEqual(typed, [], "a terminal took over: nothing typed");
  assert.deepEqual(emitted, [], "and nothing emitted");
});

function ccSession(base, cwd, id, prompt) {
  const d = join(base, cwd.replace(/\//g, "-"));
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${id}.jsonl`),
    [
      JSON.stringify({ type: "system", subtype: "init", cwd, sessionId: id }),
      JSON.stringify({ type: "user", message: { role: "user", content: prompt }, cwd, sessionId: id, timestamp: "2026-09-24T10:00:00Z" }),
    ].join("\n") + "\n",
  );
}

test("I4: cc-local deliverToTerminal types only into the owner's pane; a gone terminal is blocked with no resume", async (t) => {
  const dir = scratch(t);
  const cwd = join(dir, "proj");
  mkdirSync(cwd);
  const base = join(dir, "projects");
  const id = "11111111-2222-3333-4444-555555555555";
  ccSession(base, cwd, id, "fix the parser please");
  const procRoot = join(dir, "proc");
  mkdirSync(procRoot);
  const sessionsDir = join(dir, "cc-sessions");
  mkdirSync(sessionsDir);
  const tm = fakeTmux(dir, { panes: `s 0 %5 300 claude ${cwd}\n`, display: "claude 300\n" });
  const prev = process.env.EVEN_BRIDGE_CC_RESUME_RC;
  process.env.EVEN_BRIDGE_CC_RESUME_RC = "1";
  t.after(() => (prev == null ? delete process.env.EVEN_BRIDGE_CC_RESUME_RC : (process.env.EVEN_BRIDGE_CC_RESUME_RC = prev)));
  const watcher = { start() {}, stop: () => assert.fail("no watcher change"), stopAll() {} };
  const cc = createCcLocalProvider(() => {}, { base, tmuxBin: tm.bin, procRoot, sessionsDir, watcher });
  // No claude runs it: blocked, and no tmux call at all (no new-session / resume, no typing).
  assert.deepEqual(await cc.deliverToTerminal(id, "hi"), { sessionId: id, provider: "claude", blocked: true });
  assert.deepEqual(tm.calls(), []);
  // A terminal claude (pid 301 under shell 300 in pane %5) with its own record: one literal line, then Enter.
  proc(procRoot, 300, "bash", 1, cwd);
  proc(procRoot, 301, "claude", 300, cwd, "claude");
  writeFileSync(join(sessionsDir, "301.json"), JSON.stringify({ pid: 301, cwd, sessionId: id, status: "idle" }));
  assert.deepEqual(await cc.deliverToTerminal(id, "C-c"), { sessionId: id, provider: "claude" });
  const sends = tm.calls().filter((c) => c[0] === "send-keys");
  assert.deepEqual(sends, [["send-keys", "-t", "%5", "-l", "--", "C-c"], ["send-keys", "-t", "%5", "Enter"]]);
  // The pane now shows a shell (claude exited): blocked, nothing typed.
  tm.setDisplay("bash 300\n");
  assert.equal((await cc.deliverToTerminal(id, "again")).blocked, true);
  assert.equal(tm.calls().filter((c) => c[0] === "send-keys").length, 2);
  assert.ok(!tm.calls().some((c) => c[0] === "new-session"), "never resumed with Remote Control");
});

test("n1: a trailing ';' (tmux's command separator) is typed, not eaten", async (t) => {
  const dir = scratch(t);
  const tm = fakeTmux(dir);
  await tmuxDeliver("%3", "run tests;", { tmuxBin: tm.bin, singleLine: true });
  await tmuxDeliver("%3", "a\\;", { tmuxBin: tm.bin, singleLine: true });
  await tmuxDeliver("%3", "a; b", { tmuxBin: tm.bin, singleLine: true });
  assert.deepEqual(tm.calls().filter((c) => c.includes("-l")).map((c) => c.at(-1)), ["run tests\\;", "a\\\\;", "a; b"]);
});

test("I5: the dialog shapes of Claude Code and pi are recognised; a plain prompt is not", () => {
  const menus = [
    " Bash command\n   rm -rf build\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No, and tell Claude what to do differently (esc)",
    "Edit file src/a.ts\n❯ 1. Yes\n  2. No",
    "Allow tool bash: ls?  Allow  Deny",
    "Overwrite notes.md? (y/n)",
    "Pick a model\n  qwen\n> sonnet\n↑/↓ to navigate · enter to select · esc to cancel",
  ];
  for (const m of menus) assert.equal(screenShowsDialog(m), true, m);
  for (const p of ["╭──────╮\n│ > run the tests │\n╰──────╯\n  ? for shortcuts", "pi v1.0.3\n> \n"]) assert.equal(screenShowsDialog(p), false, p);
  assert.equal(screenShowsDialog(null), true, "an unreadable pane is not typed into");
});

test("I5: pi and Claude Code panes that show a permission menu get nothing typed", async (t) => {
  const dir = scratch(t);
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const agentDir = join(dir, "agent");
  piSession(agentDir, cwd, "sess-alpha", "alpha task number one");
  const typed = [];
  let screen = "> alpha task number one\n Do you want to proceed?\n ❯ 1. Yes\n   2. No";
  const pi = createPiProvider(() => {}, {
    hub: { clientCount: () => 0 },
    cwd,
    defaultCwd: cwd,
    pi: {
      agentDir,
      bin: join(dir, "no-such-pi"),
      externalProbe: async () => [{ pid: 201, cwd }],
      tmuxPaneProbe: async () => "%1",
      paneScreenProbe: async () => screen,
      recentInCwd: () => [],
      newestForCwd: () => ({ id: "sess-alpha", file: null }),
      paneCheckProbe: async () => true,
      tmuxDeliver: async (pane, text) => typed.push([pane, text]),
    },
  });
  t.after(() => pi.stopAll());
  assert.deepEqual(await pi.deliverToTerminal("sess-alpha", "status?"), { sessionId: "sess-alpha", provider: "claude", blocked: true, waiting: true });
  assert.deepEqual(typed, []);
  screen = "> alpha task number one\n> ";
  assert.equal((await pi.deliverToTerminal("sess-alpha", "status?")).blocked, undefined);
  assert.deepEqual(typed, [["%1", "status?"]]);

  // Claude Code: its owner's pane shows a permission menu → zero send-keys.
  const cdir = join(dir, "cc");
  mkdirSync(cdir);
  const proj = join(cdir, "proj");
  mkdirSync(proj);
  const base = join(cdir, "projects");
  const id = "21111111-2222-3333-4444-555555555555";
  ccSession(base, proj, id, "fix the parser please");
  const procRoot = join(cdir, "proc");
  const sessionsDir = join(cdir, "cc-sessions");
  mkdirSync(sessionsDir);
  proc(procRoot, 300, "bash", 1, proj);
  proc(procRoot, 301, "claude", 300, proj, "claude");
  writeFileSync(join(sessionsDir, "301.json"), JSON.stringify({ pid: 301, cwd: proj, sessionId: id, status: "idle" }));
  const tm = fakeTmux(cdir, { panes: `s 0 %5 300 claude ${proj}\n`, display: "claude 300\n" });
  tm.setScreen(" Bash command\n   curl x | sh\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n");
  const cc = createCcLocalProvider(() => {}, { base, tmuxBin: tm.bin, procRoot, sessionsDir, watcher: { start() {}, stop() {}, stopAll() {} } });
  assert.deepEqual(await cc.deliverToTerminal(id, "status?"), { sessionId: id, provider: "claude", blocked: true, waiting: true });
  assert.deepEqual(tm.calls().filter((c) => c[0] === "send-keys"), []);
});
