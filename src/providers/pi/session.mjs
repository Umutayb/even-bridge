// Vendored & adapted from even-terminal-pi (MIT, c) lallenlowe — src/even/session.ts
// See NOTICE.md.

import { PiRpcClient } from "./rpc-client.mjs";
import { summarizePiToolCall } from "./summarize.mjs";

/**
 * Resolves a freeform pi `input` dialog so its turn ends. pi reads this as a
 * non-answer and the user replies in their next prompt (conversational
 * freeform), since the Even app has no text-entry UI.
 */
export const FREEFORM_DEFER_SENTINEL = "(The user will answer in their next message.)";

/**
 * Label for an injected cancel choice in selectable questions. The Even app's
 * gestures don't reliably hit /api/interrupt during a question, and its
 * question UI is option-tap only — so the guaranteed way to let the user back
 * out is a tappable option. Picking it dismisses pi's dialog with cancelled.
 * (ASCII: the phone HUD font has no ✕ glyph.)
 */
export const CANCEL_OPTION_LABEL = "Cancel";

/** Human label for a model: "name (provider/id)". */
function formatModel(m) {
  const id = m.provider && m.id ? `${m.provider}/${m.id}` : m.id ?? "";
  return m.name ? `${m.name}${id ? ` (${id})` : ""}` : id || "unknown";
}

/**
 * Fuzzy-pick a model by free-text pattern. Matches against provider/id and
 * name, case-insensitive: exact provider/id first, then substring on the
 * "provider/id" string, then substring on the name. Returns undefined if no
 * match (caller reports the available list).
 */
export function matchModel(models, pattern) {
  const p = pattern.trim().toLowerCase();
  if (!p) return undefined;
  const full = (m) => `${m.provider ?? ""}/${m.id ?? ""}`.toLowerCase();
  const exact =
    models.find((m) => full(m) === p) ??
    models.find((m) => (m.id ?? "").toLowerCase() === p) ??
    models.find((m) => full(m).includes(p)) ??
    models.find((m) => (m.name ?? "").toLowerCase().includes(p));
  if (exact) return exact;

  // Dictation-tolerant fallback: split the spoken phrase into word tokens and
  // score each model by how many tokens fuzzily appear in its name/id.
  const tokens = p.split(/[\s/.-]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return undefined;

  let best;
  let bestScore = 0;
  for (const m of models) {
    const hay = `${m.name ?? ""} ${full(m)}`.toLowerCase();
    const hayTokens = hay.split(/[\s/.()-]+/).filter(Boolean);
    let score = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 1;
      else if (hayTokens.some((h) => closeEnough(tok, h))) score += 0.8;
    }
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return bestScore >= 1 ? best : undefined;
}

function closeEnough(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length < 3 || b.length < 3) return false;
  return levenshtein(a, b) <= 1;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[a.length];
}

/**
 * Parse a `/model` (or `/models`) command out of a prompt. Returns null when
 * the text isn't a model command, so normal prompts pass through untouched.
 */
export function parseModelCommand(text) {
  const t = text.trim().replace(/[.?!]+$/, ""); // drop trailing punctuation from dictation
  let m = t.match(/^\/models?(?:\s+(.*))?$/i);
  if (m) return { arg: (m[1] ?? "").trim() };

  // Spoken forms (dictation won't say "/").
  m = t.match(/^(?:please\s+)?(?:switch|change|set|use|pick|select)\s+(?:the\s+)?models?\b(?:\s+(?:to|=)\s*)?(.*)$/i);
  if (m) return { arg: (m[1] ?? "").trim() };

  m = t.match(/^models?\s+(?:to\s+)?(.+)$/i);
  if (m) {
    const arg = m[1].trim();
    const QUESTIONY =
      /^(?:are|is|was|do|does|did|can|could|would|should|will|of|for|that|this|the|a|an|in|on|with|about|you|your|we|i|name|names|question|questions|context|info|information)\b/i;
    if (!QUESTIONY.test(arg)) return { arg };
  }

  if (/^models?$/i.test(t)) return { arg: "" };
  return null;
}

/**
 * One pi conversation, exposed in even-terminal's vocabulary.
 *
 * Owns a PiRpcClient, translates its RPC event stream into EvenMessages via
 * `emit`, and tracks the pending approval/question dialogs so the provider's
 * respondPermission / respondQuestion can answer them by RPC id.
 */
export class PiSession {
  constructor(emit, opts) {
    this.emit = emit;
    this.opts = opts;
    this.client = null;
    this.sessionId = undefined;
    /** Epoch ms when the RPC child was spawned (external-write detection). */
    this.spawnedAtMs = 0;
    /** PID of the spawned `pi` child (so driver probes can exclude it). */
    this.childPid = 0;
    this._busy = false;
    this.turnStartMs = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.totalTokens = 0;
    this.costUsd = 0;
    this.turns = 0;
    this.currentBlock = null;
    /** tool args captured at tool_execution_start, keyed by toolCallId. */
    this.toolArgs = new Map();
    /** FIFO of pending permission dialogs (Bash/etc. confirm requests). */
    this.pendingPermissions = [];
    /** FIFO of pending question dialogs (ask_user → select). */
    this.pendingQuestions = [];
    /** Request ids whose `input` dialog is really a multi-select. */
    this.multiSelectInputs = new Set();
  }

  get busy() {
    return this._busy;
  }

  get awaitingQuestion() {
    return this.pendingQuestions.length > 0;
  }

  get status() {
    if (this.pendingPermissions.length > 0 || this.pendingQuestions.length > 0) return "awaiting";
    return this._busy ? "busy" : "idle";
  }

  send(msg) {
    this.emit(this.sessionId ?? "", msg);
  }

  async start() {
    const client = new PiRpcClient({
      ...this.opts,
      onStderr: (line) => {
        if (line.trim()) console.error(`[pi stderr] ${line}`);
      },
    });
    this.client = client;
    client.on("event", (e) => this.onEvent(e));
    client.on("ui_request", (r) => this.onUiRequest(r));
    client.on("exit", ({ code, signal }) => {
      const wasBusy = this._busy;
      this._busy = false;
      console.log(`[pi] session ${this.sessionId ?? "?"} child exited (code=${code} signal=${signal})`);
      if (wasBusy) {
        // The turn is over and will never finish — say so instead of letting
        // the glasses wait on a dead turn.
        this.send({ type: "error", message: "pi process exited mid-turn" });
      }
      this.send({ type: "status", state: "idle", sessionId: this.sessionId });
      this.opts.onExit?.(this, { code, signal });
    });
    client.on("error", (err) => {
      console.error(`[pi] spawn error: ${err.message}`);
      this.send({ type: "error", message: `pi failed to start: ${err.message}` });
      this.opts.onExit?.(this, { code: null, signal: null, error: err.message });
    });
    client.start();
    this.spawnedAtMs = Date.now();
    this.childPid = client.child?.pid ?? 0;

    // Learn the session id up front (get_state always reports it; session
    // persistence is on by default in pi).
    try {
      const res = await client.send({ type: "get_state" });
      const data = res.data;
      if (data?.sessionId) this.sessionId = data.sessionId;
    } catch (err) {
      // If the child is gone, a live session is impossible — fail loudly so
      // the caller (and the phone) see an error instead of a phantom 202.
      if (!client.running) {
        throw Object.assign(new Error(`pi exited during start: ${err.message}`), { statusCode: 502 });
      }
      /* otherwise non-fatal; id may arrive with events */
    }
  }

  async run(text) {
    if (!this.client) throw new Error("session not started");

    // Intercept /model commands: the Even app has no model picker, so the user
    // switches by typing/saying "/model <name>".
    const modelCmd = parseModelCommand(text);
    if (modelCmd) {
      this.send({ type: "user_prompt", text });
      await this.handleModelCommand(modelCmd.arg);
      return;
    }

    this.send({ type: "user_prompt", text });
    this._busy = true;
    this.turnStartMs = Date.now();
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.totalTokens = 0;
    this.costUsd = 0;
    this.turns = 0;
    this.currentBlock = null;
    this.send({ type: "status", state: "busy", sessionId: this.sessionId });
    await this.client.send({ type: "prompt", message: text });
  }

  /** Steer a prompt into a running turn (even-terminal calls prompt() again). */
  async steer(text) {
    if (!this.client) throw new Error("session not started");
    this.send({ type: "user_prompt", text });
    await this.client.send({ type: "prompt", message: text, streamingBehavior: "steer" });
  }

  /**
   * Handle `/model` (list) and `/model <pattern>` (switch). Replies as a
   * normal assistant text turn so it shows on the glasses, then returns to
   * idle — no LLM round-trip, no subprocess restart (pi's set_model switches
   * in place).
   */
  async handleModelCommand(arg) {
    const reply = (text) => {
      this.send({ type: "status", state: "text_start", sessionId: this.sessionId });
      this.send({ type: "text_delta", text });
      this.send({ type: "status", state: "text_end", sessionId: this.sessionId });
      this.send({ type: "status", state: "idle", sessionId: this.sessionId });
    };
    if (!this.client) return reply("Not connected.");

    let models = [];
    try {
      const res = await this.client.send({ type: "get_available_models" });
      models = res.data?.models ?? [];
    } catch (err) {
      return reply(`Couldn't list models: ${err.message}`);
    }

    if (!arg) {
      if (models.length === 0) return reply("No models configured.");
      const list = models.map((m, i) => `${i + 1}. ${formatModel(m)}`).join("\n");
      return reply(`Available models (say "/model <name>" to switch):\n${list}`);
    }

    const picked = matchModel(models, arg);
    if (!picked) {
      const list = models.map((m) => `- ${formatModel(m)}`).join("\n");
      return reply(`No model matches "${arg}". Available:\n${list}`);
    }

    try {
      const res = await this.client.send({
        type: "set_model",
        provider: picked.provider ?? "",
        modelId: picked.id ?? "",
      });
      if (!res.success) return reply(`Switch failed: ${res.error ?? "unknown error"}`);
      const now = res.data ?? picked;
      reply(`Switched to ${formatModel(now)}`);
    } catch (err) {
      reply(`Switch failed: ${err.message}`);
    }
  }

  interrupt() {
    // Cancel any open dialog FIRST. pi blocks on extension_ui_request dialogs
    // (select/confirm/input); a bare `abort` does NOT release them — pi just
    // hangs. The clean dismissal is extension_ui_response{cancelled:true},
    // which lets pi finish the turn understanding the user cancelled.
    const pending = [...this.pendingQuestions, ...this.pendingPermissions];
    this.pendingQuestions = [];
    this.pendingPermissions = [];
    this.multiSelectInputs.clear();
    for (const req of pending) {
      this.client?.respondUi({ type: "extension_ui_response", id: req.id, cancelled: true });
    }
    // Also abort active generation (covers the no-dialog "stop the agent" case).
    this.client?.fire({ type: "abort" });
  }

  async stop() {
    await this.client?.stop();
    this.client = null;
  }

  // ── Dialog responses ──────────────────────────────────────────────────────

  respondPermission(decision) {
    const req = this.pendingPermissions.shift();
    if (!req || !this.client) return;
    if (req.method === "confirm") {
      this.client.respondUi({
        type: "extension_ui_response",
        id: req.id,
        confirmed: decision !== "deny",
      });
    } else {
      // select: map decision → option string. Allow/allowAlways pick an
      // affirmative option; deny picks a negative one. Best-effort by label.
      const opts = req.options ?? [];
      const want = decision === "deny" ? /no|deny|block|reject|cancel/i : /yes|allow|approve|ok/i;
      const wantAlways = /always|session|project/i;
      const choice =
        (decision === "allowAlways" ? opts.find((o) => wantAlways.test(o)) : undefined) ??
        opts.find((o) => want.test(o)) ??
        opts[0];
      this.client.respondUi({ type: "extension_ui_response", id: req.id, value: choice });
    }
    this.emitPermissionResult(req, decision);
  }

  respondQuestion(answer) {
    const req = this.pendingQuestions.shift();
    if (!req || !this.client) return;

    const values = extractAnswerValues(answer);

    // The injected cancel option dismisses pi's dialog instead of answering.
    if (values.includes(CANCEL_OPTION_LABEL) || values.length === 0) {
      this.multiSelectInputs.delete(req.id);
      this.client.respondUi({ type: "extension_ui_response", id: req.id, cancelled: true });
      this.send({ type: "question_answer", answers: { [req.title ?? ""]: "(cancelled)" } });
      return;
    }

    let value;
    if (this.multiSelectInputs.has(req.id)) {
      // pi's multi-select input fallback parses a comma-separated list of
      // option titles (parseDialogSelections splits on ",").
      this.multiSelectInputs.delete(req.id);
      value = values.filter((v) => v !== CANCEL_OPTION_LABEL).join(", ");
    } else {
      value = values[0] ?? answer;
    }

    this.client.respondUi({ type: "extension_ui_response", id: req.id, value });
    this.send({ type: "question_answer", answers: { [req.title ?? ""]: value } });
  }

  emitPermissionResult(req, decision) {
    this.send({
      type: "permission_result",
      toolName: String(req.title ?? "tool"),
      summary: String(req.message ?? req.title ?? ""),
      decision: decision === "allowAlways" ? "always" : decision === "allow" ? "allowed" : "denied",
    });
  }

  // ── Inbound RPC → EvenMessage translation ─────────────────────────────────

  onUiRequest(req) {
    switch (req.method) {
      case "confirm": {
        this.pendingPermissions.push(req);
        this.send({
          type: "permission_request",
          toolName: String(req.title ?? "Confirm"),
          description: String(req.title ?? ""),
          detail: String(req.message ?? ""),
          toolUseId: req.id,
          options: [
            { text: "Yes", key: "allow" },
            { text: "No", key: "deny" },
          ],
        });
        break;
      }
      case "select": {
        const opts = req.options ?? [];
        this.pendingQuestions.push(req);
        this.send({
          type: "user_question",
          questions: [
            {
              question: String(req.title ?? ""),
              header: "",
              options: [
                ...opts.map((label) => ({ label, description: "", preview: "" })),
                { label: CANCEL_OPTION_LABEL, description: "Dismiss this question", preview: "" },
              ],
            },
          ],
          toolUseId: req.id,
        });
        break;
      }
      case "input":
      case "editor": {
        // pi-ask-user's multi-select fallback degrades to `input`, baking the
        // options into the title. Recover them so the glasses get a real
        // selectable list instead of a blank text prompt.
        const parsed = parseBakedOptions(String(req.title ?? ""));
        if (parsed && parsed.options.length > 0) {
          this.multiSelectInputs.add(req.id);
          this.pendingQuestions.push(req);
          this.send({
            type: "user_question",
            questions: [
              {
                question: parsed.question,
                header: "",
                options: [
                  ...parsed.options.map((o) => ({
                    label: o.title,
                    description: o.description,
                    preview: "",
                  })),
                  { label: CANCEL_OPTION_LABEL, description: "Dismiss this question", preview: "" },
                ],
              },
            ],
            toolUseId: req.id,
          });
          break;
        }
        // Pure freeform input: the Even app's question UI is option-tap ONLY —
        // an empty-option question traps it with nothing to tap, hanging pi
        // forever. Surface the question as normal assistant text and resolve
        // pi's input dialog with a sentinel; the user's next prompt is read as
        // the answer in context. (Conversational freeform.)
        const questionText = String(req.title ?? req.placeholder ?? "").trim();
        if (questionText) {
          this.send({ type: "status", state: "text_start", sessionId: this.sessionId });
          this.send({ type: "text_delta", text: questionText });
          this.send({ type: "status", state: "text_end", sessionId: this.sessionId });
        }
        this.client?.respondUi({
          type: "extension_ui_response",
          id: req.id,
          value: FREEFORM_DEFER_SENTINEL,
        });
        break;
      }
      case "notify": {
        this.send({
          type: "notification",
          title: String(req.notifyType ?? "info"),
          message: String(req.message ?? ""),
        });
        break;
      }
      // setStatus/setWidget/setTitle/set_editor_text: ignored (fire-and-forget).
    }
  }

  onEvent(e) {
    switch (e.type) {
      case "message_update":
        this.onMessageUpdate(e);
        break;
      case "tool_execution_start": {
        if (e.args) this.toolArgs.set(e.toolCallId, e.args);
        this.send({ type: "tool_start", name: e.toolName, toolId: e.toolCallId });
        break;
      }
      case "tool_execution_end": {
        const args = this.toolArgs.get(e.toolCallId) ?? {};
        this.toolArgs.delete(e.toolCallId);
        const output = (e.result?.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
        this.send({
          type: "tool_end",
          name: e.toolName,
          toolId: e.toolCallId,
          summary: summarizePiToolCall(e.toolName, args),
          detail: { input: args, output },
        });
        break;
      }
      case "turn_end": {
        // turn_end carries cumulative message.usage (totalTokens + cost.total).
        this.turns += 1;
        const usage = e.message?.usage;
        if (usage) {
          this.inputTokens = usage.input ?? this.inputTokens;
          this.outputTokens = usage.output ?? this.outputTokens;
          this.totalTokens = usage.totalTokens ?? this.totalTokens;
          this.costUsd = usage.cost?.total ?? this.costUsd;
          this.send({
            type: "running_stats",
            durationMs: this.turnStartMs ? Date.now() - this.turnStartMs : 0,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
          });
        }
        break;
      }
      case "agent_end":
        this.onAgentEnd();
        break;
      case "error":
      case "extension_error": {
        const msg = e.error ?? e.message ?? "error";
        this.send({ type: "error", message: msg });
        break;
      }
    }
  }

  onMessageUpdate(e) {
    const a = e.assistantMessageEvent;
    switch (a.type) {
      case "thinking_start":
        this.currentBlock = "thinking";
        this.send({ type: "status", state: "think_start", sessionId: this.sessionId });
        break;
      case "thinking_end":
        this.currentBlock = null;
        this.send({ type: "status", state: "think_end", sessionId: this.sessionId });
        break;
      case "text_start":
        this.currentBlock = "text";
        this.send({ type: "status", state: "text_start", sessionId: this.sessionId });
        break;
      case "text_end":
        this.currentBlock = null;
        this.send({ type: "status", state: "text_end", sessionId: this.sessionId });
        break;
      case "text_delta":
        if (a.delta) this.send({ type: "text_delta", text: a.delta });
        break;
      // toolcall_* deltas are covered by tool_execution_* events.
    }
  }

  onAgentEnd() {
    this._busy = false;
    this.send({
      type: "result",
      success: true,
      text: "",
      sessionId: this.sessionId ?? "",
      costUsd: this.costUsd,
      provider: "claude", // wire provider (Even app only knows claude/codex)
      turns: this.turns,
      durationMs: this.turnStartMs ? Date.now() - this.turnStartMs : 0,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    });
    this.send({ type: "status", state: "idle", sessionId: this.sessionId });
  }
}

/**
 * The Even app returns a question answer in one of a few shapes:
 *   - a JSON object keyed by question text: {"What's your fav?":"TypeScript"}
 *   - a JSON array of selected labels: ["Skills","Hot reload"]
 *   - a bare string: "TypeScript"
 * Normalize all of them to an ordered list of selected values.
 */
export function extractAnswerValues(answer) {
  const trimmed = (answer ?? "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
      if (parsed && typeof parsed === "object") {
        return Object.values(parsed)
          .flatMap((v) => (Array.isArray(v) ? v : [v]))
          .map((v) => String(v).trim())
          .filter(Boolean);
      }
    } catch {
      // fall through to bare-string handling
    }
  }
  return [trimmed];
}

/**
 * pi-ask-user's multi-select fallback (RPC mode) bakes options into an `input`
 * dialog title as:
 *   "<question>\n\nOptions (select one or more):\n1. Title — description\n2. …"
 * Parse it back into a real question + option list. Returns null when no
 * baked option list is present.
 */
export function parseBakedOptions(title) {
  const marker = title.indexOf("Options (select one or more):");
  if (marker === -1) return null;
  const question = title.slice(0, marker).replace(/\n+$/, "").trim();
  const list = title.slice(marker + "Options (select one or more):".length);
  const options = [];
  for (const rawLine of list.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (!m) continue;
    const body = m[1];
    const dash = body.indexOf(" — ");
    if (dash >= 0) {
      options.push({ title: body.slice(0, dash).trim(), description: body.slice(dash + 3).trim() });
    } else {
      options.push({ title: body.trim(), description: "" });
    }
  }
  return { question: question || title.trim(), options };
}
