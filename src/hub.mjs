// Phone-facing SSE endpoint for EXTENDED sessions (claude-remote, pi).
//
// The official events router (dist/routes/events.js) serves local claude/codex
// sessions; extended sessions get their own handler here because the Even
// phone's reconnect behavior (documented by the claude-remote-terminal fork,
// terminal_host.py `_events`) proves the official 15s-heartbeat-only contract
// loses mid-reply gaps:
//
//   * the phone reconnects with NO Last-Event-ID and needReplay=false —
//     a stream-only reconnect. Messages streamed during the offline window
//     are lost forever unless we replay them. (Observed live: the phone
//     reaps its idle SSE sockets ~4 minutes in and reconnects ~1 minute
//     later, stream-only, no resume point.)
//
// So this handler implements the fork's proven resume semantics on top of
// the official ring buffer (pushMessage/getMessages from dist/routes/events.js):
//
//   1. Last-Event-ID resume — replay exactly what the client missed.
//   2. Turn-window gap replay — a stream-only reconnect (sole client) replays
//      the whole most-recent turn (its busy start -> ring tail, capped). The
//      old "replay only after the delivery watermark" rule was unsafe:
//      res.write() succeeds into the kernel buffer of a BLACK-HOLED
//      (half-open) connection — the phone's screen sleeps, the radio drops,
//      the OS keeps ACKing — so the watermark advances past bytes the phone
//      never saw and those bytes were lost until the user manually re-opened
//      the session (the reported "reply cut off mid-sentence" bug). The app
//      merges by message id (it already tolerates the needReplay=true
//      full-ring overlap), so re-sent frames don't duplicate.
//   3. 8s heartbeat + idle re-assertion — when idle, re-emit status:idle so a
//      dropped turn-end can't leave the phone stuck on "thinking". Never
//      re-send busy (would restart the thinking animation mid-turn).
//   4. Socket tuning — TCP_NODELAY (a small text_delta must hit the wire
//      immediately, not coalesce) and aggressive keepalive (idle 5s / every
//      2s / 2 probes ~= 9s) to reap half-open connections left when the
//      phone silently switches network path.
//
// Live fan-out: extended sessions are fed by the upstream relay pump (RC) or
// the in-process pi provider; both call hub.feed, which writes to the shared
// ring (pushMessage) and to this session's live clients. The official
// eventsRouter never sees these sessions, so there is no double delivery.

import { pushMessage, getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";

const HEARTBEAT_MS = 8000; // fork: HEARTBEAT_S = 8
const GAP_REPLAY_CAP = 400; // fallback window when the ring holds no turn start
const TURN_REPLAY_CAP = 1500; // max messages replayed on a stream-only reconnect

function tuneSocket(res) {
  const sock = res.socket;
  if (!sock) return;
  try {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 5000);
  } catch {
    /* best-effort */
  }
}

class SessionStream {
  constructor(sessionId, heartbeatMs = HEARTBEAT_MS) {
    this.sid = sessionId;
    this.heartbeatMs = heartbeatMs;
    /** @type {Set<{res: import('http').ServerResponse, lastFlushed: number}>} */
    this.clients = new Set();
    /** Last local ring id actually flushed to a client (monotonic). */
    this.lastDeliveredId = 0;
    /** Last state observed on the session (from fed messages). */
    this.state = "idle";
  }

  noteMessage(msg) {
    if (msg.type === "status") {
      this.state = msg.state === "idle" ? "idle" : msg.state; // busy/think_*/text_*/awaiting
    }
  }

  /** Fan out a newly-fed message to all live clients; advance watermarks. */
  broadcast(msg, localId) {
    this.noteMessage(msg);
    let dead = 0;
    for (const client of this.clients) {
      let ok = false;
      try {
        ok = client.res.write(`id: ${localId}\ndata: ${JSON.stringify(msg)}\n\n`);
      } catch {
        ok = false;
      }
      if (!ok) {
        this.clients.delete(client);
        dead++;
      } else if (client.lastFlushed < localId) {
        client.lastFlushed = localId;
        if (this.lastDeliveredId < localId) this.lastDeliveredId = localId;
      }
    }
    if (dead > 0) {
      console.warn(`[hub] Removed ${dead} dead client(s) for session=${this.sid} (remaining: ${this.clients.size})`);
    }
  }

  /**
   * Replay window for a stream-only reconnect (no Last-Event-ID, no
   * needReplay): the whole most-recent turn — from its busy start (last
   * non-idle status marker) to the ring tail, capped. This covers the
   * black-holed tail the watermark can't (see file header, point 2).
   * Ring entries are flattened: {id, ...msg}.
   */
  reconnectWindow() {
    const ring = getMessages(this.sid, 0);
    if (ring.length === 0) return [];
    let turnStart = -1;
    for (let i = ring.length - 1; i >= 0; i--) {
      const m = ring[i];
      if ((m.type ?? m.msg?.type) !== "status") continue;
      if ((m.state ?? m.msg?.state) !== "idle") {
        turnStart = i;
        break;
      }
    }
    const from = turnStart === -1 ? Math.max(0, ring.length - GAP_REPLAY_CAP) : turnStart;
    return ring.slice(Math.max(from, ring.length - TURN_REPLAY_CAP));
  }

  async handleEvents(req, res) {
    const needReplay = req.query.needReplay === "true";
    let lastEventId = 0;
    try {
      lastEventId = parseInt(req.headers["last-event-id"] ?? "", 10) || 0;
    } catch {
      lastEventId = 0;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(":ok\n\n");
    tuneSocket(res);

    // Resume policy (mirrors the fork, hardened): Last-Event-ID wins; else
    // full replay when the client asks; else a stream-only (sole-client)
    // reconnect gets the turn-window replay — the watermark alone is unsafe
    // against black-holed connections (see header, point 2). A reconnect
    // while ANOTHER client is live gets no replay (its watermark reflects
    // that client; replaying would re-send what the newcomer already had —
    // the fork's 206-duplicate bug).
    let replay = [];
    let mode;
    if (lastEventId > 0) {
      mode = `resume from ${lastEventId}`;
      replay = getMessages(this.sid, lastEventId);
    } else if (needReplay) {
      mode = "full replay (needReplay)";
      replay = getMessages(this.sid, 0);
    } else if (this.clients.size === 0) {
      replay = this.reconnectWindow();
      mode = "stream-only reconnect -> turn-window replay";
    } else {
      mode = "stream-only (multi-client, no replay)";
    }
    console.log(
      `[hub] ${this.sid.slice(0, 8)}: /events connect Last-Event-ID=${req.headers["last-event-id"] ?? ""} ` +
        `needReplay=${String(needReplay)} -> ${mode} (${replay.length} replayed)`
    );

    const connectedAt = Date.now();
    let endReason = "loop-exit";
    let closed = false;

    // Replay (watermark advances only after a successful flush).
    // The official getMessages returns FLATTENED entries ({id, ...msg}).
    for (const m of replay) {
      const { id, ...msg } = m;
      let ok = true;
      try {
        ok = res.write(`id: ${id}\ndata: ${JSON.stringify(msg)}\n\n`);
      } catch {
        ok = false;
      }
      if (!ok) {
        endReason = "client-dropped (replay)";
        break;
      }
      if (this.lastDeliveredId < id) this.lastDeliveredId = id;
      this.noteMessage(msg);
    }

    const client = { res, lastFlushed: 0 };
    this.clients.add(client);

    const heartbeat = setInterval(() => {
      if (closed) return;
      // The fork's reconcile: re-assert idle so a dropped turn-end can't leave
      // the phone stuck on "thinking". Never re-send busy.
      if (this.state === "idle") {
        try {
          res.write(`data: ${JSON.stringify({ type: "status", state: "idle", sessionId: this.sid })}\n\n`);
        } catch {
          /* fall through to heartbeat write failure */
        }
      }
      try {
        if (!res.write(":heartbeat\n\n")) throw new Error("write failed");
      } catch {
        close("client-dropped (heartbeat)");
      }
    }, this.heartbeatMs);
    heartbeat.unref?.();

    const close = (reason) => {
      if (closed) return;
      closed = true;
      endReason = reason;
      this.clients.delete(client);
      clearInterval(heartbeat);
      console.log(`[hub] ${this.sid.slice(0, 8)}: /events closed after ${((Date.now() - connectedAt) / 1000).toFixed(1)}s reason=${endReason}`);
      try {
        res.end();
      } catch {
        /* already gone */
      }
    };

    req.on("close", () => close("client-dropped (req close)"));
    res.on("error", (err) => close(`client-dropped (${err.name})`));
  }
}

/**
 * Per-session live fan-out + the phone-facing /events handler for extended
 * sessions. Feeds land here from the upstream relay pump (claude-remote) or
 * the in-process pi provider.
 */
export class Hub {
  constructor({ heartbeatMs } = {}) {
    this.heartbeatMs = heartbeatMs ?? HEARTBEAT_MS;
    this.streams = new Map();
  }

  streamFor(sessionId) {
    let s = this.streams.get(sessionId);
    if (!s) {
      s = new SessionStream(sessionId, this.heartbeatMs);
      this.streams.set(sessionId, s);
    }
    return s;
  }

  /**
   * Feed a message into the shared ring AND this session's live clients.
   * Returns the local ring id.
   */
  feed(sessionId, msg) {
    const s = this.streamFor(sessionId);
    const id = pushMessage(sessionId, msg);
    s.broadcast(msg, id);
    return id;
  }

  clientCount(sessionId) {
    return this.streams.get(sessionId)?.clients.size ?? 0;
  }
}
