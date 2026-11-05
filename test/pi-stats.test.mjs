// The phone's "thinking" row moves on running_stats frames: the official Claude/Codex sessions tick one every
// 10 s of a turn. A pi session used to send one only at turn_end, so the row sat frozen until the answer.

import test from "node:test";
import assert from "node:assert/strict";
import { PiSession, STATS_INTERVAL_MS } from "../src/providers/pi/session.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSession(frames, statsIntervalMs) {
  const s = new PiSession((sid, m) => frames.push({ sid, ...m }), { statsIntervalMs });
  s.sessionId = "pi-1";
  s.client = { running: true, send: async () => ({ success: true, data: {} }), fire() {}, respondUi() {}, stop: async () => {} };
  return s;
}

test("official cadence is 10 s", () => {
  assert.equal(STATS_INTERVAL_MS, 10_000);
  assert.equal(new PiSession(() => {}, {}).statsIntervalMs, 10_000);
});

test("a running pi turn ticks running_stats until agent_end", async () => {
  const frames = [];
  const s = fakeSession(frames, 20);
  await s.run("hello there");
  assert.deepEqual(frames.map((f) => f.type).slice(0, 2), ["user_prompt", "status"]);
  assert.equal(frames[1].state, "busy");
  await sleep(90);
  const stats = frames.filter((f) => f.type === "running_stats");
  assert.ok(stats.length >= 2, `expected ticks, got ${stats.length}`);
  for (const f of stats) {
    assert.equal(f.sid, "pi-1");
    assert.ok(Number.isFinite(f.durationMs) && f.durationMs >= 0);
    assert.equal(f.inputTokens, 0);
    assert.equal(f.outputTokens, 0);
  }
  assert.ok(stats.at(-1).durationMs >= stats[0].durationMs);
  s.onAgentEnd();
  assert.equal(s.statsTimer, null);
  const n = frames.filter((f) => f.type === "running_stats").length;
  await sleep(70);
  assert.equal(frames.filter((f) => f.type === "running_stats").length, n, "no ticks after the turn");
  assert.equal(frames.at(-1).type, "status");
  assert.equal(frames.at(-1).state, "idle");
});

test("ticks carry the token counts seen so far and stop when the child exits or the session stops", async () => {
  const frames = [];
  const s = fakeSession(frames, 20);
  await s.run("count tokens");
  s.inputTokens = 120;
  s.outputTokens = 34;
  await sleep(50);
  const last = frames.filter((f) => f.type === "running_stats").at(-1);
  assert.ok(last, "a tick arrived");
  assert.equal(last.inputTokens, 120);
  assert.equal(last.outputTokens, 34);
  await s.stop();
  assert.equal(s.statsTimer, null);

  const frames2 = [];
  const s2 = fakeSession(frames2, 20);
  await s2.run("exit mid-turn");
  assert.ok(s2.statsTimer);
  s2._busy = false; // what the exit handler does first
  s2.emitRunningStats(); // a tick after the turn ended clears itself
  assert.equal(s2.statsTimer, null);
  assert.equal(frames2.filter((f) => f.type === "running_stats").length, 0);
});
