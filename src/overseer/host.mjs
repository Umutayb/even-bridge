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
import { dropRcTwins } from "../session-twins.mjs";

const LIST_LIMIT = 10; // rows per provider
/** A pi / Claude Code / RC session counts as active while driven, not idle, or touched within this window. */
export const ACTIVE_WINDOW_MS = 12 * 3600 * 1000;
/** What a session kind is called in summaries and spoken lines. */
export const KIND_WORD = Object.freeze({ durable: "agent", pi: "pi session", "cc-local": "Claude session", rc: "Claude RC session" });
/** Why a session cannot receive a message (host text; the shim maps it to a fixed sentence). */
export const WHY_NOT = Object.freeze({
  "terminal-no-tmux": "it runs in a terminal outside tmux, so nothing can type into it",
  "no-terminal": "no terminal runs it; open it in tmux first",
  "phone-claude": "the phone's Claude bridge runs it; message it from the phone",
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

/** idle | busy | waiting from a provider's own state word (unknown words count as busy: never "idle" by guess). */
export function normalizeState(state) {
  const s = String(state ?? "").toLowerCase();
  if (!s || s === "idle" || s === "done" || s === "stopped" || s === "ended" || s === "unknown") return "idle";
  if (/await|wait|permission|question|input/.test(s)) return "waiting";
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
    if (kind === "pi") return { canMessage: true, via: "pi-rpc" };
    return { canMessage: false, why: d === "bridge" ? "phone-claude" : "no-terminal" };
  }
  return { canMessage: false, why: "unknown" };
}

/**
 * A label for a session that is safe to speak and to put in a summary: a bridge agent's own name (set by the
 * user or the shim), else `<folder>-<first 6 of the id>` in [a-z0-9-] (the session's title is its own text,
 * untrusted, and never used).
 */
export function safeLabel(kind, id, cwd, name) {
  if (kind === "durable") {
    const n = defuse(name ?? "", { oneLine: true, max: 40 }).replace(/'/g, "’");
    if (n) return n;
  }
  const slug = (v, max) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  const short = slug(String(id ?? "").replace(/^cse_/, "").replace(/^dur-/, ""), 64).replace(/-/g, "").slice(0, 6);
  const dir = cwd ? slug(basename(String(cwd)), 20) : "";
  const prefix = dir || { pi: "pi", "cc-local": "claude", rc: "rc", durable: "agent" }[kind] || "session";
  return short ? `${prefix}-${short}` : prefix;
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

  async function durableRows() {
    if (!durable?.listAgents) return [];
    const agents = await durable.listAgents();
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

  async function fileRows(p, kind, sessions) {
    const rows = [];
    for (const s of sessions ?? []) {
      if (!s?.id) continue;
      const driver = await safe(`${kind} driver ${s.id}`, () => p.driverOf?.(s.id) ?? "none", "none");
      const state = s.status ?? (await safe(`${kind} status ${s.id}`, () => p.getSessionStatus?.(s.id), null)) ?? "idle";
      const hist = await safe(`${kind} history ${s.id}`, () => p.getHistory?.(s.id, 2), []);
      const t = msOf(s.timestamp);
      rows.push({ id: s.id, kind, title: s.title ?? "", cwd: s.cwd ?? "", state, driver, ageS: ageS(t), lastActivity: t, lastLine: lastLineOf(hist) });
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
  const finish = (r) => {
    const route = messageRoute(r.kind, r.driver);
    return { ...r, label: safeLabel(r.kind, r.id, r.cwd, r.title), state: normalizeState(r.state), ...route };
  };
  const isActive = (r) => r.kind === "durable" || r.state !== "idle" || r.driver !== "none" || (r.lastActivity != null && now() - r.lastActivity <= ACTIVE_WINDOW_MS);

  /**
   * THE session inventory: durable first, then pi, cc-local, rc; a failing provider is skipped (logged).
   * Only active sessions unless `all` (see isActive); RC twins of local transcripts dropped.
   */
  async function sessionsList({ all = false } = {}) {
    const ccList = (n) => (cc.recentSessions ?? cc.listSessions).call(cc, n);
    const [dur, piRaw, ccRaw, rcRaw] = await Promise.all([
      durable ? safe("durable list", durableRows, []) : [],
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
    if (kind === "pi" || kind === "cc-local") return (await safe(`${kind} driver ${id}`, () => providerOf(kind).driverOf?.(id), null)) ?? "none";
    return "none";
  }

  const refuse = (message) => Object.assign(new Error(message), { statusCode: 403 });

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
      const row = (await safe(`${kind} row ${id}`, () => sessionsList({ all: true }), [])).find((r) => r.id === id && r.kind === kind);
      const label = row?.label ?? safeLabel(kind, id, "", "");
      return { kind, driver, label, ...messageRoute(kind, driver) };
    },

    /** The normalized state (idle | busy | waiting) of one session now, or null for an unknown id. */
    async stateOf(id) {
      const kind = await kindOf(id);
      if (!kind) return null;
      const st = await safe(`${kind} status ${id}`, () => providerOf(kind).getSessionStatus?.(id), null);
      return normalizeState(st ?? "idle");
    },

    /** The newest assistant text of one session (untrusted; the caller fences or defuses it), or "". */
    async lastReply(id) {
      const kind = await kindOf(id);
      if (!kind) return "";
      const hist = (await safe(`${kind} history ${id}`, () => providerOf(kind).getHistory?.(id, 4), [])) ?? [];
      const a = hist.filter((h) => h?.role === "assistant" && h.text).at(-1);
      return a ? String(a.text) : "";
    },

    /**
     * Run a CONFIRMED action (src/overseer/actions.mjs calls this only after the user's yes). The
     * session's kind and driver are probed again here: a terminal-driven pi and cc-local are never
     * written to, and only bridge (durable) sessions are interrupted or stopped.
     */
    async execute(action) {
      const { id, kind, args, origin } = action;
      const requestId = "ovs-act:" + id;
      // Defense in depth (actions.mjs refuses it at propose): proposal text never starts a command.
      for (const t of [args?.task, args?.text]) {
        if (typeof t === "string" && /^\s*[\/!]/.test(t)) throw Object.assign(new Error("the overseer cannot send commands"), { statusCode: 400 });
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
        if (k === "durable") await durable.prompt(args.id, args.text, undefined, { requestId, whenBusy: args.steer ? "steer" : "followUp" });
        else if (k === "rc") await rc.prompt(args.id, args.text);
        else if (k === "pi") await pi.prompt(args.id, args.text); // tmux pane of its terminal, else pi RPC
        else {
          // cc-local: only into the tmux pane of the terminal claude that runs it; any other outcome is not "sent".
          const r = await cc.prompt(args.id, args.text);
          if (!r || r.passThrough || r.blocked) throw Object.assign(new Error(`${args.id}: the message was not delivered (no terminal took it)`), { statusCode: 409 });
        }
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
