// Tailed local Claude sessions have no busy/idle events; the watcher ticks running_stats while the transcript
// is being written so the phone's "thinking" row moves like it does for an official session.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCcWatcher } from "../src/cc-watch.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function transcript(t) {
  const base = mkdtempSync(join(tmpdir(), "evenbridge-ccstats-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "-proj-s");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "id-s.jsonl");
  writeFileSync(file, JSON.stringify({ type: "system", subtype: "init", cwd: "/proj/s", sessionId: "id-s" }) + "\n");
  return file;
}

const assistant = (text, usage) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], usage } }) + "\n";
const prompt = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

test("running_stats tick while the transcript is written, carry usage, stop when it goes quiet, restart on a new prompt", async (t) => {
  const file = transcript(t);
  const emitted = [];
  const watch = createCcWatcher({ emit: (sid, m) => emitted.push({ sid, ...m }), intervalMs: 10, statsIntervalMs: 40, freshMs: 150 });
  t.after(() => watch.stop("id-s"));
  watch.start("id-s", file, statSync(file).size);

  appendFileSync(file, prompt("first question"));
  appendFileSync(file, assistant("working", { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 }));
  await sleep(100);
  let stats = emitted.filter((m) => m.type === "running_stats");
  assert.ok(stats.length >= 1, `expected a tick, got ${stats.length}`);
  assert.equal(stats[0].sid, "id-s");
  assert.ok(stats[0].durationMs >= 40 && stats[0].durationMs < 150, `durationMs ${stats[0].durationMs}`);
  assert.equal(stats[0].inputTokens, 120);
  assert.equal(stats[0].outputTokens, 7);
  // the text frame itself still flows, before the first tick
  assert.deepEqual(emitted.slice(0, 2).map((m) => m.type), ["user_prompt", "text_delta"]);

  // keep writing: the turn lives on and the duration keeps growing
  appendFileSync(file, assistant("more", { input_tokens: 5, output_tokens: 3 }));
  await sleep(100);
  stats = emitted.filter((m) => m.type === "running_stats");
  assert.ok(stats.length >= 2);
  assert.ok(stats.at(-1).durationMs > stats[0].durationMs);
  assert.equal(stats.at(-1).inputTokens, 125);
  assert.equal(stats.at(-1).outputTokens, 10);

  // quiet for longer than freshMs: the turn is over, no more ticks
  await sleep(260);
  const n = emitted.filter((m) => m.type === "running_stats").length;
  await sleep(120);
  assert.equal(emitted.filter((m) => m.type === "running_stats").length, n, "no ticks on a quiet transcript");

  // a new prompt starts a fresh turn: the duration restarts, the counters reset
  appendFileSync(file, prompt("second question"));
  await sleep(100);
  const fresh = emitted.filter((m) => m.type === "running_stats").slice(n);
  assert.ok(fresh.length >= 1, "ticks resume on a new turn");
  assert.ok(fresh[0].durationMs < 150, `restarted duration ${fresh[0].durationMs}`);
  assert.equal(fresh[0].inputTokens, 0);
  assert.equal(fresh[0].outputTokens, 0);
});

test("no running_stats before the first tick interval and none without writes", async (t) => {
  const file = transcript(t);
  const emitted = [];
  const watch = createCcWatcher({ emit: (sid, m) => emitted.push(m), intervalMs: 10, statsIntervalMs: 500, freshMs: 1000 });
  t.after(() => watch.stop("id-s"));
  watch.start("id-s", file, statSync(file).size);
  await sleep(80);
  assert.equal(emitted.length, 0);
  appendFileSync(file, assistant("hi", { output_tokens: 1 }));
  await sleep(80);
  assert.deepEqual(emitted.map((m) => m.type), ["text_delta"]);
});
