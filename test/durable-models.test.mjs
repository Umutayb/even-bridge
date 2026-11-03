import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPiModels, thinkingLevelFor } from "../src/providers/durable/models.mjs";

const FIXTURE = { providers: { "lets-code": { baseUrl: "https://inference.i-bora.com/v1", api: "openai-completions", apiKey: "$LETS_CODE_TOKEN",
  compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } },
  models: [{ id: "qwen3.8-27b", contextWindow: 262144, maxTokens: 32768, reasoning: true, input: ["text"],
             samplingParamsByThinkingLevel: { xhigh: { max_tokens: 49152 } } }] },
  "Anthropic": { baseUrl: "http://127.0.0.1:8795/v1", api: "openai-completions", apiKey: "x", headers: { "X-Prov": "p", "X-Both": "prov" },
  models: [{ id: "claude-haiku", contextWindow: 1000000, maxTokens: 32000, headers: { "X-Both": "model" } },
           { id: "claude-sonnet", contextWindow: 1000000, maxTokens: 32000 },
           { id: "claude-opus", contextWindow: 1000000, maxTokens: 32000 }] } } };

function tmpFile(name, content) {
  const d = mkdtempSync(join(tmpdir(), "models-")); const p = join(d, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content)); return p;
}
function fixture(obj = FIXTURE) { return tmpFile("models.json", obj); }

test("default ref is the lets-code qwen model", () => {
  const { refs, default: def } = loadPiModels(fixture(), {});
  assert.deepEqual(def, { provider: "lets-code", modelId: "qwen3.8-27b" });
  assert.deepEqual(refs.get("qwen"), def);
  assert.deepEqual(refs.get("default"), def);
  assert.deepEqual(refs.get("qwen3.8-27b"), def);
  assert.deepEqual(refs.get("haiku"), { provider: "Anthropic", modelId: "claude-haiku" });
  assert.deepEqual(refs.get("sonnet"), { provider: "Anthropic", modelId: "claude-sonnet" });
  assert.deepEqual(refs.get("opus"), { provider: "Anthropic", modelId: "claude-opus" });
  assert.equal(refs.get("fable"), undefined); // not in the fixture
});

test("model carries compat, context and sampling params", () => {
  const { models } = loadPiModels(fixture(), {});
  const m = models.getModel("lets-code", "qwen3.8-27b");
  assert.equal(m.contextWindow, 262144);
  assert.equal(m.maxTokens, 32768);
  assert.equal(m.compat.thinkingFormat, "chat-template");
  assert.equal(m.samplingParamsByThinkingLevel.xhigh.max_tokens, 49152);
  assert.equal(m.reasoning, true);
  assert.equal(m.provider, "lets-code");
  assert.equal(m.api, "openai-completions");
  assert.equal(m.baseUrl, "https://inference.i-bora.com/v1");
  assert.equal(m.headers, undefined);
  const h = models.getModel("Anthropic", "claude-haiku");
  assert.equal(h.name, "claude-haiku");
  assert.deepEqual(h.input, ["text"]);
  assert.equal(h.reasoning, false);
});

test("provider headers merge with model headers (model wins)", () => {
  const { models } = loadPiModels(fixture(), {});
  assert.deepEqual(models.getModel("Anthropic", "claude-haiku").headers, { "X-Prov": "p", "X-Both": "model" });
  assert.deepEqual(models.getModel("Anthropic", "claude-sonnet").headers, { "X-Prov": "p", "X-Both": "prov" });
});

test("$VAR api keys resolve from env at request time", async () => {
  const env = {};
  const { models } = loadPiModels(fixture(), env);
  env.LETS_CODE_TOKEN = "tok-1"; // set after load: must still be picked up
  const r = await models.getProvider("lets-code").auth.apiKey.resolve({});
  assert.equal(r.auth.apiKey, "tok-1");
  const lit = await models.getProvider("Anthropic").auth.apiKey.resolve({});
  assert.equal(lit.auth.apiKey, "x");
});

test("unset $VAR key resolves to undefined (provider not configured)", async () => {
  const { models } = loadPiModels(fixture(), {});
  assert.equal(await models.getProvider("lets-code").auth.apiKey.resolve({}), undefined);
  const { models: m2 } = loadPiModels(fixture(), { LETS_CODE_TOKEN: "" });
  assert.equal(await m2.getProvider("lets-code").auth.apiKey.resolve({}), undefined);
});

test("a non openai-completions api is rejected at load", () => {
  const bad = structuredClone(FIXTURE);
  bad.providers.Anthropic.models.push({ id: "claude-x", api: "anthropic-messages", contextWindow: 1, maxTokens: 1 });
  assert.throws(() => loadPiModels(fixture(bad), {}), /Anthropic\/claude-x uses api "anthropic-messages"/);
  const badProv = structuredClone(FIXTURE);
  badProv.providers.Anthropic.api = "anthropic-messages";
  assert.throws(() => loadPiModels(fixture(badProv), {}), /only "openai-completions" is supported/);
});

test("unreadable or invalid models.json names the file", () => {
  assert.throws(() => loadPiModels("/nonexistent/models.json", {}),
    (e) => e.message.startsWith("models.json /nonexistent/models.json: ") && e.cause?.code === "ENOENT");
  const p = tmpFile("models.json", "{not json");
  assert.throws(() => loadPiModels(p, {}), (e) => e.message.startsWith(`models.json ${p}: `) && e.cause instanceof SyntaxError);
});

test("a models.json without models has no default and throws", () => {
  assert.throws(() => loadPiModels(fixture({}), {}), /no models defined/);
  assert.throws(() => loadPiModels(fixture({ providers: { "lets-code": { api: "openai-completions", models: [] } } }), {}), /no models defined/);
});

test("thinking level falls back to medium", () => {
  assert.equal(thinkingLevelFor({ provider: "lets-code", modelId: "qwen3.8-27b" }, "/nonexistent.json"), "medium");
});

test("thinking level reads lets-code's modelThinkingLevels", () => {
  const p = tmpFile("settings.json", { modelThinkingLevels: { "Anthropic/claude-sonnet": "low", "lets-code/qwen3.8-27b": "bogus" } });
  assert.equal(thinkingLevelFor({ provider: "Anthropic", modelId: "claude-sonnet" }, p), "low");
  assert.equal(thinkingLevelFor({ provider: "lets-code", modelId: "qwen3.8-27b" }, p), "medium");
  assert.equal(thinkingLevelFor({ provider: "Anthropic", modelId: "claude-haiku" }, p), "medium");
});

test("thinking level max clamps to xhigh", () => {
  const p = tmpFile("settings.json", { modelThinkingLevels: { "Anthropic/claude-opus": "max" } });
  assert.equal(thinkingLevelFor({ provider: "Anthropic", modelId: "claude-opus" }, p), "xhigh");
});
