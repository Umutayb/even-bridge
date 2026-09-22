import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { UpstreamPump } from "../src/upstream-pump.mjs";
import { Hub } from "../src/hub.mjs";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";

// ── Fake upstream: the claude-remote bridge's /api/events endpoint ─────────
// plan[i] = the frames connection (i+1) replays (its ring), newest process
// generation. Each frame: {id, ...msg}.
function startUpstream(plan) {
  return new Promise((resolve) => {
    const connections = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
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
            res.write(`id: ${msg.id}\ndata: ${JSON.stringify(msg)}\n\n`);
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

function makeClientConn() {
  const res = {
    setHeader() {},
    write() {
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
