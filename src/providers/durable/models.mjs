// Builds pi-ai providers from lets-code's ~/.pi/agent/models.json so the Durable
// harness talks to the same endpoints (private vLLM by default, the local Claude
// proxy only when named) with the same compat/sampling settings lets-code uses.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_THINKING = "medium";
const DEFAULT_REF = { provider: "lets-code", modelId: "qwen3.8-27b" };
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CLAUDE_ALIASES = ["haiku", "sonnet", "opus", "fable"];

const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p);

// "$VAR" keys are read from env on every request (rotation-safe, never cached);
// anything else is a literal key.
function keyResolver(apiKey, env) {
  if (typeof apiKey === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(apiKey)) {
    const name = apiKey.slice(1);
    return () => env[name];
  }
  return () => apiKey;
}

function toModel(providerId, prov, m) {
  const model = {
    ...m,
    id: m.id,
    name: m.name ?? m.id,
    api: m.api ?? prov.api ?? "openai-completions",
    provider: providerId,
    baseUrl: m.baseUrl ?? prov.baseUrl,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: { ...ZERO_COST, ...(m.cost ?? {}) },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
  const compat = m.compat || prov.compat ? { ...(prov.compat ?? {}), ...(m.compat ?? {}) } : undefined;
  if (compat) model.compat = compat;
  else delete model.compat;
  return model;
}

export function loadPiModels(path = "~/.pi/agent/models.json", env = process.env) {
  const file = JSON.parse(readFileSync(expandHome(path), "utf8"));
  const models = createModels();
  const refs = new Map();
  for (const [id, prov] of Object.entries(file.providers ?? {})) {
    const list = (prov.models ?? []).map((m) => toModel(id, prov, m));
    const resolveKey = keyResolver(prov.apiKey, env);
    models.setProvider(createProvider({
      id,
      baseUrl: prov.baseUrl,
      auth: { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: resolveKey() } }) } },
      models: list,
      api: openAICompletionsApi(),
    }));
    // First provider to claim a bare model id wins; lets-code is listed first live.
    for (const m of list) if (!refs.has(m.id)) refs.set(m.id, { provider: id, modelId: m.id });
    if (id === "Anthropic") {
      for (const alias of CLAUDE_ALIASES) {
        const m = list.find((x) => x.id === `claude-${alias}`);
        if (m) refs.set(alias, { provider: id, modelId: m.id });
      }
    }
  }
  const qwen = models.getModel(DEFAULT_REF.provider, DEFAULT_REF.modelId)
    ? { ...DEFAULT_REF }
    : (() => {
        const first = models.getModels("lets-code")[0] ?? models.getModels()[0];
        return first ? { provider: first.provider, modelId: first.id } : undefined;
      })();
  if (qwen) {
    refs.set("qwen", qwen);
    refs.set("default", qwen);
  }
  return { models, refs, default: qwen };
}

// lets-code stores per-model levels under settings.modelThinkingLevels["provider/modelId"].
export function thinkingLevelFor(ref, settingsPath = "~/.pi/agent/settings.json") {
  let settings;
  try {
    settings = JSON.parse(readFileSync(expandHome(settingsPath), "utf8"));
  } catch {
    return DEFAULT_THINKING;
  }
  const level = settings?.modelThinkingLevels?.[`${ref.provider}/${ref.modelId}`];
  return THINKING_LEVELS.includes(level) ? level : DEFAULT_THINKING;
}
