import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionMap, sessionMapPath } from "../src/providers/durable/sessions.mjs";

function freshMap(now) {
  const dir = mkdtempSync(join(tmpdir(), "dur-sessions-"));
  const storePath = join(dir, "durable.sqlite");
  return { map: new SessionMap(storePath, { now }), storePath };
}

function clock(start = 1_000) {
  let t = start;
  return () => t++;
}

const QWEN = { provider: "lets-code", modelId: "qwen3.8-27b" };

test("session map lives in its own file next to the Durable store", () => {
  const { map, storePath } = freshMap();
  assert.equal(sessionMapPath(storePath), storePath + ".sessions.sqlite");
  assert.ok(existsSync(storePath + ".sessions.sqlite"));
  assert.ok(!existsSync(storePath), "Durable's own store is never created by the session map");
  map.close();
});

test("create then get round-trips the row", () => {
  const { map } = freshMap(clock(5000));
  const sid = map.create({ name: "fix-tests", cwd: "/home/ay/github/x", modelRef: QWEN, origin: "evenai", conversationId: 7 });
  assert.match(sid, /^dur-[0-9a-f-]{36}$/);
  const row = map.get(sid);
  assert.deepEqual(row, {
    sid, conversation_id: 7, name: "fix-tests", cwd: "/home/ay/github/x",
    model_provider: "lets-code", model_id: "qwen3.8-27b",
    created_at: 5000, last_seen: 5000, origin: "evenai", archived: 0,
  });
  assert.equal(map.get("dur-missing"), undefined);
  map.close();
});

test("byConversation finds the row once the conversation id is set", () => {
  const { map } = freshMap(clock());
  const sid = map.create({ name: "a", cwd: "/w", modelRef: QWEN, origin: "phone" });
  assert.equal(map.get(sid).conversation_id, null);
  assert.equal(map.byConversation(42), undefined);
  map.setConversation(sid, 42);
  assert.equal(map.byConversation(42).sid, sid);
  map.close();
});

test("list is newest first and filters by cwd", () => {
  const { map } = freshMap(clock());
  const a = map.create({ name: "a", cwd: "/w1", modelRef: QWEN, origin: "evenai" });
  const b = map.create({ name: "b", cwd: "/w2", modelRef: QWEN, origin: "evenai" });
  const c = map.create({ name: "c", cwd: "/w1", modelRef: QWEN, origin: "phone" });
  assert.deepEqual(map.list().map((r) => r.sid), [c, b, a]);
  assert.deepEqual(map.list({ cwd: "/w1" }).map((r) => r.sid), [c, a]);
  assert.deepEqual(map.list({ limit: 2 }).map((r) => r.sid), [c, b]);
  map.close();
});

test("touch bumps last_seen and archive hides from list", () => {
  const { map } = freshMap(clock(100));
  const a = map.create({ name: "a", cwd: "/w", modelRef: QWEN, origin: "evenai" });
  const b = map.create({ name: "b", cwd: "/w", modelRef: QWEN, origin: "evenai" });
  map.touch(a);
  assert.ok(map.get(a).last_seen > map.get(a).created_at);
  map.archive(b);
  assert.deepEqual(map.list().map((r) => r.sid), [a]);
  assert.equal(map.get(b).archived, 1, "archived rows stay readable by sid");
  map.close();
});

test("rows survive reopening the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dur-sessions-"));
  const storePath = join(dir, "durable.sqlite");
  const m1 = new SessionMap(storePath);
  const sid = m1.create({ name: "keep", cwd: "/w", modelRef: QWEN, origin: "evenai", conversationId: 3 });
  m1.close();
  const m2 = new SessionMap(storePath);
  assert.equal(m2.get(sid).name, "keep");
  assert.equal(m2.byConversation(3).sid, sid);
  m2.close();
});

test("origin must be evenai or phone", () => {
  const { map } = freshMap();
  assert.throws(() => map.create({ name: "x", cwd: "/w", modelRef: QWEN, origin: "web" }), /origin/);
  map.close();
});

// Harness bootstrap smoke: opens Durable on memory storage with the Task 1
// models loader and the coding tools, resumes and closes. No model request.
test("openDurable opens, resumes and closes a harness", async () => {
  const { writeFileSync } = await import("node:fs");
  const { MemoryStorage } = await import("@earendil-works/pi-durable/storage/memory");
  const { createRegistry } = await import("@earendil-works/pi-durable");
  const { CodingTools } = await import("@earendil-works/pi-durable/tools");
  const { loadPiModels } = await import("../src/providers/durable/models.mjs");
  const { openDurable } = await import("../src/providers/durable/harness.mjs");
  const dir = mkdtempSync(join(tmpdir(), "dur-harness-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { "lets-code": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "x",
    models: [{ id: "qwen3.8-27b", contextWindow: 262144, maxTokens: 32768, reasoning: true }] } } }));
  const { models } = loadPiModels(modelsPath, {});
  const registry = createRegistry();
  registry.install(CodingTools);
  const d = await openDurable({ storage: new MemoryStorage(), models, registry, envFor: () => undefined });
  assert.ok(d.harness && d.ctx);
  assert.equal(process.env.PI_TELEMETRY, "0");
  const root = await d.harness.root(d.ctx);
  assert.ok(root, "a conversation can be created");
  await d.close();
  await d.close(); // idempotent
  assert.throws(() => d.harness.resume(), "a closed harness refuses to schedule");
});

test("openDurable on a SQLite file keeps the session map in a separate file", async () => {
  const { createRegistry } = await import("@earendil-works/pi-durable");
  const { createModels } = await import("@earendil-works/pi-ai");
  const { openDurable } = await import("../src/providers/durable/harness.mjs");
  const dir = mkdtempSync(join(tmpdir(), "dur-harness-"));
  const storePath = join(dir, "durable.sqlite");
  const d1 = await openDurable({ storePath, models: createModels(), registry: createRegistry() });
  const map = new SessionMap(storePath);
  const conv = await d1.harness.createConversation({ ownership: { kind: "ownerless" } }, d1.ctx);
  const sid = map.create({ name: "n", cwd: dir, modelRef: QWEN, origin: "evenai", conversationId: conv.id });
  await d1.close();
  const d2 = await openDurable({ storePath, models: createModels(), registry: createRegistry() });
  assert.ok(await d2.harness.conversation(map.get(sid).conversation_id, d2.ctx), "conversation survives reopen");
  await d2.close();
  map.close();
  assert.ok(existsSync(storePath) && existsSync(storePath + ".sessions.sqlite"));
});
