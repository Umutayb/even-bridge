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
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  return opts;
}

/**
 * The lets-code engine of durable sessions (EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE=1), or null.
 * The bin defaults to the pi provider's (the live bridge runs lets-code directly); MemoryMax
 * applies only where the kernel has a memory controller; at most EVEN_BRIDGE_LC_MAX_LIVE
 * children at once (default 1); EVEN_BRIDGE_LC_SANDBOX=0 drops lets-code's sandbox (tests only).
 */
export function lcOptions(env = process.env) {
  if (String(env.EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE ?? "").trim() !== "1") return null;
  const n = Number(env.EVEN_BRIDGE_LC_MAX_LIVE || 1);
  return {
    bin: env.EVEN_BRIDGE_LC_BIN || env.EVEN_BRIDGE_PI_BIN || "lets-code",
    caps: { memoryMax: env.EVEN_BRIDGE_LC_MEMORY_MAX || "500M", cpuQuota: "200%" },
    maxLive: Number.isInteger(n) && n >= 1 ? n : 1,
    sandbox: env.EVEN_BRIDGE_LC_SANDBOX !== "0",
  };
}

/**
 * The overseer (the Durable root conversation as `dur-overseer`, /api/overseer/*):
 * EVEN_BRIDGE_OVERSEER_ENABLE=1, and only with the durable provider on.
 */
export function overseerEnabled(env = process.env) {
  return durableEnabled(env) && String(env.EVEN_BRIDGE_OVERSEER_ENABLE ?? "").trim() === "1";
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
  if (durableOpts && overseerEnabled(process.env)) {
    try {
      overseerMods = {
        ...(await import("./overseer/overseer.mjs")),
        ...(await import("./overseer/extension.mjs")),
        ...(await import("./overseer/host.mjs")),
        ...(await import("./overseer/actions.mjs")),
      };
      const extension = overseerMods.createOverseerExtension({ host: overseerHost });
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
        });
        await o.ready;
        // Gated actions: proposals, the confirm endpoint, the phone's permission prompt on dur-overseer.
        const actions = overseerMods.createOverseerActions({
          durable: durableProvider,
          host: overseerHost,
          overseer: o,
          emit,
          onOutbox: (item) => console.log(`[overseer] outbox +${item.kind} #${item.seq}`),
        });
        await actions.ready;
        overseerHost.actions = actions;
        o.bindActions(actions);
        durableProvider.onOverseerPermission = (decision) => actions.respond(decision);
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

  const extRouter = createExtRouter({
    hub,
    providers: [rcProvider, piProvider, durableProvider, ccProvider],
    getDefaultLocalProvider: () => getProvider(getDefaultProvider()),
    overseer,
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

  function auth(req, res, next) {
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
