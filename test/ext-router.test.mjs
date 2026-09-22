import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim } from "../src/ownership.mjs";
import { Hub } from "../src/hub.mjs";

// ── Hermetic stubs for the official provider surface ───────────────────────
// The ext router consults the official default provider for LOCAL sessions;
// stub it so tests never touch the user's ~/.claude or ~/.codex.
const localProvider = {
  listSessions: async () => [
    { id: "local-1", title: "Local session", timestamp: "2025-04-01T00:00:00Z", cwd: "/local", provider: "claude", status: null },
  ],
  getSessionStatus: async () => "idle",
};

function stubRc() {
  const calls = { prompt: [], permission: [], question: [], interrupt: [] };
  return {
    calls,
    name: "claude-remote",
    wireProvider: "claude",
    probe: async (sid) => sid.startsWith("rc-"),
    listSessions: async () => [
      { id: "rc-1", title: "RC session", timestamp: "2025-05-01T00:00:00Z", cwd: "/remote", provider: "claude", status: "busy" },
    ],
    getSessionStatus: async () => "busy",
    getInfo: async () => ({ account: {}, model: "rc", version: "9.9", provider: "claude" }),
    getHistory: async () => [{ role: "user", text: "hi" }],
    prompt: async (sid, text) => {
      calls.prompt.push({ sid, text });
      return { sessionId: sid ?? "rc-new", provider: "claude" };
    },
    respondPermission: async (sid, d) => {
      calls.permission.push([sid, d]);
      return true;
    },
    respondQuestion: async (sid, a) => calls.question.push([sid, a]),
    interrupt: async (sid) => calls.interrupt.push(sid),
    getStatus: (sid) => (sid.startsWith("rc-") ? { state: "busy", provider: "claude" } : null),
    ensurePump: () => {},
  };
}

function stubPi() {
  const calls = { prompt: [], permission: [], question: [], interrupt: [] };
  return {
    calls,
    name: "pi",
    wireProvider: "claude",
    probe: (sid) => sid.startsWith("pi-"),
    listSessions: async () => [
      { id: "pi-1", title: "Pi session", timestamp: "2025-06-01T00:00:00Z", cwd: "/pi", provider: "claude", status: null },
    ],
    getSessionStatus: async () => "idle",
    getInfo: async () => ({ account: {}, model: "pi", version: "0.1", provider: "claude" }),
    getHistory: async () => [{ role: "user", text: "hey" }],
    prompt: async (sid, text) => {
      calls.prompt.push({ sid, text });
      return { sessionId: sid ?? "pi-new", provider: "claude" };
    },
    respondPermission: (sid, d) => calls.permission.push([sid, d]),
    respondQuestion: (sid, a) => calls.question.push([sid, a]),
    interrupt: (sid) => calls.interrupt.push(sid),
    getStatus: (sid) => (sid.startsWith("pi-") ? { state: "idle", provider: "claude" } : null),
  };
}

/** Build an app with ONLY the ext router + a fall-through sentinel.
 *  The official default provider is injected (hermetic — never touches
 *  the user's ~/.claude or ~/.codex). */
async function buildApp(t, { rc, pi, local = localProvider, rcTranscriptBase }) {
  const { createExtRouter } = await import("../src/ext-router.mjs");
  const hub = new Hub();
  const app = express();
  app.use(express.json());
  const fellThrough = [];
  app.use(
    "/api",
    createExtRouter({
      hub,
      providers: [rc, pi],
      getDefaultLocalProvider: () => local,
      rcTranscriptBase,
    })
  );
  app.use((req, res) => {
    // Catch-all sentinel (Express 5 has no /api/* wildcard): anything that
    // reached here fell through the ext router (would hit official routers).
    fellThrough.push(`${req.method} ${req.path}`);
    res.status(200).json({ fellThrough: true, path: req.path });
  });
  return { app, hub, fellThrough };
}

test("ext router routes by session ownership (no provider param)", async (t) => {
  const rc = stubRc();
  const pi = stubPi();
  const { app, hub, fellThrough } = await buildApp(t, { rc, pi });
  // Claim ids as listSessions would.
  claim("rc-1", "claude-remote");
  claim("pi-1", "pi");

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });

  // /prompt to an RC session: no provider param — ownership routes it.
  let r = await fetch(`${base}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "rc-1", text: "hello rc" }),
  });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true, sessionId: "rc-1", provider: "claude" });
  assert.deepEqual(rc.calls.prompt, [{ sid: "rc-1", text: "hello rc" }]);

  // /prompt to a pi session.
  r = await fetch(`${base}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "pi-1", text: "hello pi" }),
  });
  assert.equal(r.status, 202);
  assert.deepEqual(pi.calls.prompt, [{ sid: "pi-1", text: "hello pi" }]);

  // permission-response / interrupt route by ownership too.
  r = await fetch(`${base}/api/permission-response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "pi-1", decision: "allow" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(pi.calls.permission, [["pi-1", "allow"]]);
  r = await fetch(`${base}/api/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "rc-1" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(rc.calls.interrupt, ["rc-1"]);

  // /status + /messages for an owned session.
  r = await fetch(`${base}/api/status?sessionId=rc-1`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { state: "busy", sessionId: "rc-1", provider: "claude" });

  hub.feed("rc-1", { type: "text_delta", text: "streamed" });
  r = await fetch(`${base}/api/messages?sessionId=rc-1`);
  const msgs = await r.json();
  assert.equal(msgs.state, "busy");
  assert.equal(msgs.messages.length, 1);
  assert.equal(msgs.messages[0].text, "streamed");

  // /sessions/:id/history.
  r = await fetch(`${base}/api/sessions/rc-1/history`);
  assert.deepEqual(await r.json(), { sessionId: "rc-1", history: [{ role: "user", text: "hi" }] });

  assert.equal(fellThrough.length, 0, "no request leaked to the (missing) official routers");
});

test("unknown sessions fall through to the official routers", async (t) => {
  const rc = stubRc();
  const pi = stubPi();
  const { app, fellThrough } = await buildApp(t, { rc, pi });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });

  const r = await fetch(`${base}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "claude-local-123", text: "local prompt" }),
  });
  assert.equal((await r.json()).fellThrough, true);
  assert.deepEqual(fellThrough, ["POST /api/prompt"]);
  assert.equal(rc.calls.prompt.length, 0);
  assert.equal(pi.calls.prompt.length, 0);
});

test("merged /api/sessions: local + rc + pi, newest first, all provider claude", async (t) => {
  const rc = stubRc();
  const pi = stubPi();
  const { app } = await buildApp(t, { rc, pi, rcTranscriptBase: tmpdir() });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });

  const r = await fetch(`${base}/api/sessions?limit=10`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(
    body.sessions.map((s) => s.id),
    ["pi-1", "rc-1", "local-1"],
    "sorted by timestamp desc"
  );
  assert.ok(body.sessions.every((s) => s.provider === "claude"));
  // The local session's null status got filled in by the official flow.
  assert.equal(body.sessions.find((s) => s.id === "local-1").status, "idle");
  // RC status comes through as the upstream reported it.
  assert.equal(body.sessions.find((s) => s.id === "rc-1").status, "busy");
});

test("merged /api/sessions hides the local twin of a live RC session", async (t) => {
  // The RC fork's `claude --remote-control` process writes its transcript to
  // ~/.claude/projects/<cwd>/<uuid>.jsonl with a bridge-session marker, so the
  // same conversation must not appear twice in the merged list.
  const baseDir = mkdtempSync(join(tmpdir(), "ext-router-dedupe-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const CWD = "/local";
  const TWIN_ID = "c55cf77e-1257-47dc-93a3-c5e31aa2ba5f";
  const dir = join(baseDir, CWD.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${TWIN_ID}.jsonl`),
    [
      '{"type":"mode","mode":"normal","sessionId":"' + TWIN_ID + '"}',
      '{"type":"bridge-session","sessionId":"' + TWIN_ID + '","bridgeSessionId":"rc-1","lastSequenceNum":0}',
    ].join("\n") + "\n"
  );

  const local = {
    listSessions: async () => [
      { id: TWIN_ID, title: "Local twin title", timestamp: "2025-05-01T00:00:01Z", cwd: CWD, provider: "claude", status: null },
      { id: "local-2", title: "Plain local", timestamp: "2025-04-01T00:00:00Z", cwd: "/other", provider: "claude", status: null },
    ],
    getSessionStatus: async () => "idle",
  };
  const rc = stubRc();
  const pi = stubPi();
  const { app } = await buildApp(t, { rc, pi, local, rcTranscriptBase: baseDir });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });

  const r = await fetch(`${base}/api/sessions?limit=10`);
  const body = await r.json();
  const ids = body.sessions.map((s) => s.id);
  assert.ok(!ids.includes(TWIN_ID), "the local twin is hidden");
  assert.ok(ids.includes("rc-1"), "the RC entry survives");
  assert.ok(ids.includes("local-2"), "unrelated local sessions are kept");
  const rcEntry = body.sessions.find((s) => s.id === "rc-1");
  assert.equal(rcEntry.title, "Local twin title", "RC entry borrows the local title");
  assert.equal(rcEntry.cwd, CWD, "RC entry borrows the local cwd");
  assert.equal(rcEntry.status, "busy", "RC status survives dedupe");
});

test("explicit extended provider param routes directly", async (t) => {
  const rc = stubRc();
  const pi = stubPi();
  const { app, fellThrough } = await buildApp(t, { rc, pi });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });

  // /info for pi.
  let r = await fetch(`${base}/api/info?provider=pi`);
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.model, "pi");

  // /prompt with explicit provider and no session (new RC session spawn path).
  r = await fetch(`${base}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "claude-remote", text: "start rc" }),
  });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true, sessionId: "rc-new", provider: "claude" });
  assert.equal(fellThrough.length, 0);

  // provider=codex is NOT intercepted (official territory).
  r = await fetch(`${base}/api/sessions?provider=codex`);
  assert.equal((await r.json()).fellThrough, true);
});

test("/api/events serves the hub SSE stream for owned sessions", async (t) => {
  const rc = stubRc();
  const pi = stubPi();
  const { app, hub } = await buildApp(t, { rc, pi });
  claim("rc-1", "claude-remote");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });

  hub.feed("rc-1", { type: "user_prompt", text: "earlier" });

  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?sessionId=rc-1&needReplay=true`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!buf.includes("user_prompt")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  ac.abort();
  assert.match(buf, /:ok/);
  assert.match(buf, /"text":"earlier"/);
});
