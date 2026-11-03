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
import { bytes, READ_CAP_BYTES } from "./docs.mjs";

const LIST_LIMIT = 10; // rows per provider
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
export function createOverseerHost({ durable, pi, cc, rc, log = console, now = Date.now, limit = LIST_LIMIT } = {}) {
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
      lastLine: a.lastLine ?? "",
    }));
  }

  async function fileRows(p, kind, list) {
    const rows = [];
    for (const s of (await list()) ?? []) {
      if (!s?.id) continue;
      const driver = await safe(`${kind} driver ${s.id}`, () => p.driverOf?.(s.id) ?? "none", "none");
      const state = s.status ?? (await safe(`${kind} status ${s.id}`, () => p.getSessionStatus?.(s.id), null)) ?? "idle";
      const hist = await safe(`${kind} history ${s.id}`, () => p.getHistory?.(s.id, 2), []);
      rows.push({ id: s.id, kind, title: s.title ?? "", cwd: s.cwd ?? "", state, driver, ageS: ageS(msOf(s.timestamp)), lastLine: lastLineOf(hist) });
    }
    return rows;
  }

  async function rcRows() {
    const rows = [];
    for (const s of (await rc.listSessions(limit)) ?? []) {
      if (!s?.id) continue;
      const state = s.status ?? (await safe(`rc status ${s.id}`, () => rc.getSessionStatus?.(s.id), null)) ?? "idle";
      rows.push({ id: s.id, kind: "rc", title: s.title ?? "", cwd: s.cwd ?? "", state, driver: "rc", ageS: ageS(msOf(s.timestamp)), lastLine: "" });
    }
    return rows;
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

  return {
    /** Every session, durable first, then pi, cc-local, rc; a failing provider is skipped (logged). */
    async sessionsList() {
      const out = [];
      if (durable) out.push(...(await safe("durable list", durableRows, [])));
      if (pi) out.push(...(await safe("pi list", () => fileRows(pi, "pi", () => pi.listSessions(limit)), [])));
      if (cc) out.push(...(await safe("cc list", () => fileRows(cc, "cc-local", () => (cc.recentSessions ?? cc.listSessions).call(cc, limit)), [])));
      if (rc) out.push(...(await safe("rc list", rcRows, [])));
      return out;
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

/** A list row as one fenced line for the model (untrusted fields defused and cut). */
export function rowLine(r) {
  const parts = [
    `id ${r.id}`,
    `kind ${r.kind}`,
    r.engine ? `engine ${r.engine}` : null,
    r.title ? `name "${defuse(r.title, { oneLine: true, max: LINE_MAX })}"` : null,
    `state ${r.state}`,
    `driver ${r.driver}`,
    r.ageS != null ? `age ${r.ageS}s` : null,
    r.cwd ? `cwd ${defuse(r.cwd, { oneLine: true, max: LINE_MAX })}` : null,
    r.lastLine ? `last line "${defuse(r.lastLine, { oneLine: true, max: LINE_MAX })}"` : null,
  ];
  return parts.filter(Boolean).join(" | ");
}
