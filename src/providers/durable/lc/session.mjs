// One lets-code RPC child of a durable session, in even-terminal's vocabulary.
//
// LcSession is PiSession (the pi provider's RPC → glasses translation) with the
// dialog policy of the lets-code engine (plan rulings 5, 17, 18; spike Decisions):
// - a mandate ask (`select` "mandate (ask): <what>\n\nAllow?") reaches the phone
//   as a yes/no permission_request; Yes answers "Allow once", No "Deny"; "Allow
//   for this session" is never offered remotely;
// - a factory checkpoint (`select` "Factory <id>: <checkpoint>\n\n<body>") is a
//   user_question without "Edit" (glasses cannot edit text) and without the
//   injected "Cancel" (cancelling a checkpoint stops the factory run; "Stop" is
//   offered already); it is HELD: never auto-answered, never swept;
// - an `editor` dialog is answered `cancelled` and shows nothing on the glasses;
// - with no client watching, an unanswered mandate ask is denied after
//   LC_CONFIRM_DENY_MS (sweepDialogs, called by the engine every 30 s).
// Frames are emitted under the bridge's session id (`sid`), not pi's.

import { PiSession } from "../../pi/session.mjs";

export const LC_CONFIRM_DENY_MS = 600_000;
export const FACTORY_TITLE = /^Factory (\S+): ([^\n]+)/;
export const MANDATE_TITLE = /^mandate \(ask\): /;
export const MANDATE_ALLOW = "Allow once";
export const MANDATE_DENY = "Deny";
/** lets-code's factory asks this (a `confirm`) before it enables its experts host-wide; answered No here (R-C2). */
export const FACTORY_EXPERTS_TITLE = "Enable the factory's experts?";
export const FACTORY_EXPERTS_ERROR = "factory experts must be enabled by the operator";
/** The factory's question, or the one for a single expert (lets-code experts.ts: "Enable the <name> expert?"). */
export const expertsQuestion = (title) => {
  const t = String(title ?? "").trim();
  return t === FACTORY_EXPERTS_TITLE || /^Enable the [\w.-]+ expert\?$/.test(t);
};
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const ACTIVITY_EVENTS = new Set(["agent_start", "turn_start", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "agent_end"]);
/** The prompt-response wait of a command that may run long (a factory run answers its prompt only when it ends). */
export const LC_LONG_MS = 2 ** 31 - 1;

/** @returns {"factory"|"confirm"|"question"|"freeform"|null} */
export function dialogKind(req) {
  const title = String(req?.title ?? "");
  switch (req?.method) {
    case "select":
      if (MANDATE_TITLE.test(title)) return "confirm";
      if (FACTORY_TITLE.test(title)) return "factory";
      return "question";
    case "confirm":
      return "confirm";
    case "editor":
    case "input":
      return "freeform";
    default:
      return null;
  }
}

export class LcSession extends PiSession {
  /**
   * @param {(sid: string, frame: object) => void} emit
   * @param {object} opts PiSession/PiRpcClient options (bin, wrap, envExact, env, extraArgs, resume, name, cwd) plus
   *   `sid` (the bridge session id frames go to), `clientCount()`, `onDialog(kind, req)`, `onNotify(text)`,
   *   `onAgentEnd(session)`, `onToolEnd(summary)`, `onToolStart(name, args)`, `onTurnEnd(session)`, `now()`.
   */
  constructor(emit, opts = {}) {
    super(emit, opts);
    this.sid = opts.sid;
    this.now = opts.now ?? Date.now;
    this.clientCount = opts.clientCount ?? (() => 0);
    /** pi's session file (from get_state; written by pi at the first prompt). */
    this.sessionFile = undefined;
    /** Text of the current answer since the last tool call (the final answer at agent_end). */
    this.answerText = "";
  }

  /** Every frame goes to the bridge sid; a frame's own sessionId field names it too. */
  send(msg) {
    const frame = "sessionId" in msg ? { ...msg, sessionId: this.sid } : msg;
    this.emit(this.sid, frame);
  }

  async start() {
    await super.start();
    try {
      const res = await this.client.send({ type: "get_state" });
      if (res.data?.sessionId) this.sessionId = res.data.sessionId;
      if (res.data?.sessionFile) this.sessionFile = res.data.sessionFile;
    } catch (err) {
      if (!this.client?.running) throw Object.assign(new Error(`lets-code exited during start: ${err.message}`), { statusCode: 502 });
    }
  }

  /**
   * Send a prompt as one run of the engine: user_prompt + busy frames, then the prompt with a
   * long response wait (an extension command such as `/factory start` answers only when it is done).
   * @returns {Promise<object>} the prompt response (`data.disposition` "handled" = a command ran, no agent run follows)
   */
  async runLc(text, { timeoutMs = LC_LONG_MS } = {}) {
    if (!this.client) throw new Error("session not started");
    this.send({ type: "user_prompt", text });
    this._busy = true;
    this.turnStartMs = Date.now();
    this.inputTokens = this.outputTokens = this.totalTokens = this.costUsd = this.turns = 0;
    this.currentBlock = null;
    this.answerText = "";
    this.send({ type: "status", state: "busy", sessionId: this.sid });
    return this.client.send({ type: "prompt", message: text }, timeoutMs);
  }

  /** Queue a prompt after the running turn (pi `streamingBehavior: "followUp"`); `steer` is PiSession's. */
  async followUp(text) {
    if (!this.client) throw new Error("session not started");
    this.send({ type: "user_prompt", text });
    await this.client.send({ type: "prompt", message: text, streamingBehavior: "followUp" });
  }

  /** A command that shows nothing on the glasses (`/mode …`); resolves with its prompt response. */
  command(text, timeoutMs = 5000) {
    if (!this.client) return Promise.reject(new Error("session not started"));
    return this.client.send({ type: "prompt", message: text }, timeoutMs);
  }

  /** The ring's end of a run whose prompt was a command (no agent_end comes for it). */
  endCommandRun() {
    if (this._busy) this.onAgentEnd();
  }

  get running() {
    return Boolean(this.client?.running);
  }

  /** Open dialogs (pending permission requests and questions). */
  openDialogs() {
    return [...this.pendingPermissions, ...this.pendingQuestions].map((r) => ({
      id: r.id,
      kind: r._kind ?? (r.method === "confirm" ? "confirm" : "question"),
      title: String(r.title ?? ""),
    }));
  }

  /** The open factory checkpoint, if any: `{ id, runId, checkpoint }`. */
  openFactory() {
    const r = this.pendingQuestions.find((q) => q._kind === "factory");
    if (!r) return null;
    const m = FACTORY_TITLE.exec(String(r.title ?? ""));
    return { id: r.id, runId: m?.[1], checkpoint: m?.[2] };
  }

  /**
   * Deny mandate asks open for LC_CONFIRM_DENY_MS while nobody watches. Factory checkpoints
   * and questions are never touched. @returns {number} how many were denied
   */
  sweepDialogs(nowMs = this.now()) {
    if (this.clientCount() > 0) return 0;
    const due = this.pendingPermissions.filter((r) => r._kind === "confirm" && r.openedAt + LC_CONFIRM_DENY_MS <= nowMs);
    for (const req of due) {
      this.pendingPermissions = this.pendingPermissions.filter((r) => r !== req);
      // A `confirm` takes {confirmed:false}; a mandate `select` takes its Deny option.
      this.client?.respondUi(
        req.method === "confirm" ? { type: "extension_ui_response", id: req.id, confirmed: false } : { type: "extension_ui_response", id: req.id, value: MANDATE_DENY },
      );
      this.emitPermissionResult(req, "deny");
    }
    return due.length;
  }

  respondPermission(decision) {
    const req = this.pendingPermissions[0];
    if (!req || !this.client) return false;
    if (req._kind !== "confirm" || req.method !== "select") {
      super.respondPermission(decision);
      return true;
    }
    this.pendingPermissions.shift();
    const deny = decision === "deny";
    this.client.respondUi({ type: "extension_ui_response", id: req.id, value: deny ? MANDATE_DENY : MANDATE_ALLOW });
    this.emitPermissionResult(req, deny ? "deny" : "allow");
    return true;
  }

  emitPermissionResult(req, decision) {
    if (req._kind !== "confirm" || req.method !== "select") return super.emitPermissionResult(req, decision);
    this.send({ type: "permission_result", toolName: "mandate", summary: req._what ?? "", decision: decision === "deny" ? "denied" : "allowed" });
  }

  /** Anything the child does after a prompt proves lets-code accepted it (the engine's "sent" mark). */
  activity() {
    try {
      this.opts.onActivity?.();
    } catch {
      /* the engine's callback must not break the stream */
    }
  }

  onUiRequest(req) {
    // A dialog shows lets-code works on the prompt; a notify or a status/widget update may come from a
    // timer (memory guard, footer) and proves nothing.
    if (DIALOG_METHODS.has(req.method)) this.activity();
    if (req.method === "confirm" && expertsQuestion(req.title)) {
      // Experts are host-wide lets-code state: a glasses Yes must never enable them (R-C2).
      this.client?.respondUi({ type: "extension_ui_response", id: req.id, confirmed: false });
      this.send({ type: "error", message: FACTORY_EXPERTS_ERROR });
      return;
    }
    if (req.method === "notify") {
      try {
        this.opts.onNotify?.(String(req.message ?? ""), String(req.notifyType ?? "info"));
      } catch {
        /* the engine's callback must not break the stream */
      }
      return super.onUiRequest(req);
    }
    const kind = dialogKind(req);
    if (!kind) return super.onUiRequest(req);
    req._kind = kind;
    req.openedAt = this.now();
    const tell = () => {
      try {
        this.opts.onDialog?.(kind, req);
      } catch {
        /* see above */
      }
    };
    if (req.method === "editor") {
      // Glasses cannot edit text: cancel, show nothing.
      this.client?.respondUi({ type: "extension_ui_response", id: req.id, cancelled: true });
      tell();
      return;
    }
    if (kind === "confirm" && req.method === "select") {
      const title = String(req.title ?? "");
      req._what = title.replace(MANDATE_TITLE, "").replace(/\n\nAllow\?\s*$/, "").trim();
      this.pendingPermissions.push(req);
      this.send({
        type: "permission_request",
        toolName: "mandate",
        description: req._what,
        detail: title,
        toolUseId: req.id,
        options: [
          { text: "Yes", key: "allow" },
          { text: "No", key: "deny" },
        ],
      });
      tell();
      return;
    }
    if (kind === "factory") {
      req.options = (req.options ?? []).filter((o) => o !== "Edit");
      this.pendingQuestions.push(req);
      this.send({
        type: "user_question",
        questions: [
          {
            question: String(req.title ?? ""),
            header: "",
            options: req.options.map((label) => ({ label, description: "", preview: "" })),
          },
        ],
        toolUseId: req.id,
      });
      tell();
      return;
    }
    super.onUiRequest(req);
    tell();
  }

  onEvent(e) {
    if (ACTIVITY_EVENTS.has(e.type)) this.activity();
    if (e.type === "tool_execution_start") this.answerText = "";
    if (e.type === "tool_execution_end") {
      const args = this.toolArgs.get(e.toolCallId) ?? {};
      super.onEvent(e);
      try {
        this.opts.onToolEnd?.(e.toolName, args);
      } catch {
        /* see above */
      }
      return;
    }
    super.onEvent(e);
    // The engine's per-run caps (turns, identical consecutive tool calls), after the frame went out.
    try {
      if (e.type === "tool_execution_start") this.opts.onToolStart?.(e.toolName, e.args ?? {});
      else if (e.type === "turn_end") this.opts.onTurnEnd?.(this);
    } catch {
      /* see above */
    }
  }

  onMessageUpdate(e) {
    const a = e.assistantMessageEvent;
    if (a?.type === "text_delta" && a.delta) this.answerText += a.delta;
    super.onMessageUpdate(e);
  }

  onAgentEnd() {
    super.onAgentEnd();
    try {
      this.opts.onAgentEnd?.(this);
    } catch {
      /* see above */
    }
  }
}
