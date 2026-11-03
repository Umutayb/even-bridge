import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createRegistry, defineExtension, defineTool, LiveDoc } from "@earendil-works/pi-durable";
import { SessionMap } from "../src/providers/durable/sessions.mjs";
import { createDurableProvider } from "../src/providers/durable/provider.mjs";
import { createSubagentExtension, childChange, OUTPUT_CAP, allowedAgentsFrom, cap, instructionsFor } from "../src/providers/durable/subagent.mjs";
import { openDurable } from "../src/providers/durable/harness.mjs";
import { loadPiModels } from "../src/providers/durable/models.mjs";
import { startFakeOpenAI, fakeModelsJson } from "./helpers/fake-openai.mjs";

// A real Harness on memory storage against the local fake OpenAI endpoint. The
// fake answers `TOOL <name> <json>` in the last user message with that tool
// call, anything else with "ok: <last user text>": the parent's prompt calls
// `subagent`, the child's task is its own user message.
let fake;
let root;
before(async () => {
  fake = await startFakeOpenAI();
  root = realpathSync(mkdtempSync(join(tmpdir(), "dur-sub-")));
  writeFileSync(join(root, "models.json"), JSON.stringify(fakeModelsJson(fake.baseUrl)));
});
after(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

const SCOUT_BODY = "You are the scout. Report files and line ranges.";
const AGENTS = new Map([
  ["scout", { name: "scout", description: "Fast read-only recon", tools: ["read", "grep", "find", "ls", "bash"], role: "readonly", body: SCOUT_BODY, extra: {} }],
  ["general", { name: "general", description: "Runs multi-step tasks", body: "Do the task.", extra: {} }],
  ["slow", { name: "slow", description: "Never finishes in time", timeout: 0.3, body: "Take your time.", extra: {} }],
  ["auditor", { name: "auditor", description: "Read-only, every tool offered", role: "readonly", body: "Audit only.", extra: {} }],
]);

let n = 0;
function setup(extra = {}) {
  const dir = join(root, `case-${++n}`);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const frames = [];
  const provider = createDurableProvider((sid, frame) => frames.push({ sid, ...frame }), {
    hub: { clientCount: () => 0 },
    storePath: join(dir, "durable.sqlite"),
    storage: new MemoryStorage(),
    modelsPath: join(root, "models.json"),
    settingsPath: join(dir, "no-settings.json"),
    defaultCwd: work,
    allowedCwds: [dir],
    guard: { wrapper: "none", log: () => {} },
    log: { warn() {}, error() {}, log() {} },
    agents: AGENTS,
    allowedAgents: ["scout", "general", "slow", "auditor"],
    ...extra,
  });
  return { provider, frames, work };
}

const until = async (cond, ms = 8000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const idle = (frames, sid) => frames.some((f) => f.sid === sid && f.type === "status" && f.state === "idle");
const contentText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join("\n") : "");
/** Tool-result texts of requests made since `from`. */
const toolResults = (from) =>
  fake.requests
    .slice(from)
    .flatMap((r) => (r.messages ?? []).filter((m) => m.role === "tool").map((m) => contentText(m.content)));
const subagentCall = (agent, task) => `TOOL subagent ${JSON.stringify({ agent, task })}`;

test("subagent runs a child in the parent's cwd, behind the guard, and returns its answer", async () => {
  const { provider, frames, work } = setup();
  const from = fake.requests.length;
  // scout is read-only (role: readonly): a read-only command in the workspace.
  const task = 'TOOL bash {"command":"pwd"}';
  const { sessionId } = await provider.prompt(undefined, subagentCall("scout", task), undefined, {});
  await until(() => idle(frames, sessionId));

  // The child's bash ran in the parent's directory: the guard resolved the child's cwd.
  assert.ok(toolResults(from).some((t) => t.trim() === work), JSON.stringify(toolResults(from)));
  // The parent got the child's last answer as the tool result.
  assert.ok(toolResults(from).includes(`ok: ${task}`), JSON.stringify(toolResults(from)));

  // The child's requests: the agent body as instructions, only the agent's known tools, no subagent tool.
  const childReqs = fake.requests.slice(from).filter((r) => JSON.stringify(r.messages).includes(SCOUT_BODY));
  assert.equal(childReqs.length, 2, "tool round + answer");
  assert.deepEqual(childReqs[0].tools.map((t) => t.function.name).sort(), ["bash", "read"]);
  const parentReq = fake.requests.slice(from).find((r) => !JSON.stringify(r.messages).includes(SCOUT_BODY));
  assert.ok(parentReq.tools.some((t) => t.function.name === "subagent"));
  assert.match(parentReq.tools.find((t) => t.function.name === "subagent").function.description, /- scout — Fast read-only recon/);

  // The child is owned by the parent's tool task, mapped to the parent, keeps the guard and drops the subagent extension.
  const parentConv = provider._map.get(sessionId).conversation_id;
  const children = [...provider._childParents].filter(([, p]) => p === parentConv).map(([c]) => c);
  assert.equal(children.length, 1);
  const { ctx } = await provider.ready;
  const child = await provider._harness.conversation(children[0], ctx);
  const agent = await child.agent(ctx);
  assert.equal(agent.cwd, work);
  assert.ok(agent.extensions.some((e) => e.name === "even-guard"));
  assert.ok(!agent.extensions.some((e) => e.name === "even-subagent"));
  assert.equal(agent.instructions, `You are the "scout" agent. Fast read-only recon\n\n${SCOUT_BODY}`);
  await provider.stopAll();
});

test("a child's command is vetted by the guard like its parent's", async () => {
  const { provider, frames } = setup();
  const from = fake.requests.length;
  const task = 'TOOL bash {"command":"cat ~/.ssh/id_ed25519"}';
  const { sessionId } = await provider.prompt(undefined, subagentCall("general", task), undefined, {});
  await until(() => idle(frames, sessionId));
  const results = toolResults(from);
  assert.ok(results.some((t) => /blocked|denied|refus|not allowed/i.test(t)), JSON.stringify(results));
  assert.ok(!results.some((t) => t.includes("PRIVATE KEY")));
  await provider.stopAll();
});

test("an unknown agent is an error result naming the available agents", async () => {
  const { provider, frames } = setup();
  const from = fake.requests.length;
  const { sessionId } = await provider.prompt(undefined, subagentCall("nobody", "x"), undefined, {});
  await until(() => idle(frames, sessionId));
  assert.ok(toolResults(from).some((t) => /Unknown agent "nobody".*scout, general, slow, auditor/.test(t)));
  await provider.stopAll();
});

test("a child that exceeds its timeout is aborted and returns a timeout note", async () => {
  const { provider, frames } = setup();
  const base = fake.calls;
  const from = fake.requests.length;
  const { sessionId } = await provider.prompt(undefined, subagentCall("slow", "think for a long while"), undefined, {});
  await fake.waitForCalls(base + 1); // the parent's request is through (hold applies to later ones)
  fake.hold();
  await fake.waitForCalls(base + 2); // the child's request is now held
  const parentConv = provider._map.get(sessionId).conversation_id;
  const childId = [...provider._childParents].find(([, p]) => p === parentConv)?.[0];
  assert.notEqual(childId, undefined);
  // The child is aborted at 0.3 s; let the parent's follow-up request through afterwards.
  await new Promise((r) => setTimeout(r, 800));
  fake.release();
  await until(() => idle(frames, sessionId));
  assert.ok(toolResults(from).some((t) => /did not finish within 0\.3 s and was stopped/.test(t)), JSON.stringify(toolResults(from)));
  const { ctx } = await provider.ready;
  const child = await provider._harness.conversation(childId, ctx);
  await child.waitForIdle(ctx);
  const page = await child.entries({}, 50, undefined, ctx);
  assert.ok(!page.items.some((e) => e.kind === "pi.assistant" && contentText(e.model?.[0]?.content).includes("ok:")), "the child never answered");
  // Actually aborted: the child's run failed with "aborted" and its input is unanswered.
  await assertAborted(provider, childId);
  await provider.stopAll();
});

/** The child's last run failed as aborted and its input submission ended unanswered. */
async function assertAborted(provider, childId) {
  const { ctx } = await provider.ready;
  const lv = await provider._harness.snapshot(LiveDoc, childId, ctx);
  assert.equal(lv?.run, undefined, "no run left");
  assert.equal(lv?.runFailure?.reason, "aborted", JSON.stringify(lv));
  const sub = await provider._harness.submission(lv.runFailure.inputs.at(-1), ctx);
  assert.equal((await sub.status(ctx)).status, "unanswered");
}

test("a second call in the same task reuses the child and its submission", async () => {
  // A wrapper tool runs the subagent tool's execute twice with ITS api (same task id),
  // as a replay after a crash would.
  const sub = createSubagentExtension({ agents: AGENTS });
  const subagentTool = sub.tools[0];
  let seen;
  const twice = defineExtension({
    name: "twice",
    tools: [
      defineTool({
        name: "twice",
        description: "run subagent twice in one task",
        parameters: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } }, required: ["agent", "task"] },
        replay: "safe",
        async execute(args, api, context) {
          const a = await subagentTool.execute(args, api, context);
          const b = await subagentTool.execute(args, api, context);
          const owned = await api.commit((tx) => tx.scanConversations({ ownerTaskId: api.taskId }, 10), context);
          seen = { a, b, children: owned.items.map((c) => c.id) };
          return { output: b.output };
        },
      }),
    ],
  });
  const registry = createRegistry();
  registry.install(sub);
  registry.install(twice);
  const { models } = loadPiModels(join(root, "models.json"), {});
  const d = await openDurable({ storage: new MemoryStorage(), models, registry });
  try {
    const conv = await d.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "fake", modelId: "fake-model" }, thinkingLevel: "off", extensions: [sub, twice] } },
      d.ctx,
    );
    const before = fake.requests.length;
    const s = await conv.submit({ type: "input", content: 'TOOL twice {"agent":"general","task":"count to three"}', requestId: "r1" }, d.ctx);
    assert.equal((await s.wait(d.ctx)).status, "done");
    assert.equal(seen.children.length, 1, "one child");
    assert.deepEqual(seen.a.output, [{ type: "text", text: "ok: count to three" }]);
    assert.deepEqual(seen.b.output, seen.a.output);
    const childAsks = fake.requests.slice(before).filter((r) => contentText(r.messages.at(-1)?.content) === "count to three");
    assert.equal(childAsks.length, 1, "the task was sent to the model once");
  } finally {
    await d.close();
  }
});

test("childChange maps the agent file onto the child's agent", () => {
  const self = { name: "even-subagent" };
  const offered = [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "subagent" }];
  const H = (name, desc, prompt) => `You are the "${name}" agent. ${desc}\n\n${prompt}`;
  assert.deepEqual(childChange({ name: "a", description: "D", body: "B", prompt: "B", tools: ["read", "grep", "bash"], thinking: "max" }, offered, self), {
    extensions: { remove: [self] },
    instructions: H("a", "D", "B"),
    tools: [{ name: "read" }, { name: "bash" }],
    thinkingLevel: "xhigh",
  });
  // `prompt` (body + append_prompt) wins over the bare body; instructions are always set.
  assert.deepEqual(childChange({ name: "b", description: "D", body: "", prompt: "from file", disallowed: ["write"], thinking: "bogus" }, offered, self), {
    extensions: { remove: [self] },
    instructions: H("b", "D", "from file"),
    tools: [{ name: "read" }, { name: "edit" }, { name: "bash" }],
  });
  assert.deepEqual(childChange({ name: "c", description: "D", body: "x" }, [], self), { extensions: { remove: [self] }, instructions: H("c", "D", "x") });
  // A tool list that matches nothing falls back to read, with a warning.
  const warned = [];
  assert.deepEqual(childChange({ name: "d", description: "D", body: "x", tools: ["grep", "ls"] }, offered, self, { warn: (l) => warned.push(l) }).tools, [{ name: "read" }]);
  assert.match(warned.join("\n"), /agent d: .*falling back to read/);
  assert.equal(instructionsFor({ name: "e", description: "", prompt: "p" }), 'You are the "e" agent. \n\np'.trim());
  assert.equal(OUTPUT_CAP, 4000);
});

test("after a reopen the child -> parent edges come back from the session map", async () => {
  // Real SQLite store, closed and reopened by a second provider.
  const dir = join(root, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const opts = { storage: undefined, storePath: join(dir, "reopen.sqlite"), allowedCwds: [root] };
  const { provider, frames } = setup(opts);
  const { sessionId } = await provider.prompt(undefined, subagentCall("general", "hello child"), undefined, {});
  await until(() => idle(frames, sessionId));
  const edges = [...provider._childParents];
  assert.equal(edges.length, 1);
  await provider.stopAll();
  const again = setup(opts).provider;
  await again.ready;
  assert.deepEqual([...again._childParents], edges);
  await again.stopAll();
  // A parent last seen outside the resume window: its children are not loaded.
  const m = new SessionMap(opts.storePath);
  m.db.prepare("UPDATE sessions SET last_seen = 0").run();
  m.close();
  const stale = setup(opts).provider;
  await stale.ready;
  assert.equal(stale._childParents.size, 0);
  await stale.stopAll();
});

test("the in-memory child edges are bounded, oldest dropped first", async () => {
  const { provider } = setup({ maxChildEdges: 2 });
  provider._noteEdge(1, 10);
  provider._noteEdge(2, 10);
  provider._noteEdge(3, 10, "readonly");
  assert.deepEqual([...provider._childParents.keys()], [2, 3]);
  provider._noteEdge(2, 10); // touched: now the newest
  provider._noteEdge(4, 10);
  assert.deepEqual([...provider._childParents.keys()], [2, 4]);
  assert.equal(provider._childRoles.has(3), false);
  await provider.stopAll();
});

test("a long child answer keeps its LAST 4000 characters", async () => {
  const { provider, frames } = setup();
  const from = fake.requests.length;
  const task = `HEAD-${"x".repeat(5000)}-TAIL-END`;
  const { sessionId } = await provider.prompt(undefined, subagentCall("general", task), undefined, {});
  await until(() => idle(frames, sessionId));
  const answer = `ok: ${task}`;
  const result = toolResults(from).find((t) => t.includes("TAIL-END"));
  assert.ok(result, JSON.stringify(toolResults(from)).slice(0, 300));
  assert.equal(result, `[… first ${answer.length - OUTPUT_CAP} characters truncated]\n${answer.slice(-OUTPUT_CAP)}`);
  assert.ok(!result.includes("HEAD-"));
  assert.equal(cap("short"), "short");
  await provider.stopAll();
});

test("aborting the parent while the child runs aborts the child (no tool answer is made up)", async () => {
  const { provider, frames } = setup();
  const base = fake.calls;
  const { sessionId } = await provider.prompt(undefined, subagentCall("general", "work slowly"), undefined, {});
  await fake.waitForCalls(base + 1);
  fake.hold();
  await fake.waitForCalls(base + 2); // the child's request is held
  const parentConv = provider._map.get(sessionId).conversation_id;
  const childId = [...provider._childParents].find(([, p]) => p === parentConv)?.[0];
  assert.notEqual(childId, undefined);
  provider.interrupt(sessionId);
  await until(() => idle(frames, sessionId));
  fake.release();
  await assertAborted(provider, childId);
  const { ctx } = await provider.ready;
  const lv = await provider._harness.snapshot(LiveDoc, parentConv, ctx);
  assert.equal(lv?.runFailure?.reason, "aborted");
  const parent = await provider._harness.conversation(parentConv, ctx);
  const entries = JSON.stringify((await parent.entries({}, 50, undefined, ctx)).items);
  assert.doesNotMatch(entries, /did not finish within|ended without an answer|ok: work slowly/);
  assert.equal(fake.calls, base + 2, "nothing asked the model after the abort");
  await provider.stopAll();
});

test("a child whose run fails returns an 'ended without an answer' error result", async () => {
  // maxTurns 1 (inherited by the child): the child's tool round reaches the limit, its run ends unanswered.
  const { provider, frames } = setup();
  const { sessionId } = await provider.prompt(undefined, subagentCall("general", 'TOOL bash {"command":"echo hi"}'), undefined, { maxTurns: 1 });
  await until(() => idle(frames, sessionId));
  const { ctx } = await provider.ready;
  const parent = await provider._harness.conversation(provider._map.get(sessionId).conversation_id, ctx);
  const entries = JSON.stringify((await parent.entries({}, 50, undefined, ctx)).items);
  assert.match(entries, /The general agent ended without an answer \(turn_limit\)/);
  await provider.stopAll();
});

// ───────────────────────────── fix round 2

test("a read-only child may read and list but not write, edit or redirect", async () => {
  const { provider, frames, work } = setup();
  writeFileSync(join(work, "a.txt"), "content of a\n");
  const results = [];
  for (const task of [
    'TOOL read {"path":"a.txt"}',
    'TOOL write {"path":"b.txt","content":"x"}',
    'TOOL bash {"command":"echo x > f"}',
    'TOOL bash {"command":"ls"}',
  ]) {
    const from = fake.requests.length;
    const { sessionId } = await provider.prompt(undefined, subagentCall("auditor", task), undefined, {});
    await until(() => idle(frames, sessionId));
    results.push(toolResults(from).join("\n"));
  }
  const [read, write, redirect, ls] = results;
  assert.match(read, /content of a/);
  assert.match(write, /read-only agent: write is refused/);
  assert.match(redirect, /read-only agent: writing 'f' is refused/);
  assert.match(ls, /a\.txt/);
  assert.equal(existsSync(join(work, "b.txt")), false);
  assert.equal(existsSync(join(work, "f")), false);
  // The role is recorded per child (and persisted).
  assert.ok([...provider._childRoles.values()].every((r) => r === "readonly"));
  assert.ok(provider._map.children().every((c) => c.role === "readonly"));
  await provider.stopAll();
});

test("a non-readonly child may still write", async () => {
  const { provider, frames, work } = setup();
  const { sessionId } = await provider.prompt(undefined, subagentCall("general", 'TOOL bash {"command":"echo hi > note.txt"}'), undefined, {});
  await until(() => idle(frames, sessionId));
  assert.equal(readFileSync(join(work, "note.txt"), "utf8"), "hi\n");
  await provider.stopAll();
});

test("a restart with a child mid-run: the child's resumed tool call resolves its cwd (edges loaded before resume)", async () => {
  const dir = join(root, `case-${++n}`);
  mkdirSync(join(dir, "work"), { recursive: true });
  const work = join(dir, "work");
  const opts = { storage: undefined, storePath: join(dir, "child.sqlite"), allowedCwds: [dir], defaultCwd: work };
  const one = setup(opts);
  const base = fake.calls;
  const from = fake.requests.length;
  const { sessionId } = await one.provider.prompt(undefined, subagentCall("general", 'TOOL bash {"command":"pwd"}'), undefined, {});
  await fake.waitForCalls(base + 1); // the parent's subagent call went through
  fake.hold();
  await fake.waitForCalls(base + 2); // the child's first request is held
  await one.provider.stopAll(); // shutdown mid-child: everything stays pending
  fake.release();
  const two = setup(opts);
  await two.provider.ready;
  assert.equal(two.provider._childParents.size, 1);
  await until(() => idle(two.frames, sessionId));
  const results = toolResults(from);
  assert.ok(results.some((t) => t.trim() === work), JSON.stringify(results));
  assert.ok(!results.some((t) => /no workspace is known/.test(t)), JSON.stringify(results));
  await two.provider.stopAll();
});

test("the subagent tool offers only EVEN_BRIDGE_DURABLE_AGENTS; others are unknown", async () => {
  assert.deepEqual(allowedAgentsFrom({}), ["scout", "general", "worker", "reviewer", "researcher", "tester"]);
  assert.deepEqual(allowedAgentsFrom({ EVEN_BRIDGE_DURABLE_AGENTS: " general , scout,," }), ["general", "scout"]);
  const { provider, frames } = setup({ allowedAgents: undefined, env: { ...process.env, EVEN_BRIDGE_DURABLE_AGENTS: "general" } });
  const from = fake.requests.length;
  const { sessionId } = await provider.prompt(undefined, subagentCall("scout", "look around"), undefined, {});
  await until(() => idle(frames, sessionId));
  const desc = fake.requests.slice(from)[0].tools.find((t) => t.function.name === "subagent").function.description;
  assert.match(desc, /- general — /);
  assert.doesNotMatch(desc, /scout|slow|auditor/);
  assert.ok(toolResults(from).some((t) => /Unknown agent "scout"\. Available agents: general\./.test(t)), JSON.stringify(toolResults(from)));
  await provider.stopAll();
});
