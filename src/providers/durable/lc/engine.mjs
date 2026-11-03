// The lets-code engine of the durable provider (plan "Hybrid B", rulings 1–5,
// 14–22): a durable session row with `engine: "lets-code"` is driven by an
// owned `lets-code --mode rpc` child (LcSession) in its own scope; Durable only
// keeps the record (LcSessionDoc + lc.* entries) and one background task
// `even.lc-run` per busy period, so a bridge restart re-spawns the child with
// `--session <file>` and continues.
//
// Life of a session:
//   idle, no child ── prompt ──▶ task created (lc.user written) ──▶ drive():
//     spawn (or reuse) the child, `/mode orchestration` when the factory is on,
//     send the text; resolve at agent_end (a slash command: at its prompt
//     response) → lc.answer, record.runs++ → task completed → child kept
//     LC_IDLE_KEEP_MS (never while a dialog is open), then stopped.
//   busy ── prompt ──▶ steer into the running turn (one child, one run).
//   bridge restart mid-run ──▶ the task reruns: attempt+1, stale registry file
//     of the dead pid removed, child re-spawned with --session, one
//     LC_CUTOFF_PROMPT (or `/factory resume <id>` for a running/waiting run).
//
// Limits: at most `maxLive` live children (idle-kept ones make room); the
// sandbox must be available unless switched off; MemoryMax only with a memory
// cgroup controller (ruling 14).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claim, forget } from "../../../ownership.mjs";
import { readHistoryFile } from "../../pi/session-files.mjs";
import { summarizePiToolCall } from "../../pi/summarize.mjs";
import { transcriptEntriesToWire } from "../../pi/wire.mjs";
import { runSync } from "../guard.mjs";
import {
  FACTORY_ROOT,
  LC_DEFAULT_BIN,
  LC_REGISTRY_ROOT,
  LC_RUNS_ROOT,
  expandHome,
  findFactoryRun,
  lcLaunch,
  lcMemoryControllerAvailable,
  lcSandboxAvailable,
  removeStaleRegistry,
  stopLcScopes,
} from "./launch.mjs";
import { LC_ANSWER, LC_ANSWER_MAX, LC_TOOL, LC_USER, LcSessionDoc, lcSessionInitial } from "./record.mjs";
import { LcSession } from "./session.mjs";
import { LC_CUTOFF_PROMPT, LC_EXIT, LC_RUN_TASK, createLcRunTask } from "./task.mjs";

// What the provider needs besides the engine (it imports only this module, lazily).
export { stopLcScopes } from "./launch.mjs";
export { LC_RUN_TASK } from "./task.mjs";

export const LC_IDLE_KEEP_MS = 120_000;
export const LC_MODE_ACK_MS = 5000;
export const LC_MAX_LIVE_DEFAULT = 1;
export const LC_SWEEP_MS = 30_000;
export const LC_CRASH_DELAY_MS = 2000;
export const LC_GUARD_EXT = fileURLToPath(new URL("./even-guard.ts", import.meta.url));
export const LC_NO_MEMORY_WARNING =
  "lets-code: no memory cgroup controller; MemoryMax not applied (operator: add cgroup_enable=memory to /boot/firmware/cmdline.txt and reboot)";
export const LC_SANDBOX_MISSING = "lets-code sandbox unavailable: install bubblewrap and socat";

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const lastLineOf = (text) => String(text ?? "").split("\n").filter((l) => l.trim()).at(-1)?.trim() ?? "";

/** The task kind, defined once and bound late to the engine (the registry is built before the harness opens). */
export function createLcTaskBox() {
  const box = { engine: null };
  const task = createLcRunTask({
    drive: (...a) => box.engine.drive(...a),
    abortChild: (sid) => box.engine?.abortChild(sid),
    runFailed: (sid, message) => box.engine?.runFailed(sid, message),
  });
  return { box, task };
}

/**
 * @param {object} o
 * @param {object} o.harness the open Harness; @param {object} o.ctx its context
 * @param {import("../sessions.mjs").SessionMap} o.map
 * @param {(sid: string, frame: object) => void} o.emit ring + hub feed
 * @param {string} o.storeDir where `lc-sessions/<sid>` dirs go (next to the store)
 * @param {object} o.task the `even.lc-run` task (createLcTaskBox().task)
 * @param {(sid: string) => number} [o.clientCount] attached SSE clients of a session
 */
export function createLcEngine({
  harness,
  ctx,
  map,
  emit,
  storeDir,
  task,
  bin = LC_DEFAULT_BIN,
  caps = { memoryMax: "500M", cpuQuota: "200%" },
  maxLive = LC_MAX_LIVE_DEFAULT,
  sandbox = true,
  sandboxAvailable,
  wrapper = "none",
  run = runSync,
  log = console,
  now = Date.now,
  memoryController,
  idleKeepMs = LC_IDLE_KEEP_MS,
  modeAckMs = LC_MODE_ACK_MS,
  sweepMs = LC_SWEEP_MS,
  crashDelayMs = LC_CRASH_DELAY_MS,
  factoryRoot = FACTORY_ROOT,
  registryRoot = LC_REGISTRY_ROOT,
  runsRoot = LC_RUNS_ROOT,
  childEnv = {},
  baseEnv = process.env,
  guardExt = LC_GUARD_EXT,
  clientCount = () => 0,
  defaultModel,
  spawnWrap = (wrap) => wrap,
} = {}) {
  const mem = memoryController ?? lcMemoryControllerAvailable();
  if (!mem) log.warn?.(LC_NO_MEMORY_WARNING);
  const effectiveCaps = { ...caps, memoryMax: mem ? caps?.memoryMax ?? null : null };
  const sandboxOk = !sandbox || (sandboxAvailable ?? lcSandboxAvailable({ env: baseEnv }));
  const banner = `on(${!sandbox ? "nosandbox" : sandboxOk ? "sandbox" : "sandbox-missing"},${mem ? "mem" : "nomem"})`;
  const scopeEnv = baseEnv;

  /** sid → state */
  const states = new Map();
  /** sid → the last launch (tests read it) */
  const launches = new Map();
  let closed = false;

  const S = (sid) => {
    let s = states.get(sid);
    if (!s) {
      s = { sid, session: null, busy: false, taskId: null, idleTimer: null, waiter: null, expectedExit: false, queued: [], requestIds: new Set(), modeWaiters: [], crashed: false, starting: null };
      states.set(sid, s);
    }
    return s;
  };
  const convIdOf = (sid) => map.get(sid)?.conversation_id;
  /** Recent requestIds of a session (in memory; the record keeps the last one across restarts). */
  const remember = (s, requestId) => {
    s.requestIds.add(requestId);
    if (s.requestIds.size > 64) s.requestIds.delete(s.requestIds.values().next().value);
  };
  const emitTo = (sid, frame) => {
    try {
      emit(sid, frame);
    } catch (err) {
      log.warn?.(`[durable:lc] emit for ${sid} failed: ${err.message}`);
    }
  };
  const stopScope = (sid) => {
    try {
      stopLcScopes([sid], { env: scopeEnv, run });
    } catch (err) {
      log.warn?.(`[durable:lc] scope stop ${sid} failed: ${err.message}`);
    }
  };

  async function readRecord(sid) {
    const id = convIdOf(sid);
    if (id == null) return lcSessionInitial();
    return { ...lcSessionInitial(), ...((await harness.snapshot(LcSessionDoc, id, ctx)) ?? {}) };
  }

  function updateRecord(sid, change) {
    const id = convIdOf(sid);
    if (id == null) return Promise.resolve();
    return harness
      .commit(async (tx) => {
        change(await tx.doc(LcSessionDoc, id));
      }, ctx)
      .catch((err) => log.warn?.(`[durable:lc] record ${sid}: ${err.message}`));
  }

  function writeEntry(sid, kind, text) {
    const id = convIdOf(sid);
    if (id == null || closed) return Promise.resolve();
    return harness
      .conversation(id, ctx)
      .then((conv) => conv?.submit({ type: "write", entry: { kind, data: { text } } }, ctx))
      .catch((err) => log.warn?.(`[durable:lc] ${kind} for ${sid}: ${err.message}`));
  }

  const isLive = (s) => Boolean(s.session?.running) || Boolean(s.starting);
  const idleKept = (s) => isLive(s) && !s.busy && !(s.session?.openDialogs().length > 0);

  /**
   * May `sid` (null: a new session) get a child now? Throws 503 without the sandbox and 429 at the
   * live limit; an idle-kept child of another session is stopped to make room.
   */
  function admit(sid) {
    if (!sandboxOk) throw httpError(503, LC_SANDBOX_MISSING);
    if (sid && isLive(S(sid))) return;
    const live = [...states.values()].filter((s) => s.sid !== sid && (isLive(s) || s.busy));
    if (live.length < maxLive) return;
    const spare = live.find((s) => idleKept(s));
    if (spare) {
      stopChild(spare.sid).catch(() => {});
      return;
    }
    throw httpError(
      429,
      maxLive === 1 ? "1 lets-code agent is working; wait for it or stop it" : `${maxLive} lets-code agents are working; wait for one or stop one`,
    );
  }

  function armIdle(sid) {
    const s = S(sid);
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (closed || !s.session?.running) return;
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.busy || s.session?.openDialogs().length) return; // a held dialog keeps the child (ruling 1)
      stopChild(sid).catch(() => {});
    }, idleKeepMs);
    s.idleTimer.unref?.();
  }

  async function stopChild(sid) {
    const s = S(sid);
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    const session = s.session;
    if (session) {
      s.expectedExit = true;
      await session.stop().catch(() => {});
      if (s.session === session) s.session = null;
    }
    stopScope(sid);
  }

  function onChildExit(sid, session, { code, signal } = {}) {
    const s = S(sid);
    if (s.session !== session) return;
    s.session = null;
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    const expected = s.expectedExit;
    s.expectedExit = false;
    if (!expected) stopScope(sid); // subagents and the sandbox's socat live in the scope too
    if (s.waiter) {
      const w = s.waiter;
      s.waiter = null;
      const err = Object.assign(new Error(`lets-code exited (code=${code} signal=${signal})`), { code: expected ? "LC_STOPPED" : LC_EXIT });
      if (!expected) s.crashed = true;
      w.reject(err);
    }
    for (const m of s.modeWaiters.splice(0)) m.reject(httpError(504, "lets-code did not confirm the mode"));
  }

  function onNotify(sid, text) {
    const m = /^mode: (\S+)/.exec(String(text).trim());
    if (!m) return;
    const mode = m[1];
    const s = S(sid);
    const [hit, rest] = [s.modeWaiters.filter((w) => w.mode === mode), s.modeWaiters.filter((w) => w.mode !== mode)];
    s.modeWaiters = rest;
    // Resolve once the record holds the mode, so a reader right after setFactory sees it.
    updateRecord(sid, (d) => {
      d.mode = mode;
    }).then(() => {
      for (const w of hit) w.resolve(mode);
    });
  }

  /** Send `/mode <mode>` and resolve on the child's `mode: <mode>` notify (ruling 4), else 504. */
  function sendMode(sid, mode) {
    const s = S(sid);
    if (!s.session?.running) return Promise.reject(new Error("no live child"));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        s.modeWaiters = s.modeWaiters.filter((w) => w !== waiter);
        reject(httpError(504, "lets-code did not confirm the mode"));
      }, modeAckMs);
      const waiter = {
        mode,
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      };
      s.modeWaiters.push(waiter);
      s.session.command(`/mode ${mode}`, modeAckMs + 1000).catch(() => {});
    });
  }

  function modelArg(row) {
    const label = row.model_provider ? `${row.model_provider}/${row.model_id}` : null;
    return label && label !== defaultModel ? label : undefined;
  }

  /** Spawn the child of `sid` unless one is running. @returns {Promise<boolean>} whether it spawned */
  async function ensureChild(sid) {
    const s = S(sid);
    if (s.session?.running) return false;
    if (s.starting) {
      await s.starting;
      return false;
    }
    s.starting = (async () => {
      const row = map.get(sid);
      const rec = await readRecord(sid);
      const sessionDir = join(storeDir, "lc-sessions", sid);
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const resume = rec.piSessionFile && existsSync(rec.piSessionFile) ? rec.piSessionFile : undefined;
      const launch = lcLaunch({ sid, cwd: row.cwd, sessionDir, model: modelArg(row), bin, guardExt, caps: effectiveCaps, wrapper, sandbox, baseEnv, extraEnv: childEnv });
      launches.set(sid, launch);
      const session = new LcSession(emitTo, {
        sid,
        bin: launch.bin,
        wrap: spawnWrap(launch.wrap),
        envExact: true,
        env: launch.env,
        extraArgs: launch.extraArgs,
        resume,
        name: row.name,
        cwd: row.cwd,
        now,
        clientCount: () => clientCount(sid),
        onNotify: (text) => onNotify(sid, text),
        onAgentEnd: (sess) => finish(sid, sess),
        onToolEnd: (name, args) => writeEntry(sid, LC_TOOL, summarizePiToolCall(name, args)),
        onExit: (sess, info) => onChildExit(sid, sess, info),
      });
      s.session = session;
      try {
        await session.start();
      } catch (err) {
        if (s.session === session) s.session = null;
        throw err;
      }
      if (session.sessionId) claim(session.sessionId, "durable");
      await updateRecord(sid, (d) => {
        d.piSessionId = session.sessionId ?? d.piSessionId;
        d.piSessionFile = session.sessionFile ?? d.piSessionFile;
        d.childPid = session.childPid || null;
        d.label = row.name;
        d.cwd = row.cwd;
        d.model = row.model_provider ? `${row.model_provider}/${row.model_id}` : null;
      });
      if (rec.factory) {
        await sendMode(sid, "orchestration").catch((err) => log.warn?.(`[durable:lc] ${sid}: factory mode after spawn: ${err.message}`));
      }
    })();
    try {
      await s.starting;
      return true;
    } finally {
      s.starting = null;
    }
  }

  /** A run ended (agent_end, or a command's response): record the answer, wake drive(), keep the child a while. */
  function finish(sid, session) {
    const s = S(sid);
    if (session && s.session !== session) return;
    const text = String(session?.answerText ?? "").trim().slice(0, LC_ANSWER_MAX);
    const lastLine = lastLineOf(text);
    if (text) writeEntry(sid, LC_ANSWER, text);
    updateRecord(sid, (d) => {
      d.runs += 1;
      if (lastLine) d.lastLine = lastLine;
    });
    s.busy = false;
    s.crashed = false;
    const w = s.waiter;
    s.waiter = null;
    w?.resolve({ lastLine });
    armIdle(sid);
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason ?? new Error("aborted"))), { once: true });
    });

  const engine = {
    banner,
    memoryController: mem,
    sandboxOk,
    admit,

    /** A new or idle session's prompt starts a run task; a busy one's steers. Retried requestIds are dropped. */
    async prompt(sid, text, { requestId } = {}) {
      if (closed) throw httpError(503, "durable provider is shut down");
      const s = S(sid);
      if (requestId && s.requestIds.has(requestId)) return { deduped: true };
      const id = convIdOf(sid);
      if (id == null) throw httpError(404, "Session not found");
      if (s.busy) {
        const rec = await readRecord(sid);
        if (requestId && rec.lastRequestId === requestId) return { deduped: true };
        if (requestId) remember(s, requestId);
        if (s.session?.running && !s.starting && s.waiter) await s.session.steer(text);
        else s.queued.push(text); // the child is (re)starting: sent right after the run's prompt
        writeEntry(sid, LC_USER, text);
        if (requestId) updateRecord(sid, (d) => (d.lastRequestId = requestId));
        return { deduped: false, steered: true };
      }
      admit(sid);
      if (requestId) remember(s, requestId);
      s.busy = true;
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
      let taskId;
      try {
        taskId = await harness.commit(async (tx) => {
          const d = await tx.doc(LcSessionDoc, id);
          if (requestId && d.lastRequestId === requestId) return null;
          d.lastRequestId = requestId ?? null;
          await tx.appendEntry(id, { kind: LC_USER, data: { text } });
          return tx.createTask(task, { sid, text, requestId: requestId ?? null }, { ownership: { kind: "conversation" }, conversationId: id, background: true });
        }, ctx);
      } catch (err) {
        s.busy = false;
        throw err;
      }
      if (taskId == null) {
        s.busy = false;
        return { deduped: true };
      }
      s.taskId = taskId;
      return { deduped: false, taskId };
    },

    /** The run task's phase (see task.mjs). Resolves at the end of the run; rejects LC_EXIT when the child died mid-turn. */
    async drive(sid, { text, attempt }, signal) {
      const s = S(sid);
      const row = map.get(sid);
      if (!row || row.archived) throw new Error("the session is gone");
      s.busy = true;
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
      let send = text;
      if (attempt > 1) {
        const rec = await readRecord(sid);
        removeStaleRegistry(rec.childPid, { root: registryRoot });
        if (s.crashed && crashDelayMs > 0) await sleep(crashDelayMs, signal);
        const delivered = Boolean(rec.piSessionFile && existsSync(rec.piSessionFile));
        if (delivered) {
          const runId = findFactoryRun(row.cwd, factoryRoot);
          send = runId ? `/factory resume ${runId}` : LC_CUTOFF_PROMPT;
        } // else nothing reached the model: the prompt itself again, in a fresh session file
        await updateRecord(sid, (d) => {
          d.restarts += 1;
        });
      }
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      await ensureChild(sid);
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const session = s.session;
      if (!session?.running) throw Object.assign(new Error("lets-code exited during start"), { code: LC_EXIT });
      const done = new Promise((resolve, reject) => {
        s.waiter = { resolve, reject };
        signal?.addEventListener(
          "abort",
          () => {
            if (s.waiter?.resolve === resolve) s.waiter = null;
            reject(signal.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
      done.catch(() => {});
      const sent = session.runLc(send);
      // Steers that arrived while the child was starting.
      for (const q of s.queued.splice(0)) session.steer(q).catch(() => {});
      sent.then(
        (res) => {
          if (s.session !== session || !s.waiter) return;
          if (res && res.success === false) {
            const w = s.waiter;
            s.waiter = null;
            s.busy = false;
            w.reject(new Error(res.error ?? "prompt refused"));
          } else if (res?.data?.disposition === "handled") {
            // An extension command (`/factory start|resume`, or input an extension consumed) answers its
            // prompt only when it is done, and no agent_end follows: the run ends here.
            session.endCommandRun();
          }
        },
        (err) => {
          if (!session.running) return; // the exit handler rejects with LC_EXIT
          const w = s.waiter;
          s.waiter = null;
          w?.reject(err);
        },
      );
      return done;
    },

    /** The run task ended without an answer (limit, error): say so and go idle. */
    runFailed(sid, message) {
      const s = S(sid);
      s.busy = false;
      s.taskId = null;
      s.waiter = null;
      emitTo(sid, { type: "error", message });
      emitTo(sid, { type: "status", state: "idle", sessionId: sid });
      armIdle(sid);
    },

    /** The task's abort handler: cancel dialogs, abort the turn, stop the child. */
    async abortChild(sid) {
      const s = S(sid);
      s.busy = false;
      s.taskId = null;
      s.queued = [];
      if (s.session?.running) {
        s.session.interrupt();
        await stopChild(sid);
      }
      s.waiter = null;
    },

    /** Startup: a live run task of `sid` (resumed by the harness). */
    noteRunning(sid, taskId) {
      const s = S(sid);
      s.busy = true;
      s.taskId = taskId;
    },

    interrupt(sid) {
      const s = S(sid);
      const factory = s.session?.openFactory();
      if (s.session?.running) {
        s.session.interrupt();
        s.queued = [];
        if (factory) {
          emitTo(sid, {
            type: "error",
            message: `factory run ${factory.runId} stopped at the ${factory.checkpoint} checkpoint; /factory resume ${factory.runId} continues it`,
          });
        }
        return;
      }
      if (s.taskId) harness.abortTask(s.taskId, ctx).catch((err) => log.warn?.(`[durable:lc] interrupt ${sid}: ${err.message}`));
    },

    /** Abort the run (its task), stop the child and its scope. The provider archives the row. */
    async stop(sid) {
      const s = S(sid);
      const taskId = s.taskId ?? (await liveTaskOf(sid));
      if (taskId) {
        try {
          await harness.abortTask(taskId, ctx);
          await Promise.race([harness.waitForTask(taskId, ctx).catch(() => {}), new Promise((r) => setTimeout(r, 5000).unref?.())]);
        } catch (err) {
          log.warn?.(`[durable:lc] stop ${sid}: ${err.message}`);
        }
      }
      await engine.abortChild(sid);
      await stopChild(sid);
      s.busy = false;
    },

    /** Forget: stop everything of `sid` and remove its subagent runs dir (ruling 2). */
    async forget(sid) {
      const rec = await readRecord(sid).catch(() => lcSessionInitial());
      await engine.stop(sid).catch(() => {});
      if (rec.piSessionId) {
        rmSync(join(expandHome(runsRoot), rec.piSessionId), { recursive: true, force: true });
        forget(rec.piSessionId);
      }
      states.delete(sid);
      launches.delete(sid);
    },

    respondPermission(sid, decision) {
      const s = S(sid);
      return s.session?.running ? s.session.respondPermission(decision) : false;
    },

    /** An answer to an open question; with none open, the answer is a prompt. */
    async respondQuestion(sid, answer) {
      const s = S(sid);
      if (s.session?.running && s.session.awaitingQuestion) {
        s.session.respondQuestion(answer);
        return { ok: true };
      }
      return engine.prompt(sid, answer);
    },

    status(sid) {
      const s = states.get(sid);
      if (!s) return "idle";
      if (s.session?.openDialogs().length) return "awaiting";
      return s.busy ? "busy" : "idle";
    },

    async history(sid, limit = 10) {
      const rec = await readRecord(sid);
      return rec.piSessionFile ? readHistoryFile(rec.piSessionFile, limit) : [];
    },

    /** The ring is empty (restart, first load): replay the child's session file. */
    async seed(sid) {
      const rec = await readRecord(sid);
      if (!rec.piSessionFile) return;
      let raw;
      try {
        raw = readFileSync(rec.piSessionFile, "utf8");
      } catch {
        return;
      }
      const entries = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* a torn last line */
        }
      }
      for (const f of transcriptEntriesToWire(entries)) emitTo(sid, f);
    },

    async record(sid) {
      return readRecord(sid);
    },

    /**
     * The factory toggle (ruling 4): the wanted flag goes into the record; a live child gets
     * `/mode orchestration|ask` at once (504 without its notify). A ticket is written to
     * `<cwd>/.factory/ticket-<ms>.md` and started as a run (`/factory start <file>[ <howToRun>]`).
     */
    async setFactory(sid, on, { ticket, howToRun } = {}) {
      const row = map.get(sid);
      if (!row || row.archived) throw httpError(404, "Session not found");
      await updateRecord(sid, (d) => {
        d.factory = Boolean(on);
      });
      const s = S(sid);
      if (s.session?.running && !s.starting) await sendMode(sid, on ? "orchestration" : "ask");
      if (on && ticket) {
        const name = `.factory/ticket-${now()}.md`;
        const file = join(row.cwd, name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, String(ticket));
        const text = `/factory start ${name}${howToRun ? ` ${String(howToRun).trim()}` : ""}`;
        await engine.prompt(sid, text);
      }
      const rec = await readRecord(sid);
      return { factory: rec.factory, mode: rec.mode };
    },

    /** Deny mandate asks open for 10 min while nobody watches (ruling Q5). */
    sweep() {
      let n = 0;
      for (const s of states.values()) if (s.session?.running) n += s.session.sweepDialogs(now());
      return n;
    },

    liveCount() {
      return [...states.values()].filter((s) => s.session?.running).length;
    },

    /** Bridge shutdown: children and their scopes stop; run tasks stay pending (a restart resumes them). */
    async stopAll() {
      closed = true;
      clearInterval(sweeper);
      const sids = [];
      for (const s of states.values()) {
        clearTimeout(s.idleTimer);
        s.idleTimer = null;
        if (s.session) {
          sids.push(s.sid);
          s.expectedExit = true;
          await s.session.stop().catch(() => {});
          s.session = null;
        }
      }
      if (sids.length) stopLcScopes(sids, { env: scopeEnv, run });
    },

    _states: states,
    _launches: launches,
  };

  async function liveTaskOf(sid) {
    const id = convIdOf(sid);
    if (id == null) return null;
    const inspection = await harness.inspect(ctx);
    return inspection.tasks.find((t) => t.record.kind === LC_RUN_TASK && t.record.conversationId === id)?.record.id ?? null;
  }

  const sweeper = setInterval(() => {
    try {
      engine.sweep();
    } catch (err) {
      log.warn?.(`[durable:lc] sweep failed: ${err.message}`);
    }
  }, sweepMs);
  sweeper.unref?.();

  return engine;
}
