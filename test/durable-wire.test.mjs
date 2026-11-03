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
