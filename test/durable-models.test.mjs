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
  "Anthropic": { baseUrl: "http://127.0.0.1:8795/v1", api: "openai-completions", apiKey: "x",
  models: [{ id: "claude-haiku", contextWindow: 1000000, maxTokens: 32000 }, { id: "claude-sonnet", contextWindow: 1000000, maxTokens: 32000 }] } } };

function tmpFile(name, obj) { const d = mkdtempSync(join(tmpdir(), "models-")); const p = join(d, name); writeFileSync(p, JSON.stringify(obj)); return p; }
function fixture() { return tmpFile("models.json", FIXTURE); }

test("default ref is the lets-code qwen model", () => {
  const { refs, default: def } = loadPiModels(fixture(), {});
  assert.deepEqual(def, { provider: "lets-code", modelId: "qwen3.8-27b" });
  assert.deepEqual(refs.get("qwen"), def);
  assert.deepEqual(refs.get("default"), def);
  assert.deepEqual(refs.get("qwen3.8-27b"), def);
  assert.deepEqual(refs.get("haiku"), { provider: "Anthropic", modelId: "claude-haiku" });
  assert.deepEqual(refs.get("sonnet"), { provider: "Anthropic", modelId: "claude-sonnet" });
  assert.equal(refs.get("opus"), undefined); // not in the fixture
});

test("model carries compat, context and sampling params", () => {
  const { models } = loadPiModels(fixture(), {});
  const m = models.getModel("lets-code", "qwen3.8-27b");
  assert.equal(m.contextWindow, 262144);
  assert.equal(m.compat.thinkingFormat, "chat-template");
  assert.equal(m.samplingParamsByThinkingLevel.xhigh.max_tokens, 49152);
  assert.equal(m.reasoning, true);
  assert.equal(m.provider, "lets-code");
  assert.equal(m.api, "openai-completions");
  assert.equal(m.baseUrl, "https://inference.i-bora.com/v1");
  const h = models.getModel("Anthropic", "claude-haiku");
  assert.equal(h.name, "claude-haiku");
  assert.deepEqual(h.input, ["text"]);
  assert.equal(h.reasoning, false);
});

test("$VAR api keys resolve from env at request time", async () => {
  const env = {};
  const { models } = loadPiModels(fixture(), env);
  env.LETS_CODE_TOKEN = "tok-1"; // set after load: must still be picked up
  const p = models.getProvider("lets-code");
  const r = await p.auth.apiKey.resolve({});
  assert.equal(r.auth.apiKey, "tok-1");
  const lit = await models.getProvider("Anthropic").auth.apiKey.resolve({});
  assert.equal(lit.auth.apiKey, "x");
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
