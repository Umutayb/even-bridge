// The overseer's gated actions (EVEN_BRIDGE_OVERSEER_ENABLE=1 only).
//
// A gated tool of the overseer (session_start, session_message, session_interrupt,
// session_stop) and the shim's one gate (POST /api/overseer/actions) never act: they
// PROPOSE. A proposal is validated, checked against the limits, and written to the
// `even.overseer.actions` doc on the root conversation with a summary that host code
// builds from the arguments (never the model's words). The phone sees it as a
// permission_request on `dur-overseer`; Even AI speaks the summary and asks for a yes.
//
// Only `confirm(id)` executes (POST /api/overseer/actions/:id/confirm, or the phone's
// permission response). It is idempotent by action id: a second confirm, also a
// concurrent one, gets the first one's result and nothing runs twice. Pending actions
// expire after 90 s and at any restart; the kill switch (agents.disabled) blocks
// confirms. Every step is one line in a 0600 JSONL audit log.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";
import { HANDOFF_MODEL, OVERSEER_SID, OverseerHandoffs, OverseerOutbox, pushOutbox, ROOT_CONVERSATION_ID } from "./docs.mjs";
import { hhmm } from "./checkins.mjs";
import { cannotMessage, defuse, KIND_WORD } from "./host.mjs";

export const ACTION_TTL_MS = 90000;
export const ACTION_KINDS = Object.freeze(["session_start", "session_message", "session_interrupt", "session_stop", "model_switch", "standing_order"]);
/** A standing order: at most 3 uses, at most 12 h (plan ruling 12). */
export const STANDING_MAX_TIMES = 3;
export const STANDING_MAX_MS = 12 * 3600 * 1000;
export const ACTION_STATES = Object.freeze(["pending", "confirmed", "denied", "expired", "failed"]);
export const ACTION_ORIGINS = Object.freeze(["overseer", "evenai"]);
/** Settled items kept in the doc (pending ones always stay). */
export const ACTIONS_KEEP = 100;
export const SWEEP_MS = 10000;
/** Agent TTL a start may ask for (the shim reaper adopts it, capped at 43200). */
export const TTL_S = Object.freeze({ min: 300, max: 43200, default: 7200 });
/** Non-archived durable agents of origin evenai|overseer at most. */
export const AGENT_LIMIT = 2;
export const CLAUDE_STATUS_URL = "http://127.0.0.1:8795/status";
export const CLAUDE_MAX_SESSIONS = 8;
export const CLAUDE_FREE_MIN = 2;
export const CLAUDE_ALIASES = Object.freeze(["haiku", "sonnet", "opus", "fable"]);
/** Text of a message the overseer proposes: the summary shows 140 characters, so nothing is hidden past them. */
export const OVERSEER_TEXT_MAX = 140;
export const EVENAI_TEXT_MAX = 2000;
/** A task the overseer proposes: shown in full in the summary the user confirms. */
export const OVERSEER_TASK_MAX = 140;
export const TASK_MAX = 400;
/** What the summary shows of a task (Even AI's one gate may send up to TASK_MAX). */
export const SUMMARY_TASK_MAX = 140;
/** Proposal text never starts a command (lets-code reads "/mode", "/factory", "!cmd" from the prompt RPC). */
export const COMMAND_RE = /^\s*[\/!]/;
export const NO_COMMANDS = "the overseer cannot send commands";
export const ONE_PENDING = "another action is waiting for your answer";
export const QUESTION_MAX = 2000;
export const LABEL_MAX = 24;
const LABEL_RE = /^[\w .-]+$/;
export const DEFAULT_AUDIT_PATH = "~/.even-terminal/overseer-actions.log";
export const DEFAULT_DISABLE_FILE = "~/.even-terminal/agents.disabled";
/**
 * After a confirmed session_message the target is watched (in this process; a restart ends the watch) for its
 * next status change: a reply, a question waiting for the user, or a finished turn becomes ONE outbox item
 * (kind "reply"), which Even AI's "what's new" reads. Polled every REPLY_POLL_MS for at most REPLY_MAX_MS.
 */
export const REPLY_POLL_MS = 5000;
export const REPLY_MAX_MS = 30 * 60 * 1000;
/** An idle target with no busy phase seen: its reply is looked for after this long (tmux and RC report late). */
export const REPLY_QUIET_MS = 15000;
export const REPLY_TEXT_MAX = 200;
export const REPLY_WATCH_MAX = 8;

const latest = { scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => true };
export const OverseerActions = defineDoc({ kind: "even.overseer.actions", version: 1, ...latest, initial: () => ({ items: [] }) });
/** Confirmed standing orders `{ orders: [{ actionId, sid, text, maxTimes, used, until }] }` (used up / past ones pruned). */
export const OverseerStanding = defineDoc({ kind: "even.overseer.standing", version: 1, ...latest, initial: () => ({ orders: [] }) });

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
/** A plain copy of a doc draft's item (drafts are unusable once their commit settled). */
const plain = (v) => JSON.parse(JSON.stringify(v));
const expand = (p, home = homedir()) => (p === "~" ? home : String(p).startsWith("~/") ? home + String(p).slice(1) : String(p));

/** `/home/u/x` → `~/x` (the home itself → `~`). */
export function tildePath(p, home = homedir()) {
  const s = String(p ?? "");
  if (s === home) return "~";
  return s.startsWith(home + "/") ? "~" + s.slice(home.length) : s;
}

/** Is `model` (an alias, `claude-…` or `Anthropic/…`) a Claude model (the :8795 bridge)? */
export function isClaudeModel(model) {
  const m = String(model ?? "").toLowerCase();
  return CLAUDE_ALIASES.includes(m) || /^claude-/.test(m) || /^anthropic\//.test(m) || /(^|\/)claude-/.test(m);
}

const oneLine = (s, max) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return max != null && t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/**
 * The summary the user confirms, built from the arguments only (exact copy of the plan).
 * @param {string} kind one of ACTION_KINDS
 * @param {object} args the validated arguments (`label` is host-derived for message/interrupt/stop)
 */
export function summarize(kind, args = {}) {
  switch (kind) {
    case "session_start": {
      const engineWord = args.engine === "lets-code" ? "lets-code" : "native";
      const task = String(args.task ?? "");
      const what = `${task.slice(0, SUMMARY_TASK_MAX)}${task.length > SUMMARY_TASK_MAX ? "…" : ""}`;
      const until = args.until != null ? ` until ${hhmm(args.until)}` : "";
      return `Start ${engineWord} agent '${args.label}' in ${tildePath(args.cwd)} on ${args.model}${until}${args.factory ? " with the factory on" : ""} to: "${what}"?`;
    }
    case "standing_order": {
      const text = String(args.text ?? "");
      const what = `${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`;
      return `Let the overseer tell ${KIND_WORD[args.target] ?? "agent"} '${args.label}' "${what}" up to ${args.maxTimes} time${args.maxTimes > 1 ? "s" : ""} until ${hhmm(args.until)}?`;
    }
    case "session_message": {
      // The target's kind and host-built label (a pi / Claude Code / RC session's own title is never named).
      const text = String(args.text ?? "");
      return `Send ${KIND_WORD[args.target] ?? "agent"} '${args.label}': "${text.slice(0, 140)}${text.length > 140 ? "…" : ""}"${args.steer ? " now" : ""}?`;
    }
    case "session_interrupt":
      return `Interrupt agent '${args.label}'?`;
    case "session_stop":
      return `Stop agent '${args.label}'?`;
    case "model_switch":
      return `Ask the overseer this with ${args.model}?`;
    default:
      throw httpError(400, `unknown action kind ${JSON.stringify(kind)}`);
  }
}

/** Append-only JSONL, 0600, created by the bridge. Never throws. */
export function createAuditLog(path = DEFAULT_AUDIT_PATH, { log = console } = {}) {
  const file = resolve(expand(path));
  return {
    path: file,
    write(event) {
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const fd = openSync(file, "a", 0o600);
        try {
          fchmodSync(fd, 0o600);
          writeSync(fd, JSON.stringify({ ts: Date.now(), ...event }) + "\n");
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        log.warn?.(`[overseer] audit write failed: ${err.message}`);
      }
    },
  };
}

/** Free slots of the Claude bridge (:8795): 8 − sessions. Unreachable or unreadable → null. */
export async function claudeFreeSlots({ url = CLAUDE_STATUS_URL, timeoutMs = 1000, fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    const n = Array.isArray(j?.sessions) ? j.sessions.length : Number.isInteger(j?.sessions) ? j.sessions : null;
    return n == null ? null : CLAUDE_MAX_SESSIONS - n;
  } catch {
    return null;
  }
}

const strArg = (v, name, { max, required = true, min = 1 } = {}) => {
  if (v == null || v === "") {
    if (required) throw httpError(400, `'${name}' is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.trim().length < min || (max != null && v.length > max)) {
    throw httpError(400, `'${name}' must be a string of ${min}-${max} characters`);
  }
  return v;
};

/**
 * @param {object} o
 * @param {object} o.durable the durable provider (ready, listAgents, engines, defaultCwd, checkAgentCwd, hasModel,
 *   setOverseerModel, overseerBusy)
 * @param {object} o.host the overseer host (describe, execute)
 * @param {object} [o.overseer] the overseer (ask, settled) for model_switch
 * @param {(sid: string, frame: object) => void} [o.emit] frames to dur-overseer (permission_request / permission_result)
 * @param {(item: object) => void} [o.onOutbox] told about new outbox items
 */
export function createOverseerActions({
  durable,
  host,
  overseer = null,
  emit = () => {},
  onOutbox = () => {},
  log = console,
  now = Date.now,
  ttlMs = ACTION_TTL_MS,
  sweepMs = SWEEP_MS,
  auditPath = DEFAULT_AUDIT_PATH,
  disableFile = DEFAULT_DISABLE_FILE,
  claudeSlots = () => claudeFreeSlots(),
  home = homedir(),
  replyPollMs = REPLY_POLL_MS,
  replyMaxMs = REPLY_MAX_MS,
  replyQuietMs = REPLY_QUIET_MS,
} = {}) {
  let harness;
  let ctx;
  let timer = null;
  let closed = false;
  const startedAt = now();
  const audit = createAuditLog(auditPath, { log });
  /** submissionId → refusals of gated tools in that submission's run ({kind, reason}); newest 50 kept. */
  const refusals = new Map();
  /** id → in-flight confirm (concurrent confirms share it). */
  const inflight = new Map();

  const note = (event, item, by) =>
    audit.write({ event, id: item.id, kind: item.kind, origin: item.origin, summary: item.summary, by: by ?? item.origin });
  const frame = (f) => {
    try {
      emit(OVERSEER_SID, f);
    } catch (err) {
      log.warn?.(`[overseer] emit failed: ${err.message}`);
    }
  };
  const resolved = (item, decision) =>
    frame({ type: "permission_result", toolName: "overseer", summary: item.summary, decision: decision === "allow" ? "allowed" : "denied", toolUseId: item.id });

  const commit = (fn) => harness.commit(async (tx) => fn(await tx.doc(OverseerActions, ROOT_CONVERSATION_ID), tx), ctx);
  const snapshot = async () => (await harness.snapshot(OverseerActions, ROOT_CONVERSATION_ID, ctx)) ?? { items: [] };
  const find = async (id) => plain((await snapshot()).items.find((i) => i.id === id) ?? null);

  function prune(doc) {
    let extra = doc.items.filter((i) => i.state !== "pending").length - ACTIONS_KEEP;
    if (extra <= 0) return;
    doc.items = doc.items.filter((i) => i.state === "pending" || extra-- <= 0);
  }

  // ── validation ────────────────────────────────────────────────────────────
  async function describe(id) {
    const d = await host.describe(id);
    if (!d) throw httpError(404, `no session ${oneLine(id, 80)}`);
    return d;
  }

  /** The single-writer rules (spec): run at propose and again right before executing. */
  function writerCheck(kind, id, d) {
    if (d.kind === "durable" && id === OVERSEER_SID) throw httpError(403, "the overseer cannot act on itself");
    if (kind === "session_message" || kind === "standing_order") {
      // Every kind that has a transport (host.mjs messageRoute): a bridge agent, an RC session, a pi session
      // (its tmux pane or pi RPC), a Claude Code session in a tmux pane. Never a terminal outside tmux.
      if (!d.canMessage) throw httpError(403, cannotMessage(id, d.kind, d.why));
      return;
    }
    if (d.kind !== "durable") {
      throw httpError(403, kind === "session_stop" ? "only bridge agents can be stopped" : "only bridge agents can be interrupted");
    }
  }

  async function checkArgs(kind, raw, origin) {
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (kind === "session_start") {
      const label = strArg(args.label, "label", { max: LABEL_MAX });
      if (!LABEL_RE.test(label)) throw httpError(400, "'label' may hold letters, digits, space, '_', '.' or '-'");
      const task = strArg(args.task, "task", { max: origin === "overseer" ? OVERSEER_TASK_MAX : TASK_MAX });
      if (COMMAND_RE.test(task)) throw httpError(400, NO_COMMANDS);
      const engines = Array.isArray(durable.engines) ? durable.engines : ["native"];
      const engine = args.engine ?? (engines.includes("lets-code") ? "lets-code" : "native");
      if (!engines.includes(engine)) throw httpError(400, `the ${oneLine(engine, 20)} engine is not available`);
      const factory = args.factory == null ? false : args.factory;
      if (typeof factory !== "boolean") throw httpError(400, "'factory' must be true or false");
      if (factory && origin !== "evenai") throw httpError(400, "the overseer cannot start an agent with the factory");
      if (factory && engine !== "lets-code") throw httpError(400, "'factory' needs engine lets-code");
      const model = strArg(args.model ?? "qwen", "model", { max: 32 });
      if (!durable.hasModel(model)) throw httpError(400, `unknown model ${oneLine(model, 32)}`);
      let maxTurns;
      if (args.maxTurns != null) {
        if (!Number.isInteger(args.maxTurns) || args.maxTurns < 1 || args.maxTurns > 60) throw httpError(400, "'maxTurns' must be an integer from 1 to 60");
        maxTurns = args.maxTurns;
      }
      const ttlS = args.ttlS ?? TTL_S.default;
      if (!Number.isInteger(ttlS) || ttlS < TTL_S.min || ttlS > TTL_S.max) throw httpError(400, `'ttlS' must be an integer from ${TTL_S.min} to ${TTL_S.max}`);
      const want = args.cwd == null || args.cwd === "" ? join(dirname(durable.defaultCwd), label.replace(/[ ]/g, "-")) : strArg(args.cwd, "cwd", { max: 512 });
      const cwd = durable.checkAgentCwd(expand(want, home)); // 400 outside the agent roots (nothing is created)
      const out = { label, task, cwd, engine, model, ttlS };
      if (factory) out.factory = true;
      if (maxTurns != null) out.maxTurns = maxTurns;
      return out;
    }
    if (kind === "model_switch") {
      if (origin !== "evenai") throw httpError(400, "only the user switches the overseer's model");
      const model = strArg(args.model, "model", { max: 32 });
      if (!durable.hasModel(model)) throw httpError(400, `unknown model ${oneLine(model, 32)}`);
      const question = strArg(args.question, "question", { max: QUESTION_MAX });
      return { model, question };
    }
    const id = strArg(args.id, "id", { max: 128 });
    const d = await describe(id);
    writerCheck(kind, id, d);
    const label = oneLine(d.label || id, 40).replace(/'/g, "’");
    // The target's kind, for the summary ("Send pi session '…'"); a bridge agent's args are as before.
    const target = d.kind !== "durable" ? { target: d.kind } : {};
    if (kind === "session_message") {
      const text = strArg(args.text, "text", { max: origin === "overseer" ? OVERSEER_TEXT_MAX : EVENAI_TEXT_MAX });
      if (COMMAND_RE.test(text)) throw httpError(400, NO_COMMANDS);
      const steer = args.steer == null ? false : args.steer;
      if (typeof steer !== "boolean") throw httpError(400, "'steer' must be true or false");
      return { id, label, text, steer, ...target };
    }
    if (kind === "standing_order") {
      // The later messages are sent without a confirm, so the text is short enough to be read in full.
      const text = strArg(args.text, "text", { max: OVERSEER_TEXT_MAX });
      if (COMMAND_RE.test(text)) throw httpError(400, NO_COMMANDS);
      const maxTimes = args.maxTimes;
      if (!Number.isInteger(maxTimes) || maxTimes < 1 || maxTimes > STANDING_MAX_TIMES) {
        throw httpError(400, `'maxTimes' must be an integer from 1 to ${STANDING_MAX_TIMES}`);
      }
      const until = typeof args.until === "string" ? Date.parse(args.until) : args.until;
      const t = now();
      if (!Number.isFinite(until) || until <= t || until > t + STANDING_MAX_MS) throw httpError(400, "'until' must be within 12 hours from now");
      return { id, label, text, maxTimes, until: Math.floor(until), ...target };
    }
    return { id, label };
  }

  /** The hand-off a start proposed in `submissions` belongs to (a told instruction that carried one), or null. */
  async function handoffOf(submissions) {
    const subs = (submissions ?? []).map(String);
    if (!subs.length) return null;
    const doc = await harness.snapshot(OverseerHandoffs, ROOT_CONVERSATION_ID, ctx);
    return plain((doc?.items ?? []).find((h) => subs.includes(String(h.submissionId))) ?? null);
  }

  /**
   * A start for a hand-off is held to it (Ideate decision 8): its own folder only, qwen, at most the
   * hand-off's TTL (to its deadline); the summary the user confirms names the folder, model, deadline and task.
   */
  async function handoffStart(raw, h) {
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (args.cwd != null && args.cwd !== "" && resolve(expand(String(args.cwd), home)) !== h.cwd) {
      throw httpError(400, `a hand-off agent works only in ${tildePath(h.cwd, home)}`);
    }
    if (args.model != null && args.model !== "" && args.model !== HANDOFF_MODEL) throw httpError(400, `a hand-off agent runs on ${HANDOFF_MODEL}`);
    // The deadline is fixed when the hand-off is asked for (e.g. 07:00); the agent lives at most until then.
    const deadline = h.at + h.ttlS * 1000;
    const left = Math.floor((deadline - now()) / 1000);
    if (left < TTL_S.min) throw httpError(409, "this hand-off's deadline has passed");
    if (args.ttlS != null && (!Number.isInteger(args.ttlS) || args.ttlS < TTL_S.min)) throw httpError(400, `'ttlS' must be an integer from ${TTL_S.min} to ${left}`);
    const ttlS = Math.min(args.ttlS ?? left, left);
    const engines = Array.isArray(durable.engines) ? durable.engines : ["native"];
    const out = await checkArgs(
      "session_start",
      { label: h.label, task: args.task, cwd: h.cwd, engine: engines.includes("lets-code") ? "lets-code" : "native", model: HANDOFF_MODEL, ttlS, ...(args.maxTurns != null ? { maxTurns: args.maxTurns } : {}), ...(args.factory != null ? { factory: args.factory } : {}) },
      "overseer",
    );
    return { ...out, handoff: h.tag, until: Math.min(deadline, now() + ttlS * 1000) };
  }

  /** An unexpired action that waits for the user's answer (the one-at-a-time rule counts the overseer's own only). */
  const waitsForUser = (i, t) => i.state === "pending" && i.expiresAt >= t && i.origin === "overseer" && !i.standing;

  /** The limits, at propose and again at confirm. */
  async function checkLimits(kind, args) {
    const claude = isClaudeModel(args.model);
    if (kind === "session_start") {
      const agents = await durable.listAgents({ all: true });
      const ours = agents.filter((a) => a.origin === "evenai" || a.origin === "overseer");
      if (ours.length >= AGENT_LIMIT) throw httpError(409, `${ours.length} agents exist; stop one first`);
      if (claude && agents.some((a) => a.origin === "overseer" && isClaudeModel(a.model))) {
        throw httpError(409, "one overseer-started Claude agent is already running");
      }
    }
    if (claude && (kind === "session_start" || kind === "model_switch")) {
      const free = await claudeSlots();
      if (free == null || free < CLAUDE_FREE_MIN) throw httpError(409, "the Claude bridge has fewer than 2 free slots");
    }
  }

  // ── propose ───────────────────────────────────────────────────────────────
  /**
   * Validate, check the limits, write the item (pending, expiresAt = now + 90 s), tell the phone
   * (permission_request on dur-overseer) and the outbox. A retried requestId (the shim's one gate)
   * returns the same action.
   * @returns {Promise<{ id, kind, summary, expiresAt, args }>}
   */
  async function propose(kind, rawArgs, { origin = "overseer", requestId, submissions = [] } = {}) {
    await ready;
    if (!ACTION_KINDS.includes(kind)) throw httpError(400, `'kind' must be one of ${ACTION_KINDS.join(", ")}`);
    if (!ACTION_ORIGINS.includes(origin)) throw httpError(400, `invalid origin ${JSON.stringify(origin)}`);
    const h = kind === "session_start" && origin === "overseer" ? await handoffOf(submissions) : null;
    const args = h ? await handoffStart(rawArgs, h) : await checkArgs(kind, rawArgs, origin);
    if (kind === "session_message" && origin === "overseer") {
      const done = await underStandingOrder(args, submissions);
      if (done) return done;
    }
    const items = (await snapshot()).items;
    if (requestId != null) {
      const same = items.find((i) => i.requestId === requestId && i.origin === origin);
      if (same && (same.state === "pending" || same.state === "confirmed")) {
        // A retry is the same action only with the same arguments.
        if (same.kind !== kind || JSON.stringify(same.args) !== JSON.stringify(args)) throw httpError(409, "requestId reused for another action");
        return view(same);
      }
    }
    // One question at a time: the phone's answer (it carries no id) and the spoken yes always mean this one.
    // Only the overseer's own proposals wait for the user; Even AI's one gate is confirmed by the shim at once.
    const t0 = now();
    if (origin === "overseer" && items.some((i) => waitsForUser(i, t0))) throw httpError(409, ONE_PENDING);
    if (h && items.some((i) => i.args?.handoff === h.tag && (i.state === "pending" || (i.state === "confirmed" && !i.error)))) {
      throw httpError(409, "this hand-off already has an agent");
    }
    await checkLimits(kind, args);
    const t = now();
    const item = {
      id: "act-" + randomUUID().replace(/-/g, "").slice(0, 12),
      kind,
      args,
      summary: summarize(kind, args),
      origin,
      createdAt: t,
      expiresAt: t + ttlMs,
      state: "pending",
    };
    if (requestId != null) item.requestId = String(requestId);
    if (submissions.length) item.submissions = submissions.map(String);
    const box = await harness.commit(async (tx) => {
      const doc = await tx.doc(OverseerActions, ROOT_CONVERSATION_ID);
      // Checked again in the commit: two concurrent proposals never both pass (commits are serialized).
      if (origin === "overseer" && doc.items.some((i) => waitsForUser(i, t))) throw httpError(409, ONE_PENDING);
      if (h && doc.items.some((i) => i.args?.handoff === h.tag && (i.state === "pending" || (i.state === "confirmed" && !i.error)))) {
        throw httpError(409, "this hand-off already has an agent");
      }
      doc.items.push(item);
      prune(doc);
      return { ...pushOutbox(await tx.doc(OverseerOutbox, ROOT_CONVERSATION_ID), { kind: "action", text: item.summary, tag: item.id }) };
    }, ctx);
    note("propose", item);
    // The phone's prompt is for the overseer's proposals; Even AI's own one-gate actions were already
    // confirmed by the user's spoken yes, and the phone never answers them.
    if (origin === "overseer") {
      frame({
        type: "permission_request",
        toolName: "overseer",
        description: item.summary,
        detail:
          kind === "session_start" ? `${kind}: ${args.task}` : kind === "session_message" || kind === "standing_order" ? `${kind}: ${args.text}` : kind,
        toolUseId: item.id,
        options: [
          { text: "Yes", key: "allow" },
          { text: "No", key: "deny" },
        ],
      });
    }
    try {
      onOutbox(box);
    } catch {
      /* a listener never fails a proposal */
    }
    return view(item);
  }

  const view = (i) => ({ id: i.id, kind: i.kind, summary: i.summary, expiresAt: i.expiresAt, args: i.args, ...(i.standing ? { standing: i.standing } : {}) });

  /**
   * A session_message of the overseer whose sid and EXACT text a confirmed standing order covers (uses
   * left, before its `until`): one use is taken and the action is written in ONE commit, then it runs
   * through the same confirm as any action (kill switch, driver probe, audit), without a new question.
   * Returns the action's view with `standing` and `result`, or null (no order matches).
   */
  async function underStandingOrder(args, submissions) {
    const t = now();
    const item = await harness.commit(async (tx) => {
      const st = await tx.doc(OverseerStanding, ROOT_CONVERSATION_ID);
      st.orders = (st.orders ?? []).filter((o) => o.until >= t && o.used < o.maxTimes);
      // The order's summary promised a message, not an interruption: a steer never matches it.
      if (args.steer !== false) return null;
      const o = st.orders.find((x) => x.sid === args.id && x.text === args.text);
      if (!o) return null;
      o.used += 1;
      const it = {
        id: "act-" + randomUUID().replace(/-/g, "").slice(0, 12),
        kind: "session_message",
        args,
        summary: summarize("session_message", args),
        origin: "overseer",
        createdAt: t,
        expiresAt: t + ttlMs,
        state: "pending",
        standing: o.actionId,
        use: o.used,
      };
      if (submissions.length) it.submissions = submissions.map(String);
      const doc = await tx.doc(OverseerActions, ROOT_CONVERSATION_ID);
      doc.items.push(it);
      prune(doc);
      return plain(it);
    }, ctx);
    if (!item) return null;
    audit.write({ event: "standing", id: item.id, kind: item.kind, origin: item.origin, summary: item.summary, by: "standing", order: item.standing, use: item.use });
    let r;
    try {
      r = await confirm(item.id, { confirmFrameId: `standing:${item.standing}`, by: "standing" });
    } catch (err) {
      // The use was taken in the commit (two concurrent messages never both get the last one); a send that
      // did not happen (kill switch, a changed driver, a bridge error) gives it back.
      await harness.commit(async (tx) => {
        const st = await tx.doc(OverseerStanding, ROOT_CONVERSATION_ID);
        const o = (st.orders ?? []).find((x) => x.actionId === item.standing);
        if (o && o.used > 0) o.used -= 1;
      }, ctx);
      throw err;
    }
    const t2 = now();
    const out = await harness.commit(
      async (tx) => ({
        ...pushOutbox(await tx.doc(OverseerOutbox, ROOT_CONVERSATION_ID), {
          kind: "system",
          text: `Sent agent '${args.label}' "${args.text}" under your standing order (use ${item.use}).`,
          tag: item.id,
          at: t2,
        }),
      }),
      ctx,
    );
    try {
      onOutbox(out);
    } catch {
      /* a listener never fails an action */
    }
    return { ...view(item), result: r.result };
  }

  // ── confirm / deny ────────────────────────────────────────────────────────
  const stored = (item) => {
    if (item.state === "failed") throw httpError(item.error?.statusCode ?? 500, item.error?.message ?? "the action failed");
    return { ok: true, result: item.result };
  };

  async function expire(id) {
    const item = await commit((doc) => {
      const i = doc.items.find((x) => x.id === id);
      if (!i || i.state !== "pending") return null;
      i.state = "expired";
      return plain(i);
    });
    if (item) {
      note("expire", item, "bridge");
      resolved(item, "deny");
    }
    return item;
  }

  async function confirmOnce(id, { confirmFrameId, by }) {
    const item = await find(id);
    if (!item) throw httpError(404, `no action ${oneLine(id, 80)}`);
    if (item.state === "confirmed" && "result" in item) return stored(item);
    if (item.state === "failed") return stored(item);
    if (item.state === "denied") throw httpError(409, "action denied");
    if (item.state === "expired") throw httpError(410, "action expired");
    if (item.state === "confirmed") throw httpError(409, "action is running");
    if (now() > item.expiresAt) {
      await expire(id);
      throw httpError(410, "action expired");
    }
    if (existsSync(resolve(expand(disableFile, home)))) throw httpError(423, "agents are switched off");
    const claimed = await commit((doc) => {
      const i = doc.items.find((x) => x.id === id);
      if (!i || i.state !== "pending") return null;
      i.state = "confirmed";
      i.confirmedAt = now();
      if (confirmFrameId != null) i.confirmFrameId = String(confirmFrameId);
      return plain(i);
    });
    if (!claimed) return confirmOnce(id, { confirmFrameId, by }); // settled meanwhile (another process): report that
    note("confirm", claimed, by);
    resolved(claimed, "allow");
    let result;
    let baseline = null;
    try {
      // Everything is checked again right before it runs: limits, and (inside execute) the session's driver.
      if (claimed.kind === "session_start" || claimed.kind === "model_switch") await checkLimits(claimed.kind, claimed.args);
      if (claimed.kind !== "session_start" && claimed.kind !== "model_switch") {
        writerCheck(claimed.kind, claimed.args.id, await describe(claimed.args.id));
      }
      // A message's target is watched for its reply; the newest answer before the send is the baseline.
      if (claimed.kind === "session_message") baseline = await replyBaseline(claimed.args.id);
      result =
        claimed.kind === "model_switch"
          ? await modelSwitch(claimed)
          : claimed.kind === "standing_order"
            ? await recordStanding(claimed)
            : await host.execute(claimed);
    } catch (err) {
      const error = { statusCode: typeof err.statusCode === "number" ? err.statusCode : 500, message: String(err.message ?? err) };
      await commit((doc) => {
        const i = doc.items.find((x) => x.id === id);
        if (i) Object.assign(i, { state: "failed", error });
      });
      audit.write({ event: "fail", id, kind: claimed.kind, origin: claimed.origin, summary: claimed.summary, by: "bridge", error: error.message });
      throw httpError(error.statusCode, error.message);
    }
    result ??= {};
    await commit((doc) => {
      const i = doc.items.find((x) => x.id === id);
      if (i) i.result = result;
    });
    note("execute", claimed, "bridge");
    if (claimed.kind === "session_message") watchReply(claimed, baseline);
    return { ok: true, result };
  }

  // ── replies: the target's next status change after a confirmed message, as one outbox item ──
  /** Running reply watches (newest last); the oldest is dropped past REPLY_WATCH_MAX. */
  const watches = new Set();

  async function replyBaseline(id) {
    try {
      return typeof host.lastReply === "function" ? String((await host.lastReply(id)) ?? "") : null;
    } catch {
      return "";
    }
  }

  async function pushReply(item, text) {
    try {
      const box = await harness.commit(
        async (tx) => ({ ...pushOutbox(await tx.doc(OverseerOutbox, ROOT_CONVERSATION_ID), { kind: "reply", text, tag: item.id, at: now() }) }),
        ctx,
      );
      onOutbox(box);
    } catch (err) {
      log.warn?.(`[overseer] reply item for ${item.id} failed: ${err.message}`);
    }
  }

  /**
   * Watch the target of a confirmed message: "waiting" → "<Kind> '<label>' is waiting for an answer."; back to
   * idle with a new answer → "<Kind> '<label>' replied: <its newest answer, one line, ≤ 200 chars>"; idle after a
   * busy phase without a new answer → "… finished its turn without a new answer." Nothing after REPLY_MAX_MS.
   * The reply text is the session's own (untrusted): defused, one line, cut; it reaches only the outbox.
   */
  function watchReply(item, baseline) {
    if (closed || baseline == null || typeof host.stateOf !== "function") return;
    const { id, label } = item.args;
    const word = KIND_WORD[item.args.target] ?? "agent";
    const who = `${word[0].toUpperCase()}${word.slice(1)} '${label}'`;
    const t0 = now();
    const w = { timer: null, stop: false };
    watches.add(w);
    while (watches.size > REPLY_WATCH_MAX) {
      const oldest = watches.values().next().value;
      oldest.stop = true;
      clearTimeout(oldest.timer);
      watches.delete(oldest);
    }
    let seenBusy = false;
    const end = () => watches.delete(w);
    const tick = async () => {
      if (closed || w.stop) return end();
      let st = null;
      try {
        st = await host.stateOf(id);
      } catch {
        /* unknown this time */
      }
      if (st === "waiting") {
        end();
        return pushReply(item, `${who} is waiting for an answer.`);
      }
      if (st === "busy") seenBusy = true;
      else if (st === "idle" && (seenBusy || now() - t0 >= replyQuietMs)) {
        const r = await replyBaseline(id);
        if (r && r !== baseline) {
          end();
          return pushReply(item, `${who} replied: ${defuse(r, { oneLine: true, max: REPLY_TEXT_MAX })}`);
        }
        if (seenBusy) {
          end();
          return pushReply(item, `${who} finished its turn without a new answer.`);
        }
      }
      if (now() - t0 >= replyMaxMs || st == null) return end();
      w.timer = setTimeout(tick, replyPollMs);
      w.timer.unref?.();
    };
    w.timer = setTimeout(tick, replyPollMs);
    w.timer.unref?.();
  }

  /**
   * Execute a pending action (idempotent by id: concurrent and repeated confirms get the same result).
   * 404 unknown, 409 denied, 410 expired, 423 kill switch.
   */
  async function confirm(id, { confirmFrameId, by = "evenai" } = {}) {
    await ready;
    let p = inflight.get(id);
    if (!p) {
      p = confirmOnce(String(id ?? ""), { confirmFrameId, by }).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    return p;
  }

  async function deny(id, { by = "evenai" } = {}) {
    await ready;
    const r = await commit((doc) => {
      const i = doc.items.find((x) => x.id === id);
      if (!i) return { code: 404 };
      if (i.state === "denied") return { code: 200 };
      if (i.state !== "pending") return { code: i.state === "expired" ? 410 : 409, state: i.state };
      i.state = "denied";
      return { code: 200, item: plain(i) };
    });
    if (r.code === 404) throw httpError(404, `no action ${oneLine(id, 80)}`);
    if (r.code === 410) throw httpError(410, "action expired");
    if (r.code === 409) throw httpError(409, `action already ${r.state}`);
    if (r.item) {
      note("deny", r.item, by);
      resolved(r.item, "deny");
    }
    return { ok: true };
  }

  async function pending() {
    await ready;
    const t = now();
    return (await snapshot()).items.filter((i) => i.state === "pending" && i.expiresAt >= t).map(view);
  }

  /** A confirmed standing order is written; it runs nothing by itself. */
  async function recordStanding(item) {
    const { id: sid, text, maxTimes, until } = item.args;
    await harness.commit(async (tx) => {
      const st = await tx.doc(OverseerStanding, ROOT_CONVERSATION_ID);
      const t = now();
      st.orders = (st.orders ?? []).filter((o) => o.until >= t && o.used < o.maxTimes && o.actionId !== item.id);
      st.orders.push({ actionId: item.id, sid, text, maxTimes, used: 0, until });
    }, ctx);
    return { order: item.id };
  }

  /** The confirmed standing orders with uses left (`[{ actionId, sid, text, maxTimes, used, until }]`). */
  async function standing() {
    await ready;
    const t = now();
    const st = await harness.snapshot(OverseerStanding, ROOT_CONVERSATION_ID, ctx);
    return plain((st?.orders ?? []).filter((o) => o.until >= t && o.used < o.maxTimes));
  }

  /**
   * The phone's answer to the permission_request on dur-overseer: the overseer's oldest pending action
   * (Even AI's own one-gate actions never reach the phone, so the phone never answers them).
   */
  async function respond(decision) {
    await ready;
    const t = now();
    const oldest = (await snapshot()).items.find((i) => waitsForUser(i, t));
    if (!oldest) return false;
    if (String(decision ?? "").startsWith("allow")) {
      try {
        await confirm(oldest.id, { confirmFrameId: "phone", by: "phone" });
      } catch (err) {
        log.warn?.(`[overseer] phone confirm of ${oldest.id} failed: ${err.message}`);
      }
    } else {
      await deny(oldest.id, { by: "phone" }).catch((err) => log.warn?.(`[overseer] phone deny failed: ${err.message}`));
    }
    return true;
  }

  /** A gated tool's proposal was refused: remembered for the submissions of its run (the ask reply's `refused`). */
  function noteRefusal(submissions, kind, reason) {
    for (const s of submissions ?? []) {
      const k = String(s);
      refusals.set(k, [...(refusals.get(k) ?? []), { kind, reason: String(reason).slice(0, 200) }].slice(-5));
      while (refusals.size > 50) refusals.delete(refusals.keys().next().value);
    }
  }
  const refusedFor = (submissionId) => (submissionId == null ? [] : (refusals.get(String(submissionId)) ?? []));

  /** Actions proposed while the given submissions were running (POST /api/overseer/ask's `actions`). */
  async function forSubmission(submissionId) {
    if (submissionId == null) return [];
    await ready;
    return (await snapshot()).items
      .filter((i) => (i.submissions ?? []).includes(String(submissionId)))
      .map((i) => ({ ...view(i), state: i.state, done: "result" in i }));
  }

  // ── model switch: one question with another model, reverted when it settles ──
  // Known limit (v1): an input that joins the switched run (whenBusy followUp) also runs on that model;
  // the switch is refused while the root is busy, so only inputs arriving during the switched run do.
  async function modelSwitch(item) {
    if (!overseer) throw httpError(503, "the overseer is not running");
    if (await durable.overseerBusy()) throw httpError(409, "the overseer is busy; ask again when it is idle");
    await durable.setOverseerModel(item.args.model);
    const requestId = "ovs-act:" + item.id;
    let res;
    try {
      res = await overseer.ask(item.args.question, { requestId, waitMs: 0 });
    } catch (err) {
      await durable.setOverseerModel(null).catch(() => {});
      throw err;
    }
    overseer
      .settled(requestId)
      .catch(() => {})
      .then(() => durable.setOverseerModel(null))
      .catch((err) => log.warn?.(`[overseer] model revert failed: ${err.message}`));
    return { requestId, status: res.status };
  }

  async function sweep() {
    if (closed) return;
    const t = now();
    for (const i of (await snapshot()).items) if (i.state === "pending" && i.expiresAt < t) await expire(i.id);
  }

  const ready = (async () => {
    const d = await durable.ready;
    harness = d.harness;
    ctx = d.ctx;
    // A restart drops what was pending, and an execution it cut off is reported as failed.
    const { dropped, cut, found } = await commit((doc) => {
      const out = { dropped: [], cut: [], found: [] };
      for (const i of doc.items) {
        if (i.createdAt >= startedAt) continue; // proposed by this process (a resumed run)
        if (i.state === "pending") {
          i.state = "expired";
          out.dropped.push(plain(i));
        } else if (i.state === "confirmed" && !("result" in i)) {
          // A start the restart cut off may have created its agent: found by its requestId, it is done.
          const sid = i.kind === "session_start" ? durable.sidForRequest?.(`ovs-act:${i.id}`) : null;
          if (sid) {
            i.result = { sessionId: sid };
            out.found.push(plain(i));
          } else {
            Object.assign(i, { state: "failed", error: { statusCode: 500, message: "the bridge restarted while it ran" } });
            out.cut.push(plain(i));
          }
        }
      }
      return out;
    });
    for (const i of dropped) note("expire", i, "restart");
    for (const i of found) note("execute", i, "restart");
    for (const i of cut) audit.write({ event: "fail", id: i.id, kind: i.kind, origin: i.origin, summary: i.summary, by: "restart" });
    const n = dropped.length;
    if (n) {
      const root = await harness.root(ctx);
      const item = await harness.commit(async (tx) => {
        // The overseer learns it on its next run (a passive entry in its context; no run starts).
        await root.submit(tx, {
          type: "write",
          entry: {
            kind: "even.overseer.note",
            data: { dropped: n },
            model: [{ role: "user", content: [{ type: "text", text: `(bridge) ${n} pending action(s) were dropped by a restart; propose again if they are still needed.` }], timestamp: now() }],
          },
        });
        return { ...pushOutbox(await tx.doc(OverseerOutbox, ROOT_CONVERSATION_ID), { kind: "system", text: `${n} pending action${n > 1 ? "s were" : " was"} dropped by a restart.` }) };
      }, ctx);
      try {
        onOutbox(item);
      } catch {
        /* see above */
      }
    }
    timer = setInterval(() => sweep().catch((err) => log.warn?.(`[overseer] action sweep failed: ${err.message}`)), sweepMs);
    timer.unref?.();
  })();
  ready.catch((err) => log.error?.(`[overseer] actions: ${err.message}`));

  return {
    ready,
    propose,
    confirm,
    deny,
    pending,
    respond,
    standing,
    forSubmission,
    noteRefusal,
    refusedFor,
    sweep,
    auditPath: audit.path,
    bindOverseer(o) {
      overseer = o;
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      for (const w of watches) clearTimeout(w.timer);
      watches.clear();
    },
  };
}
