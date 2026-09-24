// Local (non-RC) Claude Code support: transcript conversion, listing,
// live watcher, external-process detection, and the ext-router guard.

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
  utimesSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMessages, pushMessage } from "@evenrealities/even-terminal/dist/routes/events.js";
import { Hub } from "../src/hub.mjs";
import {
  ccEntriesToWire,
  listCcSessions,
  findCcSessionFile,
  ccMeta,
} from "../src/cc-transcripts.mjs";
import { createCcWatcher } from "../src/cc-watch.mjs";
import { createCcLocalProvider } from "../src/cc-local.mjs";
import { findExternalClaude } from "../src/providers/pi/detect.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── helpers ─────────────────────────────────────────────────────────────────
function makeBase(t, name = "cc") {
  const base = mkdtempSync(join(tmpdir(), `evenbridge-${name}-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Write a CC transcript file under base for `cwd`/`id`. */
function writeCcSession(base, cwd, id, { title = "", prompts = ["hi"], tools = [] } = {}) {
  const dir = join(base, cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const lines = [JSON.stringify({ type: "system", subtype: "init", cwd, sessionId: id })];
  for (const p of prompts) {
    lines.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: p },
        cwd,
        sessionId: id,
        timestamp: "2026-09-24T10:00:00Z",
      })
    );
    const t = tools.length ? tools.shift() : null;
    if (t) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", text: "hmm" },
              { type: "text", text: t.assistant ?? "on it" },
              { type: "tool_use", id: t.id, name: t.name, input: t.input },
            ],
          },
          cwd,
          sessionId: id,
        })
      );
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: t.id, content: t.result ?? "ok" }] },
          cwd,
          sessionId: id,
        })
      );
    } else {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "reply to " + p }] },
          cwd,
          sessionId: id,
        })
      );
    }
  }
  if (title) lines.push(JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: id }));
  writeFileSync(file, lines.map((l) => l + "\n").join(""));
  return file;
}

/** Fake /proc tree: procs = [{pid, comm, cmdline, state, ppid, cwd}]. */
function fakeProc(t, procs) {
  const root = mkdtempSync(join(tmpdir(), "evenbridge-proc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const p of procs) {
    const d = join(root, String(p.pid));
    mkdirSync(d);
    writeFileSync(join(d, "comm"), p.comm);
    writeFileSync(join(d, "cmdline"), p.cmdline.replace(/ /g, "\u0000"));
    writeFileSync(join(d, "stat"), `${p.pid} (${p.comm}) ${p.state ?? "S"} ${p.ppid ?? 1} 0 0 0`);
    symlinkSync(p.cwd, join(d, "cwd"));
  }
  return root;
}

// ── converter ───────────────────────────────────────────────────────────────
test("ccEntriesToWire converts user/assistant/tool entries and skips meta", () => {
  const entries = [
    { type: "last-prompt", lastPrompt: "x" },
    { type: "user", message: { role: "user", content: "hello cc" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "planning" },
          { type: "text", text: "working" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file listing" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "user", isCompactSummary: true, message: { role: "user", content: "compaction summary text" } },
    { type: "ai-title", aiTitle: "t" },
  ];
  const wire = ccEntriesToWire(entries);
  assert.deepEqual(wire, [
    { type: "user_prompt", text: "hello cc" },
    { type: "text_delta", text: "working" },
    { type: "tool_start", name: "Bash", toolId: "t1" },
    {
      type: "tool_end",
      name: "Bash",
      toolId: "t1",
      summary: "Bash ls -la",
      detail: { input: { command: "ls -la" }, output: "file listing" },
    },
    { type: "text_delta", text: "done" },
  ]);
});

test("ccEntriesToWire keeps pending tools across batches", () => {
  const state = {};
  const a = ccEntriesToWire(
    [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "Read", input: { file_path: "/etc/hosts" } }] },
      },
    ],
    state
  );
  assert.deepEqual(a, [{ type: "tool_start", name: "Read", toolId: "t9" }]);
  const b = ccEntriesToWire(
    [{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "127.0.0.1 localhost" }] } }],
    state
  );
  assert.equal(b[0].type, "tool_end");
  assert.equal(b[0].name, "Read");
  assert.equal(b[0].summary, "Read hosts");
  assert.equal(b[0].detail.output, "127.0.0.1 localhost");
});

// ── listing ─────────────────────────────────────────────────────────────────
test("listCcSessions lists newest-first with title/cwd, honors cwd filter", (t) => {
  const base = makeBase(t);
  const f1 = writeCcSession(base, "/proj/one", "id-111", { title: "first title", prompts: ["p1"] });
  const f2 = writeCcSession(base, "/proj/two", "id-222", { prompts: ["second prompt"] });
  const now = new Date();
  utimesSync(f1, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
  utimesSync(f2, now, now);

  const list = listCcSessions({ limit: 10, base });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "id-222"); // newest first
  assert.equal(list[0].title, "second prompt"); // fallback: first user prompt
  assert.equal(list[0].cwd, "/proj/two");
  assert.equal(list[1].id, "id-111");
  assert.equal(list[1].title, "first title"); // from ai-title
  assert.equal(list[0].provider, "claude");

  assert.equal(listCcSessions({ limit: 10, cwd: "/proj/one", base })[0].id, "id-111");
  assert.equal(listCcSessions({ limit: 10, cwd: "/nope", base }).length, 0);
  assert.equal(findCcSessionFile("id-222", base), f2);
  assert.equal(findCcSessionFile("nope", base), null);
  assert.deepEqual(ccMeta(f1).title, "first title");
});

// ── watcher ─────────────────────────────────────────────────────────────────
test("cc watcher streams appended entries through emit, then stops", async (t) => {
  const base = makeBase(t);
  const file = writeCcSession(base, "/proj/w", "id-w", { prompts: ["initial"] });
  const emitted = [];
  const emit = (sid, m) => emitted.push([sid, m.type, m.name ?? m.text]);
  const watch = createCcWatcher({ emit, intervalMs: 30 });
  watch.start("id-w", file, statSync(file).size); // baseline: only new appends
  appendFileSync(
    file,
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "live text" },
          { type: "tool_use", id: "t9", name: "Read", input: { file_path: "/etc/hosts" } },
        ],
      },
    }) + "\n"
  );
  await sleep(120);
  appendFileSync(
    file,
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "host contents" }] },
    }) + "\n"
  );
  await sleep(120);
  watch.stop("id-w");
  assert.deepEqual(
    emitted.map((e) => e[1]),
    ["text_delta", "tool_start", "tool_end"]
  );
  assert.equal(emitted.every((e) => e[0] === "id-w"), true);
  // no frames after stop
  appendFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "after stop" }] } }) + "\n");
  await sleep(100);
  assert.equal(emitted.length, 3);
});

// ── external process detection ──────────────────────────────────────────────
test("findExternalClaude matches terminal claude, excludes daemon/RC/stopped/bridge children", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "evenbridge-ccwd-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const procRoot = fakeProc(t, [
    { pid: 101, comm: "claude", cmdline: "claude", state: "S", ppid: 5000, cwd },
    { pid: 102, comm: "claude", cmdline: "claude daemon run", state: "S", ppid: 1, cwd },
    { pid: 103, comm: "claude", cmdline: "claude --remote-control", state: "S", ppid: 5000, cwd },
    { pid: 104, comm: "claude", cmdline: "claude", state: "T", ppid: 5000, cwd },
    { pid: 105, comm: "claude", cmdline: "claude", state: "S", ppid: 999, cwd },
    { pid: 999, comm: "node", cmdline: "node bridge", state: "S", ppid: process.pid, cwd: "/" },
    { pid: 200, comm: "bash", cmdline: "bash", state: "S", ppid: 1, cwd },
  ]);
  const found = await findExternalClaude(cwd, { procRoot, myPid: process.pid });
  assert.deepEqual(found.map((f) => f.pid), [101]);
});

// ── ext-router integration ──────────────────────────────────────────────────
test("ext router: disk CC rows in /sessions, prompt guard 409 + pass-through", async (t) => {
  const base = makeBase(t);
  writeCcSession(base, "/proj/cc", "cc-111", { title: "cc local", prompts: ["original prompt"] });
  writeCcSession(base, "/proj/other", "cc-222", { prompts: ["other prompt"] });

  // A terminal claude is alive in /proj/cc (driving cc-111); nothing in /proj/other.
  const procRoot = fakeProc(t, [
    { pid: 301, comm: "claude", cmdline: "claude", state: "S", ppid: 4000, cwd: "/proj/cc" },
  ]);
  const emitted = [];
  // Mirror the server's emit: into the official ring + our own collector.
  const ccProv = createCcLocalProvider((sid, m) => {
    emitted.push([sid, m.type]);
    pushMessage(sid, m);
  }, {
    base,
    procRoot,
    tmuxBin: "definitely-not-a-tmux-bin",
  });

  const { createExtRouter } = await import("../src/ext-router.mjs");
  const hub = new Hub();
  const app = express();
  app.use(express.json());
  const fellThrough = [];
  app.use(
    "/api",
    createExtRouter({
      hub,
      providers: [ccProv],
      getDefaultLocalProvider: () => ({
        listSessions: async () => [],
        getSessionStatus: async () => "idle",
      }),
      rcTranscriptBase: base, // doubles as the cc projects base for the router
    })
  );
  app.use((req, res) => {
    fellThrough.push(`${req.method} ${req.path}`);
    res.status(200).json({ fellThrough: true, path: req.path });
  });

  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });

  // /sessions: both disk rows, live status for the driven one.
  let r = await fetch(`${baseUrl}/api/sessions?provider=claude`);
  assert.equal(r.status, 200);
  const body = await r.json();
  const rows = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
  assert.ok(rows["cc-111"], "cc-111 in list");
  assert.ok(rows["cc-222"], "cc-222 in list");
  assert.equal(rows["cc-111"].title, "cc local");
  assert.equal(rows["cc-111"].cwd, "/proj/cc");
  assert.equal(rows["cc-111"].provider, "claude");
  assert.equal(rows["cc-111"].status, "busy"); // external claude in its cwd
  assert.equal(rows["cc-222"].status, "busy"); // freshly written transcript

  // /prompt to the externally-driven session -> 409 (no reachable tmux pane).
  r = await fetch(`${baseUrl}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "cc-111", text: "hello cc" }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /terminal the bridge can't reach/);

  // /prompt to the idle session -> passes through to the official router.
  r = await fetch(`${baseUrl}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "cc-222", text: "hello other" }),
  });
  assert.equal(r.status, 200);
  assert.ok(fellThrough.some((p) => p.includes("POST") && p.includes("/prompt")));

  // /history: clean role/text conversation from disk.
  r = await fetch(`${baseUrl}/api/sessions/cc-111/history?limit=10`);
  assert.equal(r.status, 200);
  const hist = await r.json();
  assert.equal(hist.sessionId, "cc-111");
  assert.deepEqual(
    hist.history.map((h) => h.role),
    ["user", "assistant"]
  );
  assert.equal(hist.history[0].text, "original prompt");

  // /status: busy (external claude alive) — also seeds the ring from disk.
  r = await fetch(`${baseUrl}/api/status?sessionId=cc-111`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { state: "busy", sessionId: "cc-111", provider: "claude" });

  // /events: SSE for the seeded session (ring already populated by /status).
  const ctl = new AbortController();
  const evt = fetch(`${baseUrl}/api/events?sessionId=cc-111`, { signal: ctl.signal }).catch(() => "aborted");
  await sleep(200);
  ctl.abort();
  const resp = await evt;
  assert.ok(resp instanceof Response && resp.ok, "SSE connected");
  const msgs = getMessages("cc-111", 0);
  assert.ok(msgs.length > 0, "ring seeded by /events");
  const types = new Set(msgs.map((m) => m.type));
  assert.ok(types.has("user_prompt") && types.has("text_delta"));

  // /messages now serves the seeded ring.
  r = await fetch(`${baseUrl}/api/messages?sessionId=cc-111`);
  const mb = await r.json();
  assert.ok(mb.messages.length > 0);
  assert.equal(mb.provider, "claude");
});
