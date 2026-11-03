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
//     extensions); it gets the agent file's body as instructions, its tool
//     list, its thinking level, and loses this extension (no grandchildren).
//     The guard extension is NOT removed: children are vetted like parents.
//     The guard finds a child's cwd through `onChild` (the caller records the
//     child → parent edge; see provider.mjs).
//   - the wait is bounded by the agent file's `timeout` (seconds, default
//     `defaultTimeoutS`); on timeout the child is aborted and the model gets a
//     timeout note as an error result.

import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import { THINKING_LEVELS } from "./models.mjs";

export const SUBAGENT_EXTENSION = "even-subagent";
export const SUBAGENT_TOOL = "subagent";
export const OUTPUT_CAP = 4000;

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

const cap = (s) => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n[… output truncated at ${OUTPUT_CAP} characters]` : s);

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
export function childChange(def, offered, self) {
  const change = { extensions: { remove: [self] } };
  if (def.body) change.instructions = def.body;
  if (def.tools || def.disallowed) {
    let tools = offered.filter((t) => t.name !== SUBAGENT_TOOL);
    if (def.tools) tools = tools.filter((t) => def.tools.includes(t.name));
    if (def.disallowed) tools = tools.filter((t) => !def.disallowed.includes(t.name));
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
 * @param {number} [o.defaultTimeoutS] wait bound when the agent file names none
 * @param {(edge: {childId: unknown, parentId: unknown}) => void} [o.onChild] called before the child runs
 *   (also on a rerun that reuses it), so the guard can map the child to its parent's cwd.
 */
export function createSubagentExtension({ agents = new Map(), defaultTimeoutS = 900, onChild } = {}) {
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
      const change = childChange(def, offered, self);
      const childId = await api.commit(async (tx) => {
        // The ownership index remembers the child, so a rerun reuses it.
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        // Starts as a copy of the parent's agent: model, extensions (guard included), cwd, maxTurns.
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, created.id, change);
        return created.id;
      }, context);
      onChild?.({ childId, parentId: api.conversationId });
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
