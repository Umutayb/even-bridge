import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { UpstreamPump, PumpManager } from "../src/upstream-pump.mjs";
import { Hub } from "../src/hub.mjs";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";

// ── Fake upstream: the claude-remote bridge's /api/events endpoint ─────────
// plan[i] = the frames connection (i+1) replays (its ring), newest process
// generation. Each frame: {id, ...msg}.
// ring: optional {state, messages} served on /api/messages (the cold-start
// seed boundary); omitted = 404, like an upstream without that route.
function startUpstream(plan, ring) {
  return new Promise((resolve) => {
    const connections = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/api/messages" && ring) {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (ring.onRead) ring.onRead();
        res.end(JSON.stringify({ messages: ring.messages, state: ring.state, historyLoaded: ring.historyLoaded, historyHighId: ring.historyHighId, sessionId: u.searchParams.get("sessionId") }));
        return;
      }
      if (u.pathname !== "/api/events") {
        res.writeHead(404).end();
        return;
      }
      const conn = { res, closed: false };
      connections.push(conn);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":ok\n\n");
      const gen = plan[Math.min(connections.length - 1, plan.length - 1)];
      gen.forEach((msg, i) => {
        setTimeout(() => {
          if (conn.closed) return;
          try {
            // Like the real upstream: the id rides the SSE id line only.
            const { id, ...body } = msg;
            res.write(`id: ${id}\ndata: ${JSON.stringify(body)}\n\n`);
          } catch {
            /* socket gone */
          }
        }, i * 2);
      });
      req.on("close", () => (conn.closed = true));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, connections, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

async function waitFor(cond, ms = 4000, step = 10) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, step));
  }
}

function makeClientConn(frames = []) {
  const res = {
    setHeader() {},
    write(chunk) {
      frames.push(chunk);
      return true;
    },
    end() {},
    on() {
      return this;
    },
  };
  const req = new EventEmitter();
  req.query = {};
  req.headers = {};
  return { req, res };
}

test("pump relays upstream frames into the local ring", async () => {
  const { server, url } = await startUpstream([
    [
      { id: 1, type: "user_prompt", text: "hi" },
      { id: 2, type: "text_delta", text: "a" },
      { id: 3, type: "status", state: "idle" },
    ],
  ]);
  const hub = new Hub();
  const sid = "rc-pump-1";
  const pump = new UpstreamPump(sid, { baseUrl: url, hub, getState: async () => "idle" }).start();
  await waitFor(() => getMessages(sid, 0).length === 3);
  const msgs = getMessages(sid, 0);
  assert.deepEqual(
    msgs.map((m) => m.text ?? m.state),
    ["hi", "a", "idle"]
  );
  await pump.stop();
  server.close();
});

test("pump dedups upstream ring replays on reconnect", async () => {
  // Generation 1: ids 1..3. Generation 2 (reconnect): replays 1..3 + new id 4.
  const { server, connections, url } = await startUpstream([
    [
      { id: 1, type: "text_delta", text: "a" },
      { id: 2, type: "text_delta", text: "b" },
      { id: 3, type: "text_delta", text: "c" },
    ],
    [
      { id: 1, type: "text_delta", text: "a" },
      { id: 2, type: "text_delta", text: "b" },
      { id: 3, type: "text_delta", text: "c" },
      { id: 4, type: "text_delta", text: "d" },
    ],
  ]);
  const hub = new Hub();
  const sid = "rc-pump-2";
  // Keep a hub client subscribed so the pump REOPENS after a clean end.
  const client = makeClientConn();
  hub.streamFor(sid).handleEvents(client.req, client.res);

  const pump = new UpstreamPump(sid, { baseUrl: url, hub, getState: async () => "busy" }).start();
  await waitFor(() => getMessages(sid, 0).length === 3);
  // Upstream closes the stream (its own blip); the pump must reopen and NOT duplicate.
  connections[0].res.end();
  await waitFor(() => getMessages(sid, 0).length === 4);
  const texts = getMessages(sid, 0).map((m) => m.text);
  assert.deepEqual(texts, ["a", "b", "c", "d"], "replayed ids are deduped; only the new message lands");
  await pump.stop();
  client.req.emit("close");
  server.close();
});

test("pump re-baselines after an upstream generation reset (ids restart)", async () => {
  const gen1 = Array.from({ length: 505 }, (_, i) => ({ id: i + 1, type: "text_delta", text: `g1-${i + 1}`, gen: 1 }));
  const gen2 = [
    { id: 1, type: "text_delta", text: "g2-1", gen: 2 },
    { id: 2, type: "text_delta", text: "g2-2", gen: 2 },
  ];
  const { server, connections, url } = await startUpstream([gen1, gen2]);
  const hub = new Hub();
  const sid = "rc-pump-3";
  const client = makeClientConn();
  hub.streamFor(sid).handleEvents(client.req, client.res);

  const pump = new UpstreamPump(sid, { baseUrl: url, hub, getState: async () => "busy" }).start();
  // The official ring caps at 500, so wait on the pump's own watermark
  // (lastUpstreamId) rather than the ring length.
  await waitFor(() => pump.lastUpstreamId === 505, 15000);
  connections[0].res.end();
  // After the reset, gen2 ids (1..2) are BELOW the old water mark (505);
  // without re-baselining they would be skipped as "already fed".
  await waitFor(() => getMessages(sid, 0).some((m) => m.gen === 2), 8000);
  const tail = getMessages(sid, 0).slice(-2).map((m) => m.text);
  assert.deepEqual(tail, ["g2-1", "g2-2"]);
  await pump.stop();
  client.req.emit("close");
  server.close();
});

test("pump ends (no reconnect) when the stream closes with no clients and idle", async () => {
  const { server, connections, url } = await startUpstream([[{ id: 1, type: "status", state: "idle" }]]);
  const hub = new Hub();
  const sid = "rc-pump-4";
  const pump = new UpstreamPump(sid, { baseUrl: url, hub, getState: async () => "idle" }).start();
  await waitFor(() => getMessages(sid, 0).length === 1);
  connections[0].res.end();
  await pump.stop();
  assert.equal(connections.length, 1, "no reopen when nobody is listening and the session is idle");
  server.close();
});

// Regression (2026-09-27): _idleCheck / a clean END stopped the pump but the
// manager kept the dead instance, so ensure() on the next /events handed it
// back and the relay never restarted — replies only showed on refresh.
test("PumpManager.ensure() replaces a pump that stopped itself", async () => {
  const { server, connections, url } = await startUpstream([[{ id: 1, type: "status", state: "idle" }]]);
  const hub = new Hub();
  const sid = "rc-pump-5";
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "idle" });
  const first = mgr.ensure(sid);
  await waitFor(() => connections.length === 1);
  await first.stop(); // what _idleCheck does after 600s with no clients
  const second = mgr.ensure(sid);
  assert.notEqual(second, first, "a stopped pump must not be reused");
  await waitFor(() => connections.length === 2);
  await mgr.stop(sid);
  server.close();
});

test("PumpManager.ensure() replaces a pump whose loop ended", async () => {
  const { server, connections, url } = await startUpstream([[{ id: 1, type: "status", state: "idle" }]]);
  const hub = new Hub();
  const sid = "rc-pump-6";
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "idle" });
  const first = mgr.ensure(sid);
  await waitFor(() => connections.length === 1);
  connections[0].res.end(); // clean end, no clients, idle -> loop returns
  await first.loopPromise;
  const second = mgr.ensure(sid);
  assert.notEqual(second, first, "an ended pump must not be reused");
  await waitFor(() => connections.length === 2);
  await mgr.stop(sid);
  server.close();
});

// Live frames a hub client received (data lines only, heartbeats/idle pings skipped).
function liveTexts(frames) {
  return frames
    .join("")
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data:")))
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice(5)))
    .filter((m) => m.type !== "status")
    .map((m) => m.text);
}

const IDLE_RING = [
  { id: 1, type: "user_prompt", text: "q1" },
  { id: 2, type: "text_delta", text: "a1" },
  { id: 3, type: "status", state: "idle" },
];

test("cold pump seeds the upstream history instead of sending it live (no duplicates on the glasses)", async () => {
  const { server, url } = await startUpstream([[...IDLE_RING, { id: 4, type: "text_delta", text: "live" }]], {
    state: "idle",
    messages: IDLE_RING,
  });
  const hub = new Hub();
  const sid = "rc-pump-seed-1";
  const frames = [];
  const client = makeClientConn(frames); // the phone, connected before the pump
  hub.streamFor(sid).handleEvents(client.req, client.res);
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "idle" });
  mgr.ensure(sid);
  await waitFor(() => getMessages(sid, 0).length === 4);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(getMessages(sid, 0).map((m) => m.text ?? m.state), ["q1", "a1", "idle", "live"], "history is in the ring");
  assert.deepEqual(liveTexts(frames), ["live"], "only the frame past the upstream tail is sent live");
  await mgr.stop(sid);
  client.req.emit("close");
  server.close();
});

test("cold pump on a busy session sends live only what follows the last finished text", async () => {
  const ring = [
    ...IDLE_RING,
    { id: 4, type: "user_prompt", text: "q2" },
    { id: 5, type: "text_delta", text: "a2-done" },
    { id: 6, type: "status", state: "text_end" },
    { id: 7, type: "text_delta", text: "a2-part" },
  ];
  const { server, url } = await startUpstream([ring], { state: "busy", messages: ring });
  const hub = new Hub();
  const sid = "rc-pump-seed-2";
  const frames = [];
  const client = makeClientConn(frames);
  hub.streamFor(sid).handleEvents(client.req, client.res);
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "busy" });
  mgr.ensure(sid);
  await waitFor(() => getMessages(sid, 0).length === 7);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(liveTexts(frames), ["a2-part"]);
  await mgr.stop(sid);
  client.req.emit("close");
  server.close();
});

test("pump for a brand-new session relays everything (nothing on the phone yet)", async () => {
  const { server, url } = await startUpstream([IDLE_RING], { state: "idle", messages: IDLE_RING });
  const hub = new Hub();
  const sid = "rc-pump-seed-3";
  const frames = [];
  const client = makeClientConn(frames);
  hub.streamFor(sid).handleEvents(client.req, client.res);
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "idle" });
  mgr.ensure(sid, { newSession: true });
  await waitFor(() => getMessages(sid, 0).length === 3);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(liveTexts(frames), ["q1", "a1"]);
  await mgr.stop(sid);
  client.req.emit("close");
  server.close();
});

test("upstream restart: the new generation's replay is seeded, not sent live", async () => {
  const gen1 = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, type: "text_delta", text: `g1-${i + 1}` }));
  const gen2 = [
    { id: 1, type: "user_prompt", text: "old-q" },
    { id: 2, type: "text_delta", text: "old-a" },
    { id: 3, type: "status", state: "idle" },
  ];
  const ring = { state: "idle", messages: [] };
  const { server, connections, url } = await startUpstream([gen1, gen2, [...gen2, { id: 4, type: "text_delta", text: "after-restart" }]], ring);
  const hub = new Hub();
  const sid = "rc-pump-restart";
  const frames = [];
  const client = makeClientConn(frames);
  hub.streamFor(sid).handleEvents(client.req, client.res);
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "busy" });
  const pump = mgr.ensure(sid);
  await waitFor(() => pump.lastUpstreamId === 600, 15000);
  ring.messages = gen2; // the restarted upstream's ring
  frames.length = 0;
  connections[0].res.end();
  await waitFor(() => getMessages(sid, 0).some((m) => m.text === "after-restart"), 15000);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(liveTexts(frames), ["after-restart"], "only frames past the restarted upstream's tail go live");
  await mgr.stop(sid);
  client.req.emit("close");
  server.close();
});

test("cold pump waits for the upstream to finish loading history before reading the boundary", async () => {
  const ring = { state: "idle", messages: [], historyLoaded: false, reads: 0 };
  ring.onRead = () => {
    ring.reads += 1;
    if (ring.reads === 3) {
      ring.messages = IDLE_RING; // the upstream's rebuild finished
      ring.historyLoaded = true;
    }
  };
  const { server, url } = await startUpstream([[...IDLE_RING, { id: 4, type: "text_delta", text: "live" }]], ring);
  const hub = new Hub();
  const sid = "rc-pump-hist-wait";
  const frames = [];
  const client = makeClientConn(frames);
  hub.streamFor(sid).handleEvents(client.req, client.res);
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "idle" });
  mgr.ensure(sid);
  await waitFor(() => getMessages(sid, 0).length === 4);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(ring.reads >= 3, "polled until historyLoaded");
  assert.deepEqual(liveTexts(frames), ["live"]);
  await mgr.stop(sid);
  client.req.emit("close");
  server.close();
});

test("busy session on a rebuilt upstream ring: replayed history (historyHighId) is seeded", async () => {
  // A restarted upstream replays RC history without status frames, and its
  // window can start after the current turn's prompt: only historyHighId
  // tells where the history ends.
  const rebuilt = [
    { id: 1, type: "text_delta", text: "old-a" },
    { id: 2, type: "tool_start", name: "Bash" },
    { id: 3, type: "text_delta", text: "old-b" },
  ];
  const ring = { state: "busy", messages: rebuilt, historyLoaded: true, historyHighId: 3 };
  const { server, url } = await startUpstream([[...rebuilt, { id: 4, type: "text_delta", text: "live" }]], ring);
  const hub = new Hub();
  const sid = "rc-pump-hist-high";
  const frames = [];
  const client = makeClientConn(frames);
  hub.streamFor(sid).handleEvents(client.req, client.res);
  const mgr = new PumpManager({ baseUrl: url, hub, getState: async () => "busy" });
  mgr.ensure(sid);
  await waitFor(() => getMessages(sid, 0).length === 4);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(liveTexts(frames), ["live"]);
  await mgr.stop(sid);
  client.req.emit("close");
  server.close();
});
