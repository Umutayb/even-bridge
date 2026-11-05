// even-bridge server entry.
//
// Mirrors @evenrealities/even-terminal dist/index.js wiring (same express app,
// auth, hook endpoint, transport attach, pidfile, expose, logging, shutdown)
// and inserts the extension router BEFORE the official events/core routers:
//
//   app.use("/api", auth, extRouter);     // extended sessions (claude-remote, pi, durable)
//   app.use("/api", auth, eventsRouter);  // official SSE (local claude/codex)
//   app.use("/api", auth, coreRouter);    // official routes
//
// Local Claude Code + Codex sessions flow through the official code paths
// untouched; extended sessions are served from the shared ring by the hub.

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import express from "express";
import cors from "cors";

import {
  default as eventsRouter,
} from "@evenrealities/even-terminal/dist/routes/events.js";
import {
  default as coreRouter,
  claudeSyncTransport,
  emitBridgeMessage,
  INFO_AUTH_ERROR,
} from "@evenrealities/even-terminal/dist/routes/core.js";
import { handleHookRequest } from "@evenrealities/even-terminal/dist/claude-sync/hook-receiver.js";
import {
  CODEX_APP_SERVER_PORT,
  printServerBanner,
  resolveHost,
  stopCodexAppServer,
} from "@evenrealities/even-terminal/dist/startup/common.js";
import { writeInstancePidfile, removeInstancePidfile } from "@evenrealities/even-terminal/dist/startup/instance.js";
import { startExposeProvider } from "@evenrealities/even-terminal/dist/expose/run.js";
import { installTimestampLogging } from "@evenrealities/even-terminal/dist/logger.js";
import { redactTokenQueryParam } from "@evenrealities/even-terminal/dist/http-log.js";

import { Hub } from "./hub.mjs";
import { createExtRouter } from "./ext-router.mjs";
import { resolveRcConfig, createClaudeRemoteProvider } from "./providers/claude-remote.mjs";
import { resolvePiConfig, createPiProvider } from "./providers/pi/provider.mjs";
import { createCcLocalProvider } from "./cc-local.mjs";
import { createInfoCache, infoCacheMs } from "./info-cache.mjs";
import { getProvider } from "@evenrealities/even-terminal/dist/routes/core.js";
import { getDefaultProvider } from "@evenrealities/even-terminal/dist/session.js";

const DURABLE_CLOSE_MS = 3000; // signal shutdown: max wait for the durable store to close

/** True when the durable (Pi Durable) provider is switched on: EVEN_BRIDGE_DURABLE_ENABLE=1. */
export function durableEnabled(env = process.env) {
  return String(env.EVEN_BRIDGE_DURABLE_ENABLE ?? "").trim() === "1";
}

/**
 * createDurableProvider options from the environment, or null when the flag is
 * off. EVEN_BRIDGE_DURABLE_CWDS is a colon-separated list of roots; a new
 * agent's cwd must lie strictly below one. A durable prompt without a cwd
 * works in EVEN_BRIDGE_DURABLE_DEFAULT_CWD, default `<first root>/glasses`
 * (created on demand) — never the bridge's PROJECT_DIR.
 * @param {object} env
 */
export function durableOptions(env = process.env) {
  if (!durableEnabled(env)) return null;
  const allowedCwds = String(env.EVEN_BRIDGE_DURABLE_CWDS ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  const opts = {
    defaultCwd: env.EVEN_BRIDGE_DURABLE_DEFAULT_CWD?.trim() || `${(allowedCwds[0] ?? DURABLE_DEFAULT_ROOT).replace(/\/+$/, "")}/glasses`,
    allowedCwds,
  };
  if (env.EVEN_BRIDGE_DURABLE_STORE) opts.storePath = env.EVEN_BRIDGE_DURABLE_STORE;
  if (env.EVEN_BRIDGE_DURABLE_MODELS) opts.modelsPath = env.EVEN_BRIDGE_DURABLE_MODELS;
  const lc = lcOptions(env);
  if (lc) opts.lc = lc;
  const assistant = assistantOptions(env);
  if (assistant) opts.assistant = assistant;
  return opts;
}

/**
 * The Even AI assistant (`dur-assistant` on the lets-code engine, /api/assistant/*, Task A1):
 * EVEN_BRIDGE_ASSISTANT_ENABLE=1, and only with the durable provider on (not the agent engine flag).
 */
export function assistantEnabled(env = process.env) {
  return durableEnabled(env) && String(env.EVEN_BRIDGE_ASSISTANT_ENABLE ?? "").trim() === "1";
}

/**
 * The assistant's options, or null when off: the shim's tool server and its token file (a path; the
 * child reads the token itself). Optional, only when set: the bin (EVEN_BRIDGE_LC_BIN, else
 * EVEN_BRIDGE_PI_BIN, else lets-code), the extension (EVEN_BRIDGE_ASSISTANT_EXT, default A2's
 * even-assistant.ts), the cwd (EVEN_BRIDGE_ASSISTANT_CWD, default ~/sandbox/assistant; smoke runs) and a
 * run deadline in seconds (EVEN_BRIDGE_ASSISTANT_DEADLINE_S, default 20).
 */
export function assistantOptions(env = process.env) {
  if (!assistantEnabled(env)) return null;
  const opts = {
    toolsUrl: env.EVEN_BRIDGE_ASSISTANT_TOOLS_URL || "http://127.0.0.1:8814",
    tokenFile: env.EVEN_BRIDGE_ASSISTANT_TOKEN_FILE || "~/even-app/shim-data/assistant_tools.token",
  };
  const bin = env.EVEN_BRIDGE_LC_BIN || env.EVEN_BRIDGE_PI_BIN;
  if (bin) opts.bin = bin;
  if (env.EVEN_BRIDGE_ASSISTANT_EXT) opts.ext = env.EVEN_BRIDGE_ASSISTANT_EXT;
  // A throwaway bridge's own cwd (its core-memory store is keyed by the cwd; the live one is ~/sandbox/assistant).
  if (env.EVEN_BRIDGE_ASSISTANT_CWD) opts.cwd = env.EVEN_BRIDGE_ASSISTANT_CWD;
  const d = Number(env.EVEN_BRIDGE_ASSISTANT_DEADLINE_S);
  if (env.EVEN_BRIDGE_ASSISTANT_DEADLINE_S != null && Number.isFinite(d) && d > 0 && d <= 600) opts.deadlineMs = Math.round(d * 1000);
  return opts;
}

/**
 * The lets-code engine of durable sessions (EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE=1), or null.
 * The bin defaults to the pi provider's (the live bridge runs lets-code directly); MemoryMax
 * applies only where the kernel has a memory controller; at most EVEN_BRIDGE_LC_MAX_LIVE
 * children at once (default 1); EVEN_BRIDGE_LC_SANDBOX=0 drops lets-code's sandbox (tests only).
 * EVEN_BRIDGE_LC_MAX_TURNS caps each run's turns (the engine parses it: default 40, at most 200).
 */
export function lcOptions(env = process.env) {
  if (String(env.EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE ?? "").trim() !== "1") return null;
  const n = Number(env.EVEN_BRIDGE_LC_MAX_LIVE || 1);
  return {
    bin: env.EVEN_BRIDGE_LC_BIN || env.EVEN_BRIDGE_PI_BIN || "lets-code",
    caps: { memoryMax: env.EVEN_BRIDGE_LC_MEMORY_MAX || "500M", cpuQuota: "200%" },
    maxLive: Number.isInteger(n) && n >= 1 ? n : 1,
    sandbox: env.EVEN_BRIDGE_LC_SANDBOX !== "0",
    ...(env.EVEN_BRIDGE_LC_MAX_TURNS != null ? { maxTurns: env.EVEN_BRIDGE_LC_MAX_TURNS } : {}),
  };
}

/**
 * The overseer (the Durable root conversation as `dur-overseer`, /api/overseer/*):
 * EVEN_BRIDGE_OVERSEER_ENABLE=1, and only with the durable provider on.
 */
export function overseerEnabled(env = process.env) {
  return durableEnabled(env) && String(env.EVEN_BRIDGE_OVERSEER_ENABLE ?? "").trim() === "1";
}

/** Where the assistant API token lives (EVEN_BRIDGE_ASSISTANT_API_TOKEN_FILE). */
export const ASSISTANT_API_TOKEN_FILE = "~/.even-terminal/assistant-api.token";

/**
 * The token /api/assistant/* takes (and the only one): the shim reads it from this file. The bridge token
 * (the phone's) is refused there with 403, so the phone cannot prompt, reset or switch the assistant.
 * Created 0600 with a random value when missing. @returns {() => string|null} a reader (the file may be rotated)
 */
export function assistantApiToken(env = process.env, home = homedir()) {
  const raw = env.EVEN_BRIDGE_ASSISTANT_API_TOKEN_FILE || ASSISTANT_API_TOKEN_FILE;
  const file = raw === "~" ? home : raw.startsWith("~/") ? home + raw.slice(1) : raw;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(24).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  }
  chmodSync(file, 0o600);
  return () => {
    try {
      const t = readFileSync(file, "utf8").trim();
      return t.length >= ASSISTANT_API_TOKEN_MIN ? t : null; // empty or short: no token at all
    } catch {
      return null;
    }
  };
}

/** The shortest assistant API token accepted (a shorter or empty file means: no token, every request refused). */
export const ASSISTANT_API_TOKEN_MIN = 16;

const sameToken = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The gate of /api/assistant/*: only the assistant API token passes (marks `req.evenAssistantAuth`).
 * No usable expected token (file missing, empty, shorter than ASSISTANT_API_TOKEN_MIN, unreadable, or never
 * created) → 503 for every request, whatever was sent; the bridge (phone) token → 403; anything else → 401.
 * @param {{ reader: () => string|null, allowedTokens: Set<string>, warn?: (line: string) => void }} o
 */
export function createAssistantAuth({ reader, allowedTokens, warn = (l) => console.warn(l) }) {
  return (req, res, next) => {
    const want = reader?.() ?? null;
    if (typeof want !== "string" || want.length < ASSISTANT_API_TOKEN_MIN) {
      warn(`[auth] 503 ${req.method} ${redactTokenQueryParam(req.originalUrl)}: no usable assistant API token`);
      return res.status(503).json({ error: "the assistant API token is not set up" });
    }
    const header = req.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : req.query?.token;
    if (sameToken(provided, want)) {
      req.evenAssistantAuth = true;
      return next();
    }
    if (typeof provided === "string" && allowedTokens?.has(provided)) {
      return res.status(403).json({ error: "the assistant routes take the assistant API token, not the bridge token" });
    }
    warn(`[auth] 401 ${req.method} ${redactTokenQueryParam(req.originalUrl)} (ip=${req.ip})`);
    res.status(401).json(INFO_AUTH_ERROR);
  };
}

/** The provider's DEFAULT_AGENT_ROOT (mirrored: server.mjs must not import the provider when off). */
export const DURABLE_DEFAULT_ROOT = "~/sandbox/agents";

/**
 * Would a new agent be allowed to work in `dir`? The same rule as the
 * provider's resolveAgentCwd (strictly below a root; never ~ or /; no roots
 * configured = DURABLE_DEFAULT_ROOT) but without its side effect (it creates
 * missing dirs). Used for the startup warning about the default cwd.
 */
export function cwdAllowed(dir, roots = [], home = homedir()) {
  if (!dir) return false;
  const expand = (p) => resolve(p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p);
  const real = (p) => (existsSync(p) ? realpathSync(p) : p);
  const d = real(expand(dir));
  if (d === real(home) || d === "/") return false;
  const configured = roots.filter(Boolean);
  const rs = (configured.length ? configured : [DURABLE_DEFAULT_ROOT]).map((r) => real(expand(r)));
  return rs.some((r) => d.startsWith(r + sep));
}

/**
 * @param {{ flags?: object, cwd?: string }} opts flags = CLI flags (rcUrl, rcToken,
 *   rcEnable, piBin, piModel, piEnable, piAllCwds, piAgentDir); cwd = project dir.
 */
export async function startServer({ flags = {}, cwd } = {}) {
  const PORT = parseInt(process.env.PORT ?? "3456", 10);
  const TOKEN = process.env.BRIDGE_TOKEN;
  if (!TOKEN) {
    throw new Error("BRIDGE_TOKEN is not set (run via bin/even-bridge.mjs, which applies the config)");
  }
  // Compatibility: also accept the claude-remote-terminal fork's bridge
  // token, so phones already paired with the fork's terminal host
  // (e.g. via the cterm.* nginx vhost on port 8791) keep working against
  // the unified bridge without re-pairing.
  const ALLOWED_TOKENS = new Set([TOKEN]);
  try {
    const rc = readFileSync(
      `${process.env.HOME ?? ""}/.config/claude-remote-terminal/bridge-token`,
      "utf8",
    ).trim();
    if (rc) ALLOWED_TOKENS.add(rc);
  } catch {
    /* no fork token file */
  }
  const HOST = resolveHost();
  const BIND_ADDRESS = HOST.address || "127.0.0.1";

  // ── Extended-session plumbing ─────────────────────────────────────────────
  const hub = new Hub({ historyGraceMs: 1500 });

  /** emit for extended providers: into the shared ring + live hub clients. */
  const emit = (sessionId, msg) => {
    if (!sessionId) {
      console.warn("[bridge] emit with empty sessionId dropped:", msg.type);
      return;
    }
    hub.feed(sessionId, msg);
  };

  const rcCfg = resolveRcConfig(flags);
  const piCfg = resolvePiConfig(flags);

  const rcProvider = rcCfg.enabled ? createClaudeRemoteProvider(emit, { hub }) : null;
  const piProvider = piCfg.enabled
    ? createPiProvider(emit, { hub, pi: piCfg, cwd, defaultCwd: cwd })
    : null;
  // Local (non-RC) Claude Code sessions: disk-listed, streamed from their
  // transcripts, single-writer prompt guard. Disable with
  // EVEN_BRIDGE_CC_DISABLED=1.
  const ccProvider =
    process.env.EVEN_BRIDGE_CC_DISABLED === "1"
      ? null
      : createCcLocalProvider(emit, { hub, official: () => getProvider("claude") });
  // Pi Durable conversations (glasses-started agents), only with
  // EVEN_BRIDGE_DURABLE_ENABLE=1. Imported lazily so a flag-off bridge never
  // loads pi-durable; a store/models failure leaves the rest of the bridge up.
  let durableProvider = null;
  let durableState = "off";
  const durableOpts = durableOptions(process.env);
  // The overseer (EVEN_BRIDGE_OVERSEER_ENABLE=1): its modules load only then. Its extension is in
  // the durable registry from the start and its host is bound before the store resumes any run.
  let overseer = null;
  let overseerMods = null;
  let overseerState = "off";
  const overseerHost = {};
  let checkinBox = null;
  if (durableOpts && overseerEnabled(process.env)) {
    try {
      overseerMods = {
        ...(await import("./overseer/overseer.mjs")),
        ...(await import("./overseer/extension.mjs")),
        ...(await import("./overseer/host.mjs")),
        ...(await import("./overseer/actions.mjs")),
        ...(await import("./overseer/checkins.mjs")),
      };
      // Check-ins and the nightly reset are tasks of the root: registered now, bound once the overseer runs.
      checkinBox = overseerMods.createCheckinBox();
      const extension = overseerMods.createOverseerExtension({ host: overseerHost, checkins: checkinBox });
      durableOpts.overseer = overseerMods.overseerProviderOptions({ extension });
    } catch (err) {
      overseerMods = null;
      overseerState = `failed: ${err.message}`;
    }
  }
  if (durableOpts) {
    let p = null;
    try {
      const { createDurableProvider } = await import("./providers/durable/provider.mjs");
      p = createDurableProvider(emit, { hub, ...durableOpts });
      if (overseerMods) {
        Object.assign(overseerHost, overseerMods.createOverseerHost({ durable: p, pi: piProvider, cc: ccProvider, rc: rcProvider }));
      }
      await p.ready; // store open + resumed (undefined on providers without it)
      durableProvider = p;
      durableState = `on wrapper=${p.wrapper ?? "none"} lc=${p.lcBanner ?? "off"}`;
      if (durableOpts.assistant) durableState += ` assistant=${p.assistant ? "on" : `failed: ${p.assistantError?.message ?? "not set up"}`}`;
    } catch (err) {
      durableState = `failed: ${err.message}`;
      p?.stopAll().catch(() => {});
    }
    if (durableProvider && overseerMods) {
      try {
        const o = overseerMods.createOverseer({
          durable: durableProvider,
          host: overseerHost,
          // Item kinds and numbers only: the texts may carry session output.
          emit: (item) => console.log(`[overseer] outbox +${item.kind} #${item.seq}`),
          // Hand-offs (the Ideate overnight hand-off, gated): a told ask may carry {tag, label, ttlS}.
          handoffs: String(process.env.EVEN_BRIDGE_OVERSEER_HANDOFF ?? "").trim() === "1",
        });
        await o.ready;
        overseerHost.handoffTag = (tag) => o.handoffTag(tag);
        // Gated actions: proposals, the confirm endpoint, the phone's permission prompt on dur-overseer.
        const actions = overseerMods.createOverseerActions({
          durable: durableProvider,
          host: overseerHost,
          overseer: o,
          emit,
          onOutbox: (item) => console.log(`[overseer] outbox +${item.kind} #${item.seq}`),
          // A throwaway instance (smoke) keeps its audit next to its store; the live one uses ~/.even-terminal.
          ...(process.env.EVEN_BRIDGE_OVERSEER_AUDIT ? { auditPath: process.env.EVEN_BRIDGE_OVERSEER_AUDIT } : {}),
        });
        await actions.ready;
        overseerHost.actions = actions;
        o.bindActions(actions);
        const checkins = overseerMods.createOverseerCheckins({
          durable: durableProvider,
          box: checkinBox,
          onOutbox: (item) => console.log(`[overseer] outbox +${item.kind} #${item.seq}`),
        });
        await checkins.ready;
        durableProvider.onOverseerPermission = (decision) => actions.respond(decision);
        // A lets-code run stopped at its turn / repeated-call cap: one audit line.
        durableProvider.onLcCap = (ev) => actions.auditEvent(overseerMods.lcCapAuditEvent(ev));
        overseer = o;
        overseerState = "on";
      } catch (err) {
        overseerState = `failed: ${err.message}`;
      }
    } else if (overseerMods) {
      overseerState = "failed: durable is not running";
    }
    if (durableProvider && !cwdAllowed(durableOpts.defaultCwd, durableOpts.allowedCwds)) {
      console.warn(
        `[bridge] durable: default cwd ${durableOpts.defaultCwd} is not under EVEN_BRIDGE_DURABLE_CWDS ` +
          `(${durableOpts.allowedCwds.join(":") || `unset, so ${DURABLE_DEFAULT_ROOT}`}); prompts without a cwd will be refused`,
      );
    }
  }

  // Self-heal the dist patch (CC permission-mode env override) on every start.
  // Idempotent + no-op when already applied, so a reboot or an `npm update` that
  // refreshed node_modules can't leave the official CC permission behavior stale.
  // EVEN_BRIDGE_SKIP_PATCH_DIST=1 skips it (test children must not touch node_modules).
  if (process.env.EVEN_BRIDGE_SKIP_PATCH_DIST !== "1") try {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const out = execFileSync(process.execPath, [join(here, "..", "scripts", "patch-dist.mjs")], {
      encoding: "utf8", timeout: 15000,
    }).trim();
    if (out) console.log(`[bridge] ${out.split("\n").pop()}`);
  } catch (err) {
    console.warn(`[bridge] patch-dist self-heal skipped: ${err.message}`);
  }

  console.log(
    `[bridge] extensions: claude-remote=${rcProvider ? "on (" + rcCfg.baseUrl + ")" : "off"}, pi=${piProvider ? "on (" + piCfg.bin + ")" : "off"}, cc-local=${ccProvider ? "on" : "off"}, durable=${durableState}` +
      (overseerEnabled(process.env) ? `, overseer=${overseerState}` : ""),
  );

  // GET /api/info from a cache of the official Claude provider's getInfo()
  // (the phone's Terminal probe gives up after ~2 s). EVEN_BRIDGE_INFO_CACHE_MS=0
  // leaves /api/info to the official route.
  const infoTtlMs = infoCacheMs(process.env);
  const infoCache =
    infoTtlMs > 0 ? createInfoCache({ getInfo: () => getProvider("claude").getInfo(), ttlMs: infoTtlMs }) : null;

  const extRouter = createExtRouter({
    hub,
    providers: [rcProvider, piProvider, durableProvider, ccProvider],
    getDefaultLocalProvider: () => getProvider(getDefaultProvider()),
    overseer,
    infoCache,
    assistant: durableProvider?.assistant ?? null,
  });

  // ── App (mirrors dist/index.js) ───────────────────────────────────────────
  const app = express();
  if (process.env.EVEN_ALLOW_CORS === "1") app.use(cors());
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      console.log(`[${req.ip}] ${res.statusCode} ${req.method} ${redactTokenQueryParam(req.originalUrl)} ${durationMs.toFixed(1)}ms`);
    });
    next();
  });
  app.use(express.json({ limit: "10mb" }));

  // claude-sync hook endpoint (loopback-only, unauthenticated) — registered
  // BEFORE auth, exactly as the official server does.
  app.post("/api/claude-sync/hook", (req, res) => {
    handleHookRequest(req, res, emitBridgeMessage, claudeSyncTransport);
  });

  // /api/assistant/* takes only the assistant API token (the shim's); the bridge token is the phone's.
  if (durableOpts?.assistant) {
    let assistantToken = () => null;
    try {
      assistantToken = assistantApiToken(process.env);
    } catch (err) {
      console.warn(`[bridge] assistant API token unavailable (${err.message}); /api/assistant/* answers 503 to every request`);
    }
    if (!assistantToken()) {
      console.warn(`[bridge] the assistant API token file is missing, empty, unreadable or shorter than ${ASSISTANT_API_TOKEN_MIN} characters; /api/assistant/* answers 503 to every request`);
    }
    app.use("/api/assistant", createAssistantAuth({ reader: assistantToken, allowedTokens: ALLOWED_TOKENS }));
  }

  function auth(req, res, next) {
    if (req.evenAssistantAuth && req.originalUrl.startsWith("/api/assistant/")) return next();
    const header = req.headers.authorization;
    const queryToken = req.query.token;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
    if (!ALLOWED_TOKENS.has(provided)) {
      console.warn(`[auth] 401 ${req.method} ${redactTokenQueryParam(req.originalUrl)} (ip=${req.ip})`);
      res.status(401).json(INFO_AUTH_ERROR);
      return;
    }
    next();
  }

  // Extension router first: it intercepts only owned extended sessions and
  // next()s everything else into the official routers.
  app.use("/api", auth, extRouter);
  app.use("/api", auth, eventsRouter);
  app.use("/api", auth, coreRouter);

  // ── HTTP server + claude-sync WebSocket transport ─────────────────────────
  const httpServer = http.createServer(app);
  claudeSyncTransport.attach(httpServer);
  const loopbackServer =
    BIND_ADDRESS === "127.0.0.1" ? null : http.createServer(app);
  if (loopbackServer) {
    claudeSyncTransport.attach(loopbackServer);
    loopbackServer.on("error", (err) => {
      console.error(`[server] ERROR: failed to listen on loopback port ${PORT}: ${err.message}`);
      process.exit(1);
    });
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  httpServer.listen(PORT, BIND_ADDRESS, () => {
    loopbackServer?.listen(PORT, "127.0.0.1");
    printServerBanner(PORT, TOKEN, process.env.PROJECT_DIR || process.cwd(), true, HOST, true);
    try {
      writeInstancePidfile({
        port: PORT,
        token: TOKEN,
        cwd: process.env.PROJECT_DIR || process.cwd(),
        codexAppServerPort: CODEX_APP_SERVER_PORT,
      });
    } catch (err) {
      console.error(`[server] WARN: failed to write instance pidfile: ${err?.message}`);
    }
    startExposeProvider(PORT, TOKEN);
    installTimestampLogging();
    infoCache?.prime(); // after the log file is attached, so the refresh line lands in it
    const configuredClaudeTools = process.env.EVEN_TERMINAL_CLAUDE_ALLOWED_TOOLS;
    if (configuredClaudeTools !== undefined) {
      const allowedTools = JSON.parse(configuredClaudeTools);
      console.log(`[claude] Effective auto-approved tools: ${allowedTools.join(", ") || "(none)"}`);
    }
  });

  // ── Process-level error handlers + shutdown ───────────────────────────────
  process.on("uncaughtException", (err) => {
    console.error(`[server] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[server] UNHANDLED REJECTION: ${reason}`);
  });

  let durableClosing; // the one stopAll() promise (shutdown can run twice: signal, then exit)
  function shutdown() {
    stopCodexAppServer();
    piProvider?.stopAll().catch(() => {});
    overseer?.close();
    // No abort: unfinished durable runs stay pending and resume on the next start.
    durableClosing ??= durableProvider?.stopAll();
    durableClosing?.catch(() => {});
    rcProvider?._pumps &&
      [...rcProvider._pumps.pumps.keys()].forEach((sid) => rcProvider.stopPump(sid).catch(() => {}));
    removeInstancePidfile();
  }
  // Signals: give the durable store up to 3 s to close cleanly before exiting
  // (the `exit` event cannot wait, so it keeps the fire-and-forget path).
  async function shutdownAndExit() {
    shutdown();
    if (durableClosing) {
      await Promise.race([
        durableClosing.then(() => console.log("[bridge] durable store closed")),
        new Promise((r) => setTimeout(r, DURABLE_CLOSE_MS).unref()),
      ]).catch((err) => console.warn(`[bridge] durable close failed: ${err.message}`));
    }
    process.exit(0);
  }
  process.on("exit", shutdown);
  process.on("SIGINT", shutdownAndExit);
  process.on("SIGTERM", shutdownAndExit);

  return { app, httpServer, hub };
}
