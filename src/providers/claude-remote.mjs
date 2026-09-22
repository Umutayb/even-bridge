// claude-remote provider — Claude Code REMOTE CONTROL sessions.
//
// Backed by the existing claude-remote-terminal bridge (the fork), which
// already speaks the even-terminal host protocol against RC sessions on its
// terminal-host port (default http://127.0.0.1:8791, root /api/*). This
// provider proxies the wire contract through to it and registers ownership of
// every RC session id it sees, so the extension router can route per-session
// calls here even when the phone omits the provider param.
//
// On the wire everything is presented as provider "claude" (the Even app
// filters its session list to known providers). Live streaming rides the
// upstream pump (src/upstream-pump.mjs), which relays the fork's /events
// stream into the local ring + hub.

import http from "node:http";
import { URL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PumpManager } from "../upstream-pump.mjs";
import { claim, forget } from "../ownership.mjs";

const NAME = "claude-remote";
const WIRE_PROVIDER = "claude"; // what the phone sees
const OWNERSHIP_TTL_MS = 30 * 60 * 1000; // RC sessions can be deleted; expire claims
const HISTORY_MAX = 10;

function readPersistedRcToken() {
  // The fork persists its generated token here; reuse it so the bridge works
  // with zero extra configuration when the fork is running with generated auth.
  const p = join(homedir(), ".config", "claude-remote-terminal", "bridge-token");
  try {
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  } catch {
    /* best-effort */
  }
  return "";
}

/**
 * Small JSON-over-HTTP client for the upstream RC bridge.
 * @returns {Promise<{status: number, body: any}>}
 */
function rpc(baseUrl, token, path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
    if (token) url.searchParams.set("token", token);
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`upstream timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function resolveRcConfig(flags = {}) {
  const baseUrl = flags.rcUrl ?? process.env.EVEN_BRIDGE_RC_URL ?? "http://127.0.0.1:8791";
  const token =
    flags.rcToken ?? process.env.EVEN_BRIDGE_RC_TOKEN ?? readPersistedRcToken();
  const enabled =
    flags.rcEnable === false
      ? false
      : (process.env.EVEN_BRIDGE_RC_ENABLE ?? "1") !== "0";
  return { enabled, baseUrl, token };
}

/**
 * @param {(sessionId: string, msg: object) => void} emit unused for RC (the
 *   upstream pump feeds the hub directly) — kept for provider-shape parity.
 * @param {{ hub: import("../hub.mjs").Hub, baseUrl?: string, token?: string }} deps
 */
export function createClaudeRemoteProvider(emit, { hub, baseUrl, token } = {}) {
  const cfg = resolveRcConfig();
  const base = baseUrl ?? cfg.baseUrl;
  const tok = token ?? cfg.token;
  const known = new Map(); // sid -> expiry

  const pumpOpts = {
    baseUrl: base,
    token: tok,
    hub,
    getState: (sid) => provider.getSessionStatus(sid),
  };
  const pumps = new PumpManager(pumpOpts);

  function noteKnown(sid) {
    if (!sid) return;
    claim(sid, NAME);
    known.set(sid, Date.now() + OWNERSHIP_TTL_MS);
  }

  function isKnown(sid) {
    const exp = known.get(sid);
    if (!exp) return false;
    if (exp < Date.now()) {
      known.delete(sid);
      return false;
    }
    return true;
  }

  async function rpcGet(path, timeoutMs) {
    const r = await rpc(base, tok, path, { timeoutMs });
    return r;
  }

  const provider = {
    name: NAME,
    wireProvider: WIRE_PROVIDER,

    /** True when the upstream RC bridge owns this session id. */
    async probe(sessionId) {
      if (isKnown(sessionId)) return true;
      const r = await rpcGet(`/api/status?sessionId=${encodeURIComponent(sessionId)}`);
      if (r.status === 200 && r.body?.state) {
        noteKnown(sessionId);
        return true;
      }
      if (r.status === 404) {
        forget(sessionId);
        known.delete(sessionId);
      }
      return false;
    },

    async listSessions(limit = 10) {
      const r = await rpcGet(`/api/sessions?limit=${Math.max(1, Math.min(limit, 50))}`);
      if (r.status !== 200) throw new Error(`RC upstream /api/sessions HTTP ${r.status}`);
      const sessions = (r.body?.sessions ?? []).slice(0, limit);
      for (const s of sessions) noteKnown(s.id);
      return sessions.map((s) => ({
        id: s.id,
        title: String(s.title ?? "").slice(0, 64),
        timestamp: s.timestamp ?? "",
        cwd: s.cwd ?? "",
        provider: WIRE_PROVIDER,
        status: s.status ?? null,
      }));
    },

    async getSessionStatus(sessionId) {
      const r = await rpcGet(`/api/status?sessionId=${encodeURIComponent(sessionId)}`);
      if (r.status === 200 && r.body?.state) {
        noteKnown(sessionId);
        return r.body.state;
      }
      if (r.status === 404) {
        forget(sessionId);
        known.delete(sessionId);
      }
      return "idle";
    },

    async getInfo() {
      const r = await rpcGet("/api/info");
      if (r.status !== 200) throw new Error(`RC upstream /api/info HTTP ${r.status}`);
      return {
        account: r.body?.account ?? {},
        model: r.body?.model ?? "Unknown",
        version: r.body?.version ?? "Unknown",
        provider: WIRE_PROVIDER,
      };
    },

    async getHistory(sessionId, limit = 10) {
      const n = Math.max(1, Math.min(limit, HISTORY_MAX));
      const r = await rpcGet(`/api/sessions/${encodeURIComponent(sessionId)}/history?limit=${n}`);
      if (r.status !== 200) return [];
      return (r.body?.history ?? []).map((h) => ({ role: h.role ?? "assistant", text: String(h.text ?? "") }));
    },

    async prompt(sessionId, text, cwd) {
      const body = { text };
      if (sessionId) body.sessionId = sessionId;
      else if (cwd) body.cwd = cwd;
      // A no-sessionId prompt makes the upstream SPAWN `claude --remote-control`
      // and wait for registration — that can take ~25-30s, so the timeout is
      // generous for the new-session path only.
      const r = await rpc(base, tok, "/api/prompt", {
        method: "POST",
        body,
        timeoutMs: sessionId ? 30_000 : 60_000,
      });
      if (r.status !== 200 && r.status !== 202) {
        const err = new Error(r.body?.error ?? `RC upstream /api/prompt HTTP ${r.status}`);
        if (r.status === 404) err.statusCode = 404;
        throw err;
      }
      const sid = r.body?.sessionId;
      if (sid) {
        noteKnown(sid);
        pumps.ensure(sid); // keep the relay warm so streaming starts immediately
      }
      return { sessionId: sid ?? sessionId ?? "", provider: WIRE_PROVIDER };
    },

    async respondPermission(sessionId, decision) {
      const r = await rpc(base, tok, "/api/permission-response", {
        method: "POST",
        body: { sessionId, decision: decision || "deny" },
      });
      if (r.status === 404) throw Object.assign(new Error(r.body?.error ?? "session not found"), { statusCode: 404 });
      if (r.status === 409) throw Object.assign(new Error(r.body?.error ?? "no pending permission request"), { statusCode: 409 });
      if (r.status !== 200 && r.status !== 202) throw new Error(r.body?.error ?? `RC upstream HTTP ${r.status}`);
      return true;
    },

    async respondQuestion(sessionId, answer) {
      const r = await rpc(base, tok, "/api/question-response", {
        method: "POST",
        body: { sessionId, answer: answer || "skip" },
      });
      if (r.status === 404) throw Object.assign(new Error(r.body?.error ?? "session not found"), { statusCode: 404 });
      if (r.status !== 200 && r.status !== 202) throw new Error(r.body?.error ?? `RC upstream HTTP ${r.status}`);
    },

    async interrupt(sessionId) {
      const r = await rpc(base, tok, "/api/interrupt", { method: "POST", body: { sessionId } });
      if (r.status === 404) throw Object.assign(new Error(r.body?.error ?? "session not found"), { statusCode: 404 });
      if (r.status !== 200 && r.status !== 202) throw new Error(r.body?.error ?? `RC upstream HTTP ${r.status}`);
    },

    getStatus(sessionId) {
      // The routes guard respond*/interrupt with a truthy getStatus. Synchronous:
      // answer from the ownership cache; the async probe path covers unknown ids
      // in the extension router before this is called.
      if (isKnown(sessionId)) return { state: "idle", provider: WIRE_PROVIDER };
      return null;
    },

    /** Keep the relay pump warm for this session (called on /events, /messages, /prompt). */
    ensurePump(sessionId) {
      if (isKnown(sessionId)) pumps.ensure(sessionId);
    },

    async stopPump(sessionId) {
      await pumps.stop(sessionId);
    },

    _pumps: pumps,
  };

  return provider;
}
