// Translates successive pi-durable `ConversationView` values (from
// `conversation.watch()`) into the bridge's wire frames — the same shapes
// `src/providers/pi/session.mjs` emits, so the hub, SSE and the phone's
// Terminal feature need no change. Durable has no typed events: everything is
// derived by diffing views, and a watch may fold several commits into one
// value, so every step is idempotent and tolerates skipped intermediate states.
//
// Per run: user_prompt (one per pi.user entry) → status busy → [think_start …
// think_end] → text_start → text_delta… → text_end → tool_start/tool_end … →
// running_stats → [error] → result → status idle.

const SUMMARY_CHARS = 120;

const textOfContent = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
};

const messageOf = (entry) => entry?.model?.[0];

function usageTotals(usageDoc) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of Object.values(usageDoc?.models ?? {})) {
    inputTokens += u?.input ?? 0;
    outputTokens += u?.output ?? 0;
  }
  return { inputTokens, outputTokens };
}

export class ViewTranslator {
  /**
   * @param {string} sid bridge session id put on status/result frames.
   * @param {(frame: object) => void} emit
   * @param {{ now?: () => number, prime?: boolean }} [opts]
   *   prime (default true): the first view is history — its entries are marked
   *   seen and not replayed (an in-flight run is still reported as busy and its
   *   partial streamed). prime:false treats the first view's entries as new.
   */
  constructor(sid, emit, { now = Date.now, prime = true } = {}) {
    this.sid = sid;
    this.emit = emit;
    this.now = now;
    this.primed = !prime;
    this.lastEntryId = -Infinity; // entry ids ascend; anything above is new
    this.busy = false;
    this.runStartMs = 0;
    this.turns = 0;
    this.lastFailureKey = undefined;
    this.toolArgs = new Map(); // callId → arguments, from assistant toolCall blocks
    this.tools = new Map(); // callId → { name, started, ended }
    this.resetMessage();
  }

  resetMessage() {
    this.msgAttempt = undefined; // generation.attempt the tracked partial belongs to
    this.blockText = []; // per content index: text already emitted (text blocks)
    this.textOpen = false;
    this.thinkOpen = false;
  }

  status(state) {
    this.emit({ type: "status", state, sessionId: this.sid });
  }

  ensureBusy() {
    if (this.busy) return;
    this.busy = true;
    this.runStartMs = this.now();
    this.turns = 0;
    this.status("busy");
  }

  closeBlocks() {
    if (this.thinkOpen) {
      this.thinkOpen = false;
      this.status("think_end");
    }
    if (this.textOpen) {
      this.textOpen = false;
      this.status("text_end");
    }
  }

  /** Emit what `content` (an assistant message's blocks) adds over what was already sent. */
  streamContent(content) {
    if (!Array.isArray(content)) return;
    content.forEach((block, i) => {
      if (!block) return;
      if (block.type === "thinking") {
        if (!this.thinkOpen && !this.textOpen && this.blockText[i] === undefined) {
          this.thinkOpen = true;
          this.status("think_start");
        }
        this.blockText[i] ??= "";
      } else if (block.type === "text") {
        const text = block.text ?? "";
        const sent = this.blockText[i] ?? "";
        if (!text.startsWith(sent) || text.length === sent.length) return;
        if (this.thinkOpen) {
          this.thinkOpen = false;
          this.status("think_end");
        }
        if (!this.textOpen) {
          this.textOpen = true;
          this.status("text_start");
        }
        this.emit({ type: "text_delta", text: text.slice(sent.length) });
        this.blockText[i] = text;
      } else if (block.type === "toolCall" && block.id) {
        this.toolArgs.set(block.id, block.arguments ?? {});
      }
    });
  }

  toolStart(callId, name) {
    let t = this.tools.get(callId);
    if (!t) this.tools.set(callId, (t = { name, started: false, ended: false }));
    if (name && !t.name) t.name = name;
    if (t.started) return;
    t.started = true;
    this.emit({ type: "tool_start", name: t.name, toolId: callId });
  }

  toolEnd(callId, name, output) {
    this.toolStart(callId, name);
    const t = this.tools.get(callId);
    if (t.ended) return;
    t.ended = true;
    const out = output ?? "";
    this.emit({
      type: "tool_end",
      name: t.name,
      toolId: callId,
      summary: out.slice(0, SUMMARY_CHARS),
      detail: { input: this.toolArgs.get(callId) ?? {}, output: out },
    });
  }

  onEntry(entry, resultsByCall) {
    const msg = messageOf(entry);
    switch (entry.kind) {
      case "pi.user": {
        const text = textOfContent(msg?.content);
        this.emit({ type: "user_prompt", text });
        this.ensureBusy();
        break;
      }
      case "pi.assistant": {
        this.ensureBusy();
        // The committed answer: flush what the throttled partial had not shown yet.
        this.streamContent(msg?.content);
        this.closeBlocks();
        this.resetMessage();
        this.turns += 1;
        break;
      }
      case "pi.tool-result": {
        if (!msg?.toolCallId) break;
        this.ensureBusy();
        this.toolEnd(msg.toolCallId, msg.toolName, resultsByCall.get(msg.toolCallId));
        break;
      }
    }
  }

  onLive(live, resultsByCall) {
    const gen = live.generation;
    if (gen && gen.attempt !== this.msgAttempt) {
      // A new generation attempt (retry) or round: the old partial is abandoned.
      if (this.msgAttempt !== undefined) {
        this.closeBlocks();
        this.resetMessage();
      }
      this.msgAttempt = gen.attempt;
    }
    if (gen?.message) {
      this.ensureBusy();
      this.streamContent(gen.message.content);
    }
    for (const slot of live.tools ?? []) {
      if (!slot?.callId) continue;
      if (slot.status === "running") this.toolStart(slot.callId, slot.name);
      else if (slot.status === "done") this.toolEnd(slot.callId, slot.name, resultsByCall.get(slot.callId) ?? slot.output);
    }
  }

  endRun(view, live) {
    this.closeBlocks();
    this.resetMessage();
    for (const [callId, t] of this.tools) if (t.started && !t.ended) this.toolEnd(callId, t.name, "");
    this.tools.clear();
    this.toolArgs.clear();
    const durationMs = this.now() - this.runStartMs;
    const { inputTokens, outputTokens } = usageTotals(view.docs?.["pi.usage"]);
    this.emit({ type: "running_stats", durationMs, inputTokens, outputTokens });
    const failure = live.runFailure;
    const failureKey = failure ? `${failure.taskId}:${failure.reason}:${failure.detail ?? ""}` : undefined;
    const failed = failure !== undefined && failureKey !== this.lastFailureKey;
    if (failed) {
      this.lastFailureKey = failureKey;
      this.emit({ type: "error", message: failure.detail ? `${failure.reason}: ${failure.detail}` : failure.reason });
    }
    this.emit({
      type: "result",
      success: !failed,
      text: "",
      sessionId: this.sid,
      costUsd: 0,
      provider: "claude", // wire provider (the Even app only knows claude/codex)
      turns: this.turns,
      durationMs,
      inputTokens,
      outputTokens,
    });
    this.status("idle");
    this.busy = false;
  }

  /** Feed the next view (`call.value`); `ops` is accepted for symmetry and unused. */
  apply(view, _ops) {
    if (!view) return;
    const entries = view.entries ?? [];
    const live = view.docs?.["pi.live"] ?? {};
    let fresh = entries.filter((e) => e.id > this.lastEntryId);
    if (entries.length) this.lastEntryId = Math.max(this.lastEntryId, ...entries.map((e) => e.id));
    if (!this.primed) {
      this.primed = true;
      fresh = [];
      // A failure recorded before we attached belongs to an earlier run.
      if (live.runFailure) {
        const f = live.runFailure;
        this.lastFailureKey = `${f.taskId}:${f.reason}:${f.detail ?? ""}`;
      }
    }
    const resultsByCall = new Map();
    for (const e of entries) {
      const m = messageOf(e);
      if (e.kind === "pi.tool-result" && m?.toolCallId) resultsByCall.set(m.toolCallId, textOfContent(m.content));
    }
    for (const e of fresh) this.onEntry(e, resultsByCall);
    if (live.run) this.ensureBusy();
    this.onLive(live, resultsByCall);
    if (this.busy && !live.run) this.endRun(view, live);
  }

  /** The watch is going away: close open blocks; the run's outcome is not ours to claim. */
  finish() {
    this.closeBlocks();
    this.resetMessage();
  }
}
