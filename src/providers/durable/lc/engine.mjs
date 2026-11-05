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
// cgroup controller (ruling 14). Per run (one task): at most `maxTurns` turns
// (EVEN_BRIDGE_LC_MAX_TURNS, or the agent's own lower maxTurns) and fewer than
// LC_REPEAT_MAX identical consecutive tool calls; either cap aborts the turn
// (the child stays, idle-kept), fails the task and sets `record.lastError`.

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
  LC_STATE_FILE,
  excludeProjectGuard,
  expertsEnabled,
  factoryWorktrees,
  findFactoryRun,
  installProjectGuard,
  LC_TRUST_FILE,
  lcLaunch,
  lcMemoryControllerAvailable,
  lcSandboxAvailable,
  removeStaleRegistry,
  resetFailedScope,
  resetFailedUnit,
  stopScopeUnits,
  sealProjectPi,
  tracksDotPi,
  stopLcScopes,
  updateTrust,
} from "./launch.mjs";
import { LC_ANSWER, LC_ANSWER_MAX, LC_TOOL, LC_USER, LcSessionDoc, lcSessionInitial } from "./record.mjs";
import { LcSession } from "./session.mjs";
import { LC_CAP, LC_CRASH_PROMPT, LC_CUTOFF_PROMPT, LC_EXIT, LC_NO_RESUME, LC_RESTART_LIMIT, LC_RUN_TASK, createLcRunTask } from "./task.mjs";

// What the provider needs besides the engine (it imports only this module, lazily).
export { stopLcScopes, stopScopeUnits } from "./launch.mjs";
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
/** lc.tool entries kept per run (Durable never prunes; the full transcript is pi's session file). */
export const LC_TOOL_ENTRIES_MAX = 20;
export const LC_EXPERTS_DISABLED = "factory experts must be enabled by the operator";
/** lets-code's own refusals of `/factory start` (factory.ts handler), besides notifies of type warning/error. */
export const LC_FACTORY_REFUSAL_RE = /^(The user did not enable the factory's experts|The factory needs these experts enabled|No ticket file |factory: )/;
/** How often a session with a factory run looks for new run worktrees to guard. */
export const LC_FACTORY_WATCH_MS = 1000;
/** How often the `.pi` dirs of a session with a live child are sealed (besides every pi's own tool_result seal). */
export const LC_SEAL_MS = 1000;
export const LC_REPO_TRACKS_PI = "this repo tracks a .pi dir; lets-code agents can't run here";
/** Per-run turn cap (EVEN_BRIDGE_LC_MAX_TURNS): default and hard maximum. */
export const LC_MAX_TURNS_DEFAULT = 40;
export const LC_MAX_TURNS_CEILING = 200;
/** The same tool with the same args this many times in a row stops the run. */
export const LC_REPEAT_MAX = 8;
/** A capped run whose child does not end the turn after its abort this long: the child is stopped. */
export const LC_CAP_ABORT_MS = 10_000;
/** `record.lastError.reason` of a capped run (cleared when the next run starts; a factory refusal has none). */
export const LC_CAP_REASON = "cap";
export const lcTurnCapMessage = (n) => `lets-code run stopped after ${n} turns (cap)`;
export const lcRepeatCapMessage = (tool, n) => `lets-code run stopped: repeated tool call (${tool}, ${n} times in a row)`;
/** The error frame of the cap's abort fallback when it dropped inputs queued for the stopped run. */
export const lcCapDroppedMessage = (n) =>
  `${n} queued input${n === 1 ? " was" : "s were"} dropped when the capped run was stopped; send ${n === 1 ? "it" : "them"} again`;

/**
 * EVEN_BRIDGE_LC_MAX_TURNS as the engine's turn cap: unset → the default; not a positive integer → the
 * default (with `onBad`); above the ceiling → the ceiling (with `onBad`).
 */
export function lcTurnCap(raw, onBad = () => {}) {
  if (raw == null || String(raw).trim() === "") return LC_MAX_TURNS_DEFAULT;
  const t = String(raw).trim();
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    onBad(`EVEN_BRIDGE_LC_MAX_TURNS=${JSON.stringify(t)} is not a positive integer; using ${LC_MAX_TURNS_DEFAULT}`);
    return LC_MAX_TURNS_DEFAULT;
  }
  if (n > LC_MAX_TURNS_CEILING) {
    onBad(`EVEN_BRIDGE_LC_MAX_TURNS=${n} is above ${LC_MAX_TURNS_CEILING}; using ${LC_MAX_TURNS_CEILING}`);
    return LC_MAX_TURNS_CEILING;
  }
  return n;
}

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
  stateFile = LC_STATE_FILE,
  trustFile = LC_TRUST_FILE,
  factoryWatchMs = LC_FACTORY_WATCH_MS,
  sealMs = LC_SEAL_MS,
  maxTurns,
  repeatMax = LC_REPEAT_MAX,
  capAbortMs = LC_CAP_ABORT_MS,
  onCap = () => {},
} = {}) {
  const turnCap = lcTurnCap(maxTurns, (m) => log.warn?.(`[durable:lc] ${m}`));
  const mem = memoryController ?? lcMemoryControllerAvailable();
  if (!mem) log.warn?.(LC_NO_MEMORY_WARNING);
  const effectiveCaps = { ...caps, memoryMax: mem ? caps?.memoryMax ?? null : null };
  const sandboxOk = !sandbox || (sandboxAvailable ?? lcSandboxAvailable({ env: baseEnv }));
  const banner = `on(${!sandbox ? "nosandbox" : sandboxOk ? "sandbox" : "sandbox-missing"},${mem ? "mem" : "nomem"})`;
  const scopeEnv = baseEnv;

  /** sid → state */
  const states = new Map();
  /**
   * sid → a session profile other than the glasses agent (the Even AI assistant, Task A1): its own launch
   * and session class, no admission (sandbox, live limit), no idle stop, no seal or factory, its own caps
   * (deadline, tool calls), no resume after a restart (attempt > 1), and an exit hook (it stays warm).
   * Added with `engine.addProfile(sid, profile)` before its first spawn.
   */
  const profiles = new Map();
  const profileOf = (sid) => profiles.get(sid) ?? null;
  /** sid → the last launch (tests read it) */
  const launches = new Map();
  let closed = false;

  const S = (sid) => {
    let s = states.get(sid);
    if (!s) {
      s = {
        sid,
        session: null,
        busy: false,
        reserved: false, // a prompt between its admission and its task (counts toward maxLive)
        stopping: false, // an idle-kept child being stopped to make room
        stopPromise: null, // the stop in flight (stopChild)
        taskId: null,
        sentTaskId: null, // the run task whose prompt lets-code accepted (also in the record)
        idleTimer: null,
        waiter: null,
        queued: [],
        requestIds: new Set(),
        modeWaiters: [],
        crashed: false,
        starting: null,
        tools: 0,
        toolsDropped: 0,
        factoryStart: null, // { at, file }: a `/factory start` sent, not yet accepted (a refusal is reported)
        factoryWatch: null, // the timer guarding new factory worktrees while a run may create them
        guarded: new Set(), // factory worktrees already guarded by this process
        capTask: null, // the run task the counters below belong to (a crash retry keeps counting)
        turns: 0, // turns of that run
        lastCall: null, // "<tool>\0<args JSON>" of the last tool call of that run
        repeats: 0, // how many times in a row lastCall was made
        capped: null, // { message, reason, ... }: the run hit a cap; its turn is being aborted
        capTimer: null,
      };
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
      const prof = profileOf(sid);
      if (prof?.unit) stopScopeUnits([prof.unit], { env: scopeEnv, run });
      else stopLcScopes([sid], { env: scopeEnv, run });
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
  const idleKept = (s) => isLive(s) && !s.busy && !s.reserved && !(s.session?.openDialogs().length > 0);

  /**
   * May `sid` (null: a new session) get a child now? Throws 503 without the sandbox and 429 at the
   * live limit. Busy sessions (resumed runs included), reserved prompts and live children count; an
   * idle-kept child of another session is stopped (awaited) to make room.
   */
  async function admit(sid) {
    if (sid && profileOf(sid)) return; // its own slot (the assistant): never counted, no sandbox (no shell tools)
    if (!sandboxOk) throw httpError(503, LC_SANDBOX_MISSING);
    if (sid && isLive(S(sid))) return;
    const live = [...states.values()].filter((s) => s.sid !== sid && !profileOf(s.sid) && !s.stopping && (isLive(s) || s.busy || s.reserved));
    if (live.length < maxLive) return;
    const spare = live.find((s) => idleKept(s));
    if (spare) {
      spare.stopping = true;
      try {
        await stopChild(spare.sid);
      } finally {
        spare.stopping = false;
      }
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
    if (closed || !s.session?.running || profileOf(sid)) return; // a profile session (the assistant) stays warm
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.busy || s.session?.openDialogs().length) return; // a held dialog keeps the child (ruling 1)
      stopChild(sid).catch(() => {});
    }, idleKeepMs);
    s.idleTimer.unref?.();
  }

  /**
   * Stop the child of `sid` and its scope. One stop at a time per session; a spawn of the same
   * session waits for it (the scope stop at its end must never hit the next child of that name).
   */
  function stopChild(sid) {
    const s = S(sid);
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (s.stopPromise) return s.stopPromise;
    const session = s.session;
    s.stopPromise = (async () => {
      if (session) {
        const pid = session.childPid;
        session.expectedExit = true; // per child: a late exit of this one must not mark the next child's crash as expected
        await session.stop().catch(() => {});
        if (s.session === session) s.session = null;
        // A child that needed SIGKILL leaves its lets-code-sessions/<pid>.json behind.
        removeStaleRegistry(pid, { root: registryRoot });
      }
      stopScope(sid);
    })().finally(() => {
      s.stopPromise = null;
    });
    return s.stopPromise;
  }

  function onChildExit(sid, session, { code, signal } = {}) {
    const s = S(sid);
    if (s.session !== session) return; // an older child (stopped while idle) exiting late
    s.session = null;
    s.factoryStart = null;
    clearInterval(s.sealTimer);
    s.sealTimer = null;
    if (s.factoryWatch || s.guarded.size) guardFactory(sid).catch(() => {}); // a last pass: drops the trust of ended runs
    stopFactoryWatch(sid);
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
    const expected = Boolean(session.expectedExit);
    if (!expected) stopScope(sid); // subagents and the sandbox's socat live in the scope too
    if (s.waiter) {
      const w = s.waiter;
      s.waiter = null;
      const err = Object.assign(new Error(`lets-code exited (code=${code} signal=${signal})`), { code: expected ? "LC_STOPPED" : LC_EXIT });
      if (!expected) s.crashed = true;
      w.reject(err);
    }
    for (const m of s.modeWaiters.splice(0)) m.reject(httpError(504, "lets-code did not confirm the mode"));
    clearTimeout(s.deadlineTimer);
    s.deadlineTimer = null;
    const prof = profileOf(sid);
    if (prof?.onExit) {
      try {
        prof.onExit({ code, signal, expected, closed });
      } catch (err) {
        log.warn?.(`[durable:lc] ${sid}: exit hook failed: ${err.message}`);
      }
    }
  }

  /** lets-code refused a `/factory start`: an error frame, the answer entry and `record.lastError` (the shim reads it). */
  function factoryRefused(sid, text) {
    const s = S(sid);
    s.factoryStart = null;
    // The session already sent its own error frame when it answered the experts question No: one frame,
    // and the record says why in the bridge's words (lets-code says "the user" did not enable them).
    const expertsNo = /^The user did not enable the factory's experts/.test(text);
    const why = expertsNo ? LC_EXPERTS_DISABLED : text;
    if (!expertsNo) emitTo(sid, { type: "error", message: `lets-code refused the factory start: ${text}` });
    writeEntry(sid, LC_ANSWER, text);
    return updateRecord(sid, (d) => {
      d.lastError = { text: why, at: now() };
    });
  }

  function onNotify(sid, text, type = "info") {
    const t = String(text).trim();
    const s = S(sid);
    // Only lets-code's own replies to /factory start: other warnings (memory guard, core memory, mandate,
    // subagents) also come while a start is pending and are no refusal.
    if (s.factoryStart && LC_FACTORY_REFUSAL_RE.test(t)) {
      factoryRefused(sid, t);
      return;
    }
    if (s.factoryWatch) guardFactory(sid).catch(() => {});
    // The record follows every mode notify, also lets-code's own switch ("mode: orchestration (<why>): …",
    // mandate.ts) — so record.mode may say orchestration while record.factory (the user's wish) is false.
    // Only the exact ack of our `/mode <m>` resolves a waiter.
    const m = /^mode: (\S+)/.exec(t);
    if (!m) return;
    const mode = m[1];
    const exact = t === `mode: ${mode}`;
    const [hit, rest] = exact ? [s.modeWaiters.filter((w) => w.mode === mode), s.modeWaiters.filter((w) => w.mode !== mode)] : [[], s.modeWaiters];
    s.modeWaiters = rest;
    // Resolve once the record holds the mode, so a reader right after setFactory sees it.
    updateRecord(sid, (d) => {
      d.mode = mode;
    }).then(() => {
      for (const w of hit) w.resolve(mode);
    });
  }

  /**
   * Factory stages run as plain pi processes in the run's worktree (`<factory>/<id>/work`), not in the
   * session cwd: give each new worktree of this session's runs the project guard, keep it out of git,
   * and trust it in pi's store so pi loads the guard there (ruling (a) of the Task 2 round).
   */
  /** Keep `<dir>/.pi` to the bridge's guard (C-new-1): restore it, quarantine anything else, say so. */
  function seal(sid, dir) {
    if (!dir) return true;
    try {
      const r = sealProjectPi(dir, { quarantine: join(storeDir, "lc-quarantine", sid), now });
      if (r.restored) emitTo(sid, { type: "error", message: `even-guard: the guard in ${dir}/.pi was changed; restored` });
      for (const name of r.removed) emitTo(sid, { type: "error", message: `even-guard: removed ${name} from ${dir} (only the bridge's guard may be in .pi)` });
      if (r.restored || r.removed.length) log.warn?.(`[durable:lc] ${sid}: ${dir}/.pi sealed (restored=${r.restored}, removed=${r.removed.join(", ") || "-"})`);
      return true;
    } catch (err) {
      log.warn?.(`[durable:lc] ${sid}: ${dir}/.pi not sealed (${err.message})`);
      return false;
    }
  }

  /** The session cwd and every guarded worktree, sealed (cheap: two readdirs each). */
  function sealAll(sid) {
    const row = map.get(sid);
    if (!row) return;
    seal(sid, row.cwd);
    for (const w of S(sid).guarded) seal(sid, w);
  }

  /**
   * Factory stages run as plain pi processes in the run's worktree (`<factory>/<id>/work`), not in the
   * session cwd: each worktree of this session's running/waiting runs is sealed (guard restored, plants
   * quarantined) on every call, kept out of git and trusted in pi's store once; worktrees whose run ended
   * (or that are gone) lose their trust entry. Never overlaps itself.
   */
  async function guardFactory(sid) {
    const row = map.get(sid);
    if (!row) return [];
    const s = S(sid);
    if (s.guarding) {
      s.guardAgain = true; // one more pass after the one in flight (the last pass at exit must not be lost)
      return [];
    }
    s.guarding = true;
    s.guardAgain = false;
    const added = [];
    try {
      seal(sid, row.cwd);
      const live = factoryWorktrees(row.cwd, factoryRoot).map((x) => x.work);
      for (const work of live) {
        seal(sid, work);
        if (s.guarded.has(work)) continue;
        try {
          excludeProjectGuard(work);
          await updateTrust([work], true, { file: trustFile });
          s.guarded.add(work);
          added.push(work);
        } catch (err) {
          log.warn?.(`[durable:lc] ${sid}: factory worktree ${work} not trusted (${err.message})`);
        }
      }
      const rec = await readRecord(sid).catch(() => ({ trusted: [] }));
      const gone = [...new Set([...(rec.trusted ?? []), ...s.guarded])].filter((w) => !live.includes(w));
      if (gone.length) {
        try {
          await updateTrust(gone, null, { file: trustFile });
          for (const w of gone) s.guarded.delete(w);
        } catch (err) {
          log.warn?.(`[durable:lc] ${sid}: trust of ended runs not removed (${err.message})`);
        }
      }
      if (added.length || gone.length) {
        await updateRecord(sid, (d) => {
          d.trusted = [...new Set([...(d.trusted ?? []), ...added])].filter((w) => !gone.includes(w));
        });
      }
    } finally {
      s.guarding = false;
      if (s.guardAgain) {
        s.guardAgain = false;
        guardFactory(sid).catch(() => {});
      }
    }
    return added;
  }

  function startFactoryWatch(sid) {
    const s = S(sid);
    guardFactory(sid).catch(() => {});
    if (s.factoryWatch) return;
    s.factoryWatch = setInterval(() => guardFactory(sid).catch(() => {}), factoryWatchMs);
    s.factoryWatch.unref?.();
  }

  function stopFactoryWatch(sid) {
    const s = S(sid);
    clearInterval(s.factoryWatch);
    s.factoryWatch = null;
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
    if (s.stopPromise) await s.stopPromise;
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
      const prof = profileOf(sid);
      if (prof) return startProfileChild(sid, prof, { row, sessionDir, resume });
      // lets-code's subagents are plain pi processes in this cwd without our `-e`: they get the guard
      // from the project-local copy (trusted by the parent's even-guard.ts, see there).
      // The guard rewritten, anything else in .pi quarantined: a project that cannot be sealed gets no child
      // (its subagents would run without the guard, or load a plant).
      if (!seal(sid, row.cwd)) {
        const msg = `even-guard: could not seal ${row.cwd}/.pi; lets-code was not started`;
        emitTo(sid, { type: "error", message: msg });
        throw new Error(msg);
      }
      for (const w of s.guarded) seal(sid, w);
      excludeProjectGuard(row.cwd); // never throws
      // A failed scope of the same name (left by an OOM kill) would block the unit name.
      if (wrapper === "systemd-run") resetFailedScope(sid, { env: scopeEnv, run });
      const launch = lcLaunch({ sid, cwd: row.cwd, sessionDir, model: modelArg(row), bin, guardExt, caps: effectiveCaps, wrapper, sandbox, baseEnv, extraEnv: { ...childEnv, EVEN_GUARD_QUARANTINE: join(storeDir, "lc-quarantine", sid) } });
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
        onNotify: (text, type) => onNotify(sid, text, type),
        onDialog: (kind) => {
          if (kind !== "factory") return;
          s.factoryStart = null; // a checkpoint: lets-code accepted the run
          startFactoryWatch(sid);
        },
        onAgentEnd: (sess) => finish(sid, sess),
        onToolEnd: (name, args) => {
          if (++s.tools <= LC_TOOL_ENTRIES_MAX) writeEntry(sid, LC_TOOL, summarizePiToolCall(name, args));
          else s.toolsDropped += 1;
          sealAll(sid); // a plant that does not name .pi (tar, git checkout) is caught before the next subagent
        },
        onActivity: () => markSent(sid),
        onTurnEnd: (sess) => countTurn(sid, sess),
        onToolStart: (name, args) => countCall(sid, session, name, args),
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
      clearInterval(s.sealTimer);
      s.sealTimer = setInterval(() => {
        if (s.session === session && session.running) sealAll(sid);
      }, sealMs);
      s.sealTimer.unref?.();
      await updateRecord(sid, (d) => {
        d.piSessionId = session.sessionId ?? d.piSessionId;
        d.piSessionFile = session.sessionFile ?? d.piSessionFile;
        d.childPid = session.childPid || null;
        d.label = row.name;
        d.cwd = row.cwd;
        d.model = row.model_provider ? `${row.model_provider}/${row.model_id}` : null;
      });
      // The flag as it is NOW: a toggle during this start (it waits for the start) must win.
      if ((await readRecord(sid)).factory) {
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

  /** The child of a profile session (the assistant): its own launch and session class, nothing of the agents' seal/factory. */
  async function startProfileChild(sid, prof, { row, sessionDir, resume }) {
    const s = S(sid);
    if (wrapper === "systemd-run" && prof.unit) resetFailedUnit(prof.unit, { env: scopeEnv, run });
    const launch = prof.launch({ sessionDir, resume, caps: effectiveCaps, wrapper, bin, baseEnv, childEnv });
    launches.set(sid, launch);
    const opts = {
      sid,
      bin: launch.bin,
      wrap: spawnWrap(launch.wrap),
      envExact: true,
      env: launch.env,
      extraArgs: launch.extraArgs,
      resume: launch.resume ?? resume,
      name: row.name,
      cwd: row.cwd,
      now,
      clientCount: () => clientCount(sid),
      onNotify: (text, type) => prof.onNotify?.(text, type),
      onAgentEnd: (sess) => finish(sid, sess),
      onToolEnd: (name, args) => {
        if (++s.tools <= LC_TOOL_ENTRIES_MAX) writeEntry(sid, LC_TOOL, summarizePiToolCall(name, args));
        else s.toolsDropped += 1;
      },
      onActivity: () => markSent(sid),
      onTurnEnd: (sess) => countTurn(sid, sess),
      onToolStart: (name, args) => countCall(sid, session, name, args),
      onExit: (sess, info) => onChildExit(sid, sess, info),
    };
    const session = prof.createSession(emitTo, opts);
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
      d.model = prof.model?.() ?? d.model;
    });
    try {
      prof.onSpawn?.(session);
    } catch (err) {
      log.warn?.(`[durable:lc] ${sid}: spawn hook failed: ${err.message}`);
    }
  }

  /** A run ended (agent_end, or a command's response): record the answer, wake drive(), keep the child a while. */
  function finish(sid, session) {
    const s = S(sid);
    if (session && s.session !== session) return;
    s.factoryStart = null; // the run ended: a refusal came before its end
    if (s.factoryWatch || s.guarded.size) guardFactory(sid).catch(() => {}); // drop the trust of a run that ended
    const text = String(session?.answerText ?? "").trim().slice(0, LC_ANSWER_MAX);
    const lastLine = lastLineOf(text);
    if (s.toolsDropped) writeEntry(sid, LC_TOOL, `(+${s.toolsDropped} more tool calls)`);
    s.tools = s.toolsDropped = 0;
    s.queued = [];
    if (text) writeEntry(sid, LC_ANSWER, text);
    updateRecord(sid, (d) => {
      d.runs += 1;
      if (lastLine) d.lastLine = lastLine;
    });
    s.busy = false;
    s.crashed = false;
    const w = s.waiter;
    s.waiter = null;
    const capped = s.capped;
    s.capped = null;
    clearTimeout(s.capTimer);
    s.capTimer = null;
    clearTimeout(s.deadlineTimer);
    s.deadlineTimer = null;
    if (capped) w?.reject(capError(capped.message));
    else w?.resolve({ lastLine });
    armIdle(sid);
    runEnded(sid);
  }

  /** A profile session went idle (its queued notes go out now). */
  function runEnded(sid) {
    const prof = profileOf(sid);
    if (!prof?.onRunEnd) return;
    try {
      prof.onRunEnd();
    } catch (err) {
      log.warn?.(`[durable:lc] ${sid}: run-end hook failed: ${err.message}`);
    }
  }

  const capError = (message) => Object.assign(new Error(message), { code: LC_CAP });

  /** The turn cap of `sid`: EVEN_BRIDGE_LC_MAX_TURNS, or the agent's own maxTurns when lower. */
  function turnCapOf(sid) {
    const own = map.get(sid)?.max_turns;
    return Number.isInteger(own) && own >= 1 ? Math.min(own, turnCap) : turnCap;
  }

  /** A turn of the running run ended: at the cap, the run is stopped. */
  function countTurn(sid, session) {
    const s = S(sid);
    if (s.session !== session || !s.busy || s.capped) return;
    s.turns += 1;
    const cap = turnCapOf(sid);
    if (s.turns >= cap) capRun(sid, { message: lcTurnCapMessage(s.turns), reason: "turns", turns: s.turns, cap });
  }

  /** A tool call of the running run: the same tool with the same args `repeatMax` times in a row stops it. */
  function countCall(sid, session, name, args) {
    const s = S(sid);
    if (s.session !== session || !s.busy || s.capped) return;
    let key;
    try {
      key = `${name}\0${JSON.stringify(args ?? {})}`;
    } catch {
      key = `${name}\0?${Math.random()}`; // unserializable args never count as a repeat
    }
    if (key === s.lastCall) s.repeats += 1;
    else {
      s.lastCall = key;
      s.repeats = 1;
    }
    if (s.repeats >= repeatMax) {
      capRun(sid, { message: lcRepeatCapMessage(name, s.repeats), reason: "repeat", tool: name, repeats: s.repeats, turns: s.turns });
      return;
    }
    const prof = profileOf(sid);
    s.calls = (s.calls ?? 0) + 1;
    if (prof?.maxToolCalls && s.calls > prof.maxToolCalls) {
      capRun(sid, { message: prof.toolCapMessage?.(prof.maxToolCalls) ?? `run stopped: more than ${prof.maxToolCalls} tool calls`, reason: "tools", code: prof.toolCapCode, calls: s.calls, turns: s.turns });
    }
  }

  /**
   * Stop the run at a cap, cleanly: say why (error frame, `record.lastError`, `onCap` for the audit),
   * then abort the turn (open dialogs cancelled). The child stays; its agent_end ends the run in
   * finish(), which fails the task (LC_CAP). A child that never ends the turn is stopped after capAbortMs.
   */
  function capRun(sid, info) {
    const s = S(sid);
    const session = s.session;
    s.capped = info;
    const row = map.get(sid);
    const prof = profileOf(sid);
    log.warn?.(`[durable:lc] ${sid}: ${info.message}`);
    emitTo(sid, { type: "error", message: info.message, ...(info.code ? { code: info.code } : {}) });
    updateRecord(sid, (d) => {
      d.lastError = { text: info.message, at: now(), reason: LC_CAP_REASON };
    });
    clearTimeout(s.deadlineTimer);
    s.deadlineTimer = null;
    // The overseer's audit is about agents; a profile session (the assistant) is not one.
    if (!prof) {
      try {
        const { message, code: _code, ...rest } = info;
        onCap({ sid, label: row?.name ?? null, message, ...rest });
      } catch (err) {
        log.warn?.(`[durable:lc] ${sid}: cap hook failed: ${err.message}`);
      }
    }
    const graceMs = prof?.abortGraceMs ?? capAbortMs;
    session?.interrupt();
    clearTimeout(s.capTimer);
    s.capTimer = setTimeout(() => {
      s.capTimer = null;
      if (s.capped !== info || s.session !== session) return;
      // The child did not end the turn: end the run here, then stop the child.
      s.capped = null;
      const w = s.waiter;
      s.waiter = null;
      s.busy = false;
      // Inputs queued for this run are not carried into a later one; the user is told how many were dropped.
      const dropped = s.queued.length;
      s.queued = [];
      w?.reject(capError(info.message));
      if (dropped) emitTo(sid, { type: "error", message: lcCapDroppedMessage(dropped) });
      emitTo(sid, { type: "status", state: "idle", sessionId: sid });
      log.warn?.(`[durable:lc] ${sid}: no turn end ${graceMs} ms after the cap abort; stopping the child`);
      stopChild(sid).catch(() => {});
      runEnded(sid);
    }, graceMs);
    s.capTimer.unref?.();
  }

  /** lets-code accepted the running task's prompt (a response or any event after it): a restart now sends the cut-off prompt. */
  function markSent(sid) {
    const s = S(sid);
    const taskId = s.pendingSend;
    if (taskId == null) return;
    s.pendingSend = null;
    s.sentTaskId = taskId;
    updateRecord(sid, (d) => {
      d.sentTaskId = taskId;
    });
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason ?? new Error("aborted"))), { once: true });
    });

  const engine = {
    banner,
    /** The per-run turn cap from EVEN_BRIDGE_LC_MAX_TURNS (an agent's own lower maxTurns wins for it). */
    turnCap,
    memoryController: mem,
    sandboxOk,
    admit,

    /** A new or idle session's prompt starts a run task; a busy one's steers. Retried requestIds are dropped. */
    async prompt(sid, text, { requestId, whenBusy = "steer" } = {}) {
      if (closed) throw httpError(503, "durable provider is shut down");
      const s = S(sid);
      if (requestId && s.requestIds.has(requestId)) return { deduped: true };
      const id = convIdOf(sid);
      if (id == null) throw httpError(404, "Session not found");
      if (s.busy) {
        // A capped run is ending: a steer would land in the aborted turn.
        if (s.capped) throw httpError(409, `${s.capped.message}; send the prompt again once it is idle`);
        const rec = await readRecord(sid);
        if (requestId && rec.lastRequestId === requestId) return { deduped: true };
        const follow = whenBusy === "followUp" && typeof s.session?.followUp === "function";
        if (s.session?.running && !s.starting && s.waiter) await (follow ? s.session.followUp(text) : s.session.steer(text));
        else s.queued.push(follow ? { text, whenBusy: "followUp" } : text); // the child is (re)starting: sent right after the run's prompt
        if (requestId) remember(s, requestId); // only once it was steered or queued
        writeEntry(sid, LC_USER, text);
        if (requestId) updateRecord(sid, (d) => (d.lastRequestId = requestId));
        return { deduped: false, steered: true };
      }
      s.reserved = true; // counts toward maxLive while admit waits (concurrent prompts)
      try {
        await admit(sid);
      } catch (err) {
        s.reserved = false;
        throw err;
      }
      s.busy = true;
      s.reserved = false;
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
      let taskId;
      try {
        taskId = await harness.commit(async (tx) => {
          const d = await tx.doc(LcSessionDoc, id);
          if (requestId && d.lastRequestId === requestId) return null;
          d.lastRequestId = requestId ?? null;
          if (d.lastError?.reason === LC_CAP_REASON) d.lastError = null; // a new run: the old cap is history
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
      if (requestId) remember(s, requestId); // after the commit: a failed one may be retried
      s.taskId = taskId;
      return { deduped: false, taskId };
    },

    /** The run task's phase (see task.mjs). Resolves at the end of the run; rejects LC_EXIT when the child died mid-turn. */
    async drive(sid, { text, attempt, taskId }, signal) {
      const s = S(sid);
      const row = map.get(sid);
      if (!row || row.archived) throw new Error("the session is gone");
      s.busy = true;
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
      s.tools = s.toolsDropped = 0;
      s.capped = null;
      clearTimeout(s.capTimer);
      s.capTimer = null;
      if (s.capTask !== (taskId ?? null) || taskId == null) {
        // A new run (a crash retry of the same task keeps its counts).
        s.capTask = taskId ?? null;
        s.turns = s.repeats = s.calls = 0;
        s.lastCall = null;
      }
      let send = text;
      const prof = profileOf(sid);
      if (attempt > 1 && prof?.noResume) {
        // The assistant never resumes a cut turn (ruling 23): its hook queues the "lost" note and tells the shim.
        const crashed = s.crashed;
        const { lastRequestId } = await readRecord(sid).catch(() => ({}));
        s.crashed = false;
        s.busy = false;
        s.taskId = null;
        s.queued = [];
        s.waiter = null;
        try {
          prof.onNoResume?.({ attempt, crashed, requestId: lastRequestId ?? null });
        } catch (err) {
          log.warn?.(`[durable:lc] ${sid}: no-resume hook failed: ${err.message}`);
        }
        emitTo(sid, { type: "status", state: "idle", sessionId: sid });
        runEnded(sid);
        throw Object.assign(new Error("the run was cut off and is not resumed"), { code: LC_NO_RESUME });
      }
      if (attempt > 1) {
        const rec = await readRecord(sid);
        removeStaleRegistry(rec.childPid, { root: registryRoot });
        const crashed = s.crashed;
        if (crashed) emitTo(sid, { type: "error", message: `lets-code exited mid-turn; starting it again (attempt ${attempt} of ${LC_RESTART_LIMIT + 1})` });
        if (crashed && crashDelayMs > 0) await sleep(crashDelayMs, signal);
        const sent = taskId != null && (s.sentTaskId === taskId || rec.sentTaskId === taskId);
        if (sent) {
          // The prompt reached lets-code: continue that work, never re-send it.
          const runId = findFactoryRun(row.cwd, factoryRoot);
          send = runId ? `/factory resume ${runId}` : crashed ? LC_CRASH_PROMPT : LC_CUTOFF_PROMPT;
          if (runId) setImmediate(() => startFactoryWatch(sid));
        } // else lets-code never accepted it: the user's prompt itself again (never replaced by a cut-off prompt)
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
      s.pendingSend = taskId ?? null;
      if (prof?.deadlineMs > 0) {
        clearTimeout(s.deadlineTimer);
        s.deadlineTimer = setTimeout(() => {
          s.deadlineTimer = null;
          if (s.session !== session || !s.waiter || s.capped) return;
          capRun(sid, { message: prof.deadlineMessage?.(prof.deadlineMs) ?? `run stopped after ${prof.deadlineMs} ms (deadline)`, reason: "deadline", code: prof.deadlineCode, turns: s.turns });
        }, prof.deadlineMs);
        s.deadlineTimer.unref?.();
      }
      const sent = session.runLc(send);
      // Steers (or follow-ups) that arrived while the child was starting.
      for (const q of s.queued.splice(0)) {
        if (typeof q === "object" && q?.whenBusy === "followUp") session.followUp(q.text).catch(() => {});
        else session.steer(typeof q === "object" ? q.text : q).catch(() => {});
      }
      sent.then(
        (res) => {
          if (res && res.success !== false) markSent(sid);
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
      clearTimeout(s.deadlineTimer);
      s.deadlineTimer = null;
      s.queued = []; // steers of a run that ended without an answer are stale
      s.busy = false;
      s.taskId = null;
      s.waiter = null;
      emitTo(sid, { type: "error", message });
      emitTo(sid, { type: "status", state: "idle", sessionId: sid });
      armIdle(sid);
      runEnded(sid);
    },

    /** The task's abort handler: cancel dialogs, abort the turn, stop the child. */
    async abortChild(sid) {
      const s = S(sid);
      clearTimeout(s.deadlineTimer);
      s.deadlineTimer = null;
      s.busy = false;
      s.taskId = null;
      s.queued = [];
      s.capped = null;
      clearTimeout(s.capTimer);
      s.capTimer = null;
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
      const cwd = map.get(sid)?.cwd ?? rec.cwd;
      await engine.stop(sid).catch(() => {});
      // pi's trust of this session's cwd (its even-guard.ts answered "remember") and of the factory
      // worktrees the engine trusted; a cwd another live lets-code session still uses keeps its entry.
      const shared = cwd && [...map.rows({ seenSince: 0 })].some((r) => r.sid !== sid && !r.archived && r.engine === "lets-code" && r.cwd === cwd);
      try {
        await updateTrust([...(shared ? [] : [cwd]), ...(rec.trusted ?? [])], null, { file: trustFile });
      } catch (err) {
        log.warn?.(`[durable:lc] ${sid}: trust entries not removed (${err.message})`);
      }
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
      if (on && ticket && tracksDotPi(row.cwd)) throw Object.assign(httpError(409, LC_REPO_TRACKS_PI), { reason: "repo_tracks_pi" });
      if (on) {
        // Experts are host-wide lets-code state: only the operator enables them (ruling 4, R-C2). Orchestration
        // without them only raises expert dialogs the session answers No, so "on" needs them too.
        const ex = expertsEnabled({ stateFile });
        if (!ex.ok) throw Object.assign(httpError(409, `${LC_EXPERTS_DISABLED} (missing: ${ex.missing.join(", ")})`), { reason: "experts_disabled", missing: ex.missing });
      }
      const s = S(sid);
      // A child that is starting reads the flag after its start: wait for it, then decide (no race).
      while (s.starting) await s.starting.catch(() => {});
      const prev = Boolean((await readRecord(sid)).factory);
      await updateRecord(sid, (d) => {
        d.factory = Boolean(on);
        d.lastError = null;
      });
      let mode = null; // only what lets-code acknowledged in this call; null = applied at the next spawn
      if (s.session?.running) {
        try {
          mode = await sendMode(sid, on ? "orchestration" : "ask");
        } catch (err) {
          // not confirmed: the flag stays what it was, so the next spawn does not apply a refused change
          await updateRecord(sid, (d) => {
            d.factory = prev;
          });
          throw err;
        }
      }
      if (on && ticket) {
        const name = `.factory/ticket-${now()}.md`;
        const file = join(row.cwd, name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, String(ticket));
        const text = `/factory start ${name}${howToRun ? ` ${String(howToRun).trim()}` : ""}`;
        s.factoryStart = { at: now(), file: name };
        try {
          await engine.prompt(sid, text);
        } catch (err) {
          s.factoryStart = null; // not started (429, 503, gone): later notifies are no refusal
          throw err;
        }
        startFactoryWatch(sid);
      }
      return { factory: Boolean(on), mode };
    },

    /** A new lets-code session's cwd: a repo that tracks a `.pi` dir is refused (409 repo_tracks_pi). */
    checkCwd(cwd) {
      if (tracksDotPi(cwd)) throw Object.assign(httpError(409, LC_REPO_TRACKS_PI), { reason: "repo_tracks_pi" });
    },

    /** Experts check for a new session started with the factory on (before any row exists). */
    checkFactoryExperts() {
      const ex = expertsEnabled({ stateFile });
      if (!ex.ok) throw Object.assign(httpError(409, `${LC_EXPERTS_DISABLED} (missing: ${ex.missing.join(", ")})`), { reason: "experts_disabled", missing: ex.missing });
    },

    /** Deny mandate asks open for 10 min while nobody watches (ruling Q5). */
    sweep() {
      let n = 0;
      for (const s of states.values()) if (s.session?.running) n += s.session.sweepDialogs(now());
      return n;
    },

    liveCount() {
      return [...states.values()].filter((s) => s.session?.running && !profileOf(s.sid)).length;
    },

    /** Bridge shutdown: children and their scopes stop; run tasks stay pending (a restart resumes them). */
    async stopAll() {
      closed = true;
      clearInterval(sweeper);
      const sids = [];
      for (const s of states.values()) {
        clearTimeout(s.idleTimer);
        s.idleTimer = null;
        clearTimeout(s.capTimer);
        s.capTimer = null;
        stopFactoryWatch(s.sid);
        clearInterval(s.sealTimer);
        s.sealTimer = null;
        if (s.session) {
          sids.push(s.sid);
          s.session.expectedExit = true;
          await s.session.stop().catch(() => {});
          s.session = null;
        }
      }
      const units = sids.map((sid) => profileOf(sid)?.unit).filter(Boolean);
      const plain = sids.filter((sid) => !profileOf(sid)?.unit);
      if (plain.length) stopLcScopes(plain, { env: scopeEnv, run });
      if (units.length) stopScopeUnits(units, { env: scopeEnv, run });
    },

    /** Register a profile session (see `profiles`); before its first spawn. */
    addProfile(sid, profile) {
      profiles.set(sid, profile);
    },

    /** The live child session of `sid`, or null (a profile's own RPC calls: compact, set_model, …). */
    session(sid) {
      const s = states.get(sid);
      return s?.session?.running ? s.session : null;
    },

    /** Spawn the child of `sid` unless one runs (a profile's warm start). @returns {Promise<boolean>} whether it spawned */
    ensureChild(sid) {
      if (closed) return Promise.reject(httpError(503, "durable provider is shut down"));
      return ensureChild(sid);
    },

    /** Stop the child of `sid` (and its scope). */
    stopChild(sid) {
      return stopChild(sid);
    },

    /** Change the record of `sid` (a profile's new session file after `new_session`). */
    updateRecord(sid, change) {
      return updateRecord(sid, change);
    },

    get closed() {
      return closed;
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
