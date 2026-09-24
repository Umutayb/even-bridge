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
const NL = 0x0a; // "\n" is always a single 0x0A byte in UTF-8

/**
 * @param {{
 *   emit: (sessionId: string, msg: object) => void,
 *   intervalMs?: number,
 *   log?: (s: string) => void,
 * }} deps
 */
export function createCcWatcher({ emit, intervalMs = 1000, log = () => {} } = {}) {
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
    const w = { file, offset: Math.max(0, offset), state: {}, timer: null };
    w.timer = setInterval(() => {
      tick(sessionId).catch((err) => log(`[cc-watch] ${sessionId.slice(0, 8)}: ${err.message}`));
    }, intervalMs);
    w.timer.unref?.();
    watches.set(sessionId, w);
  }

  async function tick(sessionId) {
    const w = watches.get(sessionId);
    if (!w) return;
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
      for (const m of ccEntriesToWire(entries, w.state)) emit(sessionId, m);
      if (w.offset >= size) break;
    }
  }

  function stop(sessionId) {
    const w = watches.delete(sessionId);
    if (w) clearInterval(w.timer);
  }

  return { start, stop, has: (id) => watches.has(id) };
}
