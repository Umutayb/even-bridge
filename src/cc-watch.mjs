// Live tailer for local Claude Code transcripts.
//
// The official dist streams bridge-launched CC sessions itself (hook /
// sync transport) but never streams sessions driven by an EXTERNAL terminal
// claude. This watcher tails the transcript file of an open session and
// emits converted wire messages through the shared emit (official ring +
// live SSE clients), so the phone gets live tool/text frames exactly like
// pi external sessions.

import { statSync } from "node:fs";
import { readRange, parseCcLines, ccEntriesToWire } from "./cc-transcripts.mjs";

const MAX_STEP = 4 * 1024 * 1024; // max bytes read per tick
const STATS_INTERVAL_MS = 10_000; // official sessions tick running_stats every 10 s of a turn
const FRESH_MS = 15_000; // a transcript written within 15 s is a running turn (cc-local's own rule)
const NL = 0x0a; // "\n" is always a single 0x0A byte in UTF-8

/**
 * @param {{
 *   emit: (sessionId: string, msg: object) => void,
 *   intervalMs?: number,
 *   statsIntervalMs?: number, // running_stats cadence while the transcript is being written
 *   freshMs?: number,         // quiet for this long = the turn is over
 *   log?: (s: string) => void,
 * }} deps
 */
export function createCcWatcher({
  emit,
  intervalMs = 1000,
  statsIntervalMs = STATS_INTERVAL_MS,
  freshMs = FRESH_MS,
  log = () => {},
} = {}) {
  const watches = new Map(); // sessionId -> {file, offset, state, timer}

  /**
   * Start tailing `file` for `sessionId` from `fromByte` (default: current
   * file size — only new appends; the seeder already covered the rest).
   */
  function start(sessionId, file, fromByte = null) {
    if (!sessionId || !file || watches.has(sessionId)) return;
    let offset = fromByte;
    if (offset == null) {
      try {
        offset = statSync(file).size;
      } catch {
        return;
      }
    }
    // turn: ms of the first write of the current turn (0 = none running), lastWrite: ms of the latest write,
    // lastStats: ms of the latest running_stats; tokens accumulate from the assistant entries' usage
    const w = {
      file,
      offset: Math.max(0, offset),
      state: {},
      timer: null,
      turnStartMs: 0,
      lastWriteMs: 0,
      lastStatsMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    w.timer = setInterval(() => {
      tick(sessionId).catch((err) => log(`[cc-watch] ${sessionId.slice(0, 8)}: ${err.message}`));
    }, intervalMs);
    w.timer.unref?.();
    watches.set(sessionId, w);
  }

  async function tick(sessionId) {
    const w = watches.get(sessionId);
    if (!w) return;
    await readNew(sessionId, w);
    tickStats(sessionId, w);
  }

  /**
   * The phone's "thinking" row moves on `running_stats` frames only (the official sessions send one every 10 s
   * of a turn). A transcript turn has no busy/idle events, so: the first write after a quiet spell starts the
   * turn (a `user_prompt` restarts it), writes keep it alive for `freshMs`, and one frame goes out every
   * `statsIntervalMs` while it lives. A quiet transcript ends the turn silently (status comes from the poll).
   */
  function tickStats(sessionId, w) {
    if (!w.turnStartMs) return;
    const now = Date.now();
    if (now - w.lastWriteMs >= freshMs) {
      w.turnStartMs = 0;
      w.inputTokens = 0;
      w.outputTokens = 0;
      return;
    }
    if (now - w.lastStatsMs < statsIntervalMs) return;
    w.lastStatsMs = now;
    emit(sessionId, {
      type: "running_stats",
      durationMs: now - w.turnStartMs,
      inputTokens: w.inputTokens,
      outputTokens: w.outputTokens,
    });
  }

  function noteWrite(w, entries, frames) {
    const now = Date.now();
    const newTurn = !w.turnStartMs || frames.some((m) => m.type === "user_prompt");
    if (newTurn) {
      w.turnStartMs = now;
      w.lastStatsMs = now;
      w.inputTokens = 0;
      w.outputTokens = 0;
    }
    w.lastWriteMs = now;
    for (const e of entries) {
      const u = e?.type === "assistant" ? e.message?.usage : null;
      if (!u) continue;
      w.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      w.outputTokens += u.output_tokens ?? 0;
    }
  }

  async function readNew(sessionId, w) {
    let size;
    try {
      size = statSync(w.file).size;
    } catch {
      return;
    }
    if (size < w.offset) {
      w.offset = size; // truncated/rotated — start over
      return;
    }
    while (w.offset < size) {
      const buf = readRange(w.file, w.offset, Math.min(size - w.offset, MAX_STEP));
      const nl = buf.lastIndexOf(NL);
      if (nl < 0) {
        if (buf.length < MAX_STEP) return; // partial line — retry next tick
        w.offset += buf.length; // a >4MB line: skip (cannot happen in practice)
        continue;
      }
      const complete = buf.subarray(0, nl + 1);
      w.offset += nl + 1;
      const entries = parseCcLines(complete.toString("utf8"));
      const frames = ccEntriesToWire(entries, w.state);
      if (entries.length) noteWrite(w, entries, frames);
      for (const m of frames) emit(sessionId, m);
      if (w.offset >= size) break;
    }
  }

  function stop(sessionId) {
    const w = watches.delete(sessionId);
    if (w) clearInterval(w.timer);
  }

  return { start, stop, has: (id) => watches.has(id) };
}
