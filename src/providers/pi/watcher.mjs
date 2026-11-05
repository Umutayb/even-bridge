// Live transcript watcher: tails a pi session's on-disk transcript so that
// activity written by an EXTERNAL driver (a terminal pi TUI, or a tmux-routed
// prompt handled by that terminal) reaches the glasses/phone in near-real
// time, even though the bridge's own ring only sees what its emit() receives.
//
// Design:
//  * per-session poll (default 1s) of the file size — cheap stat;
//  * new complete JSONL lines are converted with transcriptEntriesToWire and
//    fed through the same emit() as live bridge sessions (ring + hub SSE);
//  * entries are deduped by transcript entry id so a session can flip
//    between "live child" and "external writer" without double-emitting;
//  * sessions with a HEALTHY live bridge child are skipped entirely (their
//    events already flow over RPC — the file would only double them);
//  * watching auto-stops when the session has no SSE clients and no live
//    bridge session (the ext-router calls unwatch on stream close).

import { open, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { findSessionFile } from "./session-files.mjs";
import { transcriptEntriesToWire } from "./wire.mjs";

const MAX_SEEN_IDS = 2000;

// The phone's "thinking" row moves on `running_stats` frames only (the official sessions tick one every 10 s
// of a turn). A terminal-driven pi turn has no busy/idle events, so the watcher ticks while the transcript is
// being written: the first write after a quiet spell starts the turn (a user_prompt restarts it), writes keep
// it alive for FRESH_MS, and a quiet transcript ends it silently (status comes from the poll).
const STATS_INTERVAL_MS = 10_000;
const FRESH_MS = 15_000;

export class TranscriptWatcher {
  /**
   * @param {{
   *   emit: (sessionId: string, msg: object) => void,
   *   findFile: (sessionId: string) => string|null,
   *   healthy: (sessionId: string) => boolean,   // live bridge child with no external writes
   *   active: (sessionId: string) => boolean,    // should keep watching (SSE clients / live)
   *   skipUserEcho?: (sessionId: string, text: string) => boolean, // user entry is a copy of a prompt the bridge itself just delivered (already echoed into the ring)
   *   intervalMs?: number,
   *   log?: (line: string) => void,
   * }} deps
   */
  constructor({
    emit,
    findFile,
    healthy,
    active,
    skipUserEcho,
    intervalMs = 1000,
    statsIntervalMs = STATS_INTERVAL_MS,
    freshMs = FRESH_MS,
    log = () => {},
  }) {
    this.statsIntervalMs = statsIntervalMs;
    this.freshMs = freshMs;
    this.emit = emit;
    this.findFile = findFile;
    this.healthy = healthy;
    this.active = active;
    this.skipUserEcho = skipUserEcho;
    this.intervalMs = intervalMs;
    this.log = log;
    /** sessionId -> {timer, offset, seen: Set, seenOrder: string[]} */
    this.watchers = new Map();
  }

  /** Start (or keep) watching a session. Idempotent. */
  watch(sessionId) {
    if (!sessionId || this.watchers.has(sessionId)) return;
    const file = this.findFile(sessionId);
    if (!file) return;
    const w = { offset: 0, seen: new Set(), seenOrder: [] };
    // Baseline: do NOT replay history on connect — seeding (/api/messages,
    // SSE needReplay) already covers it. Start from the current EOF so we
    // only deliver NEW external activity. (Synchronous: the first tick must
    // never see a pre-baseline offset of 0.)
    try {
      w.offset = statSync(file).size;
    } catch {
      w.offset = 0;
    }
    w.timer = setInterval(() => this.tick(sessionId), this.intervalMs);
    w.timer.unref?.();
    this.watchers.set(sessionId, w);
  }

  /** Stop watching once the session is no longer active (no clients, not live). */
  unwatch(sessionId) {
    const w = this.watchers.get(sessionId);
    if (!w) return;
    if (this.active(sessionId)) return; // still relevant — keep watching
    clearInterval(w.timer);
    this.watchers.delete(sessionId);
    this.log(`[pi-watch] ${sessionId}: stopped`);
  }

  async tick(sessionId) {
    const w = this.watchers.get(sessionId);
    if (!w) return;
    await this.readNew(sessionId, w);
    if (this.watchers.get(sessionId) === w) this.tickStats(sessionId, w);
  }

  tickStats(sessionId, w) {
    if (!w.turnStartMs) return;
    const now = Date.now();
    if (now - w.lastWriteMs >= this.freshMs) {
      w.turnStartMs = 0;
      w.inputTokens = 0;
      w.outputTokens = 0;
      return;
    }
    if (now - w.lastStatsMs < this.statsIntervalMs) return;
    w.lastStatsMs = now;
    this.emit(sessionId, {
      type: "running_stats",
      durationMs: now - w.turnStartMs,
      inputTokens: w.inputTokens,
      outputTokens: w.outputTokens,
    });
  }

  noteWrite(w, entries, msgs) {
    const now = Date.now();
    if (!w.turnStartMs || msgs.some((m) => m.type === "user_prompt")) {
      w.turnStartMs = now;
      w.lastStatsMs = now;
      w.inputTokens = 0;
      w.outputTokens = 0;
    }
    w.lastWriteMs = now;
    for (const e of entries) {
      const u = e?.type === "message" && e.message?.role === "assistant" ? e.message.usage : null;
      if (!u) continue;
      w.inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      w.outputTokens += u.output ?? 0;
    }
  }

  async readNew(sessionId, w) {
    // Prune when no longer relevant.
    if (!this.active(sessionId)) {
      clearInterval(w.timer);
      this.watchers.delete(sessionId);
      this.log(`[pi-watch] ${sessionId}: pruned (inactive)`);
      return;
    }
    // Healthy live child: its events flow over RPC; the file would only
    // double-emit. (If an external writer shows up, healthy() flips false.)
    const healthy = await this.healthy(sessionId);
    if (healthy) {
      w.turnStartMs = 0; // the live child's own session ticks its stats
      // Keep the offset current so a later flip back doesn't replay.
      const file = this.findFile(sessionId);
      if (file) {
        try {
          const st = await stat(file);
          if (st.size >= w.offset) w.offset = st.size;
        } catch {
          /* file may be recreated */
        }
      }
      return;
    }

    const file = this.findFile(sessionId);
    if (!file) return;
    let st;
    try {
      st = await stat(file);
    } catch {
      return;
    }
    if (st.size < w.offset) {
      // Truncated/rewritten (compaction). Re-baseline at the new EOF; the
      // ring already holds what it holds.
      this.log(`[pi-watch] ${sessionId}: file shrank -> rebaseline`);
      w.offset = st.size;
      return;
    }
    if (st.size === w.offset) return;

    const fh = await open(file, "r");
    try {
      const len = st.size - w.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, w.offset);
      let text = buf.toString("utf8");
      // Only consume complete lines; keep the partial tail for next tick.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) return;
      const complete = text.slice(0, lastNl + 1);
      w.offset += Buffer.byteLength(complete, "utf8");

      const entries = [];
      for (const line of complete.split("\n")) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e?.id != null) {
          if (w.seen.has(e.id)) continue;
          w.seen.add(e.id);
          w.seenOrder.push(e.id);
          if (w.seenOrder.length > MAX_SEEN_IDS) {
            const drop = w.seenOrder.shift();
            w.seen.delete(drop);
          }
        }
        entries.push(e);
      }
      // Persistent toolCall bookkeeping: toolResult entries usually land in
      // later ticks than the assistant message carrying their toolCall.
      const state = (w.state ??= { pending: new Map() });
      if (state.pending.size > 1000) state.pending.clear();
      const msgs = transcriptEntriesToWire(entries, state);
      if (entries.length) this.noteWrite(w, entries, msgs);
      for (const m of msgs) {
        // The bridge's own tmux-delivered prompt is echoed into the ring at
        // delivery time; the terminal then writes the same prompt to the
        // transcript. Without this skip the user's message reaches the
        // glasses twice, back to back.
        if (m.type === "user_prompt" && this.skipUserEcho?.(sessionId, m.text)) continue;
        this.emit(sessionId, m);
      }
      if (msgs.length) this.log(`[pi-watch] ${sessionId}: +${msgs.length} wire msg(s) from transcript`);
    } finally {
      await fh.close();
    }
  }

  stopAll() {
    for (const [, w] of this.watchers) clearInterval(w.timer);
    this.watchers.clear();
  }
}

/** Convenience default findFile bound to an agentDir. */
export function defaultFindFile(agentDir) {
  return (sessionId) => findSessionFile(sessionId, agentDir);
}
