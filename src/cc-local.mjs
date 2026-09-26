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
 *   sessionsDir?: string,   // CC per-process records (default ~/.claude/sessions)
 *   watcher?: object,       // injected createCcWatcher() result (tests)
 *   intervalMs?: number,
 *   log?: (s: string) => void,
 * }} [deps]
 */
export function createCcLocalProvider(
  emit,
  { base, tmuxBin = "tmux", procRoot = "/proc", sessionsDir, watcher, intervalMs = 1000, log = () => {} } = {}
) {
  const ccBase = base ?? ccProjectsBase();
  const watch = watcher ?? createCcWatcher({ emit, intervalMs, log });
  const seededOffsets = new Map(); // sessionId -> watcher baseline byte offset

  const fileOf = (sessionId) => findCcSessionFile(sessionId, ccBase);

  /**
   * Terminal claudes that may be driving THIS conversation. Ownership is per
   * conversation, not per cwd: a claude whose CC record names another
   * session is not a driver of this one (several share a cwd routinely).
   * A claude without a record is unknown and counts, conservatively.
   */
  async function driversOf(sessionId, cwd) {
    const external = await findExternalClaude(cwd, { procRoot, sessionsDir });
    return external.filter((p) => p.sessionId == null || p.sessionId === sessionId);
  }

  async function stateOf(sessionId, file) {
    const drivers = await driversOf(sessionId, ccMeta(file).cwd);
    let fresh = false;
    try {
      fresh = Date.now() - statSync(file).mtimeMs < FRESH_MS;
    } catch {
      /* keep false */
    }
    if (fresh) return "busy";
    if (drivers.length === 0) return "idle";
    // The owner's own busy/idle beats "a terminal is attached".
    const owner = drivers.find((p) => p.sessionId === sessionId && p.status);
    return owner ? (owner.status === "idle" ? "idle" : "busy") : "busy";
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
      return file ? stateOf(sessionId, file) : null;
    },

    async getStatus(sessionId) {
      const file = fileOf(sessionId);
      if (!file) return null;
      return { state: await stateOf(sessionId, file), provider: "claude" };
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
      // Watcher baseline = the END of the seeded window: seeding already
      // covered the tail [size - SEED_BYTES .. size], so the watcher must
      // start at `size` — starting at the window's beginning would re-emit
      // the seeded frames (duplicating them in the ring).
      seededOffsets.set(sessionId, size);
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
     *  - external claude driving this conversation (CC record) or, when
     *    unknown, this session's cwd + reachable tmux pane
     *    (screen shows this conversation, or it's the newest in the cwd)
     *    -> deliver into the pane (same session, one writer)
     *  - external claude alive but unreachable -> NOT delivered (never
     *    double-drive), told in the session stream: echo + error frame
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
      const external = await driversOf(sessionId, meta.cwd);
      if (external.length > 0) {
        // A known owner: its own pane, no guessing. Unknown: any claude pane
        // in the cwd, confirmed by screen content / newest-in-cwd.
        const owner = external.find((p) => p.sessionId === sessionId);
        const pane = await findClaudeTmuxPane(meta.cwd, { tmuxBin, procRoot, pid: owner?.pid });
        if (pane) {
          const screen = owner ? null : await capturePane(pane, { tmuxBin }).catch(() => null);
          const mine =
            owner != null ||
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
        // Refuse to double-drive — but tell it IN the session stream. The
        // glasses silently drop HTTP errors, so a bare 409 made these
        // messages vanish with no reply and no error (09-26: 5 lost prompts).
        // Same shape as pi's BLOCKED path: echo + error frame, 202.
        const pid = external[0].pid;
        log?.(`[bridge] cc-local prompt BLOCKED (claude pid ${pid} not in tmux, cwd ${meta.cwd}) text=${JSON.stringify(text)}`);
        console.log(`[bridge] prompt -> BLOCKED (external claude pid ${pid} in non-tmux terminal) session=${sessionId} text=${JSON.stringify(text)}`);
        // Seed first: seeding only runs on an EMPTY ring, so frames emitted
        // before it would leave the session showing just this error.
        await this.seedTranscript(sessionId);
        emit(sessionId, { type: "user_prompt", text });
        emit(sessionId, {
          type: "error",
          message:
            `Message NOT delivered: this Claude session is open in a terminal the bridge can't reach ` +
            `(claude pid ${pid}, ${meta.cwd}), and it won't run the conversation twice. Type ` +
            `/remote-control in that terminal to reach it from the glasses (or reply there). ` +
            `For new sessions: scripts/onboard.sh sets this up.`,
        });
        return { sessionId, provider: "claude", blocked: true };
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
      const external = await driversOf(sessionId, meta.cwd);
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
