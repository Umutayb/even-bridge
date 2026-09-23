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

test("stream-only reconnect (sole client) replays the most recent turn", () => {
  const hub = new Hub();
  const sid = "sess-gap";
  const first = makeConn();
  hub.streamFor(sid).handleEvents(first.req, first.res);
  hub.feed(sid, { type: "status", state: "busy", n: 1 });
  hub.feed(sid, { type: "text_delta", text: "a", n: 2 });
  hub.feed(sid, { type: "status", state: "idle", n: 3 });
  // Client drops.
  first.req.emit("close");
  // While offline, two more messages (the next turn).
  hub.feed(sid, { type: "status", state: "busy", n: 4 });
  hub.feed(sid, { type: "text_delta", text: "b", n: 5 });

  const second = makeConn(); // no Last-Event-ID, no needReplay
  hub.streamFor(sid).handleEvents(second.req, second.res);
  const replayed = parseFrames(second.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.n),
    [4, 5],
    "replays the whole most-recent turn, from its busy start"
  );
  second.req.emit("close");
});

test("stream-only reconnect after a COMPLETED turn replays its full body (not just the tail)", () => {
  // The real pi turn shape: busy -> think_start -> text_start -> deltas ->
  // think_end -> text_end -> running_stats -> result -> idle. The old window
  // ("from the last non-idle status") started at text_end and dropped the
  // prompt + reply body — the "reply cut off mid-sentence" symptom.
  const hub = new Hub();
  const sid = "sess-completed";
  const turn = (n0, q, body) => {
    hub.feed(sid, { type: "user_prompt", text: q, n: n0 });
    hub.feed(sid, { type: "status", state: "busy", n: n0 + 1 });
    hub.feed(sid, { type: "status", state: "think_start", n: n0 + 2 });
    hub.feed(sid, { type: "status", state: "text_start", n: n0 + 3 });
    hub.feed(sid, { type: "text_delta", text: body, n: n0 + 4 });
    hub.feed(sid, { type: "status", state: "think_end", n: n0 + 5 });
    hub.feed(sid, { type: "status", state: "text_end", n: n0 + 6 });
    hub.feed(sid, { type: "running_stats", n: n0 + 7 });
    hub.feed(sid, { type: "result", n: n0 + 8 });
    hub.feed(sid, { type: "status", state: "idle", n: n0 + 9 });
  };
  turn(1, "q1", "first answer");
  turn(11, "q2", "the reply body"); // the phone was offline for this whole turn

  const conn = makeConn(); // stream-only, no resume point
  hub.streamFor(sid).handleEvents(conn.req, conn.res);
  const replayed = parseFrames(conn.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.n),
    [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    "replays the whole most-recent completed turn, body included"
  );
  conn.req.emit("close");
});

test("stream-only reconnect MID-TURN replays from the in-progress turn's start", () => {
  const hub = new Hub();
  const sid = "sess-midturn";
  const turn = (n0, q, body) => {
    hub.feed(sid, { type: "user_prompt", text: q, n: n0 });
    hub.feed(sid, { type: "status", state: "busy", n: n0 + 1 });
    hub.feed(sid, { type: "status", state: "think_start", n: n0 + 2 });
    hub.feed(sid, { type: "status", state: "text_start", n: n0 + 3 });
    hub.feed(sid, { type: "text_delta", text: body, n: n0 + 4 });
    hub.feed(sid, { type: "status", state: "think_end", n: n0 + 5 });
    hub.feed(sid, { type: "status", state: "text_end", n: n0 + 6 });
    hub.feed(sid, { type: "running_stats", n: n0 + 7 });
    hub.feed(sid, { type: "result", n: n0 + 8 });
    hub.feed(sid, { type: "status", state: "idle", n: n0 + 9 });
  };
  turn(1, "q1", "first answer");
  // Second turn, still running (no terminal idle yet):
  hub.feed(sid, { type: "user_prompt", text: "q2", n: 11 });
  hub.feed(sid, { type: "status", state: "busy", n: 12 });
  hub.feed(sid, { type: "status", state: "think_start", n: 13 });
  hub.feed(sid, { type: "status", state: "text_start", n: 14 });
  hub.feed(sid, { type: "text_delta", text: "partial", n: 15 });

  const conn = makeConn();
  hub.streamFor(sid).handleEvents(conn.req, conn.res);
  const replayed = parseFrames(conn.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.n),
    [11, 12, 13, 14, 15],
    "replays the in-progress turn from its prompt"
  );
  conn.req.emit("close");
});

test("black-holed connection: bytes that never reached the phone are recovered on reconnect", () => {
  const hub = new Hub();
  const sid = "sess-blackhole";
  const conn = makeConn();
  hub.streamFor(sid).handleEvents(conn.req, conn.res);
  hub.feed(sid, { type: "status", state: "busy", n: 1 });
  hub.feed(sid, { type: "text_delta", text: "head", n: 2 });
  // The phone now black-holes: res.write() still returns true (kernel buffer
  // accepted it) but the phone never receives anything from here on.
  hub.feed(sid, { type: "text_delta", text: "lost-1", n: 3 });
  hub.feed(sid, { type: "text_delta", text: "lost-2", n: 4 });
  hub.feed(sid, { type: "status", state: "idle", n: 5 });
  conn.req.emit("close");

  // The phone's auto-reconnect: stream-only, no resume point. The old
  // watermark rule replayed nothing (watermark advanced past 1..5); the
  // turn-window rule recovers the whole turn including the lost middle.
  const re = makeConn();
  hub.streamFor(sid).handleEvents(re.req, re.res);
  const replayed = parseFrames(re.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.n),
    [1, 2, 3, 4, 5],
    "the full turn is replayed, black-holed middle included"
  );
  re.req.emit("close");
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
  // Reconnect: the un-flushed message is recovered; the flushed one is
  // re-sent too (the app merges by message id — same as needReplay=true).
  hub.feed(sid, { type: "text_delta", text: "c" });
  const re = makeConn();
  hub.streamFor(sid).handleEvents(re.req, re.res);
  const replayed = parseFrames(re.frames);
  assert.deepEqual(
    replayed.map((m) => m.msg.text),
    ["a", "b", "c"],
    "the whole recent window replays (id-merged by the app); the un-flushed message is recovered"
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
