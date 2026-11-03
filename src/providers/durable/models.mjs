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
const SUPPORTED_API = "openai-completions";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CLAUDE_ALIASES = ["haiku", "sonnet", "opus", "fable"];

export const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p);

// "$VAR" keys are read from env on every request (rotation-safe, never cached);
// anything else is a literal key. Empty/unset yields undefined.
function keyResolver(apiKey, env) {
  if (typeof apiKey === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(apiKey)) {
    const name = apiKey.slice(1);
    return () => env[name] || undefined;
  }
  return () => apiKey || undefined;
}

function toModel(providerId, prov, m) {
  const model = {
    ...m,
    name: m.name ?? m.id,
    api: m.api ?? prov.api ?? SUPPORTED_API,
    provider: providerId,
    baseUrl: m.baseUrl ?? prov.baseUrl,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    cost: { ...ZERO_COST, ...(m.cost ?? {}) },
  };
  // Only the openai-completions stream implementation is wired up below.
  if (model.api !== SUPPORTED_API) {
    throw new Error(`models.json: ${providerId}/${m.id} uses api "${model.api}"; only "${SUPPORTED_API}" is supported`);
  }
  const compat = m.compat || prov.compat ? { ...(prov.compat ?? {}), ...(m.compat ?? {}) } : undefined;
  if (compat) model.compat = compat;
  else delete model.compat;
  if (prov.headers || m.headers) model.headers = { ...(prov.headers ?? {}), ...(m.headers ?? {}) };
  return model;
}

export function loadPiModels(path = "~/.pi/agent/models.json", env = process.env) {
  let file;
  try {
    file = JSON.parse(readFileSync(expandHome(path), "utf8"));
  } catch (e) {
    throw new Error(`models.json ${path}: ${e.message}`, { cause: e });
  }
  const models = createModels();
  const refs = new Map();
  for (const [id, prov] of Object.entries(file?.providers ?? {})) {
    const list = (prov.models ?? []).map((m) => toModel(id, prov, m));
    const resolveKey = keyResolver(prov.apiKey, env);
    models.setProvider(createProvider({
      id,
      baseUrl: prov.baseUrl,
      auth: {
        apiKey: {
          name: id,
          // undefined = provider not configured (pi-ai ApiKeyAuth contract).
          resolve: async () => {
            const apiKey = resolveKey();
            return apiKey ? { auth: { apiKey } } : undefined;
          },
        },
      },
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
  let def;
  if (models.getModel(DEFAULT_REF.provider, DEFAULT_REF.modelId)) def = { ...DEFAULT_REF };
  else {
    const first = models.getModels(DEFAULT_REF.provider)[0] ?? models.getModels()[0];
    if (first) def = { provider: first.provider, modelId: first.id };
  }
  if (!def) throw new Error(`models.json ${path}: no models defined, cannot pick a default`);
  refs.set("qwen", def);
  refs.set("default", def);
  return { models, refs, default: def };
}

// lets-code stores per-model levels under settings.modelThinkingLevels["provider/modelId"].
export function thinkingLevelFor(ref, settingsPath = "~/.pi/agent/settings.json") {
  let settings;
  try {
    settings = JSON.parse(readFileSync(expandHome(settingsPath), "utf8"));
  } catch {
    return DEFAULT_THINKING;
  }
  let level = settings?.modelThinkingLevels?.[`${ref.provider}/${ref.modelId}`];
  if (level === "max") level = "xhigh"; // Anthropic maps offer "max"; our enum tops out at xhigh
  return THINKING_LEVELS.includes(level) ? level : DEFAULT_THINKING;
}
