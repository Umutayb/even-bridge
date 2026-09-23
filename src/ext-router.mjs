// Extension router — mounted BEFORE the official eventsRouter/coreRouter.
//
// Intercepts only requests that belong to EXTENDED sessions (claude-remote,
// pi); everything else falls through to the official routers unchanged, so
// local Claude Code and Codex sessions behave exactly as stock even-terminal.
//
// Routing rule (session-ID ownership, not provider param — the Even phone
// omits the provider on follow-up calls and only ever knows "claude"/"codex"):
//   1. explicit provider param ∈ extended names → that provider (CLI/test path)
//   2. sessionId claimed/probed to an extended provider → that provider
//   3. otherwise → next() (official router)
//
// /api/sessions is merged (default provider + every enabled extension), all
// tagged provider "claude", because the phone filters its list to the provider
// it thinks it's connected to.

import { Router } from "express";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";
import { getOwner } from "./ownership.mjs";
import { findBridgeSessionId } from "./rc-transcripts.mjs";

const STATUS_CHECK_COUNT = 10; // mirrors core.js

/**
 * @param {{
 *   hub: import("./hub.mjs").Hub,
 *   providers: object[],                   // enabled extended providers
 *   getDefaultLocalProvider: () => object, // official default provider thunk
 *   rcTranscriptBase?: string,             // ~/.claude/projects base (tests)
 * }} deps
 */
export function createExtRouter({ hub, providers, getDefaultLocalProvider, rcTranscriptBase } = {}) {
  const ext = providers.filter(Boolean); // [{name, probe, listSessions, ...}]
  const router = Router();

  const byName = (name) => ext.find((p) => p.name === name) || null;

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

    // Local (official) sessions — the default provider, exactly as core.js does.
    // Fetched with headroom so RC-twin detection (below) can match transcripts
    // just outside the phone's limit window; the final slice restores `limit`.
    let local = [];
    let localProvider;
    try {
      localProvider = getDefaultLocalProvider();
      const localLimit = Math.min(limit + 10, 50);
      local = await localProvider.listSessions(localLimit, cwd);
      await fillStatus(localProvider, local);
    } catch (err) {
      console.warn(`[bridge] local session list failed: ${err.message}`);
    }

    // Fetch the extended lists, keyed by provider name.
    const extLists = new Map();
    for (const p of ext) {
      let list = [];
      try {
        list = await p.listSessions(limit, cwd);
      } catch (err) {
        console.warn(`[bridge] ${p.name} session list failed: ${err.message}`);
      }
      extLists.set(p.name, list);
    }

    // RC transcripts: the claude-remote fork runs the real `claude
    // --remote-control` CLI, so each live RC session ALSO exists as a local
    // transcript file under ~/.claude/projects/. The same conversation would
    // therefore appear twice (once as the cse_… RC session, once as a local
    // claude session). We keep the RC entry (the phone must interact by its
    // cse_ id — the upstream only knows that) and hide the local duplicate,
    // borrowing the local entry's real title + cwd for a better list row.
    const rcList = extLists.get("claude-remote") || [];
    if (rcList.length > 0 && local.length > 0) {
      const rcIds = new Set(rcList.map((s) => s.id));
      const rcByTwin = new Map(); // local session id -> rc entry
      const dropLocal = new Set();
      for (const s of local) {
        let rcId = null;
        try {
          rcId = findBridgeSessionId(s.cwd, s.id, rcTranscriptBase);
        } catch {
          /* ignore */
        }
        if (rcId && rcIds.has(rcId)) {
          dropLocal.add(s.id);
          rcByTwin.set(s.id, rcId);
        }
      }
      if (dropLocal.size > 0) {
        for (const rc of rcList) {
          const twin = local.find((l) => rcByTwin.get(l.id) === rc.id);
          if (twin) {
            rc.title = twin.title || rc.title;
            rc.cwd = twin.cwd || rc.cwd;
          }
        }
        local = local.filter((s) => !dropLocal.has(s.id));
      }
    }

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
    out.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    res.json({ sessions: out.slice(0, limit) });
  });

  // ── GET /api/info — extended provider info (explicit param only) ──────────
  router.get("/info", async (req, res, next) => {
    const p = byName(req.query.provider);
    if (!p) return next();
    try {
      const info = await p.getInfo();
      res.json({ ...info, extra: {} });
    } catch (err) {
      res.status(500).json({ error: { code: "info_failed", message: err.message } });
    }
  });

  // ── POST /api/prompt ───────────────────────────────────────────────────────
  router.post("/prompt", async (req, res, next) => {
    const { text, sessionId, provider, cwd } = req.body ?? {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing 'text' field" });
    }
    const explicit = byName(provider);
    const p = explicit ?? (sessionId ? await ownProvider(sessionId) : null);
    if (!p) return next();
    console.log(`[bridge] prompt -> ${p.name} session=${sessionId ?? "(new)"}`);
    try {
      const effectiveCwd = sessionId ? undefined : cwd ?? process.env.PROJECT_DIR;
      const result = await p.prompt(sessionId, text, effectiveCwd);
      res.status(202).json({ ok: true, sessionId: result.sessionId, provider: result.provider });
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
      await p.respondQuestion(sessionId, answer || "skip");
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
      await p.interrupt(sessionId);
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
  });

  return router;
}
