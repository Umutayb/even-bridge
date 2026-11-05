// Extension router — mounted BEFORE the official eventsRouter/coreRouter.
//
// Intercepts only requests that belong to EXTENDED sessions (claude-remote,
// pi, cc-local); everything else falls through to the official routers
// unchanged, so Codex sessions and officially-launched Claude Code sessions
// behave exactly as stock even-terminal.
//
// Routing rule (session-ID ownership, not provider param — the Even phone
// omits the provider on follow-up calls and only ever knows "claude"/"codex"):
//   1. explicit provider param ∈ extended names → that provider (CLI/test path)
//   2. sessionId claimed/probed to an extended provider → that provider
//   3. otherwise → next() (official router)
//
// /api/sessions is merged (every enabled extension + the local slot), all
// tagged provider "claude", because the phone filters its list to the provider
// it thinks it's connected to. The local slot is served from a disk scan of
// ~/.claude/projects (ground truth — includes live sessions the official SDK
// list skips) with live busy/idle status; the SDK list is a fallback only.

import { Router } from "express";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";
import { getDefaultProvider } from "@evenrealities/even-terminal/dist/session.js";
import { exposeType } from "./info-cache.mjs";
import { getOwner } from "./ownership.mjs";
import { dropRcTwins } from "./session-twins.mjs";
import { listCcSessions, ccProjectsBase } from "./cc-transcripts.mjs";

const STATUS_CHECK_COUNT = 10; // mirrors core.js

// Durable prompt fields (POST /api/prompt): limits per the plan's rulings.
export const AGENT_LIMITS = Object.freeze({ nameMax: 24, maxTurns: 60, requestIdMax: 128, modelMax: 32 });
export const AGENT_ORIGINS = Object.freeze(["evenai", "phone", "overseer"]);
export const AGENT_ENGINES = Object.freeze(["native", "lets-code"]);
const NAME_RE = /^[\w .-]+$/;

/**
 * Validate the durable prompt fields. Absent (undefined/null) fields are left
 * out; `maxTurns` may be a number or a digit-only string and comes back a number.
 * @returns {{ opts: object } | { error: string }}
 */
/**
 * One session row as the phone expects it: the official providers send `timestamp` as an ISO-8601 string and the
 * app's model parses it as such; durable/overseer rows carry epoch ms internally (ordering), so the wire copy gets
 * the ISO form. Every other field passes through unchanged. Never throws (a bad number stays as it was).
 */
export function wireSession(row) {
  if (!row || typeof row !== "object") return row;
  const t = row.timestamp;
  if (typeof t !== "number" || !Number.isFinite(t)) return row;
  try {
    return { ...row, timestamp: new Date(t).toISOString() };
  } catch {
    return row;
  }
}

export function agentOpts({ name, model, maxTurns, requestId, origin, engine, factory } = {}) {
  const opts = {};
  const L = AGENT_LIMITS;
  if (name != null) {
    if (typeof name !== "string" || name.length < 1 || name.length > L.nameMax || !NAME_RE.test(name)) {
      return { error: `'name' must be 1-${L.nameMax} characters of letters, digits, space, '_', '.' or '-'` };
    }
    opts.name = name;
  }
  if (model != null) {
    if (typeof model !== "string" || model.length < 1 || model.length > L.modelMax) {
      return { error: `'model' must be a string of 1-${L.modelMax} characters` };
    }
    opts.model = model;
  }
  if (maxTurns != null) {
    const n =
      typeof maxTurns === "number" ? maxTurns : typeof maxTurns === "string" && /^\d+$/.test(maxTurns) ? Number(maxTurns) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > L.maxTurns) {
      return { error: `'maxTurns' must be an integer from 1 to ${L.maxTurns}` };
    }
    opts.maxTurns = n;
  }
  if (requestId != null) {
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > L.requestIdMax) {
      return { error: `'requestId' must be a string of 1-${L.requestIdMax} characters` };
    }
    opts.requestId = requestId;
  }
  if (origin != null) {
    if (!AGENT_ORIGINS.includes(origin)) {
      return { error: `'origin' must be one of ${AGENT_ORIGINS.join(", ")}` };
    }
    opts.origin = origin;
  }
  if (engine != null) {
    if (!AGENT_ENGINES.includes(engine)) {
      return { error: `'engine' must be one of ${AGENT_ENGINES.join(", ")}` };
    }
    opts.engine = engine;
  }
  if (factory != null) {
    if (typeof factory !== "boolean") return { error: "'factory' must be true or false" };
    if (factory && opts.engine !== "lets-code") return { error: "'factory' needs engine lets-code" };
    opts.factory = factory;
  }
  return { opts };
}

// POST /api/agents/:sid/factory body limits. The how-to-run goes to lets-code unquoted
// (ruling 4: it splits on whitespace), so it is one line without quotes.
export const FACTORY_LIMITS = Object.freeze({ ticketMax: 8000, howToRunMax: 200 });

/**
 * Validate a factory toggle body.
 * @returns {{ on: boolean, opts: { ticket?: string, howToRun?: string } } | { error: string }}
 */
export function factoryOpts({ on, ticket, howToRun } = {}) {
  const L = FACTORY_LIMITS;
  if (typeof on !== "boolean") return { error: "'on' must be true or false" };
  const opts = {};
  if (ticket != null) {
    if (typeof ticket !== "string" || ticket.length < 1 || ticket.length > L.ticketMax) {
      return { error: `'ticket' must be a string of 1-${L.ticketMax} characters` };
    }
    if (!on) return { error: "'ticket' needs on true" };
    opts.ticket = ticket;
  }
  if (howToRun != null) {
    if (typeof howToRun !== "string" || howToRun.trim().length < 1 || howToRun.length > L.howToRunMax) {
      return { error: `'howToRun' must be a string of 1-${L.howToRunMax} characters` };
    }
    if (/[\r\n"'`]/.test(howToRun)) return { error: "'howToRun' must be one line without quotes" };
    if (opts.ticket == null) return { error: "'howToRun' needs a ticket" };
    opts.howToRun = howToRun.trim();
  }
  return { on, opts };
}

/**
 * @param {{
 *   hub: import("./hub.mjs").Hub,
 *   providers: object[],                   // enabled extended providers
 *   getDefaultLocalProvider: () => object, // official default provider thunk
 *   rcTranscriptBase?: string,             // ~/.claude/projects base (tests)
 * }} deps
 */
/** POST /api/overseer/ask limits (the overseer's wait is capped at 15 s). */
export const OVERSEER_LIMITS = Object.freeze({ questionMax: 2000, requestIdMax: 128, waitMsMax: 15000 });

export const OVERSEER_ASK_MODES = Object.freeze(["ask", "tell"]);
export const ACTION_BY = Object.freeze(["evenai", "http"]);

/**
 * Validate an overseer ask body: `{ question, requestId, waitMs, mode, handoff? }` or `{ error }`.
 * `handoff` (`{tag, label, ttlS}`, tell only) is checked further by the overseer (400 while hand-offs are off).
 */
export function overseerAskOpts({ question, requestId, waitMs, mode, handoff } = {}) {
  if (typeof question !== "string" || !question.trim()) return { error: "Missing 'question'" };
  if (question.length > OVERSEER_LIMITS.questionMax) return { error: `'question' must be 1-${OVERSEER_LIMITS.questionMax} characters` };
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > OVERSEER_LIMITS.requestIdMax) {
    return { error: `'requestId' must be 1-${OVERSEER_LIMITS.requestIdMax} characters` };
  }
  if (waitMs != null && (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > OVERSEER_LIMITS.waitMsMax)) {
    return { error: `'waitMs' must be 0-${OVERSEER_LIMITS.waitMsMax}` };
  }
  if (mode != null && !OVERSEER_ASK_MODES.includes(mode)) return { error: `'mode' must be one of ${OVERSEER_ASK_MODES.join(", ")}` };
  const out = { question, requestId, waitMs: waitMs ?? OVERSEER_LIMITS.waitMsMax, mode: mode ?? "ask" };
  if (handoff != null) {
    if (typeof handoff !== "object" || Array.isArray(handoff)) return { error: "'handoff' must be an object" };
    if (out.mode !== "tell") return { error: "a hand-off needs mode tell" };
    out.handoff = handoff;
  }
  return out;
}

/** Validate a POST /api/overseer/actions body (the shim's one gate): `{ kind, args, requestId }` or `{ error }`. */
export function overseerActionOpts({ kind, args, origin, requestId } = {}) {
  if (typeof kind !== "string" || !kind) return { error: "Missing 'kind'" };
  if (args != null && (typeof args !== "object" || Array.isArray(args))) return { error: "'args' must be an object" };
  // Only Even AI proposes over HTTP; the overseer's own proposals come from its tools in this process.
  if (origin !== "evenai") return { error: "'origin' must be evenai" };
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > OVERSEER_LIMITS.requestIdMax) {
    return { error: `'requestId' must be 1-${OVERSEER_LIMITS.requestIdMax} characters` };
  }
  return { kind, args: args ?? {}, requestId };
}

/** /api/assistant/* body limits (Task A1). */
export const ASSISTANT_LIMITS = Object.freeze({ textMax: 4000, requestIdMax: 128, modelMax: 64, dialogIdMax: 128 });
export const ASSISTANT_WHEN_BUSY = Object.freeze(["steer", "followUp"]);
export const ASSISTANT_THINKING = Object.freeze(["off", "minimal", "low", "medium", "high"]);

/** Validate POST /api/assistant/prompt: `{ text, requestId, whenBusy }` or `{ error }`. */
export function assistantPromptOpts({ text, requestId, whenBusy } = {}) {
  const L = ASSISTANT_LIMITS;
  if (typeof text !== "string" || !text.trim()) return { error: "Missing 'text'" };
  if (text.length > L.textMax) return { error: `'text' must be 1-${L.textMax} characters` };
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > L.requestIdMax) {
    return { error: `'requestId' must be 1-${L.requestIdMax} characters` };
  }
  if (whenBusy != null && !ASSISTANT_WHEN_BUSY.includes(whenBusy)) return { error: "'whenBusy' must be steer or followUp" };
  return { text, requestId, whenBusy: whenBusy ?? "steer" };
}

/** Validate POST /api/assistant/model: `{ model?, thinking? }` (at least one) or `{ error }`. */
export function assistantModelOpts({ model, thinking } = {}) {
  const out = {};
  if (model != null) {
    if (typeof model !== "string" || model.length < 3 || model.length > ASSISTANT_LIMITS.modelMax || !/^[\w.-]+\/[\w.:-]+$/.test(model)) {
      return { error: `'model' must be <provider>/<model id> (at most ${ASSISTANT_LIMITS.modelMax} characters)` };
    }
    out.model = model;
  }
  if (thinking != null) {
    if (!ASSISTANT_THINKING.includes(thinking)) return { error: `'thinking' must be one of ${ASSISTANT_THINKING.join(", ")}` };
    out.thinking = thinking;
  }
  if (!out.model && !out.thinking) return { error: "Missing 'model' or 'thinking'" };
  return out;
}

/** Validate POST /api/assistant/dialog: `{ id, answer: {value}|{confirmed}|{cancelled:true} }` or `{ error }`. */
export function assistantDialogOpts({ id, value, confirmed, cancelled } = {}) {
  if (typeof id !== "string" || id.length < 1 || id.length > ASSISTANT_LIMITS.dialogIdMax) return { error: "Missing 'id'" };
  const given = [value !== undefined, confirmed !== undefined, cancelled !== undefined].filter(Boolean).length;
  if (given !== 1) return { error: "Give exactly one of 'value', 'confirmed' or 'cancelled'" };
  if (value !== undefined && (typeof value !== "string" || value.length > ASSISTANT_LIMITS.textMax)) return { error: "'value' must be a string" };
  if (confirmed !== undefined && typeof confirmed !== "boolean") return { error: "'confirmed' must be true or false" };
  if (cancelled !== undefined && cancelled !== true) return { error: "'cancelled' must be true" };
  return { id, answer: value !== undefined ? { value } : confirmed !== undefined ? { confirmed } : { cancelled: true } };
}

const seqParam = (v) => {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * Does a /api/info request with this `provider` param land on the official
 * Claude provider (the object the info cache wraps)? No param → the official
 * default provider (DEFAULT_PROVIDER, "claude" when unset).
 */
function infoTargetsClaude(param) {
  if (param === undefined) {
    try {
      return getDefaultProvider() === "claude";
    } catch {
      return false; // invalid DEFAULT_PROVIDER: let the official route answer
    }
  }
  return param === "claude";
}

export function createExtRouter({ hub, providers, getDefaultLocalProvider, rcTranscriptBase, overseer = null, infoCache = null, assistant = null } = {}) {
  const ext = providers.filter(Boolean); // [{name, probe, listSessions, ...}]
  const router = Router();

  const byName = (name) => ext.find((p) => p.name === name) || null;
  const ccBaseDir = rcTranscriptBase || ccProjectsBase();
  const ccProv = ext.find((p) => p.name === "cc-local") || null;

  /** Which extended provider (if any) owns this session id? */
  async function ownProvider(sessionId) {
    if (!sessionId) return null;
    const cached = getOwner(sessionId);
    if (cached) {
      const p = byName(cached);
      if (p) return p;
    }
    for (const p of ext) {
      try {
        if (await p.probe(sessionId)) return p;
      } catch (err) {
        console.warn(`[bridge] ${p.name} probe(${sessionId.slice(0, 8)}) failed: ${err.message}`);
      }
    }
    return null;
  }

  /** Fill in session status the way the official route does. */
  async function fillStatus(p, sessions) {
    for (const [i, s] of sessions.slice(0, STATUS_CHECK_COUNT).entries()) {
      if (s.status) continue;
      try {
        s.status = await p.getSessionStatus(s.id);
      } catch {
        /* leave null */
      }
    }
  }

  // ── GET /api/sessions — merged list ────────────────────────────────────────
  router.get("/sessions", async (req, res, next) => {
    const providerName = req.query.provider;
    if (providerName && providerName !== "claude") return next();
    const limit = Number(req.query.limit) || 10;
    const cwd = req.query.cwd;
    const out = [];

    // Local sessions — from the disk scan of the CC projects dir (ground
    // truth; the official SDK list skips in-progress CC sessions and carries
    // no live status). Fetched with headroom so RC-twin detection (below)
    // can match transcripts just outside the phone's limit window; the final
    // slice restores `limit`.
    let local = [];
    let localProvider;
    try {
      const localLimit = Math.min(limit + 10, 50);
      local = listCcSessions({ limit: localLimit, cwd, base: ccBaseDir });
    } catch (err) {
      console.warn(`[bridge] cc session scan failed: ${err.message}`);
    }
    if (local.length === 0 && !cwd) {
      // Fallback to the official SDK list only when the scan found nothing
      // AND there is no cwd filter (a filter legitimately matches zero).
      try {
        localProvider = getDefaultLocalProvider();
        const localLimit = Math.min(limit + 10, 50);
        local = await localProvider.listSessions(localLimit, cwd);
        await fillStatus(localProvider, local);
      } catch (err) {
        console.warn(`[bridge] local session list failed: ${err.message}`);
      }
    }
    if (!localProvider && ccProv) {
      // Live status for disk rows (busy while a terminal claude drives the
      // cwd or the transcript is being written) for the phone's top window.
      for (const s of local.slice(0, STATUS_CHECK_COUNT)) {
        if (s.status) continue;
        try {
          s.status = (await ccProv.getSessionStatus(s.id)) ?? "idle";
        } catch {
          /* leave null */
        }
      }
    }

    // Fetch the extended lists, keyed by provider name (with live status for
    // running sessions, the same way the local list is filled above).
    const extLists = new Map();
    for (const p of ext) {
      let list = [];
      try {
        list = await p.listSessions(limit, cwd);
        await fillStatus(p, list);
      } catch (err) {
        console.warn(`[bridge] ${p.name} session list failed: ${err.message}`);
      }
      extLists.set(p.name, list);
    }

    // RC transcripts: each live RC session also exists as a local transcript; the local
    // duplicate is hidden and the RC row borrows its title + cwd (src/session-twins.mjs, the
    // same function the overseer's session inventory uses).
    const rcList = extLists.get("claude-remote") || [];
    local = dropRcTwins(local, rcList, { base: rcTranscriptBase });

    // Honor the phone's project filter on the extended lists too (the RC
    // upstream ignores cwd; pi entries already carry their real cwd).
    if (cwd) {
      for (const p of ext) {
        const list = extLists.get(p.name) || [];
        extLists.set(p.name, list.filter((s) => s.cwd === cwd));
      }
    }

    out.push(...local);
    for (const p of ext) out.push(...(extLists.get(p.name) || []));
    // Durable rows carry epoch ms, CC/RC/pi rows ISO strings: compare as ms (the wire values stay as they are).
    const ms = (t) => (typeof t === "number" ? t : Date.parse(t ?? "") || 0);
    out.sort((a, b) => ms(b.timestamp) - ms(a.timestamp));
    if (overseer?.sid) {
      // The overseer is pinned first (plan ruling 6), whatever the other rows' timestamps.
      const i = out.findIndex((s) => s.id === overseer.sid);
      if (i > 0) out.unshift(...out.splice(i, 1));
    }
    if (assistant?.sid) {
      // Even AI right after the overseer (or first without one).
      const at = overseer?.sid && out[0]?.id === overseer.sid ? 1 : 0;
      const i = out.findIndex((s) => s.id === assistant.sid);
      if (i > at) out.splice(at, 0, ...out.splice(i, 1));
    }
    res.json({ sessions: out.slice(0, limit).map(wireSession) });
  });

  // ── GET /api/info — extended provider info (explicit param) or the cache ──
  // Without an extended provider param the official Claude provider's info is
  // served from the info cache (src/info-cache.mjs): the phone's Terminal
  // readiness probe gives up after ~2 s, and the official route's getInfo()
  // takes 0.5-2 s on every call. Body shape as the official route's. With the
  // cache off (EVEN_BRIDGE_INFO_CACHE_MS=0) or another provider → official route.
  router.get("/info", async (req, res, next) => {
    const p = byName(req.query.provider);
    if (!p) {
      if (!infoCache || !infoTargetsClaude(req.query.provider)) return next();
      const info = await infoCache.get();
      return res.json({ ...info, extra: { expose: exposeType() } });
    }
    try {
      const info = await p.getInfo();
      res.json({ ...info, extra: {} });
    } catch (err) {
      res.status(500).json({ error: { code: "info_failed", message: err.message } });
    }
  });

  // ── POST /api/prompt ───────────────────────────────────────────────────────
  router.post("/prompt", async (req, res, next) => {
    const { text, sessionId, provider, cwd, name, model, maxTurns, requestId, origin, engine, factory } = req.body ?? {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing 'text' field" });
    }
    const explicit = byName(provider);
    let p = explicit;
    if (!p) {
      if (sessionId) {
        p = await ownProvider(sessionId);
      } else {
        // NEW session. The phone sends provider="claude" as an app-level
        // default (from the pairing URL), not a user choice — so it can't be
        // honored here. New sessions get stock Claude Code by default;
        // EVEN_BRIDGE_NEW_SESSION_PROVIDER picks an extended provider instead:
        // "official"/"claude" (default), "pi", "durable", or "claude-remote".
        const want = String(process.env.EVEN_BRIDGE_NEW_SESSION_PROVIDER ?? "official").trim().toLowerCase();
        if (want !== "official" && want !== "claude") p = byName(want);
      }
    }
    if (!p) return next();
    console.log(`[bridge] prompt -> ${p.name} session=${sessionId ?? "(new)"}`);
    try {
      // A durable prompt without a cwd uses the provider's default cwd (below an agent root),
      // never PROJECT_DIR (the bridge's own project dir).
      const effectiveCwd = sessionId ? undefined : p.name === "durable" ? cwd : cwd ?? process.env.PROJECT_DIR;
      let result;
      if (p.name === "durable") {
        // Agent fields: validated, and only the ones the caller sent.
        if (sessionId && factory != null) {
          return res.status(400).json({ error: "'factory' is set when an agent starts; use /api/agents/:sid/factory" });
        }
        const checked = agentOpts({ name, model, maxTurns, requestId, origin, engine, factory });
        if (checked.error) return res.status(400).json({ error: checked.error });
        result = await p.prompt(sessionId, text, effectiveCwd, checked.opts);
      } else {
        result = await p.prompt(sessionId, text, effectiveCwd);
      }
      // cc-local: session not externally driven -> the official router is
      // the single writer (spawn/resume) for this session.
      if (result?.passThrough) return next();
      const body = { ok: true, sessionId: result.sessionId, provider: result.provider };
      if (result.submissionId !== undefined) body.submissionId = result.submissionId; // durable only
      res.status(202).json(body);
    } catch (err) {
      const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
      res.status(statusCode).json({ error: err.message });
    }
  });

  // ── POST /api/permission-response ──────────────────────────────────────────
  router.post("/permission-response", async (req, res, next) => {
    const { sessionId, decision, provider } = req.body ?? {};
    if (!sessionId) return res.status(400).json({ error: "Missing 'sessionId'" });
    const p = byName(provider) ?? (await ownProvider(sessionId));
    if (!p) return next();
    if (!p.getStatus(sessionId)) return res.status(404).json({ error: "Session not found" });
    try {
      const accepted = await p.respondPermission(sessionId, decision || "deny");
      if (accepted?.passThrough) return next(); // cc-local: the official pipeline asked
      if (accepted === false) {
        return res.status(400).json({ error: "Permission decision was not offered or no permission request is pending" });
      }
      res.json({ ok: true });
    } catch (err) {
      const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
      res.status(statusCode).json({ error: err.message });
    }
  });

  // ── POST /api/question-response ────────────────────────────────────────────
  router.post("/question-response", async (req, res, next) => {
    const { sessionId, answer, provider } = req.body ?? {};
    if (!sessionId) return res.status(400).json({ error: "Missing 'sessionId'" });
    const p = byName(provider) ?? (await ownProvider(sessionId));
    if (!p) return next();
    if (!p.getStatus(sessionId)) return res.status(404).json({ error: "Session not found" });
    try {
      const result = await p.respondQuestion(sessionId, answer || "skip");
      if (result?.passThrough) return next(); // cc-local: the official pipeline asked
      res.json({ ok: true });
    } catch (err) {
      const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
      res.status(statusCode).json({ error: err.message });
    }
  });

  // ── POST /api/interrupt ────────────────────────────────────────────────────
  router.post("/interrupt", async (req, res, next) => {
    const { sessionId, provider } = req.body ?? {};
    if (!sessionId) return res.status(400).json({ error: "Missing 'sessionId'" });
    const p = byName(provider) ?? (await ownProvider(sessionId));
    if (!p) return next();
    if (!p.getStatus(sessionId)) return res.status(404).json({ error: "Session not found" });
    try {
      const result = await p.interrupt(sessionId);
      if (result?.passThrough) return next(); // cc-local: the official pipeline runs it
      res.json({ ok: true });
    } catch (err) {
      const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
      res.status(statusCode).json({ error: err.message });
    }
  });

  // ── GET /api/status ────────────────────────────────────────────────────────
  router.get("/status", async (req, res, next) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing 'sessionId'" });
    const p = byName(req.query.provider) ?? (await ownProvider(sessionId));
    if (!p) return next();
    await p.seedTranscript?.(sessionId); // pi: seed the ring from the on-disk transcript
    const status = await p.getStatus(sessionId);
    if (!status) return res.status(404).json({ error: "Session not found" });
    res.json({ state: status.state, sessionId, provider: status.provider });
  });

  // ── GET /api/messages — ring read for owned sessions ──────────────────────
  router.get("/messages", async (req, res, next) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Missing 'sessionId'" });
    const p = byName(req.query.provider) ?? (await ownProvider(sessionId));
    if (!p) return next();
    p.ensurePump?.(sessionId); // keep the RC relay warm while the client reads
    await p.seedTranscript?.(sessionId); // pi: make the transcript available to the ring
    const after = parseInt(req.query.after) || 0;
    const status = await p.getStatus(sessionId);
    res.json({
      messages: getMessages(sessionId, after),
      state: status?.state ?? "idle",
      sessionId,
      provider: status?.provider ?? "claude",
    });
  });

  // ── GET /api/sessions/:id/history ─────────────────────────────────────────
  router.get("/sessions/:id/history", async (req, res, next) => {
    const id = req.params.id;
    const p = byName(req.query.provider) ?? (await ownProvider(id));
    if (!p) return next();
    hub.noteHistory(id); // a reconnect alongside this reload needs no turn replay
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    try {
      const history = await p.getHistory(id, limit);
      res.json({ sessionId: id, history });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/events — the phone-facing SSE for extended sessions ──────────
  router.get("/events", async (req, res, next) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return next(); // let the official handler report its own error
    const p = byName(req.query.provider) ?? (await ownProvider(sessionId));
    if (!p) return next();
    p.ensurePump?.(sessionId); // RC: ensure the relay is pumping into the ring
    await p.seedTranscript?.(sessionId); // pi: seed the ring before the replay reads it
    hub.streamFor(sessionId).handleEvents(req, res);
    p.watchTranscript?.(sessionId); // pi: tail the transcript for external (terminal) writers
    res.on("close", () => p.unwatchTranscript?.(sessionId));
  });

  // ── /api/agents — durable agents (the shim's registry/reaper) ─────────────
  // Bridge-only endpoints. Without the durable provider they fall through
  // (next()), exactly as before they existed.
  const durable = byName("durable");

  router.get("/agents", async (req, res, next) => {
    if (!durable) return next();
    try {
      const agents = await durable.listAgents();
      // `engines` only when there is a choice (ruling 9); with the lets-code flag off the body is as before.
      const engines = Array.isArray(durable.engines) && durable.engines.includes("lets-code") ? durable.engines : null;
      const body = engines ? { agents, engines } : { agents };
      if (overseer) body.overseer = true; // the shim offers overseer_ask only then (flag off: the body of before)
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/agents/:sid/stop", async (req, res, next) => {
    if (!durable) return next();
    try {
      await durable.stopSession(req.params.sid);
      res.json({ ok: true, sessionId: req.params.sid });
    } catch (err) {
      const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
      res.status(statusCode).json({ error: err.message });
    }
  });

  // Factory toggle of a lets-code agent (ruling 4): 409 native, 504 without the mode notify.
  router.post("/agents/:sid/factory", async (req, res, next) => {
    // Without the lets-code engine the route does not exist (as on main).
    if (!durable || !(Array.isArray(durable.engines) && durable.engines.includes("lets-code"))) return next();
    const checked = factoryOpts(req.body ?? {});
    if (checked.error) return res.status(400).json({ error: checked.error });
    try {
      const r = await durable.setFactory(req.params.sid, checked.on, checked.opts);
      res.json({ ok: true, sessionId: req.params.sid, factory: r?.factory, mode: r?.mode });
    } catch (err) {
      const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
      res.status(statusCode).json({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) });
    }
  });

  // ── /api/overseer — the overseer (EVEN_BRIDGE_OVERSEER_ENABLE=1) ───────────
  // Without it every route falls through (next()), as before they existed.
  const fail = (res, err) => {
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    res.status(statusCode).json({ error: err.message });
  };

  router.post("/overseer/ask", async (req, res, next) => {
    if (!overseer) return next();
    const checked = overseerAskOpts(req.body ?? {});
    if (checked.error) return res.status(400).json({ error: checked.error });
    try {
      const opts = { requestId: checked.requestId, waitMs: checked.waitMs };
      if (checked.mode === "tell") opts.mode = "tell";
      if (checked.handoff) opts.handoff = checked.handoff;
      res.json(await overseer.ask(checked.question, opts));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/overseer/outbox", async (req, res, next) => {
    if (!overseer) return next();
    const since = seqParam(req.query.since);
    if (since == null) return res.status(400).json({ error: "'since' must be a non-negative integer" });
    try {
      res.json(await overseer.outbox({ since }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/overseer/outbox/read", async (req, res, next) => {
    if (!overseer) return next();
    const upTo = req.body?.upTo;
    if (!Number.isSafeInteger(upTo) || upTo < 0) return res.status(400).json({ error: "'upTo' must be a non-negative integer" });
    try {
      res.json(await overseer.markRead(upTo));
    } catch (err) {
      fail(res, err);
    }
  });

  // Every active session of both harnesses (durable agents, pi, local Claude Code, Remote Control) with a
  // host-built label, a normalized state and whether it can receive a message: the same inventory the
  // overseer's sessions_list reads (src/overseer/host.mjs). Titles and last lines are not sent. `all=1`: also
  // sessions idle and undriven for longer than the active window.
  router.get("/overseer/sessions", async (req, res, next) => {
    const h = overseer?.host;
    if (typeof h?.inventory !== "function") return next();
    const all = req.query.all === "1" || req.query.all === "true";
    try {
      res.json({ sessions: await h.inventory({ all }) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Gated actions (src/overseer/actions.mjs). Only a confirm executes; the phone answers through
  // /api/permission-response on dur-overseer instead.
  const actionsOf = () => overseer?.actions ?? null;
  /** Who answered over HTTP, for the audit: the shim says evenai; any other bearer holder is "http". */
  const actionBy = (body) => {
    const by = body?.by ?? "http";
    return ACTION_BY.includes(by) ? by : null;
  };

  router.get("/overseer/actions", async (req, res, next) => {
    const a = actionsOf();
    if (!a) return next();
    if (req.query.state != null && req.query.state !== "pending") return res.status(400).json({ error: "'state' must be pending" });
    try {
      res.json({ actions: await a.pending() });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/overseer/actions", async (req, res, next) => {
    const a = actionsOf();
    if (!a) return next();
    const checked = overseerActionOpts(req.body ?? {});
    if (checked.error) return res.status(400).json({ error: checked.error });
    try {
      res.json(await a.propose(checked.kind, checked.args, { origin: "evenai", requestId: checked.requestId }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/overseer/actions/:id/confirm", async (req, res, next) => {
    const a = actionsOf();
    if (!a) return next();
    const confirmFrameId = req.body?.confirmFrameId;
    // The confirm names the frame the user's yes answered (spec): required.
    if (typeof confirmFrameId !== "string" || confirmFrameId.length < 1 || confirmFrameId.length > 128) {
      return res.status(400).json({ error: "'confirmFrameId' must be a string of 1-128 characters" });
    }
    const by = actionBy(req.body);
    if (!by) return res.status(400).json({ error: `'by' must be one of ${ACTION_BY.join(", ")}` });
    try {
      res.json(await a.confirm(req.params.id, { confirmFrameId, by }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/overseer/actions/:id/deny", async (req, res, next) => {
    const a = actionsOf();
    if (!a) return next();
    const by = actionBy(req.body);
    if (!by) return res.status(400).json({ error: `'by' must be one of ${ACTION_BY.join(", ")}` });
    try {
      res.json(await a.deny(req.params.id, { by }));
    } catch (err) {
      fail(res, err);
    }
  });

  // ── /api/assistant — the Even AI assistant (EVEN_BRIDGE_ASSISTANT_ENABLE=1, Task A1) ─────────
  // Without it every route falls through (next()), as before they existed. Events: GET /api/events?sessionId=dur-assistant.
  router.post("/assistant/prompt", async (req, res, next) => {
    if (!assistant) return next();
    const checked = assistantPromptOpts(req.body ?? {});
    if (checked.error) return res.status(400).json({ error: checked.error });
    try {
      res.status(202).json(await assistant.prompt(checked.text, { requestId: checked.requestId, whenBusy: checked.whenBusy }));
    } catch (err) {
      fail(res, err);
    }
  });

  for (const verb of ["interrupt", "reset", "compact"]) {
    router.post(`/assistant/${verb}`, async (req, res, next) => {
      if (!assistant) return next();
      try {
        await assistant[verb]();
        res.json({ ok: true });
      } catch (err) {
        fail(res, err);
      }
    });
  }

  router.post("/assistant/model", async (req, res, next) => {
    if (!assistant) return next();
    const checked = assistantModelOpts(req.body ?? {});
    if (checked.error) return res.status(400).json({ error: checked.error });
    try {
      res.json(await assistant.setModel(checked));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/assistant/note", async (req, res, next) => {
    if (!assistant) return next();
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Missing 'text'" });
    if (text.length > ASSISTANT_LIMITS.textMax) return res.status(400).json({ error: `'text' must be 1-${ASSISTANT_LIMITS.textMax} characters` });
    try {
      const r = assistant.note(text);
      res.json({ ok: true, queued: Boolean(r?.queued) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/assistant/dialog", async (req, res, next) => {
    if (!assistant) return next();
    const checked = assistantDialogOpts(req.body ?? {});
    if (checked.error) return res.status(400).json({ error: checked.error });
    try {
      res.json(await assistant.answerDialog(checked.id, checked.answer));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/assistant/state", async (req, res, next) => {
    if (!assistant) return next();
    try {
      res.json(assistant.state());
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
