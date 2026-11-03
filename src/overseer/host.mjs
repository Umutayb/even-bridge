// The overseer's host: what its read-only tools see, built from the providers in
// this process (no HTTP). Every kind in one list (durable sessions of both engines,
// pi session files, local Claude Code sessions, Remote Control sessions), each
// with its driver; and one session's status and recent history as untrusted data.
//
// Driver: "bridge" (a bridge-owned process runs it: durable sessions, lets-code
// children included, and pi/cc sessions the bridge spawned), "terminal-tmux" /
// "terminal" (a terminal pi or claude drives it, with or without a tmux pane),
// "rc" (a Remote Control session), "none" (nothing runs it).
//
// Everything a session wrote (titles, last lines, history) is untrusted: it is
// shown to the overseer's model fenced as data, and the fence cannot be closed
// from inside (the markers are defused in the content).
//
// The inventory (Task 6b) is ONE function, `sessionsList`, read by the overseer's
// sessions_list tool, by GET /api/overseer/sessions (Even AI's list_sessions) and by
// the actions (describe: the label and kind a summary names). Each row has a
// host-built `label` (a bridge agent's name; for pi / Claude Code / RC sessions the
// folder name plus the id's first characters, never the session's own title), a
// normalized `state` (idle | busy | waiting), `lastActivity` (epoch ms), and whether
// the session can receive a message (`canMessage`, `via`, `why`): see messageRoute.
// RC twins (a live RC session's local transcript) are dropped with the phone list's
// own function (src/session-twins.mjs).
import { basename } from "node:path";
import { bytes, READ_CAP_BYTES } from "./docs.mjs";
import { CONTROL_CHARS_RE } from "../providers/pi/detect.mjs";
import { dropRcTwins } from "../session-twins.mjs";

const LIST_LIMIT = 10; // rows per provider
/** A pi / Claude Code / RC session counts as active while driven, not idle, or touched within this window. */
export const ACTIVE_WINDOW_MS = 12 * 3600 * 1000;
/** What a session kind is called in summaries and spoken lines. */
export const KIND_WORD = Object.freeze({ durable: "agent", pi: "pi session", "cc-local": "Claude session", rc: "Claude RC session" });
/** Why a session cannot receive a message (host text; the shim maps it to a fixed sentence). */
/** A message to a pi / Claude Code / RC session is at most this long for every origin: the summary shows all of it. */
export const SESSION_TEXT_MAX = 140;
/** How long describe() reuses the inventory it built (one action's propose and confirm read the same labels). */
export const DESCRIBE_CACHE_MS = 15000;
export const NO_COMMANDS = "the overseer cannot send commands";
export const NOT_ONE_LINE = "a message must be one line without control characters";
/** Leading whitespace and invisible format characters (zero-width space/joiners, BOM, bidi marks): skipped before the "/" "!" check. */
const LEAD_RE = /^[\s\p{Cf}]*/u;
/**
 * Invisible characters anywhere in a message: format characters (bidi overrides and isolates, zero-width space and
 * non-joiner, BOM, word joiner, Mongolian vowel separator, …; the zero-width joiner of emoji sequences is allowed)
 * and the blank fillers that render as nothing (Hangul fillers, braille blank, halfwidth filler). With them the
 * summary the user confirms could display differently from what is typed.
 */
const INVISIBLE_RE = /(?!\u200d)\p{Cf}|[\u115f\u1160\u3164\u2800\uffa0]/u;
/** Only punctuation, symbols and spaces: nothing to say (";" alone would even type nothing and submit a draft). */
const NO_WORDS_RE = /^[\p{P}\p{S}\s]*$/u;
export const INVISIBLE = "a message can't hold invisible characters";
export const NO_WORDS = "a message needs words";

/**
 * Why a text may not be sent as a message (null when it may): any control character (newline, CR, ESC, C-…, DEL,
 * C1, line/paragraph separators) — a typed line must be exactly what the user confirmed — or a "/" or "!" after any
 * leading whitespace or zero-width characters (a slash command or a shell escape in Claude Code, pi and lets-code).
 */
export function textProblem(text) {
  const t = String(text ?? "");
  if (CONTROL_CHARS_RE.test(t)) return NOT_ONE_LINE;
  if (/^[\/!]/.test(t.replace(LEAD_RE, ""))) return NO_COMMANDS;
  if (INVISIBLE_RE.test(t)) return INVISIBLE;
  if (NO_WORDS_RE.test(t)) return NO_WORDS;
  return null;
}

/** A task's leading command check (a task goes to a durable agent's prompt, never typed into a terminal). */
export const startsWithCommand = (text) => /^[\/!]/.test(String(text ?? "").replace(LEAD_RE, ""));

export const WHY_NOT = Object.freeze({
  "terminal-no-tmux": "it runs in a terminal outside tmux, so nothing can type into it",
  "no-terminal": "no terminal runs it; open it in tmux first",
  "phone-claude": "the phone's Claude bridge runs it; message it from the phone",
  "driver-unknown": "who drives it could not be checked",
  "waiting-in-terminal": "it is showing a prompt or menu in its terminal; answer it there",
  "draft-in-terminal": "it has unsent text in its terminal; send or clear it there",
  "no-pane": "no tmux pane could be matched to it",
  unknown: "its kind is unknown",
});
const LINE_MAX = 160; // characters of a last line / title in a list row
export const UNTRUSTED_OPEN = (id) => `<<untrusted session output: ${id}>>`;
export const UNTRUSTED_CLOSE = "<<end of untrusted output>>";

/** Defuse fence markers inside untrusted text (`<<` → `‹‹`, `>>` → `››`), one line where asked. */
export function defuse(text, { oneLine = false, max } = {}) {
  let s = String(text ?? "").replace(/<</g, "‹‹").replace(/>>/g, "››");
  if (oneLine) s = s.replace(/\s+/g, " ").trim();
  if (max != null && s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

const lastLineOf = (history) => {
  const answer = (history ?? []).filter((h) => h?.role === "assistant" && h.text).at(-1);
  return answer ? (String(answer.text).split("\n").filter((l) => l.trim()).at(-1) ?? "") : "";
};

const msOf = (ts) => {
  if (ts == null) return null;
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : null;
};

/**
 * idle | busy | waiting from a provider's own state word. No state at all, and the words of a finished or failed
 * turn (idle, done, completed, stopped, ended, failed, error, unknown), are idle; a turn that waits for the user
 * (await…, wait…, permission, question, input, requires_action, approval) is waiting; any other word is busy.
 */
export function normalizeState(state) {
  const s = String(state ?? "").toLowerCase().trim();
  if (!s || /^(idle|done|completed?|stopped|ended|failed|error|errored|unknown|archived)$/.test(s)) return "idle";
  if (/await|wait|permission|question|input|requires_action|approv/.test(s)) return "waiting";
  return "busy";
}

/**
 * Can a session of this kind and driver receive a message, and through which transport?
 *   durable → the durable prompt path; rc → the Remote Control engine; pi with no terminal (or the
 *   bridge's own child) → pi RPC (`pi --mode rpc`, resumed when needed); pi or Claude Code in a terminal
 *   under tmux → typed into that pane (the terminal stays the only writer). A terminal outside tmux, a
 *   Claude Code session no terminal runs, or one the phone's Claude bridge runs: no.
 * @returns {{ canMessage: boolean, via?: string, why?: string }}
 */
export function messageRoute(kind, driver) {
  const d = String(driver ?? "none");
  if (kind === "durable") return { canMessage: true, via: "durable" };
  if (kind === "rc") return { canMessage: true, via: "rc" };
  if (kind === "pi" || kind === "cc-local") {
    if (d === "terminal-tmux") return { canMessage: true, via: "tmux" };
    if (d === "terminal") return { canMessage: false, why: "terminal-no-tmux" };
    // The driver probe failed: never spawn an RPC child next to a terminal that may own the session.
    if (d === "unknown") return { canMessage: false, why: "driver-unknown" };
    if (kind === "pi") return { canMessage: true, via: "pi-rpc" };
    return { canMessage: false, why: d === "bridge" ? "phone-claude" : "no-terminal" };
  }
  return { canMessage: false, why: "unknown" };
}

const slug = (v, max) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
/** The id's letters and digits without its kind prefix (cse_, dur-), lowercased. */
const idChars = (id) => String(id ?? "").replace(/^cse_/, "").replace(/^dur-/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A label for a session that is safe to speak and to put in a summary: a bridge agent's own name (set by the
 * user or the shim; its sid when it has none), else `<folder>-<last N of the id>` in [a-z0-9-]. The id's TAIL is
 * used: pi ids are UUIDv7 and RC ids ULID-like, whose heads are timestamps shared by sessions hours apart. The
 * session's title is its own text, untrusted, and never used. `n` (default 6) grows when labels collide
 * (uniqueLabels).
 */
export function safeLabel(kind, id, cwd, name, n = 6) {
  if (kind === "durable") {
    const nm = defuse(name ?? "", { oneLine: true, max: 40 }).replace(/'/g, "’");
    return nm || defuse(id, { oneLine: true, max: 80 });
  }
  const chars = idChars(id);
  const tail = chars.slice(Math.max(0, chars.length - n));
  const dir = cwd ? slug(basename(String(cwd)), 20) : "";
  const prefix = dir || { pi: "pi", "cc-local": "claude", rc: "rc" }[kind] || "session";
  return tail ? `${prefix}-${tail}` : prefix;
}

/**
 * Labels unique within one inventory (case-insensitive): colliding rows get a longer id tail (10, 16, the whole
 * id), and as a last resort "-2", "-3", … in list order. Mutates and returns `rows`.
 */
export function uniqueLabels(rows) {
  const key = (l) => String(l).toLowerCase();
  for (const n of [10, 16, 64]) {
    const count = new Map();
    for (const r of rows) count.set(key(r.label), (count.get(key(r.label)) ?? 0) + 1);
    const clash = rows.filter((r) => count.get(key(r.label)) > 1);
    if (!clash.length) return rows;
    for (const r of clash) {
      r.label = r.kind === "durable" ? `${safeLabel(r.kind, r.id, r.cwd, r.title)}-${idChars(r.id).slice(-Math.min(n, 64))}` : safeLabel(r.kind, r.id, r.cwd, r.title, n);
    }
  }
  const seen = new Map();
  for (const r of rows) {
    const k = key(r.label);
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    if (c > 1) r.label = `${r.label}-${c}`;
  }
  return rows;
}

/** The tail of `body` that fits in `budget` bytes, with a `[… N bytes cut]` line in front when cut. */
function tailFit(body, budget) {
  if (bytes(body) <= budget) return body;
  const buf = Buffer.from(body, "utf8");
  // The marker's length depends on N; reserve its widest form.
  const reserve = bytes(`[… ${buf.length} bytes cut]\n`);
  let start = buf.length - Math.max(0, budget - reserve);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // never split a UTF-8 sequence
  return `[… ${start} bytes cut]\n` + buf.subarray(start).toString("utf8");
}

/**
 * @param {object} o
 * @param {object} [o.durable] the durable provider (listAgents, probe, getSessionStatus, getHistory)
 * @param {object} [o.pi] the pi provider (listSessions, driverOf, …)
 * @param {object} [o.cc] the cc-local provider (recentSessions or listSessions, driverOf, …)
 * @param {object} [o.rc] the claude-remote provider
 * @param {() => number} [o.now]
 */
export function createOverseerHost({ durable, pi, cc, rc, log = console, now = Date.now, limit = LIST_LIMIT, rcTranscriptBase, rcTwinOf } = {}) {
  const warn = (m) => log.warn?.(`[overseer] ${m}`);
  const ageS = (ms) => (ms == null ? null : Math.max(0, Math.round((now() - ms) / 1000)));

  async function safe(what, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      warn(`${what}: ${err.message}`);
      return fallback;
    }
  }

  async function durableRows(all = false) {
    if (!durable?.listAgents) return [];
    // `all`: every agent (archived or older than 7 days too), so a describe() still names it by its name.
    const agents = await (all ? durable.listAgents({ all: true }) : durable.listAgents());
    return agents.map((a) => ({
      id: a.sid,
      kind: "durable",
      engine: a.engine ?? "native",
      title: a.name ?? "",
      cwd: a.cwd ?? "",
      state: a.state ?? "idle",
      driver: "bridge",
      ageS: ageS(a.lastSeen),
      lastActivity: a.lastSeen ?? null,
      lastLine: a.lastLine ?? "",
    }));
  }

  /**
   * "input" | "draft" | "menu" | null: what the terminal of a tmux-driven pi / Claude Code session shows (the
   * allowlist); null is no bound pane. undefined when the provider cannot tell (no terminalScreen).
   */
  const screenOf = (p, kind, id) => (typeof p?.terminalScreen === "function" ? safe(`${kind} screen ${id}`, () => p.terminalScreen(id), "menu") : undefined);
  /** Why a tmux session takes no message besides a prompt (its state "waiting"): unsent text, or no bound pane. */
  const holdOf = (screen) => (screen === "draft" ? "draft-in-terminal" : screen === null ? "no-pane" : null);

  async function fileRows(p, kind, sessions) {
    const rows = [];
    for (const s of sessions ?? []) {
      if (!s?.id) continue;
      // A failed probe is "unknown" (no route), never "none" (which would mean pi RPC).
      const driver = await safe(`${kind} driver ${s.id}`, async () => (await p.driverOf?.(s.id)) ?? "none", "unknown");
      let state = s.status ?? (await safe(`${kind} status ${s.id}`, () => p.getSessionStatus?.(s.id), null)) ?? "idle";
      // A terminal in tmux: its screen is the truth (a terminal pi reports idle, cc-local only busy/idle). Anything
      // but its idle input box is "waiting" (a prompt or menu typing would answer).
      const screen = driver === "terminal-tmux" ? await screenOf(p, kind, s.id) : undefined;
      if (screen === "menu") state = "waiting";
      const hold = holdOf(screen); // unsent text (I7) or no bound pane (n9): canMessage false (finish)
      const hist = await safe(`${kind} history ${s.id}`, () => p.getHistory?.(s.id, 2), []);
      const t = msOf(s.timestamp);
      rows.push({ id: s.id, kind, title: s.title ?? "", cwd: s.cwd ?? "", state, driver, ageS: ageS(t), lastActivity: t, lastLine: lastLineOf(hist), ...(hold ? { hold } : {}) });
    }
    return rows;
  }

  async function rcRows(sessions) {
    const rows = [];
    for (const s of sessions ?? []) {
      if (!s?.id) continue;
      const state = s.status ?? (await safe(`rc status ${s.id}`, () => rc.getSessionStatus?.(s.id), null)) ?? "idle";
      const t = msOf(s.timestamp);
      rows.push({ id: s.id, kind: "rc", title: s.title ?? "", cwd: s.cwd ?? "", state, driver: "rc", ageS: ageS(t), lastActivity: t, lastLine: "" });
    }
    return rows;
  }

  /** label, normalized state, message route: added to every row in one place. */
  const finish = ({ hold, ...r }) => {
    const state = normalizeState(r.state);
    // A terminal at a permission / select prompt: typing would answer it, so it takes no message now. Unsent text
    // in its input box (it would be submitted with ours) or no bound pane: no message either.
    let route = waitingInTerminal(messageRoute(r.kind, r.driver), state);
    if (hold && route.via === "tmux") route = { canMessage: false, why: hold };
    return { ...r, label: safeLabel(r.kind, r.id, r.cwd, r.title), state, ...route };
  };
  // Driven by a terminal or a bridge child counts as active; an RC row's driver is always "rc", so RC counts by its
  // state and last activity like any other.
  const isActive = (r) =>
    r.kind === "durable" ||
    r.state !== "idle" ||
    ["bridge", "terminal", "terminal-tmux"].includes(r.driver) ||
    (r.lastActivity != null && now() - r.lastActivity <= ACTIVE_WINDOW_MS);
  /** The last inventory built with all=true (describe() reuses it for DESCRIBE_CACHE_MS). */
  let cache = null;

  /**
   * THE session inventory: durable first, then pi, cc-local, rc; a failing provider is skipped (logged).
   * Only active sessions unless `all` (see isActive); RC twins of local transcripts dropped.
   */
  async function sessionsList({ all = false } = {}) {
    const ccList = (n) => (cc.recentSessions ?? cc.listSessions).call(cc, n);
    const [dur, piRaw, ccRaw, rcRaw] = await Promise.all([
      durable ? safe("durable list", () => durableRows(all), []) : [],
      pi ? safe("pi list", async () => (await pi.listSessions(limit)) ?? [], []) : [],
      cc ? safe("cc list", async () => (await ccList(limit)) ?? [], []) : [],
      rc ? safe("rc list", async () => (await rc.listSessions(limit)) ?? [], []) : [],
    ]);
    const rcCopy = rcRaw.map((s) => ({ ...s })); // twins lend title + cwd to these copies only
    const ccKept = safe("rc twins", () => dropRcTwins(ccRaw, rcCopy, { base: rcTranscriptBase, twinOf: rcTwinOf }), ccRaw);
    const out = [
      ...dur,
      ...(pi ? await safe("pi rows", () => fileRows(pi, "pi", piRaw), []) : []),
      ...(cc ? await safe("cc rows", async () => fileRows(cc, "cc-local", await ccKept), []) : []),
      ...(rc ? await safe("rc rows", () => rcRows(rcCopy), []) : []),
    ].map(finish);
    // Unique among every listed row (all of them), so the active view and describe() agree on each label.
    uniqueLabels(out);
    if (all) cache = { at: now(), rows: out };
    return all ? out : out.filter(isActive);
  }

  async function kindOf(id) {
    if (typeof id !== "string" || !id) return null;
    if (durable && id.startsWith("dur-") && (await safe("durable probe", () => durable.probe(id), false))) return "durable";
    if (rc && (await safe("rc probe", () => rc.probe?.(id), false))) return "rc";
    if (pi && (await safe("pi probe", () => pi.probe?.(id), false))) return "pi";
    if (cc && (await safe("cc probe", () => cc.probe?.(id), false))) return "cc-local";
    return null;
  }

  const providerOf = (kind) => ({ durable, pi, "cc-local": cc, rc })[kind];

  async function driverOf(id) {
    const kind = await kindOf(id);
    if (kind === "durable") return "bridge";
    if (kind === "rc") return "rc";
    if (kind === "pi" || kind === "cc-local") {
      return (await safe(`${kind} driver ${id}`, async () => (await providerOf(kind).driverOf?.(id)) ?? "none", "unknown")) ?? "none";
    }
    return "none";
  }

  const refuse = (message) => Object.assign(new Error(message), { statusCode: 403 });
  /** The normalized state of a session of a known kind, now ("idle" when unreadable is never assumed: null). */
  const stateNow = async (kind, id) => {
    const p = providerOf(kind);
    const st = await safe(`${kind} status ${id}`, () => p.getSessionStatus?.(id), null);
    if ((kind === "pi" || kind === "cc-local") && (await driverOf(id)) === "terminal-tmux" && (await screenOf(p, kind, id)) === "menu") return "waiting";
    return normalizeState(st ?? "idle");
  };
  /** "draft-in-terminal" | "no-pane" | null for a session of a known kind, now (a tmux terminal's screen). */
  const holdNow = async (kind, id) => {
    if (kind !== "pi" && kind !== "cc-local") return null;
    if ((await driverOf(id)) !== "terminal-tmux") return null;
    return holdOf(await screenOf(providerOf(kind), kind, id));
  };

  return {
    /**
     * `{ kind, driver, label, canMessage, via?, why? }` of a session (probed now), or null for an unknown id.
     * The label is the inventory's (safeLabel), so the summary the user confirms names the session as
     * list_sessions did.
     */
    async describe(id) {
      const kind = await kindOf(id);
      if (!kind) return null;
      const driver = await driverOf(id);
      // The inventory of the last DESCRIBE_CACHE_MS (an action's propose and confirm read the same labels);
      // rebuilt once when it is older or does not hold the id.
      const find = (rows) => (rows ?? []).find((r) => r.id === id && r.kind === kind);
      let row = cache && now() - cache.at <= DESCRIBE_CACHE_MS ? find(cache.rows) : null;
      if (!row) row = find(await safe(`${kind} row ${id}`, () => sessionsList({ all: true }), []));
      const label = row?.label ?? safeLabel(kind, id, "", "");
      return { kind, driver, label, ...messageRoute(kind, driver) };
    },

    /** The normalized state (idle | busy | waiting) of one session now, or null for an unknown id. */
    async stateOf(id) {
      const kind = await kindOf(id);
      if (!kind) return null;
      return stateNow(kind, id);
    },

    /**
     * Why a tmux-driven session takes no message now besides a prompt: "draft-in-terminal" (unsent text in its
     * input box, I7), "no-pane" (no bound pane, n9), or null (anything else, an unknown id too).
     */
    async terminalHold(id) {
      const kind = await kindOf(id);
      if (!kind) return null;
      return holdNow(kind, id);
    },

    /**
     * The tail of one session's history as a fingerprint (`fp`: its last 6 items), the newest item's role and the
     * newest assistant text (untrusted; the caller defuses it). Null for an unknown id or an unreadable history.
     */
    async replySnapshot(id) {
      const kind = await kindOf(id);
      if (!kind) return null;
      const hist = await safe(`${kind} history ${id}`, () => providerOf(kind).getHistory?.(id, 6), null);
      if (!Array.isArray(hist)) return null;
      const a = hist.filter((h) => h?.role === "assistant" && h.text).at(-1);
      return { fp: JSON.stringify(hist.map((h) => [h?.role ?? "", String(h?.text ?? "")])), lastRole: hist.at(-1)?.role ?? null, text: a ? String(a.text) : "" };
    },

    /**
     * Run a CONFIRMED action (src/overseer/actions.mjs calls this only after the user's yes). The
     * session's kind and driver are probed again here: a terminal-driven pi and cc-local are never
     * written to, and only bridge (durable) sessions are interrupted or stopped.
     */
    async execute(action) {
      const { id, kind, args, origin } = action;
      const requestId = "ovs-act:" + id;
      // Defense in depth (actions.mjs refuses it at propose): no command, no control character, one line.
      if (typeof args?.task === "string" && startsWithCommand(args.task)) throw Object.assign(new Error(NO_COMMANDS), { statusCode: 400 });
      if (typeof args?.text === "string") {
        const bad = textProblem(args.text);
        if (bad) throw Object.assign(new Error(bad), { statusCode: 400 });
      }
      if (kind === "session_start") {
        const opts = { engine: args.engine, name: args.label, model: args.model, origin: origin === "evenai" ? "evenai" : "overseer", requestId, ttlS: args.ttlS };
        if (args.maxTurns != null) opts.maxTurns = args.maxTurns;
        if (args.factory) opts.factory = true;
        const r = await durable.prompt(undefined, args.task, args.cwd, opts);
        return { sessionId: r.sessionId };
      }
      const k = await kindOf(args.id);
      if (!k) throw Object.assign(new Error(`no session ${args.id}`), { statusCode: 404 });
      if (kind === "session_message") {
        // The route is probed again here (a terminal may have come or gone since the yes).
        const route = messageRoute(k, await driverOf(args.id));
        if (!route.canMessage) throw refuse(cannotMessage(args.id, k, route.why));
        if (k !== "durable" && String(args.text).length > SESSION_TEXT_MAX) {
          throw Object.assign(new Error(`'text' must be a string of 1-${SESSION_TEXT_MAX} characters`), { statusCode: 400 });
        }
        const notDelivered = () => Object.assign(new Error(`${args.id}: the message was not delivered (no terminal took it)`), { statusCode: 409 });
        let r;
        if (k === "durable") r = await durable.prompt(args.id, args.text, undefined, { requestId, whenBusy: args.steer ? "steer" : "followUp" });
        else if (k === "rc") r = await rc.prompt(args.id, args.text);
        else if (route.via === "tmux") {
          // pi and Claude Code in tmux: one literal line into the pane bound to that terminal's pid, checked again
          // right before typing; never a resume, a spawn or the official router. A session waiting at a permission /
          // select prompt is refused (its state now, and the pane's screen right before typing).
          const waiting = () => Object.assign(new Error(waitingText(k, args.label || args.id)), { statusCode: 409 });
          // Unsent text in its input box (I7) is refused the same way: ours would be submitted with it.
          const draft = () => Object.assign(new Error(draftText(k, args.label || args.id)), { statusCode: 409 });
          if ((await stateNow(k, args.id)) === "waiting") throw waiting();
          if ((await holdNow(k, args.id)) === "draft-in-terminal") throw draft();
          const p = providerOf(k);
          if (typeof p.deliverToTerminal !== "function") throw notDelivered();
          r = await p.deliverToTerminal(args.id, args.text);
          if (r?.waiting) throw waiting();
          if (r?.draft) throw draft();
        } else {
          // pi RPC: refused (blocked) if a terminal took the session over since the probe.
          r = await pi.prompt(args.id, args.text, undefined, { noTerminal: true });
        }
        // Only a delivery is "sent": a blocked or passed-through prompt is a failed action (409), never a result.
        if (k !== "durable" && (r?.blocked || r?.passThrough)) throw notDelivered();
        return { sessionId: args.id };
      }
      if (k !== "durable") throw refuse(kind === "session_stop" ? "only bridge agents can be stopped" : "only bridge agents can be interrupted");
      if (kind === "session_interrupt") {
        await durable.interrupt(args.id);
        return { sessionId: args.id, interrupted: true };
      }
      if (kind === "session_stop") {
        await durable.stopSession(args.id);
        return { sessionId: args.id, stopped: true };
      }
      throw Object.assign(new Error(`unknown action kind ${kind}`), { statusCode: 400 });
    },

    sessionsList,

    /** The inventory as sent to Even AI (GET /api/overseer/sessions): no titles, last lines or folders. */
    async inventory({ all = false } = {}) {
      return (await sessionsList({ all })).map(publicRow);
    },

    /**
     * Status and the last `n` history items of one session, fenced as untrusted data and capped at
     * READ_CAP_BYTES (the newest part is kept). "No session <id>." for an unknown id.
     */
    async sessionRead(id, n = 5) {
      const kind = await kindOf(id);
      if (!kind) return `No session ${id}.`;
      const p = providerOf(kind);
      const status = (await safe(`${kind} status ${id}`, () => p.getSessionStatus?.(id), null)) ?? "unknown";
      const hist = (await safe(`${kind} history ${id}`, () => p.getHistory?.(id, n), [])) ?? [];
      const driver = await driverOf(id);
      // The head (kind, driver, status) is always kept; the history is cut from the oldest end.
      const head = `${UNTRUSTED_OPEN(defuse(id, { oneLine: true, max: 80 }))}\nkind: ${kind}\ndriver: ${driver}\nstatus: ${defuse(status, { oneLine: true, max: 40 })}`;
      const lines = hist.map((h) => `${h.role === "user" ? "user" : "assistant"}: ${defuse(h.text)}`);
      if (!lines.length) return `${head}\n(no history)\n${UNTRUSTED_CLOSE}`;
      const budget = READ_CAP_BYTES - bytes(head) - bytes(UNTRUSTED_CLOSE) - 2;
      return `${head}\n${tailFit(lines.join("\n"), budget)}\n${UNTRUSTED_CLOSE}`;
    },

    driverOf,
    kindOf,
  };
}

/** A terminal (tmux) route with the session waiting at a prompt takes no message: `{canMessage:false, why}`. */
export function waitingInTerminal(route, state) {
  return route?.via === "tmux" && state === "waiting" ? { canMessage: false, why: "waiting-in-terminal" } : route;
}

/** The refusal for a message to a terminal session that waits at a permission / select prompt. */
export function waitingText(kind, label) {
  return `${KIND_WORD[kind] ?? "session"} '${defuse(label, { oneLine: true, max: 60 })}' is showing a prompt or menu in its terminal; answer it there`;
}

/** The refusal for a message to a terminal session whose input box holds unsent text (a draft, I7). */
export function draftText(kind, label) {
  return `${KIND_WORD[kind] ?? "session"} '${defuse(label, { oneLine: true, max: 60 })}' has unsent text in its terminal; send or clear it there`;
}

/** The refusal text for a session that cannot receive a message (host text; "driven from a terminal" kept for the shim). */
export function cannotMessage(id, kind, why) {
  const who = `${KIND_WORD[kind] ?? "session"} ${defuse(id, { oneLine: true, max: 80 })}`;
  if (why === "terminal-no-tmux") return `${who} is driven from a terminal outside tmux; the overseer only watches it`;
  return `${who} can't receive messages: ${WHY_NOT[why] ?? WHY_NOT.unknown}`;
}

/** An inventory row for Even AI: host-built fields only (no title, last line or folder). */
export function publicRow(r) {
  const out = { id: r.id, kind: r.kind };
  if (r.engine) out.engine = r.engine;
  Object.assign(out, { label: r.label, state: r.state, driver: r.driver, lastActivity: r.lastActivity ?? null, ageS: r.ageS ?? null, canMessage: r.canMessage });
  if (r.via) out.via = r.via;
  if (r.why) out.why = r.why;
  return out;
}

/** A list row as one fenced line for the model (untrusted fields defused and cut). */
export function rowLine(r) {
  const parts = [
    `id ${defuse(r.id, { oneLine: true, max: 80 })}`,
    `kind ${r.kind}`,
    r.engine ? `engine ${r.engine}` : null,
    r.title ? `name "${defuse(r.title, { oneLine: true, max: LINE_MAX })}"` : null,
    `state ${defuse(r.state, { oneLine: true, max: 40 })}`,
    `driver ${r.driver}`,
    r.label ? `label ${defuse(r.label, { oneLine: true, max: 60 })}` : null,
    r.canMessage != null ? `messages ${r.canMessage ? `yes (${r.via})` : `no (${WHY_NOT[r.why] ?? r.why})`}` : null,
    r.ageS != null ? `age ${r.ageS}s` : null,
    r.cwd ? `cwd ${defuse(r.cwd, { oneLine: true, max: LINE_MAX })}` : null,
    r.lastLine ? `last line "${defuse(r.lastLine, { oneLine: true, max: LINE_MAX })}"` : null,
  ];
  return parts.filter(Boolean).join(" | ");
}
