// Upstream SSE relay pump for claude-remote sessions.
//
// Connects to the existing claude-remote-terminal bridge's Even-Terminal-mode
// endpoint (the fork's terminal_host.py, default http://127.0.0.1:8791/api)
// and feeds its event stream into the LOCAL ring + hub, so the phone can talk
// to THIS bridge for RC sessions exactly as it would for local ones.
//
// Resilience mirrors the fork's `_run_pump` (terminal_host.py):
//
//   * RESILIENT LOOP — the upstream stream can END without raising (its own
//     reconnects exhausted, a server-side close). Before, such a pump would
//     die silently and the wearer received nothing until the next /prompt.
//     Here: while anyone is listening (or the session is busy), reopen.
//   * DEDUP — the upstream ring replays on every connect; message ids are
//     monotonic within an upstream process lifetime, so we skip ids we have
//     already fed. A first frame far below our water mark (by more than the
//     upstream ring size) means the upstream restarted (ids reset) — we
//     re-baseline instead of going silent.
//   * IDLE STOP — no local clients for 600s and the session is idle: release
//     the upstream connection (fork: PUMP_IDLE_STOP_S = 600).
//   * SOCKET TUNING — the fork's `_tune_stream_socket`: TCP_NODELAY (a small
//     text_delta must hit the wire immediately) and aggressive keepalive
//     (idle 5s / every 2s / 2 probes ~= 9s) to reap half-open connections
//     left when the network path silently changes.
//   * ONE BAD FRAME MUST NOT KILL THE STREAM — parse errors are logged, not
//     thrown.
//   * ALWAYS SETTLES — a destroyed request (stop()) or a dead socket resolves
//     the in-flight stream; the pump loop can never hang on a half-open TCP.

import http from "node:http";
import { URL } from "node:url";

const IDLE_STOP_MS = 600_000; // fork: PUMP_IDLE_STOP_S
const RING_SIZE = 500; // fork: MAX_MESSAGES_PER_SESSION — reset-detection threshold

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class UpstreamPump {
  /**
   * @param {string} sessionId
   * @param {{
   *   baseUrl: string,          // e.g. http://127.0.0.1:8791
   *   token?: string,           // upstream bearer token ("" = auth disabled upstream)
   *   hub: import("./hub.mjs").Hub,
   *   getState?: (sessionId: string) => Promise<string>, // "busy"|"idle"|"awaiting"
   * }} opts
   */
  constructor(sessionId, opts) {
    this.sid = sessionId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? "";
    this.hub = opts.hub;
    this.getState = opts.getState ?? (async () => "idle");
    this.stopped = false;
    this.lastUpstreamId = 0;
    this.awaitFirstId = true;
    this.lastClientAt = 0;
    this.req = null;
    this.loopPromise = null;
  }

  short() {
    return this.sid.slice(0, 8);
  }

  start() {
    if (!this.loopPromise) {
      this.loopPromise = this._loop();
    }
    return this;
  }

  async stop() {
    this.stopped = true;
    this.req?.destroy();
    await this.loopPromise;
    this.loopPromise = null;
  }

  async _loop() {
    let backoff = 1000;
    while (!this.stopped) {
      const hadClients = this.hub.clientCount(this.sid) > 0;
      try {
        await this._streamOnce();
        backoff = 1000; // clean end — no penalty
      } catch (err) {
        if (this.stopped) break;
        console.warn(`[rc-pump ${this.short()}] upstream error ${err.name}: ${err.message} — reopening in ${backoff}ms`);
        backoff = Math.min(backoff * 2, 10000);
      }
      if (this.stopped) break;
      // The fork: if nobody is listening, a clean end releases the stream.
      // If clients are present (or were just now), reopen.
      if (hadClients || this.hub.clientCount(this.sid) > 0) {
        console.log(`[rc-pump ${this.short()}] upstream stream ended — reopening from water mark ${this.lastUpstreamId}`);
        await sleep(backoff);
        continue;
      }
      // No clients: stay alive only while the session is busy (a turn may be
      // in flight upstream and its result must be delivered).
      let state = "idle";
      try {
        state = await this.getState(this.sid);
      } catch {
        state = "idle";
      }
      if (state !== "idle") {
        await sleep(5000);
        continue;
      }
      console.log(`[rc-pump ${this.short()}] END (stream ended, no clients, idle)`);
      return;
    }
  }

  /** One upstream /events connection. Resolves on a clean close or stop(). */
  _streamOnce() {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/api/events`);
      url.searchParams.set("sessionId", this.sid);
      url.searchParams.set("needReplay", "true");
      if (this.token) url.searchParams.set("token", this.token);
      let settled = false;
      let timer = null;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        if (err) reject(err);
        else resolve();
      };
      const req = http.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            done(new Error(`upstream /events HTTP ${res.statusCode}`));
            return;
          }
          // The fork's socket tuning.
          const sock = res.socket;
          if (sock) {
            try {
              sock.setNoDelay(true);
              sock.setKeepAlive(true, 5000);
            } catch {
              /* best-effort */
            }
          }
          console.log(`[rc-pump ${this.short()}] START (upstream connected)`);
          this.awaitFirstId = true;
          timer = setInterval(() => this._idleCheck(), 30_000);
          timer.unref?.();
          let buf = "";
          res.on("data", (chunk) => {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              try {
                this._handleFrame(frame);
              } catch (err) {
                // One bad frame must not kill the stream (fork: convert error).
                console.warn(`[rc-pump ${this.short()}] frame error: ${err.message}`);
              }
            }
          });
          res.on("end", () => done());
          res.on("error", (err) => done(err));
        }
      );
      this.req = req;
      req.on("error", (err) => done(err));
      // Catch-all: destroying the request (stop()) or the socket dying must
      // still settle this promise — otherwise the pump loop would hang.
      req.on("close", () => done());
      req.end();
    });
  }

  _handleFrame(frame) {
    if (!frame.trim()) return;
    let id = null;
    let data = null;
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) {
        id = parseInt(line.slice(3).trim(), 10);
      } else if (line.startsWith("data:")) {
        data = line.slice(5).trim();
      } else if (line.startsWith(":")) {
        continue; // comment / heartbeat
      }
    }
    if (data === null || data === "") return;
    const msg = JSON.parse(data);
    if (typeof id === "number" && Number.isFinite(id)) {
      if (this.awaitFirstId) {
        this.awaitFirstId = false;
        if (id < this.lastUpstreamId - RING_SIZE) {
          // Upstream restarted: ids reset. Re-baseline so we don't go silent.
          console.log(`[rc-pump ${this.short()}] upstream generation reset (first id ${id} < water mark ${this.lastUpstreamId}) — re-baselining`);
          this.lastUpstreamId = 0;
        }
      }
      if (id <= this.lastUpstreamId) return; // replayed / already fed
      this.lastUpstreamId = id;
    }
    this.hub.feed(this.sid, msg);
  }

  async _idleCheck() {
    if (this.stopped) return;
    if (this.hub.clientCount(this.sid) > 0) {
      this.lastClientAt = 0;
      return;
    }
    if (this.lastClientAt === 0) this.lastClientAt = Date.now();
    if (Date.now() - this.lastClientAt < IDLE_STOP_MS) return;
    let state = "idle";
    try {
      state = await this.getState(this.sid);
    } catch {
      state = "idle";
    }
    if (state === "idle") {
      console.log(`[rc-pump ${this.short()}] END (idle, no clients for ${IDLE_STOP_MS / 1000}s)`);
      this.stop();
    }
  }
}

/** Owns the pump per RC session. */
export class PumpManager {
  constructor(opts) {
    this.opts = opts;
    this.pumps = new Map();
  }

  get(sessionId) {
    return this.pumps.get(sessionId);
  }

  ensure(sessionId) {
    let p = this.pumps.get(sessionId);
    if (!p) {
      p = new UpstreamPump(sessionId, this.opts).start();
      this.pumps.set(sessionId, p);
    }
    return p;
  }

  async stop(sessionId) {
    const p = this.pumps.get(sessionId);
    if (!p) return;
    this.pumps.delete(sessionId);
    await p.stop().catch(() => {});
  }
}
