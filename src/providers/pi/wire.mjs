// Convert pi transcript entries (parsed JSONL) into even-terminal wire
// messages. Shared by seedTranscript() (bulk history) and the live transcript
// watcher (terminal → glasses sync).

import { textOf } from "./session-files.mjs";
import { summarizePiToolCall } from "./summarize.mjs";

/**
 * @param {object[]} entries parsed transcript entries (any types).
 * @param {{ pending?: Map }} [state] — persistent toolCall -> {name, args}
 *   bookkeeping. seedTranscript passes a fresh one; the live watcher keeps a
 *   per-session one across ticks (toolResult entries land in later batches
 *   than their toolCall).
 * @returns {object[]} wire messages in transcript order.
 */
export function transcriptEntriesToWire(entries, state = {}) {
  const out = [];
  const pending = state.pending ?? new Map(); // toolCallId -> {name, args}
  state.pending = pending;
  for (const e of entries) {
    if (e?.type !== "message") continue;
    const m = e.message;
    if (!m || !Array.isArray(m.content)) continue;
    if (m.role === "user") {
      const text = textOf(m.content);
      if (text) out.push({ type: "user_prompt", text });
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b?.type === "text" && b.text) {
          out.push({ type: "text_delta", text: b.text });
        } else if (b?.type === "toolCall") {
          pending.set(b.id, { name: b.name, args: b.arguments ?? {} });
          out.push({ type: "tool_start", name: b.name, toolId: b.id });
        }
        // thinking blocks: no wire equivalent; skipped.
      }
    } else if (m.role === "toolResult") {
      const t =
        pending.get(m.toolCallId) ??
        (m.toolName ? { name: m.toolName, args: {} } : null); // cross-batch: use the entry's own toolName
      if (m.toolCallId && t) pending.delete(m.toolCallId);
      if (!t) continue;
      out.push({
        type: "tool_end",
        name: t.name,
        toolId: m.toolCallId,
        summary: summarizePiToolCall(t.name, t.args),
        detail: { input: t.args, output: textOf(m.content) },
      });
    }
  }
  return out;
}
