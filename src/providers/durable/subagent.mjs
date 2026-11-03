// The `subagent` tool: a parent conversation delegates a self-contained task to
// one of the lets-code agents (agent-files.mjs) and gets the child's answer
// back. It follows pi-durable's foreground subagent pattern (README "Abort and
// Subagents", example 21):
//   - the child is created inside `api.commit()` and OWNED by the tool call's
//     task, so aborting the call (or the parent) aborts the child, and the
//     parent is idle only once the child is;
//   - `replay: "safe"`: a rerun after a crash finds the same child through the
//     ownership index and resubmits with the same `requestId`, which Durable
//     dedupes, so the task is never sent twice;
//   - the child starts as a copy of the parent's agent (model, cwd, maxTurns,
//     extensions); it gets lets-code's header plus the agent's prompt as
//     instructions (always set, never the parent's), its tool list (an empty
//     match falls back to `read`), its thinking level, and loses this
//     extension (no grandchildren).
//     The guard extension is NOT removed: children are vetted like parents.
//     The guard finds a child's cwd through `onChild` (the caller records the
//     child → parent edge; see provider.mjs).
//   - the wait is bounded by the agent file's `timeout` (seconds, default
//     `defaultTimeoutS`); on timeout the child is aborted and the model gets a
//     timeout note as an error result;
//   - the answer returned is the LAST 4000 characters of the child's answer.

import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import { THINKING_LEVELS } from "./models.mjs";

export const SUBAGENT_EXTENSION = "even-subagent";
export const SUBAGENT_TOOL = "subagent";
export const OUTPUT_CAP = 4000;
/** The lets-code agents offered when EVEN_BRIDGE_DURABLE_AGENTS is unset. */
export const DEFAULT_ALLOWED_AGENTS = Object.freeze(["scout", "general", "worker", "reviewer", "researcher", "tester"]);

/** `EVEN_BRIDGE_DURABLE_AGENTS` (comma-separated) or the default list. */
export function allowedAgentsFrom(env = process.env) {
  const raw = env.EVEN_BRIDGE_DURABLE_AGENTS;
  if (raw == null || raw.trim() === "") return [...DEFAULT_ALLOWED_AGENTS];
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}

// The same JSON Schema `obj({ agent: str(), task: str() })` from pi-schema
// builds, written out so the bridge needs no direct pi-schema dependency.
const PARAMETERS = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Name of the agent to run" },
    task: { type: "string", description: "The complete, self-contained task for the agent" },
  },
  required: ["agent", "task"],
  additionalProperties: false,
};

const text = (t) => [{ type: "text", text: t }];

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
};

/** The LAST `OUTPUT_CAP` characters (agents end with their summary), with a leading note when cut. */
export const cap = (s) => (s.length > OUTPUT_CAP ? `[… first ${s.length - OUTPUT_CAP} characters truncated]\n${s.slice(-OUTPUT_CAP)}` : s);

/** lets-code's child prompt header (runAgent's prompt.md), then the agent's own prompt. */
export const instructionsFor = (def) => `You are the "${def.name}" agent. ${def.description ?? ""}\n\n${def.prompt ?? def.body ?? ""}`.trim();

function describe(agents) {
  const lines = [...agents.values()].map((a) => `- ${a.name}${a.description ? ` — ${a.description}` : ""}`);
  return [
    "Delegate a self-contained task to a named agent and get its answer back. The agent works in the same directory",
    "with a fresh context: put everything it needs in `task`.",
    "Available agents:",
    ...(lines.length ? lines : ["(none)"]),
  ].join("\n");
}

/**
 * The child's agent change for `def`: instructions, tools, thinking level, and
 * no subagent extension of its own. `offered` are the tools the parent's model
 * is offered (the agent file's tool names are matched against them; names the
 * harness does not have, such as lets-code's grep/find/ls, are dropped).
 */
export function childChange(def, offered, self, log) {
  // Always set: an unset field would inherit the parent's (Even AI) instructions.
  const change = { extensions: { remove: [self] }, instructions: instructionsFor(def) };
  if (def.tools || def.disallowed) {
    const usable = offered.filter((t) => t.name !== SUBAGENT_TOOL);
    let tools = usable;
    if (def.tools) tools = tools.filter((t) => def.tools.includes(t.name));
    if (def.disallowed) tools = tools.filter((t) => !def.disallowed.includes(t.name));
    if (tools.length === 0) {
      tools = usable.filter((t) => t.name === "read");
      log?.warn?.(`[durable] agent ${def.name}: its tool list matches no available tool; falling back to read`);
    }
    change.tools = tools;
  }
  let level = def.thinking;
  if (level === "max") level = "xhigh";
  if (THINKING_LEVELS.includes(level)) change.thinkingLevel = level;
  return change;
}

/**
 * @param {object} o
 * @param {Map<string, object>} o.agents from loadAgentFiles()
 * @param {string[]|null} [o.allowed] agent names offered (null = every loaded agent); others are unknown
 * @param {number} [o.defaultTimeoutS] wait bound when the agent file names none
 * @param {{ warn?: Function }} [o.log]
 * @param {(edge: {childId: unknown, parentId: unknown, agent: string, role?: string}) => void} [o.onChild]
 *   called before the child runs (also on a rerun that reuses it), so the guard can map the child to
 *   its parent's cwd and apply the agent file's `role` (e.g. `readonly`).
 */
export function createSubagentExtension({ agents: loaded = new Map(), allowed = null, defaultTimeoutS = 900, onChild, log } = {}) {
  const agents = allowed ? new Map([...loaded].filter(([name]) => allowed.includes(name))) : loaded;
  let self;
  const subagent = defineTool({
    name: SUBAGENT_TOOL,
    description: describe(agents),
    parameters: PARAMETERS,
    replay: "safe", // a rerun after a crash finds the same child and submission
    async execute(args, api, context) {
      const def = agents.get(args.agent);
      if (!def) {
        const names = [...agents.keys()].join(", ") || "none";
        return { isError: true, output: text(`Unknown agent ${JSON.stringify(args.agent)}. Available agents: ${names}.`) };
      }
      const offered = def.tools || def.disallowed ? (await api.agent(context)).tools : [];
      const change = childChange(def, offered, self, log);
      const childId = await api.commit(async (tx) => {
        // The ownership index remembers the child, so a rerun reuses it.
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        // Starts as a copy of the parent's agent: model, extensions (guard included), cwd, maxTurns.
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, created.id, change);
        return created.id;
      }, context);
      onChild?.({ childId, parentId: api.conversationId, agent: def.name, role: def.role });
      await api.details({ conversationId: childId, agent: def.name }, context); // lets a UI attach to the child
      const child = await api.conversation(childId, context);
      if (!child) return { isError: true, output: text(`The ${def.name} agent's conversation is gone.`) };
      const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` };
      const submission = await child.submit(request, context);
      const timeoutS = def.timeout ?? defaultTimeoutS;
      const timer = AbortSignal.timeout(timeoutS * 1000);
      let settled;
      try {
        settled = await submission.wait(withAbortSignal(timer, context));
      } catch (err) {
        if (!timer.aborted || context.abortSignal?.aborted) throw err;
        await child.abort(context);
        return {
          isError: true,
          output: text(`The ${def.name} agent did not finish within ${timeoutS} s and was stopped. Its work so far may be partial.`),
        };
      }
      if (settled.status !== "done") {
        return { isError: true, output: text(`The ${def.name} agent ended without an answer (${settled.reason ?? settled.status}).`) };
      }
      const answer = await api.commit((tx) => tx.entry(settled.answer), context);
      const out = textOf(answer?.model?.[0]?.content).trim();
      return { output: text(cap(out || `(the ${def.name} agent gave an empty answer)`)) };
    },
  });
  self = defineExtension({ name: SUBAGENT_EXTENSION, tools: [subagent] });
  return self;
}
