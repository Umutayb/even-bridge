import { test } from "node:test";
import assert from "node:assert/strict";
import { ViewTranslator } from "../src/providers/durable/wire.mjs";

// Hand-built ConversationView snapshots shaped like pi-durable 1.5.0's
// (entries: EntryRecord[] with kind + model; docs["pi.live"] / docs["pi.usage"]).
const SID = "dur-test";

const user = (id, text) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1 }] });
const assistant = (id, content, stopReason = "stop") => ({
  id, conversationId: 1, kind: "pi.assistant",
  model: [{ role: "assistant", content, stopReason, api: "openai-completions", provider: "lets-code", model: "qwen3.8-27b", usage: {}, timestamp: 2 }],
});
const toolResult = (id, toolCallId, toolName, text) => ({
  id, conversationId: 1, kind: "pi.tool-result", data: { diagnostics: [] },
  model: [{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 3 }],
});
const partial = (content) => ({ role: "assistant", content, stopReason: "stop", timestamp: 2 });
const view = (entries, live = {}, usage) => ({
  conversation: { id: 1 },
  entries,
  docs: { "pi.live": live, ...(usage ? { "pi.usage": usage } : {}) },
});
const RUN = { taskId: 10, inputs: [5], turns: 0 };

function translator(opts) {
  const frames = [];
  let t = 1000;
  const tr = new ViewTranslator(SID, (f) => frames.push(f), { now: () => (t += 100), ...opts });
  return { tr, frames };
}
const shape = (f) => (f.type === "status" ? `status ${f.state}` : f.type);

test("plain text turn emits the pi wire sequence", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "hello");
  tr.apply(view([u], { run: RUN }));
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "Hi" }]) } }));
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "Hi the" }]) } }));
  const a = assistant(2, [{ type: "text", text: "Hi there." }]);
  const usage = { models: { "lets-code/qwen3.8-27b": { input: 120, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 129, cost: {} } }, tools: {} };
  tr.apply(view([u, a], {}, usage));

  assert.deepEqual(frames.map(shape), [
    "user_prompt", "status busy", "status text_start", "text_delta", "text_delta", "text_delta",
    "status text_end", "running_stats", "result", "status idle",
  ]);
  assert.deepEqual(frames[0], { type: "user_prompt", text: "hello" });
  assert.deepEqual(frames[1], { type: "status", state: "busy", sessionId: SID });
  assert.equal(frames.filter((f) => f.type === "text_delta").map((f) => f.text).join(""), "Hi there.");
  assert.deepEqual(frames.slice(3, 6).map((f) => f.text), ["Hi", " the", "re."]);
  const stats = frames.find((f) => f.type === "running_stats");
  assert.equal(stats.inputTokens, 120);
  assert.equal(stats.outputTokens, 9);
  assert.ok(stats.durationMs > 0);
  const result = frames.find((f) => f.type === "result");
  assert.deepEqual(result, {
    type: "result", success: true, text: "", sessionId: SID, costUsd: 0, provider: "claude",
    turns: 1, durationMs: stats.durationMs, inputTokens: 120, outputTokens: 9,
  });
  assert.deepEqual(frames.at(-1), { type: "status", state: "idle", sessionId: SID });
  assert.equal(frames.filter((f) => f.type === "user_prompt").length, 1);
});

test("a tool call emits tool_start before tool_end with the same toolId", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "list files");
  const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } };
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "Let me look." }, call]) } }));
  const a1 = assistant(2, [{ type: "text", text: "Let me look." }, call], "toolUse");
  tr.apply(view([u, a1], { run: RUN, tools: [{ callId: "call-1", name: "bash", status: "running", output: "a.txt" }] }));
  const r = toolResult(3, "call-1", "bash", "a.txt\nb.txt");
  tr.apply(view([u, a1, r], { run: { ...RUN, turns: 1 }, tools: [{ callId: "call-1", name: "bash", status: "done", entry: 3 }] }));
  const a2 = assistant(4, [{ type: "text", text: "Two files." }]);
  tr.apply(view([u, a1, r, a2], {}));

  const start = frames.findIndex((f) => f.type === "tool_start");
  const end = frames.findIndex((f) => f.type === "tool_end");
  assert.ok(start >= 0 && end > start);
  assert.deepEqual(frames[start], { type: "tool_start", name: "bash", toolId: "call-1" });
  assert.deepEqual(frames[end], {
    type: "tool_end", name: "bash", toolId: "call-1", summary: "a.txt\nb.txt",
    detail: { input: { command: "ls" }, output: "a.txt\nb.txt" },
  });
  assert.equal(frames.filter((f) => f.type === "tool_start").length, 1);
  assert.equal(frames.filter((f) => f.type === "tool_end").length, 1);
  assert.equal(frames.filter((f) => f.type === "text_delta").map((f) => f.text).join(""), "Let me look.Two files.");
  assert.equal(frames.find((f) => f.type === "result").turns, 2);
  assert.equal(frames.at(-1).state, "idle");
});

test("tool_end summary is the first 120 chars of the output", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "cat");
  const call = { type: "toolCall", id: "c", name: "read", arguments: { path: "f" } };
  const long = "x".repeat(300);
  tr.apply(view([u, assistant(2, [call], "toolUse"), toolResult(3, "c", "read", long)], { run: RUN, tools: [{ callId: "c", name: "read", status: "done" }] }));
  const end = frames.find((f) => f.type === "tool_end");
  assert.equal(end.summary, "x".repeat(120));
  assert.equal(end.detail.output, long);
  assert.ok(frames.findIndex((f) => f.type === "tool_start") < frames.findIndex((f) => f.type === "tool_end"));
});

test("a failed run emits one error frame then result success:false", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "go");
  tr.apply(view([u], { run: RUN }));
  const failure = { taskId: 10, inputs: [5], reason: "model_error", detail: "502 Bad Gateway" };
  tr.apply(view([u], { runFailure: failure }));
  tr.apply(view([u], { runFailure: failure })); // the failure doc stays until the next run

  assert.deepEqual(frames.map(shape), ["user_prompt", "status busy", "running_stats", "error", "result", "status idle"]);
  const errors = frames.filter((f) => f.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "model_error: 502 Bad Gateway");
  assert.equal(frames.find((f) => f.type === "result").success, false);
});

test("identical snapshots emit no duplicate text_delta", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "hi");
  const live = { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "Same text" }]) } };
  tr.apply(view([u], live));
  tr.apply(view([u], live));
  tr.apply(view([u], structuredClone(live)));
  assert.equal(frames.filter((f) => f.type === "text_delta").length, 1);
  assert.equal(frames.filter((f) => f.type === "status" && f.state === "text_start").length, 1);
});

test("thinking is bracketed by think_start/think_end and never emitted as text", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "think");
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "thinking", thinking: "hmm" }]) } }));
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "thinking", thinking: "hmm, ok" }, { type: "text", text: "Answer" }]) } }));
  tr.apply(view([u, assistant(2, [{ type: "thinking", thinking: "hmm, ok" }, { type: "text", text: "Answer." }])], {}));
  assert.deepEqual(frames.map(shape), [
    "user_prompt", "status busy", "status think_start", "status think_end", "status text_start",
    "text_delta", "text_delta", "status text_end", "running_stats", "result", "status idle",
  ]);
  assert.ok(!frames.some((f) => f.type === "text_delta" && f.text.includes("hmm")));
});

test("a whole turn folded into one view still emits the full sequence", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  tr.apply(view([user(1, "quick"), assistant(2, [{ type: "text", text: "Done." }])], {}));
  assert.deepEqual(frames.map(shape), [
    "user_prompt", "status busy", "status text_start", "text_delta", "status text_end",
    "running_stats", "result", "status idle",
  ]);
});

test("the first view is history: old entries are not replayed", () => {
  const { tr, frames } = translator();
  tr.apply(view([user(1, "old"), assistant(2, [{ type: "text", text: "old answer" }])], {}));
  assert.deepEqual(frames, []);
  tr.apply(view([user(1, "old"), assistant(2, [{ type: "text", text: "old answer" }]), user(3, "new")], { run: RUN }));
  assert.deepEqual(frames.map(shape), ["user_prompt", "status busy"]);
  assert.equal(frames[0].text, "new");
});

test("prime:false treats the first view as new", () => {
  const { tr, frames } = translator({ prime: false });
  tr.apply(view([user(1, "submitted before attach")], { run: RUN }));
  assert.deepEqual(frames.map(shape), ["user_prompt", "status busy"]);
});

test("attaching mid-run reports busy and streams the in-flight partial", () => {
  const { tr, frames } = translator();
  tr.apply(view([user(1, "x")], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "partial" }]) } }));
  assert.deepEqual(frames.map(shape), ["status busy", "status text_start", "text_delta"]);
});

test("a retry attempt closes the abandoned partial and starts fresh", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "x");
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "Hel" }]) } }));
  tr.apply(view([u], { run: RUN, generation: { attempt: 2, message: partial([{ type: "text", text: "Hello" }]) } }));
  assert.deepEqual(frames.slice(2).map(shape), ["status text_start", "text_delta", "status text_end", "status text_start", "text_delta"]);
  assert.equal(frames.at(-1).text, "Hello");
});

test("a steer mid-run emits its own user_prompt but no second busy", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "first");
  tr.apply(view([u], { run: RUN }));
  tr.apply(view([u, user(2, "also this")], { run: RUN }));
  assert.deepEqual(frames.map(shape), ["user_prompt", "status busy", "user_prompt"]);
});

test("finish closes open blocks without claiming a result", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  tr.apply(view([user(1, "x")], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "ab" }]) } }));
  tr.finish();
  tr.finish();
  assert.deepEqual(frames.map(shape), ["user_prompt", "status busy", "status text_start", "text_delta", "status text_end"]);
});

test("user content arrays are flattened to text", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "image", data: "", mimeType: "image/png" }, { type: "text", text: "b" }] }] };
  tr.apply(view([u], { run: RUN }));
  assert.equal(frames[0].text, "a\nb");
});

// ---- fix round 1 ----
const usageOf = (input, output) => ({ models: { "lets-code/qwen3.8-27b": { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: {} } }, tools: {} });
const between = (frames, a, b) => frames.slice(a + 1, b);
const promptIdx = (frames) => frames.map((f, i) => (f.type === "user_prompt" ? i : -1)).filter((i) => i >= 0);

test("each run reports only its own tokens", () => {
  const { tr, frames } = translator();
  tr.apply(view([], {}, usageOf(0, 0)));
  const u1 = user(1, "one"), a1 = assistant(2, [{ type: "text", text: "1" }]);
  tr.apply(view([u1], { run: { taskId: 10, inputs: [], turns: 0, first: 1 } }, usageOf(0, 0)));
  tr.apply(view([u1, a1], {}, usageOf(100, 10)));
  const u2 = user(3, "two"), a2 = assistant(4, [{ type: "text", text: "2" }]);
  // second run folded into a single view: its usage is already in that view
  tr.apply(view([u1, a1, u2, a2], {}, usageOf(250, 25)));
  const results = frames.filter((f) => f.type === "result");
  assert.deepEqual(results.map((r) => [r.inputTokens, r.outputTokens]), [[100, 10], [150, 15]]);
  const stats = frames.filter((f) => f.type === "running_stats");
  assert.deepEqual(stats.map((r) => [r.inputTokens, r.outputTokens]), [[100, 10], [150, 15]]);
});

test("priming starts the usage baseline at the first view", () => {
  const { tr, frames } = translator();
  tr.apply(view([user(1, "old"), assistant(2, [{ type: "text", text: "x" }])], {}, usageOf(500, 50)));
  tr.apply(view([user(3, "new"), assistant(4, [{ type: "text", text: "y" }])], {}, usageOf(530, 53)));
  const r = frames.find((f) => f.type === "result");
  assert.deepEqual([r.inputTokens, r.outputTokens], [30, 3]);
});

test("queued input in the ending commit ends the first run before the second prompt", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u1 = user(1, "first"), a1 = assistant(2, [{ type: "text", text: "Answer one." }]), u2 = user(3, "second");
  tr.apply(view([u1], { run: { taskId: 10, inputs: [5], turns: 0, first: 1 } }));
  tr.apply(view([u1, a1, u2], { run: { taskId: 20, inputs: [6], turns: 0, first: 3 } }));
  const [p1, p2] = promptIdx(frames);
  assert.equal(frames[p2].text, "second");
  const mid = between(frames, p1, p2).map(shape);
  assert.equal(mid.filter((s) => s === "result").length, 1);
  assert.equal(mid.filter((s) => s === "status idle").length, 1);
  assert.equal(mid.at(-1), "status idle");
  assert.ok(mid.includes("text_delta"), "the first run's answer lands in the first run");
  assert.equal(frames.find((f) => f.type === "result").success, true);
  assert.deepEqual(frames.slice(p2).map(shape), ["user_prompt", "status busy"]);
});

test("continue after a failed run reports the failure, then a new busy run", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u1 = user(1, "go");
  tr.apply(view([u1], { run: { taskId: 10, inputs: [5], turns: 0, first: 1 } }));
  const failure = { taskId: 10, inputs: [5], reason: "model_error", detail: "boom", first: 1 };
  // afterFailedRun: "continue" — the same commit ends the run and starts its continuation (same first)
  tr.apply(view([u1], { run: { taskId: 11, inputs: [], turns: 0, first: 1 }, runFailure: failure }));
  tr.apply(view([u1], { run: { taskId: 11, inputs: [], turns: 0, first: 1 }, runFailure: failure }));
  const a = assistant(2, [{ type: "text", text: "Recovered." }]);
  tr.apply(view([u1, a], { runFailure: failure })); // the failure doc is kept by the continuation
  const u2 = user(3, "next");
  tr.apply(view([u1, a, u2], { run: { taskId: 12, inputs: [7], turns: 0, first: 3 } }));
  assert.deepEqual(frames.map(shape), [
    "user_prompt", "status busy", "running_stats", "error", "result", "status idle",
    "status busy", "status text_start", "text_delta", "status text_end", "running_stats", "result", "status idle",
    "user_prompt", "status busy",
  ]);
  const results = frames.filter((f) => f.type === "result");
  assert.deepEqual(results.map((r) => r.success), [false, true]);
  assert.equal(frames.filter((f) => f.type === "error").length, 1);
  const [p1, p2] = promptIdx(frames);
  assert.equal(between(frames, p1, p2).at(-1).state, "idle");
});

test("steer mid-run does not end the run", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u1 = user(1, "first"), u2 = user(3, "steer");
  const a1 = assistant(2, [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], "toolUse");
  tr.apply(view([u1], { run: { taskId: 10, inputs: [5], turns: 0, first: 1 } }));
  tr.apply(view([u1, a1, u2], { run: { taskId: 11, inputs: [5, 6], turns: 1, first: 1 } }));
  assert.ok(!frames.some((f) => f.type === "result"));
  assert.deepEqual(frames.map(shape), ["user_prompt", "status busy", "user_prompt"]);
  tr.apply(view([u1, a1, u2, assistant(4, [{ type: "text", text: "ok" }])], {}));
  assert.equal(frames.filter((f) => f.type === "result").length, 1);
});

test("priming mid-run emits the run's prompt before busy", () => {
  const { tr, frames } = translator();
  tr.apply(view([user(1, "old"), assistant(2, [{ type: "text", text: "x" }]), user(3, "current")], { run: { taskId: 10, inputs: [5], turns: 0, first: 3 } }));
  assert.deepEqual(frames.map(shape), ["user_prompt", "status busy"]);
  assert.equal(frames[0].text, "current");
});

test("committed text that rewrites the streamed text is resent in full", () => {
  const warnings = [];
  const { tr, frames } = translator({ log: { warn: (m) => warnings.push(m) } });
  tr.apply(view([]));
  const u = user(1, "x");
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "Hello wrld" }]) } }));
  tr.apply(view([u, assistant(2, [{ type: "text", text: "Hello world." }])], {}));
  assert.deepEqual(frames.slice(2).map(shape), [
    "status text_start", "text_delta", "status text_end", "status text_start", "text_delta", "status text_end",
    "running_stats", "result", "status idle",
  ]);
  assert.equal(frames.filter((f) => f.type === "text_delta").at(-1).text, "Hello world.");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[durable:wire\]/);
});

test("a later text block starts on a new line", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  const u = user(1, "x");
  tr.apply(view([u], { run: RUN, generation: { attempt: 1, message: partial([{ type: "text", text: "A" }]) } }));
  tr.apply(view([u, assistant(2, [{ type: "text", text: "A" }, { type: "thinking", thinking: "t" }, { type: "text", text: "B" }])], {}));
  assert.deepEqual(frames.filter((f) => f.type === "text_delta").map((f) => f.text), ["A", "\nB"]);
});

test("stray assistant or tool-result entries outside a run emit nothing", () => {
  const { tr, frames } = translator();
  tr.apply(view([]));
  tr.apply(view([assistant(2, [{ type: "text", text: "summary" }])], {}));
  tr.apply(view([assistant(2, [{ type: "text", text: "summary" }]), toolResult(3, "c9", "bash", "out")], {}));
  assert.deepEqual(frames, []);
});
