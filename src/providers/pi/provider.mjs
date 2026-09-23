// Vendored & adapted from even-terminal-pi (MIT, c) lallenlowe — src/even/provider.ts
// See NOTICE.md.
//
// Bridge adaptations vs the standalone reference:
//  * provider name on the wire is "claude" (the Even app filters the session
//    list to known providers; "pi" would be invisible) — cosmetic only.
//  * every session id this provider creates/resumes is CLAIMED in the
//    ownership registry (src/ownership.mjs) so per-session calls route here
//    even when the phone omits the provider param.
//  * `probe(sessionId)` answers the ownership registry from disk: a pi session
//    file for that id in ~/.pi/agent/sessions means this provider owns it.
//  * messages emitted before the session id is known are buffered per session
//    and flushed when the id resolves (the reference dropped them).

import { readFileSync } from "node:fs";
import { PiSession } from "./session.mjs";
import {
  listSessionFiles,
  findSessionFile,
  readHistory,
  readSessionCwd,
  readRecentModel,
} from "./session-files.mjs";
import { claim, forget } from "../../ownership.mjs";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";
import { transcriptEntriesToWire } from "./wire.mjs";
import { TranscriptWatcher, defaultFindFile } from "./watcher.mjs";
import { findExternalPi, findPiTmuxPane, tmuxDeliver } from "./detect.mjs";

const NAME = "pi";
const WIRE_PROVIDER = "claude";

function isFlag(v) {
  return v === false || v === "0" || v === "false" || v === "no";
}

export function resolvePiConfig(flags = {}) {
  return {
    enabled: !isFlag(flags.piEnable ?? process.env.EVEN_BRIDGE_PI_ENABLE ?? "1"),
    bin: flags.piBin ?? process.env.EVEN_BRIDGE_PI_BIN ?? "pi",
    model: flags.piModel ?? process.env.EVEN_BRIDGE_PI_MODEL ?? "",
    allCwds: !isFlag(flags.piAllCwds ?? process.env.EVEN_BRIDGE_PI_ALL_CWDS ?? "1"),
    agentDir: flags.piAgentDir ?? process.env.EVEN_BRIDGE_PI_AGENT_DIR ?? undefined,
    tmuxEnabled: !isFlag(flags.piTmux ?? process.env.EVEN_BRIDGE_PI_TMUX ?? "1"),
    watchIntervalMs: Number(
      flags.piWatchIntervalMs ?? process.env.EVEN_BRIDGE_PI_WATCH_MS ?? 1000
    ) || 1000,
  };
}

function waitForId(session, ms = 10_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (session.sessionId) {
        clearInterval(t);
        resolve(session.sessionId);
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        resolve(null);
      }
    }, 100);
  });
}

/**
 * @param {(sessionId: string, msg: object) => void} emit — (sessionId, msg) =>
 *   ring + hub feed. Messages with an empty sessionId are dropped (guarded in
 *   PiSession by the per-session buffering done here before calling emit).
 * @param {{ hub, pi?: object, cwd?: string, defaultCwd?: string }} deps
 */
export function createPiProvider(emit, { hub, pi = {}, cwd, defaultCwd } = {}) {
  // Env/flag defaults, with the injected config taking precedence (tests DI a
  // temporary agentDir here).
  const cfg = { ...resolvePiConfig(), ...pi };
  const sessions = new Map(); // sessionId -> PiSession
  const seeding = new Set(); // session ids whose transcript seed is in flight
  const liveByFile = new Map(); // resume file -> PiSession
  let cachedVersion = null;
  const extCache = new Map(); // cwd -> {at, ext: [{pid,cwd}]}

  // DI hooks (tests inject fakes): probe external terminal pi processes for a
  // cwd, find a matching tmux pane, and deliver text into it.
  const probeExternal = pi.externalProbe ?? findExternalPi;
  const probeTmuxPane = pi.tmuxPaneProbe ?? findPiTmuxPane;
  const deliverTmux = pi.tmuxDeliver ?? tmuxDeliver;

  async function probeExternalCached(cwd) {
    const hit = extCache.get(cwd);
    if (hit && Date.now() - hit.at < 3000) return hit.ext;
    let ext = [];
    try {
      ext = await probeExternal(cwd, { excludePids: childPids() });
    } catch {
      ext = [];
    }
    extCache.set(cwd, { at: Date.now(), ext });
    return ext;
  }

  /** PIDs of our own bridge-spawned pi children (excluded from driver probes). */
  function childPids() {
    const pids = [];
    for (const s of sessions.values()) if (s.childPid) pids.push(s.childPid);
    return pids;
  }

  /** True when this session has a live bridge child that is still the sole
   *  writer (no external terminal pi for its cwd). */
  async function isSoleWriter(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || !s.client?.running) return false;
    const file = findSessionFile(sessionId, cfg.agentDir);
    if (!file) return true; // fresh in-memory session: nothing else can write it
    const cwd = readSessionCwd(sessionId, cfg.agentDir) ?? cwd ?? defaultCwd;
    const ext = await probeExternalCached(cwd);
    return ext.length === 0;
  }

  const watcher = new TranscriptWatcher({
    emit: (sid, msg) => {
      if (sid) emit(sid, msg);
    },
    findFile: defaultFindFile(cfg.agentDir),
    healthy: async (sid) => isSoleWriter(sid),
    active: (sid) => hub?.clientCount(sid) > 0 || sessions.has(sid),
    intervalMs: cfg.watchIntervalMs,
  });
  // The watcher's healthy/active are async-friendly (tick awaits nothing; the
  // healthy callback may return a promise — tick treats falsy as unhealthy).
  // Wrap so a rejected probe never kills the timer.
  const origTick = watcher.tick.bind(watcher);
  watcher.tick = async (sid) => {
    try {
      await origTick(sid);
    } catch (err) {
      console.warn(`[pi-watch] tick failed for ${sid}: ${err.message}`);
    }
  };

  async function piVersion() {
    if (cachedVersion) return cachedVersion;
    try {
      const { execFile } = await import("node:child_process");
      const out = await new Promise((res, rej) =>
        execFile(cfg.bin, ["--version"], { timeout: 5000 }, (err, stdout) =>
          err ? rej(err) : res(String(stdout ?? "").trim())
        )
      );
      cachedVersion = out.split(/\s+/).pop() || out;
      return cachedVersion;
    } catch {
      cachedVersion = "unknown";
      return cachedVersion;
    }
  }

  function noteLive(session, file) {
    if (session.sessionId) {
      sessions.set(session.sessionId, session);
      claim(session.sessionId, NAME);
    }
    if (file) liveByFile.set(file, session);
  }

  const provider = {
    name: NAME,
    wireProvider: WIRE_PROVIDER,

    /** Disk-based ownership probe: is there a pi session file for this id? */
    probe(sessionId) {
      const file = findSessionFile(sessionId, cfg.agentDir);
      if (file) claim(sessionId, NAME);
      return !!file;
    },

    listSessions(limit = 10, phoneCwd) {
      const scope = phoneCwd ?? (cfg.allCwds ? undefined : cwd ?? defaultCwd);
      return listSessionFiles(limit, scope, cfg.agentDir);
    },

    async getSessionStatus(sessionId) {
      const s = sessions.get(sessionId);
      if (s) return s.status;
      return "idle";
    },

    async getInfo() {
      const model = readRecentModel(cwd ?? defaultCwd, cfg.agentDir);
      return {
        account: { loggedIn: true, email: "pi", scope: "local" },
        model: model || cfg.model || "pi",
        version: await piVersion(),
        provider: WIRE_PROVIDER,
      };
    },

    getHistory(sessionId, limit = 10) {
      const items = readHistory(sessionId, limit, cfg.agentDir);
      if (items.length) claim(sessionId, NAME);
      return items.map((h) => ({ role: h.role, text: h.text }));
    },

    /**
     * Seed the shared ring with this session's on-disk transcript so that
     * /messages and SSE needReplay can serve the conversation even for
     * sessions never loaded live in this bridge instance (e.g. right after a
     * restart). Mirrors the RC pump, which rebuilds its ring from upstream
     * history. No-op when the session is already live, the ring is already
     * populated, or no transcript exists. The official ring's 500-message cap
     * applies, so very long sessions surface their most recent context
     * (same as the fork's behavior).
     */
    async seedTranscript(sessionId) {
      if (!sessionId) return;
      if (sessions.has(sessionId)) return; // live: its messages already flow into the ring
      if (seeding.has(sessionId)) return;
      if (getMessages(sessionId, 0).length > 0) return;
      const file = findSessionFile(sessionId, cfg.agentDir);
      if (!file) return;
      let raw;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        return;
      }
      seeding.add(sessionId);
      try {
        const entries = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          entries.push(e);
        }
        for (const m of transcriptEntriesToWire(entries)) emit(sessionId, m);
        claim(sessionId, NAME);
      } finally {
        seeding.delete(sessionId);
      }
    },

    /** Watch a session's transcript for EXTERNAL writers (terminal pi). */
    watchTranscript(sessionId) {
      watcher.watch(sessionId);
    },

    /** Stop watching once no clients remain and no live session. */
    unwatchTranscript(sessionId) {
      watcher.unwatch(sessionId);
    },

    /**
     * Send a prompt. Single-writer routing (the crux of pi sync):
     *  1. External terminal pi alive for the session's cwd? That terminal
     *     owns the conversation: deliver via tmux send-keys (single writer),
     *     or report clearly if the terminal isn't under tmux — NEVER spawn a
     *     second instance (it wedges and silently drops prompts).
     *  2. Otherwise a live bridge child (sole writer) gets steer/run.
     *  3. Otherwise spawn/resume our own `pi --mode rpc --session <file>`.
     */
    async prompt(sessionId, text, phoneCwd) {
      let session = null;
      let file = null;
      const directEmit = (sid, msg) => {
        if (sid) emit(sid, msg);
      };

      if (sessionId) {
        file = findSessionFile(sessionId, cfg.agentDir);
        const cwd0 = readSessionCwd(sessionId, cfg.agentDir) ?? phoneCwd ?? cwd;
        session = sessions.get(sessionId);

        // External terminal driver for this cwd? The terminal owns the
        // conversation — route to it, never to a second instance.
        const ext = file ? await probeExternalCached(cwd0) : [];
        if (ext.length > 0) {
          if (session) {
            // Drop our wedged/superseded child (it would eat prompts).
            console.log(`[pi] ${sessionId}: external pi pid ${ext[0].pid} active — dropping bridge child`);
            await session.stop().catch(() => {});
            this.forgetSession(sessionId);
          }
          if (cfg.tmuxEnabled) {
            const pane = await probeTmuxPane(cwd0).catch(() => null);
            if (pane) {
              await deliverTmux(pane, text);
              emit(sessionId, { type: "user_prompt", text }); // echo the phone's own message
              console.log(`[bridge] prompt -> tmux pane ${pane} (external pi pid ${ext[0].pid}) session=${sessionId}`);
              return { sessionId, provider: WIRE_PROVIDER };
            }
          }
          emit(sessionId, { type: "user_prompt", text });
          emit(sessionId, {
            type: "error",
            message:
              "This pi session is being driven from a terminal that is not in tmux. " +
              "The glasses can watch it live, but can't send to it. Run the terminal " +
              "session under tmux (tmux new; pi --resume) to send prompts from the glasses.",
          });
          console.log(`[bridge] prompt -> BLOCKED (external pi pid ${ext[0].pid} in non-tmux terminal) session=${sessionId}`);
          return { sessionId, provider: WIRE_PROVIDER };
        }

        if (!session && file) {
          session = new PiSession(directEmit, {
            resume: file,
            cwd: cwd0,
            ...rpcOpts(),
            onExit: (s) => this.forgetSession(s.sessionId ?? sessionId),
          });
          await session.start();
          noteLive(session, file);
        }
        if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
      } else {
        const startCwd = phoneCwd ?? cwd ?? defaultCwd;
        session = new PiSession(directEmit, {
          cwd: startCwd,
          ...rpcOpts(),
          onExit: (s) => {
            if (s.sessionId) this.forgetSession(s.sessionId);
          },
        });
        await session.start();
      }

      // Buffer messages emitted before the id is known (PiSession.send uses
      // sessionId ?? ""); flush once the id is resolved.
      const pending = [];
      session.emit = (sid, msg) => (sid ? emit(sid, msg) : pending.push(msg));

      if (session.sessionId) noteLive(session, file);

      if (session.status === "busy") {
        // even-terminal semantics: prompting a busy session steers the live turn.
        await session.steer(text);
      } else {
        await session.run(text);
      }

      const sid = session.sessionId ?? (await waitForId(session));
      if (sid) {
        for (const m of pending.splice(0)) emit(sid, m);
        noteLive(session, file);
      }
      return { sessionId: sid ?? "", provider: WIRE_PROVIDER };
    },

    respondPermission(sessionId, decision) {
      const s = sessions.get(sessionId);
      if (!s) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
      s.respondPermission(decision || "deny");
    },

    respondQuestion(sessionId, answer) {
      const s = sessions.get(sessionId);
      if (!s) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
      s.respondQuestion(answer || "skip");
    },

    interrupt(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
      s.interrupt();
    },

    getStatus(sessionId) {
      const s = sessions.get(sessionId);
      if (s) return { state: s.status, provider: WIRE_PROVIDER };
      if (findSessionFile(sessionId, cfg.agentDir)) {
        return { state: "idle", provider: WIRE_PROVIDER };
      }
      return null;
    },

    /** Release a dead subprocess for a session (call after pi exits). */
    forgetSession(sessionId) {
      const s = sessions.get(sessionId);
      if (s) sessions.delete(sessionId);
      for (const [file, live] of liveByFile) if (live === s) liveByFile.delete(file);
      forget(sessionId);
    },

    /** Kill every live pi subprocess (bridge shutdown). */
    async stopAll() {
      watcher.stopAll();
      const all = new Set(sessions.values());
      for (const s of all) {
        try {
          await s.stop();
        } catch {
          /* best-effort */
        }
      }
    },

    _sessions: sessions,
  };

  function rpcOpts() {
    const o = { bin: cfg.bin };
    if (cfg.model) o.model = cfg.model;
    return o;
  }

  return provider;
}
