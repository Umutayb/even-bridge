import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createDurableProvider, resolveAgentCwd, AGENT_INSTRUCTIONS, DEFAULT_MAX_TURNS } from "../src/providers/durable/provider.mjs";
import { getOwner } from "../src/ownership.mjs";
import { startFakeOpenAI, fakeModelsJson } from "./helpers/fake-openai.mjs";

// A real Harness on memory storage, talking to a local fake OpenAI endpoint:
// no network, no real model, deterministic answers ("ok: <prompt>").
let fake;
let root;
before(async () => {
  fake = await startFakeOpenAI();
  root = realpathSync(mkdtempSync(join(tmpdir(), "dur-prov-")));
  writeFileSync(join(root, "models.json"), JSON.stringify(fakeModelsJson(fake.baseUrl)));
});
after(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function setup(extra = {}) {
  const dir = join(root, `case-${++n}`);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const frames = [];
  const emit = (sid, frame) => frames.push({ sid, ...frame });
  const provider = createDurableProvider(emit, {
    hub: { clientCount: () => 0 },
    storePath: join(dir, "durable.sqlite"),
    storage: new MemoryStorage(),
    modelsPath: join(root, "models.json"),
    settingsPath: join(dir, "no-settings.json"),
    defaultCwd: work,
    allowedCwds: [dir],
    guard: { wrapper: "none", log: () => {} },
    log: { warn() {}, error() {}, log() {} },
    ...extra,
  });
  return { provider, frames, work, dir };
}

const shape = (f) => (f.type === "status" ? `status ${f.state}` : f.type);
const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const idleCount = (frames, sid) => frames.filter((f) => f.sid === sid && f.type === "status" && f.state === "idle").length;

test("new session creates a conversation and emits a full turn to the hub", async () => {
  const { provider, frames, work } = setup();
  const { sessionId, provider: wire } = await provider.prompt(undefined, "hello", undefined, { name: "first" });
  assert.equal(wire, "claude");
  assert.match(sessionId, /^dur-/);
  await until(() => idleCount(frames, sessionId) === 1);
  const seq = frames.filter((f) => f.sid === sessionId).map(shape);
  assert.deepEqual(seq, [
    "user_prompt", "status busy", "status text_start", ...seq.filter((s) => s === "text_delta").map(() => "text_delta"),
    "status text_end", "running_stats", "result", "status idle",
  ]);
  assert.equal(frames[0].text, "hello");
  assert.equal(frames.filter((f) => f.type === "text_delta").map((f) => f.text).join(""), "ok: hello");
  const result = frames.find((f) => f.type === "result");
  assert.equal(result.success, true);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.outputTokens, 3);

  const row = provider._map.get(sessionId);
  assert.equal(row.name, "first");
  assert.equal(row.cwd, work);
  assert.equal(row.origin, "phone");
  assert.equal(typeof row.conversation_id, "number");
  const { ctx } = await provider.ready;
  const conv = await provider._harness.conversation(row.conversation_id, ctx);
  const agent = await conv.agent(ctx);
  assert.deepEqual(agent.model, { provider: "fake", modelId: "fake-model" });
  assert.equal(agent.thinkingLevel, "medium");
  assert.equal(agent.cwd, work);
  assert.equal(agent.maxTurns, DEFAULT_MAX_TURNS);
  assert.equal(agent.instructions, AGENT_INSTRUCTIONS);
  assert.equal(agent.extensions.at(-1).name, "even-guard"); // after CodingTools: its bash wins
  assert.equal(agent.extensions.length, 2);
  assert.equal(provider.probe(sessionId), true);
  assert.equal(getOwner(sessionId), "durable");
  assert.deepEqual(await provider.getHistory(sessionId, 10), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "ok: hello" },
  ]);
  assert.equal(await provider.getSessionStatus(sessionId), "idle");
  // Idle and no client: the watcher is gone.
  await until(() => !provider._live.has(sessionId));
  await provider.stopAll();
});

test("prompt while busy steers", async () => {
  // The model is held mid-round: the first prompt asks for a tool call, the
  // second arrives while that request is in flight.
  const { provider, frames } = setup();
  fake.hold();
  const base = fake.calls;
  const { sessionId } = await provider.prompt(undefined, 'TOOL bash {"command":"echo hi"}', undefined, {});
  await fake.waitForCalls(base + 1);
  assert.equal(provider.getStatus(sessionId).state, "busy");
  const again = await provider.prompt(sessionId, "also say bye", undefined, {});
  assert.equal(again.sessionId, sessionId);
  const ctx = (await provider.ready).ctx;
  const conv = await provider._harness.conversation(provider._map.get(sessionId).conversation_id, ctx);
  const watch = await conv.watch(ctx);
  assert.deepEqual(watch.value.docs["pi.inbox"].items.map((i) => [i.mode, i.content]), [["steer", "also say bye"]]);
  await watch.stop();
  fake.release();
  await until(() => idleCount(frames, sessionId) === 1);
  await new Promise((r) => setTimeout(r, 50));
  const mine = frames.filter((f) => f.sid === sessionId);
  // One run: one result, one idle; the steer shows as a second user_prompt inside it.
  assert.equal(mine.filter((f) => f.type === "result").length, 1);
  assert.equal(idleCount(frames, sessionId), 1);
  const prompts = mine.filter((f) => f.type === "user_prompt").map((f) => f.text);
  assert.deepEqual(prompts, ['TOOL bash {"command":"echo hi"}', "also say bye"]);
  const seq = mine.map(shape);
  assert.ok(seq.indexOf("tool_end") < seq.lastIndexOf("user_prompt"), "steer placed after the tool round");
  assert.ok(seq.lastIndexOf("user_prompt") < seq.indexOf("result"));
  assert.equal(mine.filter((f) => f.type === "text_delta").map((f) => f.text).join(""), "ok: also say bye");
  // The model never ran two requests at once: tool round, then the steered answer.
  assert.equal(fake.calls - base, 2);
  await provider.stopAll();
});

test("prompt while busy on a text-only run queues behind it, never a parallel run", async () => {
  const { provider, frames } = setup();
  fake.hold();
  const base = fake.calls;
  const { sessionId } = await provider.prompt(undefined, "first", undefined, {});
  await fake.waitForCalls(base + 1);
  await provider.prompt(sessionId, "second", undefined, {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.calls - base, 1, "no second request while the first is in flight");
  fake.release();
  await until(() => idleCount(frames, sessionId) === 2);
  const seq = frames.filter((f) => f.sid === sessionId).map(shape);
  const firstResult = seq.indexOf("result");
  // The second user_prompt does not appear until the first run has ended.
  assert.equal(seq.filter((s, i) => s === "user_prompt" && i < firstResult).length, 1);
  assert.equal(seq.filter((s) => s === "user_prompt").length, 2);
  assert.equal(seq.filter((s) => s === "result").length, 2);
  await provider.stopAll();
});

test("requestId is stable across prompt retries", async () => {
  const { provider, frames } = setup();
  fake.hold();
  const a = await provider.prompt(undefined, "do it once", undefined, { requestId: "req-1", origin: "evenai" });
  // Retry of the new-session request (e.g. the shim's HTTP retry): same session, same submission.
  const b = await provider.prompt(undefined, "do it once", undefined, { requestId: "req-1", origin: "evenai" });
  assert.equal(b.sessionId, a.sessionId);
  assert.equal(b.submissionId, a.submissionId);
  // Retry against the known session.
  const c = await provider.prompt(a.sessionId, "do it once", undefined, { requestId: "req-1" });
  assert.equal(c.submissionId, a.submissionId);
  const ctx = (await provider.ready).ctx;
  const s1 = await provider._harness.submission(a.submissionId, ctx);
  const s2 = await provider._harness.submission(c.submissionId, ctx);
  assert.equal(s1.id, s2.id);
  fake.release();
  await until(() => idleCount(frames, a.sessionId) === 1);
  // A retry after it settled still finds the same submission and starts nothing.
  const d = await provider.prompt(a.sessionId, "do it once", undefined, { requestId: "req-1" });
  assert.equal(d.submissionId, a.submissionId);
  await new Promise((r) => setTimeout(r, 50));
  const mine = frames.filter((f) => f.sid === a.sessionId);
  assert.equal(mine.filter((f) => f.type === "user_prompt").length, 1);
  assert.equal(mine.filter((f) => f.type === "result").length, 1);
  assert.equal(provider.listSessions(10).length, 1);
  assert.equal(provider._map.get(a.sessionId).origin, "evenai");
  assert.equal(provider.getStatus(a.sessionId).state, "idle");
  await provider.stopAll();
});

test("interrupt aborts and emits result success:false", async () => {
  const { provider, frames } = setup();
  fake.hold();
  const base = fake.calls;
  const { sessionId } = await provider.prompt(undefined, "long job", undefined, {});
  await fake.waitForCalls(base + 1);
  assert.equal(provider.interrupt(sessionId), undefined); // sync, fire and forget
  await until(() => idleCount(frames, sessionId) === 1);
  fake.release();
  const mine = frames.filter((f) => f.sid === sessionId);
  const err = mine.find((f) => f.type === "error");
  assert.match(err.message, /aborted/);
  const result = mine.find((f) => f.type === "result");
  assert.equal(result.success, false);
  assert.ok(mine.indexOf(err) < mine.indexOf(result));
  assert.equal(provider.getStatus(sessionId).state, "idle");
  assert.throws(() => provider.interrupt("dur-unknown"), (e) => e.statusCode === 404);
  await provider.stopAll();
});

test("getStatus is sync and null for unknown sid", async () => {
  const { provider, frames } = setup();
  assert.equal(provider.getStatus("dur-nope"), null);
  assert.equal(provider.getStatus("not-even-durable"), null);
  const { sessionId } = await provider.prompt(undefined, "hi", undefined, {});
  const st = provider.getStatus(sessionId);
  assert.ok(!(st instanceof Promise));
  assert.equal(st.provider, "claude");
  await until(() => idleCount(frames, sessionId) === 1);
  assert.deepEqual(provider.getStatus(sessionId), { state: "idle", provider: "claude" });
  assert.equal(provider.probe("dur-nope"), false);
  assert.equal(provider.probe("abc"), false);
  provider.forgetSession(sessionId);
  assert.equal(provider.getStatus(sessionId), null);
  assert.equal(provider.probe(sessionId), false);
  await provider.stopAll();
});

test("listSessions rows look like pi rows", async () => {
  const { provider, frames, work, dir } = setup();
  const other = join(dir, "other");
  mkdirSync(other);
  const a = await provider.prompt(undefined, "one", undefined, { name: "alpha" });
  const b = await provider.prompt(undefined, "two", other, { name: "beta" });
  await until(() => idleCount(frames, a.sessionId) === 1 && idleCount(frames, b.sessionId) === 1);
  const rows = provider.listSessions(10);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["cwd", "id", "provider", "status", "timestamp", "title"]);
    assert.equal(r.provider, "claude");
    assert.equal(r.status, null);
    assert.equal(typeof r.timestamp, "number");
  }
  assert.deepEqual(provider.listSessions(10, work).map((r) => r.title), ["alpha"]);
  assert.deepEqual(provider.listSessions(10, other).map((r) => r.id), [b.sessionId]);
  const info = await provider.getInfo();
  assert.deepEqual(info, { account: { loggedIn: true, email: "durable", scope: "local" }, model: "fake-model", version: "pi-durable 1.5.0", provider: "claude" });
  const agents = await provider.listAgents();
  const alpha = agents.find((x) => x.sid === a.sessionId);
  assert.equal(alpha.name, "alpha");
  assert.equal(alpha.state, "idle");
  assert.equal(alpha.model, "fake/fake-model");
  assert.equal(alpha.lastLine, "ok: one");
  assert.equal(alpha.cwd, work);
  await provider.stopAll();
});

test("the guard's bash runs the conversation's tools and blocks escapes", async () => {
  const { provider, frames } = setup();
  const { sessionId } = await provider.prompt(undefined, 'TOOL bash {"command":"cat ~/.ssh/id_ed25519"}', undefined, {});
  await until(() => idleCount(frames, sessionId) === 1);
  const end = frames.find((f) => f.sid === sessionId && f.type === "tool_end");
  assert.equal(end.name, "bash");
  assert.match(end.detail.output, /guard:/);
  const ok = await provider.prompt(sessionId, 'TOOL bash {"command":"echo fine > made.txt && cat made.txt"}', undefined, {});
  await until(() => idleCount(frames, ok.sessionId) === 2);
  const ends = frames.filter((f) => f.sid === sessionId && f.type === "tool_end");
  assert.match(ends[1].detail.output, /fine/);
  assert.ok(existsSync(join(provider._map.get(sessionId).cwd, "made.txt")));
  await provider.stopAll();
});

test("seedTranscript replays finished runs once each; stopSession aborts and archives", async () => {
  const { provider, frames } = setup();
  const { sessionId } = await provider.prompt(undefined, "q1", undefined, {});
  await until(() => idleCount(frames, sessionId) === 1);
  await provider.prompt(sessionId, "q2", undefined, {});
  await until(() => idleCount(frames, sessionId) === 2);
  await until(() => !provider._live.has(sessionId));
  // The even-terminal ring is empty for this sid (the test's emit does not feed it), so the seed emits.
  const mark = frames.length;
  await provider.seedTranscript(sessionId);
  const seeded = frames.slice(mark).filter((f) => f.sid === sessionId);
  assert.deepEqual(seeded.filter((f) => f.type === "user_prompt").map((f) => f.text), ["q1", "q2"]);
  assert.equal(seeded.filter((f) => f.type === "result").length, 2);

  fake.hold();
  const base = fake.calls;
  await provider.prompt(sessionId, "q3", undefined, {});
  await fake.waitForCalls(base + 1);
  await provider.stopSession(sessionId);
  fake.release();
  assert.equal(provider.getStatus(sessionId), null);
  assert.equal(provider.listSessions(10).length, 0);
  const last = frames.filter((f) => f.sid === sessionId && f.type === "result").at(-1);
  assert.equal(last.success, false);
  await provider.stopAll();
});

test("unknown model and disallowed cwd are 400s", async () => {
  const { provider, dir } = setup();
  await assert.rejects(provider.prompt(undefined, "x", undefined, { model: "gpt-9" }), (e) => e.statusCode === 400);
  await assert.rejects(provider.prompt(undefined, "x", "/etc", {}), (e) => e.statusCode === 400);
  await assert.rejects(provider.prompt(undefined, "x", dir, {}), (e) => e.statusCode === 400); // a bare root
  await assert.rejects(provider.prompt("dur-missing", "x", undefined, {}), (e) => e.statusCode === 404);
  assert.equal(provider.listSessions(10).length, 0);
  await provider.stopAll();
});

test("resolveAgentCwd: below a root only, never home, creates missing dirs below a root", () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "dur-cwd-")));
  mkdirSync(join(r, "github", "proj"), { recursive: true });
  const roots = [join(r, "github"), join(r, "sandbox")];
  assert.equal(resolveAgentCwd(join(r, "github", "proj"), { allowedCwds: roots }), join(r, "github", "proj"));
  assert.throws(() => resolveAgentCwd(join(r, "github"), { allowedCwds: roots }), (e) => e.statusCode === 400);
  assert.throws(() => resolveAgentCwd(join(r, "elsewhere"), { allowedCwds: roots }), (e) => e.statusCode === 400);
  assert.throws(() => resolveAgentCwd(join(r, "github", "proj", ".."), { allowedCwds: roots }), (e) => e.statusCode === 400);
  const made = resolveAgentCwd(join(r, "sandbox", "agents", "x"), { allowedCwds: roots });
  assert.ok(existsSync(made));
  assert.throws(() => resolveAgentCwd("~", {}), (e) => e.statusCode === 400);
  assert.throws(() => resolveAgentCwd(homedir(), { allowedCwds: [] }), (e) => e.statusCode === 400);
  assert.throws(() => resolveAgentCwd(join(r, "nope"), {}), (e) => e.statusCode === 400);
  rmSync(r, { recursive: true, force: true });
});

test("a restart resumes the unfinished run once and re-attaches its watcher", async () => {
  // Real SQLite store: the first provider closes mid-turn (no abort), the second reopens it.
  const { dir, work } = setup();
  const storePath = join(dir, "restart.sqlite");
  const opts = { storage: undefined, storePath, allowedCwds: [dir] };
  const one = setup(opts);
  fake.hold();
  const base = fake.calls;
  const a = await one.provider.prompt(undefined, "survive", work, { requestId: "req-r" });
  await fake.waitForCalls(base + 1);
  await one.provider.stopAll(); // bridge shutdown: the run stays pending
  fake.release();

  const two = setup(opts);
  await two.provider.ready;
  assert.equal(two.provider.getStatus(a.sessionId).state, "busy");
  await until(() => idleCount(two.frames, a.sessionId) === 1);
  const mine = two.frames.filter((f) => f.sid === a.sessionId);
  assert.equal(mine.filter((f) => f.type === "result").length, 1);
  assert.equal(mine.find((f) => f.type === "result").success, true);
  // The shim retries the dispatch after the restart: same session, same submission, no second answer.
  const again = await two.provider.prompt(undefined, "survive", work, { requestId: "req-r" });
  assert.equal(again.sessionId, a.sessionId);
  assert.equal(again.submissionId, a.submissionId);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await two.provider.getHistory(a.sessionId, 10), [
    { role: "user", text: "survive" },
    { role: "assistant", text: "ok: survive" },
  ]);
  await two.provider.stopAll();
});

test("concurrent retries of one new-session request share one session and submission", async () => {
  const { provider, frames } = setup();
  const [a, b] = await Promise.all([
    provider.prompt(undefined, "twice?", undefined, { requestId: "req-c" }),
    provider.prompt(undefined, "twice?", undefined, { requestId: "req-c" }),
  ]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(a.submissionId, b.submissionId);
  await until(() => idleCount(frames, a.sessionId) === 1);
  assert.equal(provider.listSessions(10).length, 1);
  await provider.stopAll();
});

test("watchTranscript keeps a watcher for clients; the last unwatch stops it", async () => {
  const { provider, frames } = setup();
  const { sessionId } = await provider.prompt(undefined, "hi", undefined, {});
  await until(() => idleCount(frames, sessionId) === 1);
  await until(() => !provider._live.has(sessionId));
  provider.watchTranscript(sessionId);
  provider.watchTranscript(sessionId);
  await provider._live.get(sessionId).starting;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(provider._live.has(sessionId));
  provider.unwatchTranscript(sessionId);
  assert.ok(provider._live.has(sessionId));
  // A prompt while a client watches streams through the same watcher, without replaying history.
  await provider.prompt(sessionId, "again", undefined, {});
  await until(() => idleCount(frames, sessionId) === 2);
  assert.deepEqual(frames.filter((f) => f.sid === sessionId && f.type === "user_prompt").map((f) => f.text), ["hi", "again"]);
  provider.unwatchTranscript(sessionId);
  assert.equal(provider._live.has(sessionId), false);
  provider.watchTranscript("dur-unknown"); // unknown: ignored
  assert.equal(provider._live.has("dur-unknown"), false);
  await provider.stopAll();
});
