import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";
import { Hub } from "../src/hub.mjs";

// Minimal mock of express req/res for the SSE handler.
function makeConn({ lastEventId, needReplay } = {}) {
  const frames = []; // raw SSE frame strings
  const res = {
    headers: {},
    socket: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(chunk) {
      frames.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
    on() {
      return this;
    },
  };
  const req = new EventEmitter();
  req.query = { needReplay: needReplay ? "true" : "false" };
  req.headers = {};
  if (lastEventId !== undefined) req.headers["last-event-id"] = String(lastEventId);
  return { req, res, frames };
}

function parseFrames(frames) {
  const out = [];
  let buf = "";
  for (const f of frames) buf += f;
  for (const block of buf.split("\n\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const id = lines.find((l) => l.startsWith("id:"))?.slice(3).trim();
    const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
    if (data) out.push({ id: id ? Number(id) : null, msg: JSON.parse(data) });
  }
  return out;
}

test("Last-Event-ID resume replays only the missed tail", () => {
  const hub = new Hub();
  const sid = "sess-leid";
  for (let i = 1; i <= 10; i++) hub.feed(sid, { type: "status", state: "busy", n: i });

  const conn = makeConn({ lastEventId: 5 });
  hub.streamFor(sid).handleEvents(conn.req, conn.res);
  const replayed = parseFrames(conn.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.n),
    [6, 7, 8, 9, 10],
    "replays exactly the messages after Last-Event-ID"
  );

  // Live message after connect is delivered.
  hub.feed(sid, { type: "text_delta", text: "hi" });
  assert.equal(parseFrames(conn.frames).at(-1).msg.text, "hi");

  conn.req.emit("close");
});

test("stream-only reconnect (sole client) gap-replays after the watermark", () => {
  const hub = new Hub();
  const sid = "sess-gap";
  const first = makeConn();
  hub.streamFor(sid).handleEvents(first.req, first.res);
  hub.feed(sid, { type: "status", state: "busy", n: 1 });
  hub.feed(sid, { type: "text_delta", text: "a", n: 2 });
  hub.feed(sid, { type: "status", state: "idle", n: 3 });
  // Client drops.
  first.req.emit("close");
  // While offline, two more messages.
  hub.feed(sid, { type: "status", state: "busy", n: 4 });
  hub.feed(sid, { type: "text_delta", text: "b", n: 5 });

  const second = makeConn(); // no Last-Event-ID, no needReplay
  hub.streamFor(sid).handleEvents(second.req, second.res);
  const replayed = parseFrames(second.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.n),
    [4, 5],
    "replays exactly what arrived after the delivery watermark — not 1..3 again"
  );
  second.req.emit("close");
});

test("watermark does NOT advance for a client that dropped mid-write", () => {
  const hub = new Hub();
  const sid = "sess-drop";
  const conn = makeConn();
  hub.streamFor(sid).handleEvents(conn.req, conn.res);
  hub.feed(sid, { type: "text_delta", text: "a" }); // delivered
  // Second message: socket dies.
  const stream = hub.streamFor(sid);
  const origWrite = conn.res.write.bind(conn.res);
  let first = true;
  conn.res.write = (chunk) => {
    if (first) {
      first = false;
      return false; // flush failure
    }
    return origWrite(chunk);
  };
  hub.feed(sid, { type: "text_delta", text: "b" }); // write fails -> client removed
  assert.equal(hub.clientCount(sid), 0);
  // Watermark is the last SUCCESSFULLY flushed id (1), so a reconnect
  // replays the failed message, not drops it.
  hub.feed(sid, { type: "text_delta", text: "c" });
  const re = makeConn();
  hub.streamFor(sid).handleEvents(re.req, re.res);
  const replayed = parseFrames(re.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.text),
    ["b", "c"],
    "the un-flushed message is recovered, the flushed one is not re-sent"
  );
  re.req.emit("close");
});

test("idle heartbeat re-asserts status:idle; busy state never re-sends idle", async () => {
  const hub = new Hub({ heartbeatMs: 20 });
  const sid = "sess-hb";
  const conn = makeConn();
  hub.streamFor(sid).handleEvents(conn.req, conn.res);
  hub.feed(sid, { type: "status", state: "busy" });
  await new Promise((r) => setTimeout(r, 60));
  const afterBusy = parseFrames(conn.frames);
  // Heartbeat fired (comment frame) but NO idle re-assertion while busy.
  assert.ok(!afterBusy.some((m) => m.msg.type === "status" && m.msg.state === "idle"), "no idle while busy");

  hub.feed(sid, { type: "status", state: "idle" });
  await new Promise((r) => setTimeout(r, 60));
  const afterIdle = parseFrames(conn.frames);
  const reasserts = afterIdle.filter((m) => m.msg.type === "status" && m.msg.state === "idle");
  assert.ok(reasserts.length >= 2, "re-asserts idle on heartbeat (last feed + at least one beat)");
  conn.req.emit("close");
});

test("needReplay=true sends the full ring", () => {
  const hub = new Hub();
  const sid = "sess-full";
  hub.feed(sid, { type: "status", state: "busy", n: 1 });
  hub.feed(sid, { type: "status", state: "idle", n: 2 });
  const conn = makeConn({ needReplay: true });
  hub.streamFor(sid).handleEvents(conn.req, conn.res);
  assert.deepEqual(parseFrames(conn.frames).map((m) => m.msg.n), [1, 2]);
  conn.req.emit("close");
});

test("hub feeds the shared ring (getMessages sees extended-session messages)", () => {
  const hub = new Hub();
  const sid = "sess-ring";
  hub.feed(sid, { type: "user_prompt", text: "hello" });
  const msgs = getMessages(sid, 0);
  assert.equal(msgs.length, 1);
  // The official ring returns flattened entries: {id, ...msg}.
  assert.equal(msgs[0].type, "user_prompt");
  assert.equal(msgs[0].text, "hello");
});
