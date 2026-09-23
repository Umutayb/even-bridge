// pi cross-surface sync: transcript watcher, external-driver detection, and
// single-writer prompt routing (the fix for glasses prompts being eaten by
// a wedged second instance while a terminal pi drove the session).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, symlink, chmod } from "node:fs/promises";
import { readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { createPiProvider } from "../src/providers/pi/provider.mjs";
import { TranscriptWatcher } from "../src/providers/pi/watcher.mjs";
import { findExternalPi, findPiTmuxPane, tmuxDeliver } from "../src/providers/pi/detect.mjs";

const require = createRequire(import.meta.url);
const getMessages = require("@evenrealities/even-terminal/dist/routes/events.js").getMessages;

async function tmp() {
  return mkdtemp(join(tmpdir(), "evenbridge-pi-sync-"));
}

/** A pi session file with two messages (user + assistant). */
async function makeSessionFile(agentDir, cwd, id, entries) {
  const dir = join(agentDir, "sessions", enc(cwd));
  await mkdir(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", id: "s0", cwd })];
  for (const e of entries) lines.push(JSON.stringify(e));
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

function enc(cwd) {
  return cwd.replace(/[\/.]/g, "-").replace(/^-+/, "");
}

function msgEntry(id, role, content) {
  return { type: "message", id, timestamp: "2026-01-01T00:00:01.000Z", message: { role, content } };
}

/** Fake `pi` binary: answers every RPC command with a canned response. */
async function makeFakePi(dir, sessionId) {
  const script = join(dir, "fake-pi");
  await writeFile(
    script,
    `#!/bin/sh
while read line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":"([^"]*)".*/\\1/')
  printf '{"id":"%s","type":"response","success":true,"data":{"sessionId":"%s"}}\\n' "$id" "${sessionId}"
done
`
  );
  await chmod(script, 0o755);
  return script;
}

/** Fake `tmux` binary: records subcommands; answers list-panes with canned rows. */
async function makeFakeTmux(dir, panes) {
  const log = join(dir, "tmux-calls.log");
  const script = join(dir, "fake-tmux");
  const rows = panes
    .map((p) => `  echo ${JSON.stringify(`${p.session} 0 ${p.pane} ${p.command} ${p.path}`)}`)
    .join("\n");
  await writeFile(
    script,
    `#!/bin/sh
echo "tmux $*" >> ${JSON.stringify(log)}
if [ "$1" = "list-panes" ]; then
${rows}
fi
exit 0
`
  );
  await chmod(script, 0o755);
  return { bin: script, log };
}

/** Fake /proc root with one pi process at the given cwd. */
async function makeProcRoot(dir, pid, cwd) {
  const proc = join(dir, "proc");
  await mkdir(join(proc, String(pid)), { recursive: true });
  await writeFile(join(proc, String(pid), "comm"), "pi\n");
  await symlink(cwd, join(proc, String(pid), "cwd"));
  return proc;
}

function collectEmit() {
  const by = new Map();
  const emit = (sid, msg) => {
    if (!by.has(sid)) by.set(sid, []);
    by.get(sid).push(msg);
  };
  emit.get = (sid) => by.get(sid) ?? [];
  return emit;
}

// ── detect: external pi probe ───────────────────────────────────────────────

test("findExternalPi finds pi processes by cwd", async () => {
  const dir = await tmp();
  const proc = await makeProcRoot(dir, 4242, "/home/ay/github");
  const hit = await findExternalPi("/home/ay/github", { procRoot: proc, myPid: 1 });
  assert.deepEqual(hit, [{ pid: 4242, cwd: "/home/ay/github" }]);
  const miss = await findExternalPi("/other/cwd", { procRoot: proc, myPid: 1 });
  assert.deepEqual(miss, []);
});

// ── detect: tmux pane lookup + delivery ─────────────────────────────────────

test("findPiTmuxPane matches command+path; tmuxDeliver sends keys", async () => {
  const dir = await tmp();
  const { bin } = await makeFakeTmux(dir, [
    { session: "s1", pane: "%1", command: "vi", path: "/home/ay/github" },
    { session: "s2", pane: "%2", command: "pi", path: "/home/ay/github" },
    { session: "s3", pane: "%3", command: "pi", path: "/elsewhere" },
  ]);
  const pane = await findPiTmuxPane("/home/ay/github", { tmuxBin: bin });
  assert.equal(pane, "%2");

  await tmuxDeliver("%2", "hello glasses", { tmuxBin: bin });
  const { readFile } = await import("node:fs/promises");
  const calls = (await readFile(join(dir, "tmux-calls.log"), "utf8")).trim().split("\n");
  assert.ok(
    calls.includes("tmux send-keys -t %2 hello glasses Enter"),
    `send-keys recorded; got: ${JSON.stringify(calls)}`
  );

  // multi-line goes through load-buffer + paste-buffer + Enter
  await tmuxDeliver("%2", "line one\nline two", { tmuxBin: bin });
  const calls2 = (await readFile(join(dir, "tmux-calls.log"), "utf8")).trim().split("\n");
  const loadCall = calls2.find((c) => c.startsWith("tmux load-buffer -b evenbridge "));
  assert.ok(loadCall && loadCall.endsWith("/prompt.txt"), "loads a temp buffer file");
  assert.ok(calls2.includes("tmux paste-buffer -b evenbridge -t %2"));
  assert.equal(calls2.at(-1), "tmux send-keys -t %2 Enter");
});

// ── watcher: terminal → phone sync ──────────────────────────────────────────

test("watcher delivers new transcript entries once, dedupes by id, skips healthy", async () => {
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const id = "aaaa1111-2222-3333-4444-555566667777";
  const file = await makeSessionFile(agentDir, "/home/ay/github", id, [
    msgEntry("e1", "user", [{ type: "text", text: "first from terminal" }]),
  ]);

  const emit = collectEmit();
  const w = new TranscriptWatcher({
    emit,
    findFile: (sid) => (sid === id ? file : null),
    healthy: async () => false, // external writer drives
    active: () => true,
    intervalMs: 25,
  });
  w.watch(id);

  // append NEW entries (terminal writes while glasses watch)
  await appendFile(
    file,
    JSON.stringify(msgEntry("e2", "assistant", [{ type: "text", text: "reply from terminal" }])) + "\n"
  );
  await new Promise((r) => setTimeout(r, 60));
  await appendFile(
    file,
    JSON.stringify(msgEntry("e3", "user", [{ type: "text", text: "next terminal line" }])) + "\n"
  );
  await new Promise((r) => setTimeout(r, 60));
  w.stopAll();

  const msgs = emit.get(id);
  const types = msgs.map((m) => m.type);
  assert.deepEqual(
    types.sort(),
    ["text_delta", "user_prompt"],
    "only NEW entries delivered (history stays with seeding)"
  );
  const delta = msgs.find((m) => m.type === "text_delta");
  assert.equal(delta.text, "reply from terminal");

  // Re-watching from the same offset must not double-deliver (id dedupe +
  // EOF baseline): a second watcher over the same file delivers nothing new.
  const emit2 = collectEmit();
  const w2 = new TranscriptWatcher({
    emit: emit2,
    findFile: (sid) => (sid === id ? file : null),
    healthy: async () => false,
    active: () => true,
    intervalMs: 25,
  });
  w2.watch(id);
  await new Promise((r) => setTimeout(r, 80));
  w2.stopAll();
  assert.equal(emit2.get(id).length, 0, "no history replay on re-watch");
});

test("watcher skips healthy sessions (events already flow over RPC)", async () => {
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const id = "bbbb1111-2222-3333-4444-555566667777";
  const file = await makeSessionFile(agentDir, "/home/ay/github", id, [
    msgEntry("e1", "user", [{ type: "text", text: "x" }]),
  ]);
  const emit = collectEmit();
  const w = new TranscriptWatcher({
    emit,
    findFile: (sid) => (sid === id ? file : null),
    healthy: async () => true, // live bridge child is the sole writer
    active: () => true,
    intervalMs: 25,
  });
  w.watch(id);
  await appendFile(file, JSON.stringify(msgEntry("e2", "assistant", [{ type: "text", text: "y" }])) + "\n");
  await new Promise((r) => setTimeout(r, 80));
  w.stopAll();
  assert.equal(emit.get(id).length, 0, "nothing fed from the file while healthy");
});

test("watcher delivers tool results across ticks (persistent toolCall bookkeeping)", async () => {
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const id = "00011111-2222-3333-4444-555566667777";
  const file = await makeSessionFile(agentDir, "/home/ay/github", id, [
    // assistant message with a toolCall lands in the baseline (not delivered)
    msgEntry("e1", "assistant", [
      { type: "text", text: "doing it" },
      { type: "toolCall", id: "tc-1", name: "Bash", arguments: { command: "ls" } },
    ]),
  ]);

  const emit = collectEmit();
  const w = new TranscriptWatcher({
    emit,
    findFile: (sid) => (sid === id ? file : null),
    healthy: async () => false,
    active: () => true,
    intervalMs: 25,
  });
  w.watch(id);
  await new Promise((r) => setTimeout(r, 60)); // settle baseline

  // toolResult arrives in a LATER batch than its toolCall (the real case)
  await appendFile(
    file,
    JSON.stringify({
      type: "message",
      id: "e2",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "toolResult", toolCallId: "tc-1", toolName: "Bash", isError: false, content: [{ type: "text", text: "total 0" }] },
    }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 80));
  w.stopAll();

  const msgs = emit.get(id);
  const end = msgs.find((m) => m.type === "tool_end");
  assert.ok(end, "tool_end delivered despite cross-batch toolCall");
  assert.equal(end.name, "Bash");
  assert.equal(end.toolId, "tc-1");
});

// ── provider prompt routing (single-writer rule) ────────────────────────────

test("prompt routes to tmux when an external terminal pi drives the session", async () => {
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const id = "cccc1111-2222-3333-4444-555566667777";
  await makeSessionFile(agentDir, "/home/ay/github", id, [
    msgEntry("e1", "user", [{ type: "text", text: "hello" }]),
  ]);

  const emitted = collectEmit();
  const tmux = await makeFakeTmux(dir, [{ session: "t", pane: "%9", command: "pi", path: "/home/ay/github" }]);
  const delivered = [];
  let stopped = 0;

  // Pre-seed a wedged bridge child (the 02:59 zombie scenario).
  const wedged = {
    client: { running: true },
    childPid: 999001,
    sessionId: id,
    status: "idle",
    stop: async () => {
      stopped += 1;
    },
  };

  const provider = createPiProxy({
    emitted,
    agentDir,
    tmux,
    delivered,
    wedged,
    wedgedId: id,
  });

  const res = await provider.prompt(id, "hi from glasses", undefined);
  assert.equal(res.sessionId, id);
  assert.equal(res.provider, "claude");
  assert.deepEqual(delivered, ["%9", "hi from glasses"]); // send-keys into the tmux pane
  assert.equal(stopped, 1, "wedged bridge child dropped");
  const echo = emitted.get(id).find((m) => m.type === "user_prompt");
  assert.equal(echo.text, "hi from glasses"); // phone sees its own message
  assert.equal(provider._sessions.has(id), false, "wedged child removed from the map");
});

test("prompt reports clearly when external pi is not in tmux (no wedged spawn)", async () => {
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const id = "dddd1111-2222-3333-4444-555566667777";
  await makeSessionFile(agentDir, "/home/ay/github", id, [
    msgEntry("e1", "user", [{ type: "text", text: "hello" }]),
  ]);

  const emitted = collectEmit();
  const tmux = await makeFakeTmux(dir, []); // no matching pane
  const provider = createPiProxy({ emitted, agentDir, tmux, delivered: [] });
  const res = await provider.prompt(id, "hi", undefined);
  assert.equal(res.sessionId, id);
  const err = emitted.get(id).find((m) => m.type === "error");
  assert.ok(err, "error surfaced to the phone");
  assert.match(err.message, /tmux/);
  assert.equal(provider._sessions.size, 0, "no second instance spawned");
});

test("prompt spawns/resumes its own instance when no external driver exists", async () => {
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const id = "eeee1111-2222-3333-4444-555566667777";
  const fakeSid = "ffff1111-2222-3333-4444-555566667777";
  await makeSessionFile(agentDir, "/home/ay/github", id, [
    msgEntry("e1", "user", [{ type: "text", text: "hello" }]),
  ]);
  const fakePi = await makeFakePi(dir, fakeSid);
  const tmux = await makeFakeTmux(dir, []);

  const emitted = collectEmit();
  const provider = createPiProxy({
    emitted,
    agentDir,
    tmux,
    delivered: [],
    external: async () => [], // no terminal pi for this cwd
    bin: fakePi,
  });
  const res = await provider.prompt(id, "hi", undefined);
  // The fake pi reports its own session id (as real pi does via get_state).
  assert.equal(res.sessionId, fakeSid);
  const msgs = emitted.get(fakeSid);
  assert.ok(msgs.some((m) => m.type === "user_prompt" && m.text === "hi"));
  // Live in the map; a prompt to it reuses the instance (steer/run, no spawn).
  assert.equal(provider._sessions.has(fakeSid), true);
  await provider.stopAll();
});

test("prompt for a non-newest session in an external driver's cwd spawns its own instance", async () => {
  // The 12:44 collision: an external terminal pi drives the FRESHEST
  // conversation in /home/ay/github ("this" session); a prompt to a DIFFERENT
  // session in the same cwd must NOT be injected into the terminal — the
  // bridge drives its own instance for it (distinct transcripts are safe).
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const mine = "aaaa1111-2222-3333-4444-555566660000"; // external pi's conversation
  const theirs = "bbbb1111-2222-3333-4444-555566660000"; // the prompted (older) session
  const fakeSid = "ffff1111-2222-3333-4444-555566667777";
  const myFile = await makeSessionFile(agentDir, "/home/ay/github", mine, [
    msgEntry("e1", "user", [{ type: "text", text: "terminal convo" }]),
  ]);
  const theirFile = await makeSessionFile(agentDir, "/home/ay/github", theirs, [
    msgEntry("e2", "user", [{ type: "text", text: "phone convo" }]),
  ]);
  // The terminal pi is actively writing `mine` -> it is the freshest file.
  const now = Date.now() / 1000;
  utimesSync(theirFile, now - 3600, now - 3600);
  utimesSync(myFile, now, now);

  const fakePi = await makeFakePi(dir, fakeSid);
  const tmux = await makeFakeTmux(dir, [{ session: "t", pane: "%9", command: "pi", path: "/home/ay/github" }]);
  const delivered = [];
  const emitted = collectEmit();
  const provider = createPiProxy({ emitted, agentDir, tmux, delivered, bin: fakePi });

  const res = await provider.prompt(theirs, "hi to the phone session", undefined);
  assert.equal(res.sessionId, fakeSid, "bridge spawned its own instance (fake pi's id)");
  assert.equal(delivered.length, 0, "nothing was injected into the terminal pane");
  const msgs = emitted.get(fakeSid) ?? [];
  assert.ok(msgs.some((m) => m.type === "user_prompt" && m.text === "hi to the phone session"));
  const errs = msgs.filter((m) => m.type === "error");
  assert.equal(errs.length, 0, "no BLOCKED error — this is not the terminal's conversation");
  assert.equal(provider._sessions.has(fakeSid), true, "own instance is live in the map");
  await provider.stopAll();
});

test("pane screen content identifies the conversation the terminal drives (beats mtime)", async () => {
  // Two sessions share /home/ay/github. The prompted (older) one is what the
  // terminal TUI is actually SHOWING on screen — so route to the pane even
  // though mtime would say the other conversation is fresher.
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const other = "cccc1111-2222-3333-4444-555566669999"; // fresher on disk
  const target = "cccc1111-2222-3333-4444-555566668888"; // on screen (older file)
  const otherFile = await makeSessionFile(agentDir, "/home/ay/github", other, [
    msgEntry("e1", "user", [{ type: "text", text: "some other recent conversation text" }]),
  ]);
  const targetFile = await makeSessionFile(agentDir, "/home/ay/github", target, [
    msgEntry("e2", "user", [{ type: "text", text: "the conversation the terminal shows right now" }]),
  ]);
  const now = Date.now() / 1000;
  utimesSync(targetFile, now - 3600, now - 3600);
  utimesSync(otherFile, now, now);

  const tmux = await makeFakeTmux(dir, [{ session: "t", pane: "%9", command: "pi", path: "/home/ay/github" }]);
  const delivered = [];
  const emitted = collectEmit();
  // The screen shows the TARGET session's recent prompt text.
  const provider = createPiProxy({
    emitted,
    agentDir,
    tmux,
    delivered,
    screen: "\u2500\u2500 USER: the conversation the terminal shows right now \u2500\u2500\n~ assistant thinking ~",
  });

  const res = await provider.prompt(target, "hi", undefined);
  assert.equal(res.sessionId, target);
  assert.deepEqual(delivered, ["%9", "hi"], "routed to the pane — screen is ground truth");
});

test("pane clearly showing a sibling conversation -> spawn own instance for the prompted one", async () => {
  const dir = await tmp();
  const agentDir = join(dir, "agent");
  const sibling = "dddd1111-2222-3333-4444-555566669999"; // on screen
  const target = "dddd1111-2222-3333-4444-555566668888"; // prompted (not on screen)
  const fakeSid = "ffff1111-2222-3333-4444-555566661111";
  await makeSessionFile(agentDir, "/home/ay/github", sibling, [
    msgEntry("e1", "user", [{ type: "text", text: "sibling conversation visible on the screen here" }]),
  ]);
  await makeSessionFile(agentDir, "/home/ay/github", target, [
    msgEntry("e2", "user", [{ type: "text", text: "the prompted conversation that is NOT on screen" }]),
  ]);

  const fakePi = await makeFakePi(dir, fakeSid);
  const tmux = await makeFakeTmux(dir, [{ session: "t", pane: "%9", command: "pi", path: "/home/ay/github" }]);
  const delivered = [];
  const emitted = collectEmit();
  const provider = createPiProxy({
    emitted,
    agentDir,
    tmux,
    delivered,
    bin: fakePi,
    screen: "USER: sibling conversation visible on the screen here ...",
    recentInCwd: () => [sibling, target],
  });

  const res = await provider.prompt(target, "hi", undefined);
  assert.equal(res.sessionId, fakeSid, "own instance spawned (screen shows a DIFFERENT conversation)");
  assert.equal(delivered.length, 0, "nothing injected into the terminal pane");
  await provider.stopAll();
});

/** Provider with DI'd probes (external driver, tmux pane, tmux delivery). */
function createPiProxy({ emitted, agentDir, tmux, delivered, wedged, wedgedId, external, bin, screen, recentInCwd }) {
  const pi = {
    agentDir,
    bin,
    externalProbe:
      external ??
      (async () => [{ pid: 4242, cwd: "/home/ay/github" }]), // default: external driver alive
    tmuxPaneProbe: async (cwd) => findPiTmuxPane(cwd, { tmuxBin: tmux.bin }),
    tmuxDeliver: async (pane, text) => {
      delivered.push(pane, text);
    },
    // Pane screen capture (null = indeterminate -> mtime fallback).
    paneScreenProbe: async () => (screen ?? null),
    recentInCwd: recentInCwd ?? (() => []),
    // Mirror the real "freshest transcript in the cwd" signal against the
    // tests' loose session-dir layout.
    newestForCwd: (c) => {
      const dir = join(agentDir, "sessions", enc(c));
      let names;
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
      } catch {
        return null;
      }
      let best = null;
      for (const n of names) {
        const p = join(dir, n);
        const st = statSync(p);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { file: p, id: n.slice(n.lastIndexOf("_") + 1, -6), mtimeMs: st.mtimeMs };
        }
      }
      return best;
    },
  };
  const provider = createPiProvider(
    (sid, msg) => emitted(sid, msg),
    { hub: { clientCount: () => 1 }, pi, cwd: "/home/ay/github", defaultCwd: "/home/ay/github" }
  );
  if (wedged && wedgedId) provider._sessions.set(wedgedId, wedged);
  return provider;
}
