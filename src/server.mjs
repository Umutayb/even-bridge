// even-bridge server entry.
//
// Mirrors @evenrealities/even-terminal dist/index.js wiring (same express app,
// auth, hook endpoint, transport attach, pidfile, expose, logging, shutdown)
// and inserts the extension router BEFORE the official events/core routers:
//
//   app.use("/api", auth, extRouter);     // extended sessions (claude-remote, pi)
//   app.use("/api", auth, eventsRouter);  // official SSE (local claude/codex)
//   app.use("/api", auth, coreRouter);    // official routes
//
// Local Claude Code + Codex sessions flow through the official code paths
// untouched; extended sessions are served from the shared ring by the hub.

import http from "node:http";
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
import { getProvider } from "@evenrealities/even-terminal/dist/routes/core.js";
import { getDefaultProvider } from "@evenrealities/even-terminal/dist/session.js";

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
  const HOST = resolveHost();
  const BIND_ADDRESS = HOST.address || "127.0.0.1";

  // ── Extended-session plumbing ─────────────────────────────────────────────
  const hub = new Hub();

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

  console.log(
    `[bridge] extensions: claude-remote=${rcProvider ? "on (" + rcCfg.baseUrl + ")" : "off"}, pi=${piProvider ? "on (" + piCfg.bin + ")" : "off"}`
  );

  const extRouter = createExtRouter({
    hub,
    providers: [rcProvider, piProvider],
    getDefaultLocalProvider: () => getProvider(getDefaultProvider()),
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
    if (provided !== TOKEN) {
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

  function shutdown() {
    stopCodexAppServer();
    piProvider?.stopAll().catch(() => {});
    rcProvider?._pumps &&
      [...rcProvider._pumps.pumps.keys()].forEach((sid) => rcProvider.stopPump(sid).catch(() => {}));
    removeInstancePidfile();
  }
  process.on("exit", shutdown);
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  return { app, httpServer, hub };
}
