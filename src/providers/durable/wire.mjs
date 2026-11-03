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
//
// Run boundaries: a run ends when `pi.live.run` disappears, or — when one
// commit ends a run and starts the next (a queued input placed in the ending
// commit, `afterFailedRun: "continue"`) — when `run.first` changes or a new
// `runFailure` of the current run shows up while `run` is still present. A
// steer adds a `pi.user` mid-run but keeps `run.first`, so it never ends a run.

const SUMMARY_CHARS = 120;

const textOfContent = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
};

const messageOf = (entry) => entry?.model?.[0];

const failureKeyOf = (f) => (f ? `${f.taskId}:${f.reason}:${f.detail ?? ""}` : undefined);

export function usageTotals(usageDoc) {
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
   * @param {{ now?: () => number, prime?: boolean, log?: { warn: Function } }} [opts]
   *   prime (default true): the first view is history — its entries are marked
   *   seen and not replayed (an in-flight run is still reported: its prompt,
   *   busy, and its streaming partial). prime:false treats the first view as new.
   */
  constructor(sid, emit, { now = Date.now, prime = true, log = console } = {}) {
    this.sid = sid;
    this.emit = emit;
    this.now = now;
    this.log = log;
    this.primed = !prime;
    this.lastEntryId = -Infinity; // entry ids ascend; anything above is new
    this.busy = false;
    this.runStartMs = 0;
    this.turns = 0;
    this.runFirst = undefined; // live.run.first of the current run, once known
    this.runTaskIds = new Set(); // live.run.taskId values seen during the current run
    this.lastFailureKey = undefined;
    this.lastUsage = { inputTokens: 0, outputTokens: 0 }; // totals as of the previous view
    this.usageBase = this.lastUsage; // totals when the current run started
    this.toolArgs = new Map(); // callId → arguments, from assistant toolCall blocks
    this.tools = new Map(); // callId → { name, started, ended }
    this.resetMessage();
  }

  resetMessage() {
    this.msgAttempt = undefined; // generation.attempt the tracked partial belongs to
    this.blockText = []; // per content index: text already emitted (text blocks)
    this.textSent = false; // some text block of this message was emitted
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
    this.runFirst = undefined;
    this.runTaskIds = new Set();
    // The previous view's totals: a folded view may already hold this run's usage.
    this.usageBase = this.lastUsage;
    this.status("busy");
  }

  noteRun(run) {
    if (!run) return;
    if (run.first !== undefined) this.runFirst = run.first;
    if (run.taskId !== undefined) this.runTaskIds.add(run.taskId);
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
        const sent = this.blockText[i];
        if (sent !== undefined && text === sent) return;
        if (sent === undefined && text === "") return;
        if (this.thinkOpen) {
          this.thinkOpen = false;
          this.status("think_end");
        }
        if (sent !== undefined && !text.startsWith(sent)) {
          // The committed text rewrote what was streamed: restart the block with the full text.
          this.log?.warn?.(`[durable:wire] ${this.sid}: text block ${i} is not an extension of the streamed text; resending it`);
          if (this.textOpen) {
            this.textOpen = false;
            this.status("text_end");
          }
          this.textOpen = true;
          this.status("text_start");
          this.emit({ type: "text_delta", text });
          this.blockText[i] = text;
          this.textSent = true;
          return;
        }
        if (!this.textOpen) {
          this.textOpen = true;
          this.status("text_start");
        }
        // A new text block after earlier ones starts on its own line.
        const sep = sent === undefined && this.textSent ? "\n" : "";
        this.emit({ type: "text_delta", text: sep + text.slice((sent ?? "").length) });
        this.blockText[i] = text;
        this.textSent = true;
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

  /** @param {boolean} mayStart a run is visible (live.run) or a pi.user preceded this entry. */
  onEntry(entry, resultsByCall, mayStart) {
    const msg = messageOf(entry);
    switch (entry.kind) {
      case "pi.user": {
        this.emit({ type: "user_prompt", text: textOfContent(msg?.content) });
        this.ensureBusy();
        return true;
      }
      case "pi.assistant": {
        if (msg?.content) for (const b of msg.content) if (b?.type === "toolCall" && b.id) this.toolArgs.set(b.id, b.arguments ?? {});
        if (!this.busy && !mayStart) return false; // not part of any run we can see
        this.ensureBusy();
        // The committed answer: flush what the throttled partial had not shown yet.
        this.streamContent(msg?.content);
        this.closeBlocks();
        this.resetMessage();
        this.turns += 1;
        return false;
      }
      case "pi.tool-result": {
        if (!msg?.toolCallId) return false;
        if (!this.busy && !mayStart) return false;
        this.ensureBusy();
        this.toolEnd(msg.toolCallId, msg.toolName, resultsByCall.get(msg.toolCallId));
        return false;
      }
    }
    return false;
  }

  processEntries(entries, resultsByCall, runVisible) {
    let sawUser = false;
    for (const e of entries) {
      if (this.onEntry(e, resultsByCall, runVisible || sawUser)) sawUser = true;
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
    if (gen?.message && this.busy) this.streamContent(gen.message.content);
    if (!this.busy) return;
    for (const slot of live.tools ?? []) {
      if (!slot?.callId) continue;
      if (slot.status === "running") this.toolStart(slot.callId, slot.name);
      else if (slot.status === "done") this.toolEnd(slot.callId, slot.name, resultsByCall.get(slot.callId) ?? slot.output);
    }
  }

  /** Whether `failure` was recorded for the run we are tracking. */
  failureOfCurrentRun(failure) {
    if (!failure) return false;
    if (failureKeyOf(failure) === this.lastFailureKey) return false;
    if (this.runFirst !== undefined && failure.first !== undefined) return failure.first === this.runFirst;
    if (failure.taskId !== undefined && this.runTaskIds.size) return this.runTaskIds.has(failure.taskId);
    return true; // nothing to tell it apart by: a new failure while we were busy is ours
  }

  endRun(view, failure) {
    this.closeBlocks();
    this.resetMessage();
    for (const [callId, t] of this.tools) if (t.started && !t.ended) this.toolEnd(callId, t.name, "");
    this.tools.clear();
    this.toolArgs.clear();
    const durationMs = this.now() - this.runStartMs;
    const total = usageTotals(view.docs?.["pi.usage"]);
    const inputTokens = Math.max(0, total.inputTokens - this.usageBase.inputTokens);
    const outputTokens = Math.max(0, total.outputTokens - this.usageBase.outputTokens);
    this.emit({ type: "running_stats", durationMs, inputTokens, outputTokens });
    if (failure) {
      this.lastFailureKey = failureKeyOf(failure);
      this.emit({ type: "error", message: failure.detail ? `${failure.reason}: ${failure.detail}` : failure.reason });
    }
    this.emit({
      type: "result",
      success: !failure,
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
    this.runFirst = undefined;
    this.runTaskIds = new Set();
    // The next run counts from here, even when it started in this same view.
    this.lastUsage = total;
  }

  /** Feed the next view (`call.value`); `ops` is accepted for symmetry and unused. */
  apply(view, _ops) {
    if (!view) return;
    const entries = view.entries ?? [];
    const live = view.docs?.["pi.live"] ?? {};
    const run = live.run;
    let fresh = entries.filter((e) => e.id > this.lastEntryId);
    if (entries.length) this.lastEntryId = Math.max(this.lastEntryId, ...entries.map((e) => e.id));

    if (!this.primed) {
      this.primed = true;
      fresh = [];
      this.lastUsage = usageTotals(view.docs?.["pi.usage"]);
      // A failure recorded before we attached belongs to an earlier run.
      this.lastFailureKey = failureKeyOf(live.runFailure);
      if (run) {
        if (run.first !== undefined) {
          const prompt = entries.filter((e) => e.kind === "pi.user" && e.id >= run.first).at(-1);
          if (prompt) this.emit({ type: "user_prompt", text: textOfContent(messageOf(prompt)?.content) });
        }
        this.ensureBusy();
        this.noteRun(run);
      }
    }

    const resultsByCall = new Map();
    for (const e of entries) {
      const m = messageOf(e);
      if (e.kind === "pi.tool-result" && m?.toolCallId) resultsByCall.set(m.toolCallId, textOfContent(m.content));
    }

    // One commit ended the tracked run and started the next one.
    if (this.busy && run) {
      const firstChanged = run.first !== undefined && this.runFirst !== undefined && run.first !== this.runFirst;
      const failed = this.failureOfCurrentRun(live.runFailure) ? live.runFailure : undefined;
      if (firstChanged || failed) {
        const split = firstChanged ? run.first : Infinity;
        this.processEntries(fresh.filter((e) => e.id < split), resultsByCall, true);
        this.endRun(view, failed);
        fresh = fresh.filter((e) => e.id >= split);
      }
    }

    this.processEntries(fresh, resultsByCall, Boolean(run));
    if (run) {
      this.ensureBusy();
      this.noteRun(run);
    }
    this.onLive(live, resultsByCall);
    if (this.busy && !run) {
      this.endRun(view, this.failureOfCurrentRun(live.runFailure) ? live.runFailure : undefined);
    }
    this.lastUsage = usageTotals(view.docs?.["pi.usage"]);
  }

  /** The watch is going away: close open blocks; the run's outcome is not ours to claim. */
  finish() {
    this.closeBlocks();
    this.resetMessage();
  }
}
