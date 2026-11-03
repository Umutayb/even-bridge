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
    getSessionStatus: async () => "busy",
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
async function buildApp(t, { rc, pi, durable, local = localProvider, rcTranscriptBase, overseer }) {
  const { createExtRouter } = await import("../src/ext-router.mjs");
  const hub = new Hub();
  const app = express();
  app.use(express.json());
  const fellThrough = [];
  app.use(
    "/api",
    createExtRouter({
      hub,
      providers: [rc, pi, durable],
      getDefaultLocalProvider: () => local,
      rcTranscriptBase,
      overseer,
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
  // Empty CC projects base: the disk scan finds nothing, so the official SDK
  // list (stub) serves the local slot — the fallback path.
  const emptyBase = mkdtempSync(join(tmpdir(), "ext-router-ccbase-"));
  t.after(() => rmSync(emptyBase, { recursive: true, force: true }));
  const { app } = await buildApp(t, { rc, pi, rcTranscriptBase: emptyBase });
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
  // pi's live status is filled from the provider (the disk list says null):
  // the phone can show a running pi session as busy instead of stale idle.
  assert.equal(body.sessions.find((s) => s.id === "pi-1").status, "busy");
});

test("merged /api/sessions hides the local twin of a live RC session", async (t) => {
  // The RC fork's `claude --remote-control` process writes its transcript to
  // ~/.claude/projects/<cwd>/<uuid>.jsonl with a bridge-session marker, so the
  // same conversation must not appear twice in the merged list. The local slot
  // is served from the disk scan, so the fixtures live on disk here: the twin
  // transcript AND an unrelated plain local transcript.
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
      '{"type":"user","message":{"role":"user","content":"Local twin title"},"cwd":"' + CWD + '","sessionId":"' + TWIN_ID + '"}',
    ].join("\n") + "\n"
  );
  // An unrelated plain local session (no bridge-session marker) in another cwd.
  const otherDir = join(baseDir, "-other");
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(
    join(otherDir, `local-2.jsonl`),
    '{"type":"user","message":{"role":"user","content":"Plain local"},"cwd":"/other","sessionId":"local-2"}\n'
  );

  // The SDK stub is NOT used for the local slot (disk scan found files);
  // kept only so buildApp has something to fall back to.
  const local = {
    listSessions: async () => ["local-1"].map((id) => ({ id, title: "stub", timestamp: "2025-05-01T00:00:01Z", cwd: "/stub", provider: "claude", status: null })),
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

test("new sessions default to stock Claude Code when EVEN_BRIDGE_NEW_SESSION_PROVIDER is unset", async (t) => {
  const rc = stubRc();
  const pi = stubPi();
  const { app, fellThrough } = await buildApp(t, { rc, pi });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const prev = process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER;
  delete process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER;
  t.after(() => {
    if (prev === undefined) delete process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER;
    else process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER = prev;
    server.close(); server.closeAllConnections();
  });

  const r = await fetch(`${base}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "claude", cwd: "/newproj", text: "stock session" }),
  });
  assert.equal((await r.json()).fellThrough, true, "new session went to the official router");
  assert.deepEqual(fellThrough, ["POST /api/prompt"]);
  assert.equal(pi.calls.prompt.length, 0);
  assert.equal(rc.calls.prompt.length, 0);
});

test("EVEN_BRIDGE_NEW_SESSION_PROVIDER=pi routes new sessions to pi (the phone's provider=claude is an app default)", async (t) => {
  const rc = stubRc();
  const pi = stubPi();
  const { app, fellThrough } = await buildApp(t, { rc, pi });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const prev = process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER;
  process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER = "pi";
  t.after(() => {
    if (prev === undefined) delete process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER;
    else process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER = prev;
    server.close(); server.closeAllConnections();
  });

  // Exact phone shape for "new session": no sessionId, provider "claude"
  // (app-level default from the pairing URL), cwd picked in the app.
  const r = await fetch(`${base}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "claude", cwd: "/newproj", text: "start a pi session" }),
  });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true, sessionId: "pi-new", provider: "claude" });
  assert.equal(pi.calls.prompt.length, 1, "routed to the pi provider");
  assert.equal(pi.calls.prompt[0].text, "start a pi session");
  assert.equal(rc.calls.prompt.length, 0);
  assert.equal(fellThrough.length, 0, "did not fall through to official Claude Code");
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

// ── Durable agents ─────────────────────────────────────────────────────────

function stubDurable() {
  const calls = { prompt: [], stop: [] };
  return {
    calls,
    name: "durable",
    wireProvider: "claude",
    probe: (sid) => sid.startsWith("dur-"),
    listSessions: async () => [],
    getSessionStatus: async () => "idle",
    getHistory: async () => [],
    prompt: async (sid, text, cwd, opts) => {
      calls.prompt.push({ sid, text, cwd, opts });
      return { sessionId: sid ?? "dur-new", provider: "claude", submissionId: "sub-1" };
    },
    getStatus: (sid) => (sid.startsWith("dur-") ? { state: "idle", provider: "claude" } : null),
    listAgents: async () => [{ sid: "dur-1", name: "fixer", cwd: "/w", model: "qwen", state: "busy", lastLine: "ok" }],
    stopSession: async (sid) => {
      if (!sid.startsWith("dur-")) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
      calls.stop.push(sid);
    },
  };
}

async function listen(t, app) {
  const server = app.listen(0);
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}

const postJson = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("/prompt passes the agent fields to the provider's prompt as its 4th argument", async (t) => {
  const durable = stubDurable();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);

  const r = await postJson(`${base}/api/prompt`, {
    provider: "durable", text: "fix the tests", cwd: "/w/proj",
    name: "fixer", model: "qwen", maxTurns: 12, requestId: "req-1", origin: "evenai",
  });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true, sessionId: "dur-new", provider: "claude", submissionId: "sub-1" });
  assert.deepEqual(durable.calls.prompt, [{
    sid: undefined, text: "fix the tests", cwd: "/w/proj",
    opts: { name: "fixer", model: "qwen", maxTurns: 12, requestId: "req-1", origin: "evenai" },
  }]);

  // Fields the caller did not send are absent, not undefined.
  claim("dur-1", "durable");
  await postJson(`${base}/api/prompt`, { sessionId: "dur-1", text: "and the docs" });
  assert.deepEqual(durable.calls.prompt[1], { sid: "dur-1", text: "and the docs", cwd: undefined, opts: {} });
});

test("/prompt to other providers keeps the 3-argument call and no submissionId", async (t) => {
  const pi = stubPi();
  const argc = [];
  const inner = pi.prompt;
  pi.prompt = function (...args) {
    argc.push(args.length);
    return inner(...args);
  };
  const { app } = await buildApp(t, { rc: stubRc(), pi, durable: stubDurable() });
  const base = await listen(t, app);
  // Agent fields (even invalid ones) are neither validated nor passed for pi.
  const r = await postJson(`${base}/api/prompt`, { provider: "pi", text: "hi", name: "x".repeat(99), maxTurns: "lots" });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true, sessionId: "pi-new", provider: "claude" });
  assert.deepEqual(argc, [3]);
});

test("/prompt validates the durable agent fields (400 with a clear error)", async (t) => {
  const durable = stubDurable();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  const bad = [
    [{ name: "x".repeat(25) }, /'name'/],
    [{ name: "rm -rf /;" }, /'name'/],
    [{ name: "" }, /'name'/],
    [{ name: 7 }, /'name'/],
    [{ maxTurns: 0 }, /'maxTurns'/],
    [{ maxTurns: 61 }, /'maxTurns'/],
    [{ maxTurns: 2.5 }, /'maxTurns'/],
    [{ maxTurns: "12a" }, /'maxTurns'/],
    [{ maxTurns: "-3" }, /'maxTurns'/],
    [{ requestId: "r".repeat(129) }, /'requestId'/],
    [{ requestId: 42 }, /'requestId'/],
    [{ origin: "shell" }, /'origin'/],
    [{ model: "m".repeat(33) }, /'model'/],
    [{ model: ["qwen"] }, /'model'/],
  ];
  for (const [fields, re] of bad) {
    const r = await postJson(`${base}/api/prompt`, { provider: "durable", text: "go", cwd: "/w", ...fields });
    assert.equal(r.status, 400, JSON.stringify(fields));
    assert.match((await r.json()).error, re, JSON.stringify(fields));
  }
  assert.equal(durable.calls.prompt.length, 0, "no rejected prompt reached the provider");

  // Boundaries accepted; a digit-only maxTurns string becomes a number.
  const r = await postJson(`${base}/api/prompt`, {
    provider: "durable", text: "go", cwd: "/w",
    name: "fix-the_tests v2.0 abcdef", model: "m".repeat(32), maxTurns: "60",
    requestId: "r".repeat(128), origin: "phone",
  });
  assert.equal(r.status, 400, "a 25-char name is still too long");
  const ok = await postJson(`${base}/api/prompt`, {
    provider: "durable", text: "go", cwd: "/w",
    name: "fix-the_tests v2.0 abcde", model: "m".repeat(32), maxTurns: "60",
    requestId: "r".repeat(128), origin: "phone",
  });
  assert.equal(ok.status, 202);
  assert.deepEqual(durable.calls.prompt[0].opts, {
    name: "fix-the_tests v2.0 abcde", model: "m".repeat(32), maxTurns: 60,
    requestId: "r".repeat(128), origin: "phone",
  });
});

test("/prompt passes a validated engine to the durable provider", async (t) => {
  const durable = stubDurable();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  const bad = await postJson(`${base}/api/prompt`, { provider: "durable", text: "go", cwd: "/w", engine: "docker" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "'engine' must be one of native, lets-code");
  assert.equal(durable.calls.prompt.length, 0);
  const ok = await postJson(`${base}/api/prompt`, { provider: "durable", text: "go", cwd: "/w", engine: "lets-code" });
  assert.equal(ok.status, 202);
  assert.deepEqual(durable.calls.prompt[0].opts, { engine: "lets-code" });
});

test("GET /agents returns the durable provider's listAgents()", async (t) => {
  const durable = stubDurable();
  const { app, fellThrough } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  const r = await fetch(`${base}/api/agents`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { agents: await durable.listAgents() });
  assert.equal(fellThrough.length, 0);
});

test("POST /agents/:sid/stop calls stopSession; unknown sid is 404", async (t) => {
  const durable = stubDurable();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  let r = await postJson(`${base}/api/agents/dur-1/stop`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, sessionId: "dur-1" });
  assert.deepEqual(durable.calls.stop, ["dur-1"]);

  r = await postJson(`${base}/api/agents/nope/stop`, {});
  assert.equal(r.status, 404);
  assert.deepEqual(durable.calls.stop, ["dur-1"]);
});

test("/agents routes fall through (next()) without the durable provider, as before they existed", async (t) => {
  const { app, fellThrough } = await buildApp(t, { rc: stubRc(), pi: stubPi() });
  const base = await listen(t, app);
  await fetch(`${base}/api/agents`);
  await postJson(`${base}/api/agents/dur-1/stop`, {});
  assert.equal(fellThrough.length, 2);
});

test("a durable prompt without a cwd reaches the provider with no cwd (never PROJECT_DIR)", async (t) => {
  const durable = stubDurable();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  const prev = process.env.PROJECT_DIR;
  process.env.PROJECT_DIR = "/home/u/github/even-bridge";
  t.after(() => (prev === undefined ? delete process.env.PROJECT_DIR : (process.env.PROJECT_DIR = prev)));
  const r = await postJson(`${base}/api/prompt`, { provider: "durable", text: "go" });
  assert.equal(r.status, 202);
  assert.equal(durable.calls.prompt[0].cwd, undefined);
});

// ── Task 3: engine selection and the factory toggle ────────────────────────

/** A durable stub with the lets-code engine: `engines` and `setFactory`. */
function stubDurableLc({ engines = ["native", "lets-code"] } = {}) {
  const d = stubDurable();
  d.calls.factory = [];
  d.engines = engines;
  d.listAgents = async () => [];
  d.setFactory = async (sid, on, opts) => {
    if (!sid.startsWith("dur-")) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    if (sid === "dur-native") throw Object.assign(new Error("the factory needs the lets-code engine"), { statusCode: 409 });
    if (sid === "dur-mute") throw Object.assign(new Error("lets-code did not confirm the mode"), { statusCode: 504 });
    if (sid === "dur-noexperts") throw Object.assign(new Error("factory experts must be enabled by the operator (missing: tester)"), { statusCode: 409, reason: "experts_disabled" });
    d.calls.factory.push([sid, on, opts]);
    return { factory: on };
  };
  return d;
}

test("engine and factory are validated", async () => {
  const { agentOpts } = await import("../src/ext-router.mjs");
  assert.equal(agentOpts({ engine: "docker" }).error, "'engine' must be one of native, lets-code");
  assert.deepEqual(agentOpts({ engine: "lets-code", factory: true }).opts, { engine: "lets-code", factory: true });
  assert.equal(agentOpts({ factory: true }).error, "'factory' needs engine lets-code");
  assert.equal(agentOpts({ engine: "native", factory: true }).error, "'factory' needs engine lets-code");
  assert.equal(agentOpts({ factory: "yes" }).error, "'factory' must be true or false");
  assert.deepEqual(agentOpts({ factory: false }).opts, { factory: false });
  assert.deepEqual(agentOpts({}).opts, {});
});

test("/prompt passes factory to the durable provider", async (t) => {
  const durable = stubDurableLc();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  const bad = await postJson(`${base}/api/prompt`, { provider: "durable", text: "go", cwd: "/w", factory: true });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "'factory' needs engine lets-code");
  const ok = await postJson(`${base}/api/prompt`, { provider: "durable", text: "go", cwd: "/w", engine: "lets-code", factory: true });
  assert.equal(ok.status, 202);
  assert.deepEqual(durable.calls.prompt.map((c) => c.opts), [{ engine: "lets-code", factory: true }]);
});

test("GET /agents lists engines", async (t) => {
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable: stubDurableLc() });
  const base = await listen(t, app);
  const r = await fetch(`${base}/api/agents`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { agents: [], engines: ["native", "lets-code"] });
});

test("GET /agents without the lets-code engine is unchanged (no engines field)", async (t) => {
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable: stubDurableLc({ engines: ["native"] }) });
  const base = await listen(t, app);
  const r = await fetch(`${base}/api/agents`);
  assert.equal(await r.text(), JSON.stringify({ agents: [] }));
});

test("POST /agents/:sid/factory forwards on and ticket", async (t) => {
  const durable = stubDurableLc();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  let r = await postJson(`${base}/api/agents/dur-1/factory`, { on: true, ticket: "Fix the CI" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, sessionId: "dur-1", factory: true });
  r = await postJson(`${base}/api/agents/dur-1/factory`, { on: true, ticket: "Add hello.txt", howToRun: "test -f hello.txt" });
  assert.equal(r.status, 200);
  r = await postJson(`${base}/api/agents/dur-1/factory`, { on: false });
  assert.equal(r.status, 200);
  assert.deepEqual(durable.calls.factory, [
    ["dur-1", true, { ticket: "Fix the CI" }],
    ["dur-1", true, { ticket: "Add hello.txt", howToRun: "test -f hello.txt" }],
    ["dur-1", false, {}],
  ]);
});

test("POST /agents/:sid/factory validates the body", async (t) => {
  const durable = stubDurableLc();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  const bad = [
    [{}, "'on' must be true or false"],
    [{ on: "yes" }, "'on' must be true or false"],
    [{ on: true, ticket: "" }, "'ticket' must be a string of 1-8000 characters"],
    [{ on: true, ticket: "x".repeat(8001) }, "'ticket' must be a string of 1-8000 characters"],
    [{ on: true, ticket: 5 }, "'ticket' must be a string of 1-8000 characters"],
    [{ on: false, ticket: "Fix it" }, "'ticket' needs on true"],
    [{ on: true, ticket: "t", howToRun: "npm test\nrm -rf /" }, "'howToRun' must be one line without quotes"],
    [{ on: true, ticket: "t", howToRun: "bash -c 'npm test'" }, "'howToRun' must be one line without quotes"],
    [{ on: true, ticket: "t", howToRun: 'say "hi"' }, "'howToRun' must be one line without quotes"],
    [{ on: true, ticket: "t", howToRun: "x".repeat(201) }, "'howToRun' must be a string of 1-200 characters"],
    [{ on: true, ticket: "t", howToRun: "  " }, "'howToRun' must be a string of 1-200 characters"],
    [{ on: true, howToRun: "npm test" }, "'howToRun' needs a ticket"],
  ];
  for (const [body, error] of bad) {
    const r = await postJson(`${base}/api/agents/dur-1/factory`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(await r.json(), { error }, JSON.stringify(body));
  }
  assert.equal(durable.calls.factory.length, 0);
  const ok = await postJson(`${base}/api/agents/dur-1/factory`, { on: true, ticket: "x".repeat(8000), howToRun: "x".repeat(200) });
  assert.equal(ok.status, 200);
});

test("factory on a native agent is 409", async (t) => {
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable: stubDurableLc() });
  const base = await listen(t, app);
  let r = await postJson(`${base}/api/agents/dur-native/factory`, { on: true });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "the factory needs the lets-code engine" });
  r = await postJson(`${base}/api/agents/dur-mute/factory`, { on: true });
  assert.equal(r.status, 504);
  assert.deepEqual(await r.json(), { error: "lets-code did not confirm the mode" });
  r = await postJson(`${base}/api/agents/nope/factory`, { on: true });
  assert.equal(r.status, 404);
  r = await postJson(`${base}/api/agents/dur-noexperts/factory`, { on: true, ticket: "Fix the CI" });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "factory experts must be enabled by the operator (missing: tester)", reason: "experts_disabled" });
});

test("/agents/:sid/factory falls through without the durable provider", async (t) => {
  const { app, fellThrough } = await buildApp(t, { rc: stubRc(), pi: stubPi() });
  const base = await listen(t, app);
  await postJson(`${base}/api/agents/dur-1/factory`, { on: true });
  assert.equal(fellThrough.length, 1);
});


test("/prompt with a sessionId and a factory flag is 400 (the toggle has its own route)", async (t) => {
  const durable = stubDurableLc();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  claim("dur-1", "durable");
  const r = await postJson(`${base}/api/prompt`, { sessionId: "dur-1", text: "go", factory: true });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "'factory' is set when an agent starts; use /api/agents/:sid/factory" });
  assert.equal(durable.calls.prompt.length, 0);
});

test("/agents/:sid/factory falls through when the durable provider has no lets-code engine (as on main)", async (t) => {
  const durable = stubDurableLc({ engines: ["native"] });
  const { app, fellThrough } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  await postJson(`${base}/api/agents/dur-1/factory`, { on: true });
  assert.equal(fellThrough.length, 1);
  assert.equal(durable.calls.factory.length, 0);
});

test("a 409 experts_disabled keeps its reason on the wire", async (t) => {
  const durable = stubDurableLc();
  durable.setFactory = async () => {
    throw Object.assign(new Error("factory experts must be enabled by the operator (missing: tester)"), { statusCode: 409, reason: "experts_disabled" });
  };
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable });
  const base = await listen(t, app);
  const r = await postJson(`${base}/api/agents/dur-1/factory`, { on: true });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "factory experts must be enabled by the operator (missing: tester)", reason: "experts_disabled" });
});

// ── /api/overseer ─────────────────────────────────────────────────────────────

function stubOverseer() {
  const calls = { ask: [], outbox: [], read: [] };
  return {
    calls,
    ask: async (question, opts) => {
      calls.ask.push([question, opts]);
      return { status: "done", answer: "two agents run" };
    },
    outbox: async (opts) => {
      calls.outbox.push(opts);
      return { seq: 3, readUpTo: 0, items: [{ seq: 3, at: 1, kind: "notify", text: "hi" }] };
    },
    markRead: async (upTo) => {
      calls.read.push(upTo);
      return { seq: 3, readUpTo: upTo };
    },
  };
}

test("POST /overseer/ask validates question and waitMs", async (t) => {
  const overseer = stubOverseer();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable: stubDurable(), overseer });
  const base = await listen(t, app);
  const bad = async (body, error) => {
    const r = await postJson(`${base}/api/overseer/ask`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(await r.json(), { error });
  };
  await bad({ question: "", requestId: "r1" }, "Missing 'question'");
  await bad({ requestId: "r1" }, "Missing 'question'");
  await bad({ question: "x".repeat(2001), requestId: "r1" }, "'question' must be 1-2000 characters");
  await bad({ question: "what runs?" }, "'requestId' must be 1-128 characters");
  await bad({ question: "what runs?", requestId: "r".repeat(129) }, "'requestId' must be 1-128 characters");
  await bad({ question: "what runs?", requestId: "r1", waitMs: 20000 }, "'waitMs' must be 0-15000");
  await bad({ question: "what runs?", requestId: "r1", waitMs: -1 }, "'waitMs' must be 0-15000");
  await bad({ question: "what runs?", requestId: "r1", waitMs: "5" }, "'waitMs' must be 0-15000");
  assert.deepEqual(overseer.calls.ask, []);
  let r = await postJson(`${base}/api/overseer/ask`, { question: "what runs?", requestId: "r1", waitMs: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "done", answer: "two agents run" });
  r = await postJson(`${base}/api/overseer/ask`, { question: "and now?", requestId: "r2" });
  assert.equal(r.status, 200);
  assert.deepEqual(overseer.calls.ask, [
    ["what runs?", { requestId: "r1", waitMs: 0 }],
    ["and now?", { requestId: "r2", waitMs: 15000 }],
  ]);
});

test("GET /overseer/outbox passes since; POST /overseer/outbox/read passes upTo", async (t) => {
  const overseer = stubOverseer();
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable: stubDurable(), overseer });
  const base = await listen(t, app);
  let r = await fetch(`${base}/api/overseer/outbox?since=2`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { seq: 3, readUpTo: 0, items: [{ seq: 3, at: 1, kind: "notify", text: "hi" }] });
  r = await fetch(`${base}/api/overseer/outbox`);
  assert.equal(r.status, 200);
  assert.deepEqual(overseer.calls.outbox, [{ since: 2 }, { since: 0 }]);
  r = await fetch(`${base}/api/overseer/outbox?since=-1`);
  assert.equal(r.status, 400);
  r = await fetch(`${base}/api/overseer/outbox?since=abc`);
  assert.equal(r.status, 400);
  r = await postJson(`${base}/api/overseer/outbox/read`, { upTo: 3 });
  assert.deepEqual(await r.json(), { seq: 3, readUpTo: 3 });
  r = await postJson(`${base}/api/overseer/outbox/read`, { upTo: "3" });
  assert.equal(r.status, 400);
  assert.deepEqual(overseer.calls.read, [3]);
});

test("overseer errors keep their status code", async (t) => {
  const overseer = { ...stubOverseer(), ask: async () => { throw Object.assign(new Error("durable store failed"), { statusCode: 503 }); } };
  const { app } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable: stubDurable(), overseer });
  const base = await listen(t, app);
  const r = await postJson(`${base}/api/overseer/ask`, { question: "q", requestId: "r" });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "durable store failed" });
});

test("/overseer routes fall through without the overseer", async (t) => {
  const { app, fellThrough } = await buildApp(t, { rc: stubRc(), pi: stubPi(), durable: stubDurable() });
  const base = await listen(t, app);
  await postJson(`${base}/api/overseer/ask`, { question: "q", requestId: "r" });
  await fetch(`${base}/api/overseer/outbox?since=0`);
  await postJson(`${base}/api/overseer/outbox/read`, { upTo: 1 });
  assert.deepEqual(fellThrough, ["POST /api/overseer/ask", "GET /api/overseer/outbox", "POST /api/overseer/outbox/read"]);
});
