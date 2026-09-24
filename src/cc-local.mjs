// Local (non-remote-control) Claude Code sessions as an extended provider.
//
// The phone already sees local CC sessions in the list (the ext-router
// /sessions slot serves them from a disk scan — see cc-transcripts.mjs).
// This provider gives them the same live treatment as pi/RC:
//   - ring seeding from the on-disk transcript (official /api/messages is
//     ring-only and the official dist only knows bridge-launched sessions)
//   - transcript watching (terminal -> phone streaming with tool frames)
//   - a single-writer prompt guard: NEVER spawn a parallel claude while a
//     terminal claude is driving the session (tmux injection when reachable,
//     409 when not)
//
// Sessions the official dist launched itself keep flowing through the
// official routers: if the session's ring is already populated (the official
// pipeline streams it) we never seed or watch, and prompt() passes through
// to the official handler (spawn/resume is the correct single writer for
// dead or bridge-launched sessions).

import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";
import { statSync } from "node:fs";
import { claim } from "./ownership.mjs";
import {
  ccMeta,
  ccProjectsBase,
  findCcSessionFile,
  listCcSessions,
  parseCcLines,
  readTail,
  ccEntriesToWire,
  recentCcPromptFragments,
} from "./cc-transcripts.mjs";
import { createCcWatcher } from "./cc-watch.mjs";
import {
  capturePane,
  findClaudeTmuxPane,
  findExternalClaude,
  screenShowsFragments,
  tmuxDeliver,
} from "./providers/pi/detect.mjs";

export const CC_LOCAL_NAME = "cc-local";

const SEED_BYTES = 1024 * 1024; // seeding tail window
const FRESH_MS = 15_000; // transcript written within 15s counts as live

/**
 * @param {(sessionId: string, msg: object) => void} emit shared emit
 *   (official ring + hub live clients — same emit the server uses for pi/RC)
 * @param {{
 *   base?: string,          // CC projects dir (default ~/.claude/projects)
 *   tmuxBin?: string,
 *   procRoot?: string,
 *   watcher?: object,       // injected createCcWatcher() result (tests)
 *   intervalMs?: number,
 *   log?: (s: string) => void,
 * }} [deps]
 */
export function createCcLocalProvider(
  emit,
  { base, tmuxBin = "tmux", procRoot = "/proc", watcher, intervalMs = 1000, log = () => {} } = {}
) {
  const ccBase = base ?? ccProjectsBase();
  const watch = watcher ?? createCcWatcher({ emit, intervalMs, log });
  const seededOffsets = new Map(); // sessionId -> watcher baseline byte offset

  const fileOf = (sessionId) => findCcSessionFile(sessionId, ccBase);

  async function stateOf(file) {
    const meta = ccMeta(file);
    const external = await findExternalClaude(meta.cwd, { procRoot });
    let fresh = false;
    try {
      fresh = Date.now() - statSync(file).mtimeMs < FRESH_MS;
    } catch {
      /* keep false */
    }
    return external.length > 0 || fresh ? "busy" : "idle";
  }

  return {
    name: CC_LOCAL_NAME,
    wireProvider: "claude",

    // Disk file existence is the probe (CC session ids are plain uuids).
    probe: (sessionId) => fileOf(sessionId) != null,

    // The disk rows flow through the /sessions "local" slot instead; the
    // ext list adds nothing here.
    listSessions: async () => [],

    getSessionStatus: async (sessionId) => {
      const file = fileOf(sessionId);
      return file ? stateOf(file) : null;
    },

    async getStatus(sessionId) {
      const file = fileOf(sessionId);
      if (!file) return null;
      return { state: await stateOf(file), provider: "claude" };
    },

    /**
     * Seed the shared ring from the on-disk transcript. Once per bridge
     * instance, and only when nothing else populated the ring yet — the
     * official pipeline already streams bridge-launched sessions, and
     * re-seeding would duplicate their frames.
     */
    async seedTranscript(sessionId) {
      if (getMessages(sessionId, 0).length > 0) return;
      const file = fileOf(sessionId);
      if (!file) return;
      let size;
      try {
        size = statSync(file).size;
      } catch {
        return;
      }
      seededOffsets.set(sessionId, Math.max(0, size - SEED_BYTES));
      const entries = parseCcLines(readTail(file, SEED_BYTES));
      for (const m of ccEntriesToWire(entries)) emit(sessionId, m);
      claim(sessionId, CC_LOCAL_NAME);
      log?.(`[bridge] cc-local: seeded ring for ${sessionId.slice(0, 8)} from ${file}`);
    },

    /**
     * Start (or keep) the transcript watcher. Only sessions WE seeded are
     * watched: if the ring was already populated, the official pipeline
     * streams this session and our watcher would double-emit its frames.
     */
    watchTranscript(sessionId) {
      const file = fileOf(sessionId);
      if (!file) return;
      const baseline = seededOffsets.get(sessionId);
      if (baseline == null) return;
      watch.start(sessionId, file, baseline);
    },

    unwatchTranscript(sessionId) {
      watch.stop(sessionId);
    },

    /**
     * Single-writer guard (mirrors the pi provider):
     *  - external claude driving this session's cwd + reachable tmux pane
     *    (screen shows this conversation, or it's the newest in the cwd)
     *    -> deliver into the pane (same session, one writer)
     *  - external claude alive but unreachable -> 409 (never double-drive)
     *  - nothing external -> pass through to the official router, which
     *    owns spawn/resume of bridge-launched/dead sessions
     */
    async prompt(sessionId, text) {
      const file = fileOf(sessionId);
      if (!file) {
        const err = new Error("Session not found");
        err.statusCode = 404;
        throw err;
      }
      const meta = ccMeta(file);
      const external = await findExternalClaude(meta.cwd, { procRoot });
      if (external.length > 0) {
        const pane = await findClaudeTmuxPane(meta.cwd, { tmuxBin });
        if (pane) {
          const screen = await capturePane(pane, { tmuxBin }).catch(() => null);
          const mine =
            screenShowsFragments(screen, recentCcPromptFragments(file)) ||
            (await listCcSessions({ limit: 1, cwd: meta.cwd, base: ccBase })[0]?.id === sessionId);
          if (mine) {
            await tmuxDeliver(pane, text, { tmuxBin });
            log?.(
              `[bridge] cc-local prompt -> tmux pane ${pane} (external claude ${external[0].pid}, cwd ${meta.cwd})`
            );
            claim(sessionId, CC_LOCAL_NAME);
            return { sessionId, provider: "claude" };
          }
        }
        const err = new Error(
          `That session is running in a terminal the bridge can't reach ` +
            `(claude pid ${external[0].pid}, cwd ${meta.cwd}). Reply in that terminal — or put it in ` +
            `a tmux pane — instead of driving it twice.`
        );
        err.statusCode = 409;
        throw err;
      }
      // Not externally driven: the official router is the single writer.
      // Stop our watcher first so frames can't double once it spawns.
      watch.stop(sessionId);
      seededOffsets.delete(sessionId);
      return { passThrough: true };
    },

    /**
     * History in the official wire shape ({role, text} only — the phone's
     * history view renders clean conversation; tool activity is a live-feed
     * feature, same as official sessions).
     */
    getHistory(sessionId, limit = 10) {
      const file = fileOf(sessionId);
      if (!file) return [];
      const wire = ccEntriesToWire(parseCcLines(readTail(file, 512 * 1024)));
      const out = [];
      for (const m of wire) {
        if (m.type === "user_prompt") out.push({ role: "user", text: m.text });
        else if (m.type === "text_delta") out.push({ role: "assistant", text: m.text });
      }
      return out.slice(-limit);
    },

    async interrupt(sessionId) {
      const file = fileOf(sessionId);
      if (!file) {
        const err = new Error("Session not found");
        err.statusCode = 404;
        throw err;
      }
      const meta = ccMeta(file);
      const external = await findExternalClaude(meta.cwd, { procRoot });
      if (external.length > 0) {
        const err = new Error("That session is running in a terminal the bridge can't interrupt. Use Ctrl+C there.");
        err.statusCode = 409;
        throw err;
      }
      return { ok: true }; // bridge-launched/dead: official router's territory
    },

    // CC permission prompts are answered in the terminal UI itself.
    respondPermission: async () => false,

    async respondQuestion() {
      throw Object.assign(new Error("No question pending on this session"), { statusCode: 400 });
    },
  };
}
