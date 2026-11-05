// Terminal-driven pi sessions reach the phone through the transcript watcher, which has no busy/idle events:
// it ticks running_stats while the transcript is written so the "thinking" row moves like an official session's.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptWatcher } from "../src/providers/pi/watcher.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const entry = (role, content, usage) =>
  JSON.stringify({
    type: "message",
    id: `m${++seq}`,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: usage ? { role, content, usage } : { role, content },
  }) + "\n";

function transcript(t) {
  const dir = mkdtempSync(join(tmpdir(), "evenbridge-piwatch-stats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: "s0", cwd: "/proj" }) + "\n");
  return file;
}

function watcher(file, emitted, { healthy = async () => false, statsIntervalMs = 40, freshMs = 150 } = {}) {
  return new TranscriptWatcher({
    emit: (sid, m) => emitted.push({ sid, ...m }),
    findFile: () => file,
    healthy,
    active: () => true,
    intervalMs: 10,
    statsIntervalMs,
    freshMs,
  });
}

test("an external pi turn ticks running_stats with its usage, stops when quiet, restarts on a new prompt", async (t) => {
  const file = transcript(t);
  const emitted = [];
  const w = watcher(file, emitted);
  t.after(() => w.stopAll());
  w.watch("pi-ext");

  appendFileSync(file, entry("user", [{ type: "text", text: "first question" }]));
  appendFileSync(file, entry("assistant", [{ type: "text", text: "working" }], { input: 100, cacheRead: 20, output: 7 }));
  await sleep(100);
  let stats = emitted.filter((m) => m.type === "running_stats");
  assert.ok(stats.length >= 1, `expected a tick, got ${stats.length}`);
  assert.equal(stats[0].sid, "pi-ext");
  assert.ok(stats[0].durationMs >= 40 && stats[0].durationMs < 150, `durationMs ${stats[0].durationMs}`);
  assert.equal(stats[0].inputTokens, 120);
  assert.equal(stats[0].outputTokens, 7);
  assert.deepEqual(emitted.slice(0, 2).map((m) => m.type), ["user_prompt", "text_delta"]);

  appendFileSync(file, entry("assistant", [{ type: "text", text: "more" }], { input: 5, output: 3 }));
  await sleep(100);
  stats = emitted.filter((m) => m.type === "running_stats");
  assert.ok(stats.length >= 2);
  assert.ok(stats.at(-1).durationMs > stats[0].durationMs);
  assert.equal(stats.at(-1).inputTokens, 125);
  assert.equal(stats.at(-1).outputTokens, 10);

  await sleep(260);
  const n = emitted.filter((m) => m.type === "running_stats").length;
  await sleep(120);
  assert.equal(emitted.filter((m) => m.type === "running_stats").length, n, "no ticks on a quiet transcript");

  appendFileSync(file, entry("user", [{ type: "text", text: "second question" }]));
  await sleep(100);
  const fresh = emitted.filter((m) => m.type === "running_stats").slice(n);
  assert.ok(fresh.length >= 1, "ticks resume on a new turn");
  assert.ok(fresh[0].durationMs < 150, `restarted duration ${fresh[0].durationMs}`);
  assert.equal(fresh[0].inputTokens, 0);
});

test("a healthy live child gets no watcher ticks (its session ticks its own stats)", async (t) => {
  const file = transcript(t);
  const emitted = [];
  const w = watcher(file, emitted, { healthy: async () => true });
  t.after(() => w.stopAll());
  w.watch("pi-live");
  appendFileSync(file, entry("user", [{ type: "text", text: "hello" }]));
  appendFileSync(file, entry("assistant", [{ type: "text", text: "hi" }], { input: 1, output: 1 }));
  await sleep(120);
  assert.equal(emitted.length, 0);
});
