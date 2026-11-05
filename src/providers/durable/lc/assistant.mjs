// The Even AI assistant: one always-warm lets-code session `dur-assistant` (plan Task A1, rulings 23–32,
// design docs/superpowers/specs/2026-11-03-evenai-agent-design.md §2, A0 decisions in docs/assistant-spike.md).
//
// It is a profile of the lets-code engine, not an agent:
// - launch: `-ne -e <lets-code ext> -e even-assistant.ts --tools <Even tools>,memory --thinking medium
//   --no-mandate --approve` (launch.mjs `assistantLaunch`), cwd `~/sandbox/assistant` (keys core memory),
//   env ASSISTANT_MODULE_ENV + the tool server's URL and token *file*; scope `even-lc-dur-assistant-<store>`;
// - own slot: never admitted against EVEN_BRIDGE_LC_MAX_LIVE, not in /api/agents, no idle stop, no reaper/TTL;
// - always warm: spawned at bridge start, respawned with `--session` after an exit (backoff 2 s → 60 s; at
//   once after the engine stopped it itself, e.g. a run that ignored its abort);
// - per run: ASSISTANT_RUN_DEADLINE_S and ASSISTANT_MAX_TOOL_CALLS → RPC `abort`; a child still busy
//   ASSISTANT_ABORT_GRACE_MS later is stopped and respawned, so the next prompt never meets
//   "Agent is already processing" (A0: qwen tool loops of 241 and 519 calls);
// - no resume after a restart: the note ASSISTANT_RESTART_NOTE, a frame `assistant_restarted`, the task aborted;
// - dialogs never reach the phone: frames `assistant_dialog`, answered through `answerDialog`;
// - host notes go in as files through the extension command `/even-note <file>` (no run), queued while busy;
// - the daily reset (04:00, `even.assistant-nightly`) and a switch to Claude hand off: `compact` (instructions:
//   keep open questions, tasks, plans; no phone data) → `new_session` → the summary as the first note;
//   a failed compact still resets (`new_session` + a note that no summary was kept).
//
// Core memory (A0 `MEMORY_REREAD = no`): the child reads its store only at `session_start` (a new session or
// a respawn), and its next `remember`/`forget` saves its cached entries over the file. So nothing in the
// bridge writes the store while the child runs; the reset path (new_session) is the only point where a write
// made outside the child is picked up. The one-time import (A5) runs while the assistant is off.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTask } from "@earendil-works/pi-durable";
import { claim } from "../../../ownership.mjs";
import { ASSISTANT_EXT_DIR, assistantLaunch, assistantScopeUnit, expandHome } from "./launch.mjs";
import { LcSession } from "./session.mjs";

export const ASSISTANT_SID = "dur-assistant";
export const ASSISTANT_TITLE = "Even AI";
export const ASSISTANT_CWD = "~/sandbox/assistant";
export const ASSISTANT_MODEL = "lets-code/qwen3.8-27b";
export const ASSISTANT_THINKING = "medium";
export const ASSISTANT_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high"]);
export const ASSISTANT_RESET_HOUR = 4;
export const ASSISTANT_RESET_RETRY_MS = 600000;
/**
 * The note after a cut run (bridge restart or crash). The cut user message stays in the session and qwen went
 * back to it on its own in the A1 real run, so the note says not to; A2's context hook also stubs that turn.
 */
export const ASSISTANT_RESTART_NOTE =
  "(bridge restarted; your last answer was lost. Do not answer or continue that interrupted request unless the user asks for it again.)";
export const ASSISTANT_LOST = "I lost that one, please ask again.";
/**
 * The hand-off's compaction instructions (ruling 28 plus A0 finding 6: the summary copied calendar and
 * notes contents into the next session; phone data changes and the phone is the truth). The A1 real run
 * showed a milder wording ("leave out calendar … contents") was ignored by qwen: the summary still listed
 * "Lasagna at 18:00", taken from the model's own earlier answer; hence the explicit placeholder.
 */
export const ASSISTANT_HANDOFF =
  "Keep open questions, pending tasks and the user's stated plans. " +
  "Do not copy calendar events, notes, quick-list items or any other phone data (titles, times, dates of events) into the summary, " +
  "not even from your own earlier answers: write \"(phone data left out; fetch it again)\" instead. They change, and the phone is the source.";
export const ASSISTANT_SUMMARY_PREFIX = "Summary of the earlier conversation:\n";
/** The first note of a reset whose compact failed (the reset goes ahead without a summary). */
export const ASSISTANT_NO_SUMMARY_NOTE = "(the earlier conversation was reset; no summary of it was kept)";
export const ASSISTANT_TOOLS = Object.freeze([
  "fetch_calendar",
  "fetch_notes",
  "fetch_quicklist",
  "control_app",
  "kb_search",
  "web_search",
  "get_preferences",
  "set_preference",
  "agent_start",
  "agent_list",
  "agent_status",
  "agent_message",
  "agent_stop",
  "sessions_list",
  "session_read",
  "overseer_outbox",
  "memory",
]);
export const ASSISTANT_NOTE_CMD = "/even-note";
export const ASSISTANT_NIGHTLY_TASK = "even.assistant-nightly";
/** A0: a normal run took ≤ 3.8 s; the degenerate ones 31–180 s. */
export const ASSISTANT_RUN_DEADLINE_S = 20;
/** A0: per run; the extension blocks the 9th call, the host aborts when the model keeps calling. */
export const ASSISTANT_MAX_TOOL_CALLS = 8;
/** After the abort of a capped run: a child still busy this long later is stopped and respawned. */
export const ASSISTANT_ABORT_GRACE_MS = 2000;
export const ASSISTANT_BACKOFF = Object.freeze({ minMs: 2000, maxMs: 60000 });
/** A child that lived this long before an exit resets the backoff. */
export const ASSISTANT_STABLE_MS = 60000;
/** How long a fresh child may take to print its `[even-assistant] tools:` line. */
export const ASSISTANT_TOOLS_WAIT_MS = 3000;
/** The lets-code Claude proxy port: a Claude model in the child hosts it in-process (A0 4d). */
export const ASSISTANT_CLAUDE_PROXY_PORT = 8795;
/** `<cwd>/.pi/settings.json`: a small kept tail, so `compact` works on a short day (A0 4d: "Nothing to compact"). */
export const ASSISTANT_KEEP_RECENT_TOKENS = 200;
/**
 * A0 `ASSISTANT_MODULE_ENV`: lets-code derives each module switch from `LETS_CODE_<X>` (the `_ON` names are
 * unset by the launcher); only core memory, the agent guard and grounding stay on. The mandate module has no
 * switch: `--no-mandate` (launch argv).
 */
export const ASSISTANT_MODULE_ENV = Object.freeze({
  LETS_CODE_SUBAGENTS: "false",
  LETS_CODE_EXPERTS: "false",
  LETS_CODE_SESSIONS: "false",
  LETS_CODE_CLAUDE_CODE: "false",
  LETS_CODE_MANDATE: "false",
  LETS_CODE_SANDBOX: "false",
  LETS_CODE_GIT_GUARD: "false",
  LETS_CODE_SESSION_TAG: "false",
  LETS_CODE_METRICS: "false",
  LETS_CODE_CORE_MEMORY: "true",
  LETS_CODE_AGENT_GUARD: "true",
  LETS_CODE_GROUNDING: "true",
  LETS_CODE_MEM_WATCH: "false",
  LETS_CODE_MEM_GUARD: "false",
});
/** A2's extension (`even-assistant.ts`, next to this file); EVEN_BRIDGE_ASSISTANT_EXT overrides it. */
export const ASSISTANT_EXT = fileURLToPath(new URL("./even-assistant.ts", import.meta.url));
export const ASSISTANT_TOOLS_LINE = /\[even-assistant\] tools: (\d+) \((live|cache|none)\)/;
const META_CONVERSATION = "assistant.conversation";
const META_LAST_RESET = "assistant.lastResetAt";

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const isClaudeModel = (m) => /^Anthropic\/claude-/.test(String(m ?? ""));

/** The next `hour`:00 local after `t` (epoch ms). */
export function nextResetAt(t, hour = ASSISTANT_RESET_HOUR) {
  const d = new Date(t);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Is nothing listening on `host:port`? (A second lets-code Claude proxy would fail to bind it.) */
export function portIsFree(port = ASSISTANT_CLAUDE_PROXY_PORT, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * The assistant's child: LcSession frames (text, tools, result, status), but dialogs never become a
 * permission_request or user_question (ruling 23, design §6): each is one `assistant_dialog` frame the
 * shim turns into HUD text; `editor` is cancelled (the glasses cannot edit text).
 */
export class AssistantSession extends LcSession {
  constructor(emit, opts = {}) {
    super(emit, opts);
    /** id → the open dialog request */
    this.dialogs = new Map();
  }

  onUiRequest(req) {
    if (!DIALOG_METHODS.has(req.method)) return super.onUiRequest(req);
    this.activity();
    if (req.method === "editor") {
      this.client?.respondUi({ type: "extension_ui_response", id: req.id, cancelled: true });
      return;
    }
    req.openedAt = this.now();
    this.dialogs.set(req.id, req);
    this.send({
      type: "assistant_dialog",
      id: req.id,
      method: req.method,
      title: String(req.title ?? ""),
      ...(req.message != null ? { message: String(req.message) } : {}),
      options: Array.isArray(req.options) ? req.options.map(String) : req.method === "confirm" ? ["Yes", "No"] : [],
    });
  }

  /** `{ value }` (select/input), `{ confirmed }` (confirm) or `{ cancelled: true }`. @returns {boolean} whether it was open */
  answerDialog(id, { value, confirmed, cancelled } = {}) {
    const req = this.dialogs.get(id);
    if (!req || !this.client) return false;
    this.dialogs.delete(id);
    const res = { type: "extension_ui_response", id };
    if (cancelled === true) res.cancelled = true;
    else if (req.method === "confirm") res.confirmed = confirmed === true || /^(yes|y|allow)/i.test(String(value ?? ""));
    else res.value = String(value ?? "");
    this.client.respondUi(res);
    return true;
  }

  openDialogs() {
    return [...this.dialogs.values()].map((r) => ({ id: r.id, kind: "assistant", title: String(r.title ?? "") }));
  }

  get awaitingQuestion() {
    return false;
  }

  interrupt() {
    for (const id of [...this.dialogs.keys()]) this.answerDialog(id, { cancelled: true });
    super.interrupt();
  }

  sweepDialogs() {
    return 0; // the shim owns the assistant's dialogs
  }

  respondPermission() {
    return false;
  }
}

/**
 * The nightly reset task, defined once and bound late (the registry is built before the harness opens).
 * `box.bind({ resetIfIdle })`: resolves true when the hand-off ran, false when busy (retry in 10 min).
 */
export function createAssistantBox({ now = Date.now } = {}) {
  let deps = null;
  let bindIt;
  const bound = new Promise((r) => (bindIt = r));
  const box = {
    now: () => now(),
    bind(d) {
      deps = d;
      bindIt(d);
    },
    wait(signal) {
      if (deps) return Promise.resolve(deps);
      return new Promise((res, rej) => {
        bound.then(res);
        signal?.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), { once: true });
      });
    },
  };
  box.task = defineTask({
    name: ASSISTANT_NIGHTLY_TASK,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (_task, runtime, context) => runtime.sleepUntil(nextResetAt(box.now()), { phase: "reset" }, context),
      reset: async (_task, runtime, context) => {
        const d = await box.wait(runtime.signal);
        const t = box.now();
        let done = false;
        try {
          done = (await d.resetIfIdle()) === true;
        } catch {
          done = false;
        }
        if (!done) {
          await runtime.sleepUntil(t + ASSISTANT_RESET_RETRY_MS, { phase: "reset" }, context); // busy: again in 10 minutes
          return;
        }
        await runtime.commit(() => ({ status: "sleeping", until: nextResetAt(t), checkpoint: { phase: "reset" } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  return box;
}

/**
 * The assistant's Durable conversation (a record only, like a lets-code agent's): created once, its id kept
 * in the session map's meta table. @returns {Promise<number>}
 */
export async function ensureAssistantConversation({ harness, ctx, map, agent }) {
  const have = map.getMeta(META_CONVERSATION);
  if (have != null && have !== "") {
    const id = Number(have);
    const conv = await harness.conversation(id, ctx).catch(() => null);
    if (conv) return id;
  }
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
  map.setMeta(META_CONVERSATION, String(conv.id));
  return conv.id;
}

/** The nightly task of the assistant's conversation exists once (re-created if it ended). */
export async function ensureNightly({ harness, ctx, box, conversationId }) {
  await harness.commit(async (tx) => {
    const page = await tx.scanTasks({ conversationId, kind: ASSISTANT_NIGHTLY_TASK }, 20);
    if (page.items.some((t) => t.state?.status !== "terminal")) return;
    await tx.createTask(box.task, {}, { ownership: { kind: "conversation" }, conversationId, background: true });
  }, ctx);
}

/**
 * @param {object} o
 * @param {object} o.engine the lets-code engine (createLcEngine)
 * @param {(sid: string, frame: object) => void} o.emit ring + hub feed
 * @param {string} o.storeDir where `lc-sessions/` lives
 * @param {object} o.box createAssistantBox() (its nightly task is registered)
 * @param {{ getMeta(k): string|undefined, setMeta(k, v): void }} o.meta the session map's meta table
 * @param {object} o.opts `{ toolsUrl, tokenFile, moduleEnv, bin, caps, wrapper, ext, extDir, cwd, model,
 *   deadlineMs, maxToolCalls, abortGraceMs, backoff, toolsWaitMs, portFree }`
 */
export function createAssistant({ engine, emit, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console, storeDir, box, meta, opts = {} }) {
  const o = {
    moduleEnv: ASSISTANT_MODULE_ENV,
    cwd: ASSISTANT_CWD,
    ext: ASSISTANT_EXT,
    extDir: ASSISTANT_EXT_DIR,
    deadlineMs: ASSISTANT_RUN_DEADLINE_S * 1000,
    maxToolCalls: ASSISTANT_MAX_TOOL_CALLS,
    abortGraceMs: ASSISTANT_ABORT_GRACE_MS,
    backoff: ASSISTANT_BACKOFF,
    toolsWaitMs: ASSISTANT_TOOLS_WAIT_MS,
    portFree: portIsFree,
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  };
  const sid = ASSISTANT_SID;
  const cwd = expandHome(o.cwd);
  const sessionsDir = join(storeDir, "lc-sessions");
  const notesDir = join(sessionsDir, `${sid}-notes`);
  const schemaCache = join(sessionsDir, "assistant-tools-schema.json");
  const tokenFile = o.tokenFile ? expandHome(o.tokenFile) : undefined;
  const st = { model: ASSISTANT_MODEL, thinking: ASSISTANT_THINKING };
  let tools = { n: 0, source: "none", seen: false };
  let toolsWaitOver = false; // the wait for the tools line of this child is over (seen or timed out)
  let synced = false; // afterStart (model + thinking) ran for this child
  let toolWaiters = [];
  let spawning = null;
  let respawnTimer = null;
  let delay = o.backoff.minMs;
  let spawnedAt = 0;
  let stopped = false;
  let handing = false;
  const queue = []; // note files not yet sent, oldest first
  let flushing = null;
  let noteSeq = 0;
  let lost = null; // { requestId, at }: the last run a restart cut (the shim matches its pending requestId)

  const emitTo = (frame) => {
    try {
      emit(sid, frame);
    } catch (err) {
      log.warn?.(`[assistant] emit failed: ${err.message}`);
    }
  };

  function prepareCwd() {
    // The cwd and its .pi are the bridge's: 0700 (with --approve pi trusts this project).
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    chmodSync(cwd, 0o700);
    mkdirSync(notesDir, { recursive: true, mode: 0o700 });
    // The reset's compact needs a small kept tail (A0 4d); `--approve` makes pi read this project file.
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    chmodSync(piDir, 0o700);
    try {
      const other = readdirSync(piDir).filter((n) => n !== "settings.json");
      if (other.length) log.warn?.(`[assistant] ${piDir} holds ${other.join(", ")}: only the bridge's settings.json belongs there`);
    } catch {
      /* unreadable: the spawn will tell */
    }
    // Notes a previous process wrote but never sent (a hand-off summary among them): oldest first.
    try {
      for (const n of readdirSync(notesDir).filter((x) => x.endsWith(".txt")).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
        const f = join(notesDir, n);
        if (!queue.includes(f)) queue.push(f);
      }
    } catch {
      /* none */
    }
    const file = join(piDir, "settings.json");
    let cur = {};
    try {
      cur = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* none yet, or not ours */
    }
    const want = { ...cur, compaction: { ...(cur.compaction ?? {}), keepRecentTokens: ASSISTANT_KEEP_RECENT_TOKENS } };
    if (JSON.stringify(want) !== JSON.stringify(cur)) writeFileSync(file, `${JSON.stringify(want, null, 2)}\n`);
  }

  function onStderrLine(line) {
    const m = ASSISTANT_TOOLS_LINE.exec(String(line));
    if (!m) return;
    tools = { n: Number(m[1]), source: m[2], seen: true };
    for (const w of toolWaiters.splice(0)) w();
  }

  function waitTools(ms) {
    if (tools.seen) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimer(t);
        resolve();
      };
      const t = setTimer(() => {
        toolWaiters = toolWaiters.filter((w) => w !== done);
        resolve();
      }, ms);
      t?.unref?.();
      toolWaiters.push(done);
    });
  }

  const running = () => Boolean(engine.session(sid));

  function status() {
    if (handing) return "busy";
    if (engine.status(sid) !== "idle") return "busy";
    if (running()) return synced && (tools.seen || toolsWaitOver) ? "idle" : "starting";
    if (spawning) return "starting";
    return "down";
  }

  function clearRespawn() {
    if (respawnTimer) clearTimer(respawnTimer);
    respawnTimer = null;
  }

  function scheduleRespawn() {
    if (stopped || engine.closed || respawnTimer) return;
    const wait = delay;
    delay = Math.min(delay * 2, o.backoff.maxMs);
    respawnTimer = setTimer(() => {
      respawnTimer = null;
      spawn().catch(() => {});
    }, wait);
    respawnTimer?.unref?.();
  }

  function spawn() {
    if (stopped || engine.closed) return Promise.resolve(false);
    if (spawning) return spawning;
    clearRespawn();
    spawning = (async () => {
      try {
        await engine.ensureChild(sid);
        await waitTools(o.toolsWaitMs);
        toolsWaitOver = true;
        if (!tools.seen) log.warn?.("[assistant] no `[even-assistant] tools:` line from the child; prompts are refused (assistant tools not loaded)");
        return true;
      } catch (err) {
        log.warn?.(`[assistant] start failed: ${err.message}`);
        scheduleRespawn();
        return false;
      } finally {
        spawning = null;
      }
    })();
    spawning.then((ok) => ok && flushNotes()).catch(() => {});
    return spawning;
  }

  async function rpc(cmd, timeoutMs = 30000) {
    const sess = engine.session(sid);
    if (!sess?.client) throw httpError(503, "assistant not ready");
    const res = await sess.client.send(cmd, timeoutMs);
    return res ?? {};
  }

  function writeNote(text) {
    mkdirSync(notesDir, { recursive: true, mode: 0o700 });
    let ms = now();
    let file = join(notesDir, `${ms}.txt`);
    while (existsSync(file)) file = join(notesDir, `${++ms}.txt`);
    writeFileSync(file, String(text), { mode: 0o600 });
    noteSeq += 1;
    return file;
  }

  /** Send the queued notes, oldest first, while the child is idle and its extension is loaded. */
  function flushNotes() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (queue.length) {
        const sess = engine.session(sid);
        // tools.seen: the extension printed its line, so `/even-note` is its command (never a prompt to the model).
        if (!sess || !tools.seen || engine.status(sid) !== "idle") return;
        const file = queue[0];
        let res;
        try {
          res = await sess.command(`${ASSISTANT_NOTE_CMD} ${file}`, 10000);
        } catch (err) {
          log.warn?.(`[assistant] note not sent: ${err.message}`);
          return;
        }
        if (res?.success === false) {
          log.warn?.(`[assistant] note refused: ${res.error ?? "?"}`);
          return;
        }
        if (queue[0] === file) queue.shift();
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  function note(text) {
    const idle = running() && tools.seen && engine.status(sid) === "idle" && queue.length === 0 && !handing;
    queue.push(writeNote(text));
    if (!handing) flushNotes().catch(() => {});
    return { queued: !idle };
  }

  async function handoff(instructions = ASSISTANT_HANDOFF, { force = false } = {}) {
    if (!force && status() === "busy") throw httpError(409, "assistant is busy");
    if (!running()) throw httpError(503, "assistant not ready");
    handing = true;
    let summary = "";
    try {
      const c = await rpc({ type: "compact", customInstructions: instructions }, 180000);
      if (c.success !== false && typeof c.data?.summary === "string") summary = c.data.summary;
      else log.warn?.(`[assistant] compact failed (${c.error ?? "no summary"}); resetting without a summary`);
    } catch (err) {
      log.warn?.(`[assistant] compact failed (${err.message}); resetting without a summary`);
    }
    try {
      const ns = await rpc({ type: "new_session" });
      if (ns.success === false || ns.data?.cancelled) throw httpError(502, `new_session failed: ${ns.error ?? "cancelled"}`);
      const s = await rpc({ type: "get_state" });
      const file = s.data?.sessionFile;
      const id = s.data?.sessionId;
      const sess = engine.session(sid);
      if (sess) {
        if (file) sess.sessionFile = file;
        if (id) sess.sessionId = id;
      }
      if (id) claim(id, "durable");
      await engine.updateRecord(sid, (d) => {
        if (file) d.piSessionFile = file;
        if (id) d.piSessionId = id;
      });
    } finally {
      handing = false;
    }
    queue.unshift(writeNote(summary ? ASSISTANT_SUMMARY_PREFIX + summary : ASSISTANT_NO_SUMMARY_NOTE));
    await flushNotes();
    const at = now();
    meta?.setMeta?.(META_LAST_RESET, String(at));
    return summary;
  }

  const profile = {
    unit: assistantScopeUnit(storeDir),
    noResume: true,
    deadlineMs: o.deadlineMs,
    maxToolCalls: o.maxToolCalls,
    abortGraceMs: o.abortGraceMs,
    deadlineCode: "assistant_deadline",
    toolCapCode: "assistant_tool_cap",
    deadlineMessage: (ms) => `assistant run stopped after ${Math.round(ms / 100) / 10} s (deadline)`,
    toolCapMessage: (n) => `assistant run stopped: more than ${n} tool calls`,
    model: () => st.model,
    launch: ({ sessionDir, resume, caps, wrapper, bin, baseEnv, childEnv }) => {
      tools = { n: 0, source: "none", seen: false };
      toolsWaitOver = false;
      synced = false;
      // qwen at medium at launch and on every respawn (global constraint).
      st.model = ASSISTANT_MODEL;
      st.thinking = ASSISTANT_THINKING;
      return assistantLaunch({
        cwd,
        sessionDir,
        sessionFile: resume,
        bin: o.bin ?? bin,
        extDir: o.extDir,
        assistantExt: o.ext,
        tools: ASSISTANT_TOOLS,
        thinking: ASSISTANT_THINKING,
        // Always: on `--session` pi would restore the session's own model (a Claude switch writes one).
        model: o.model ?? ASSISTANT_MODEL,
        caps: o.caps ?? caps,
        wrapper: o.wrapper ?? wrapper,
        moduleEnv: o.moduleEnv,
        toolsUrl: o.toolsUrl,
        tokenFile,
        schemaCache,
        unit: profile.unit,
        baseEnv,
        extraEnv: childEnv,
      });
    },
    createSession: (emitFn, sopts) => new AssistantSession(emitFn, { ...sopts, onStderr: onStderrLine }),
    /**
     * Before the first prompt reaches a new child: the model it really runs (back to qwen when pi restored
     * another from the session file) and the thinking level (set_model and a launch both leave it to settings.json).
     */
    afterStart: async (session) => {
      const want = o.model ?? ASSISTANT_MODEL;
      const label = (m) => (m?.provider && m?.id ? `${m.provider}/${m.id}` : null);
      const s = await session.client.send({ type: "get_state" }, 10000).catch(() => null);
      let have = label(s?.data?.model);
      if (have && have !== want) {
        const slash = want.indexOf("/");
        const r = await session.client.send({ type: "set_model", provider: want.slice(0, slash), modelId: want.slice(slash + 1) }, 10000).catch((e) => ({ success: false, error: e.message }));
        if (r.success === false) log.warn?.(`[assistant] the child runs ${have}; set_model ${want} failed: ${r.error ?? "?"}`);
        else have = want;
      }
      st.model = have ?? want;
      const t = await session.client.send({ type: "set_thinking_level", level: ASSISTANT_THINKING }, 10000).catch((e) => ({ success: false, error: e.message }));
      if (t.success === false) log.warn?.(`[assistant] set_thinking_level failed: ${t.error ?? "?"}`);
      else st.thinking = ASSISTANT_THINKING;
      synced = true;
    },
    onSpawn: () => {
      spawnedAt = now();
    },
    onExit: ({ expected, closed }) => {
      tools = { n: 0, source: "none", seen: false };
      if (stopped || closed || engine.closed) return;
      if (expected) {
        // The engine stopped it (a run that ignored its abort): back at once, with --session.
        spawn().catch(() => {});
        return;
      }
      if (now() - spawnedAt >= ASSISTANT_STABLE_MS) delay = o.backoff.minMs;
      log.warn?.(`[assistant] the child exited; respawning in ${delay} ms`);
      scheduleRespawn();
    },
    onNoResume: ({ requestId } = {}) => {
      lost = { requestId: requestId ?? null, at: now() };
      note(ASSISTANT_RESTART_NOTE);
      emitTo({ type: "error", code: "assistant_restarted", message: ASSISTANT_LOST });
    },
    onRunEnd: () => {
      flushNotes().catch(() => {});
    },
  };
  engine.addProfile(sid, profile);

  box?.bind({
    resetIfIdle: async () => {
      if (stopped || status() !== "idle") return false;
      await handoff(ASSISTANT_HANDOFF);
      return true;
    },
  });

  const assistant = {
    sid,
    profile,
    /** The first warm start (spawn + the tools line, or its wait). */
    ready: null,

    start() {
      prepareCwd();
      assistant.ready = spawn();
      return assistant.ready;
    },

    /** 202 body: `{ ok, requestId, deduped }`. 503 not ready / tools not loaded; 409 during a hand-off or a capped run's end. */
    async prompt(text, { requestId, whenBusy = "steer" } = {}) {
      // A slash command would reach lets-code/pi as a command (`/even-note <file>` among them): refused here too.
      if (String(text ?? "").trimStart().startsWith("/")) throw httpError(400, "slash_command_refused");
      if (stopped) throw httpError(503, "assistant not ready");
      if (!running()) {
        if (!spawning) {
          clearRespawn();
          spawn().catch(() => {});
        }
        if (spawning) await spawning;
      }
      if (!running()) throw httpError(503, "assistant not ready");
      if (!tools.seen) await waitTools(o.toolsWaitMs);
      if (tools.n === 0) throw httpError(503, "assistant tools not loaded");
      if (handing) throw httpError(409, "assistant is busy");
      const r = await engine.prompt(sid, text, { requestId, whenBusy });
      return { ok: true, requestId, deduped: Boolean(r?.deduped) };
    },

    interrupt() {
      if (engine.status(sid) !== "idle") engine.interrupt(sid);
    },

    /** The daily reset by hand: the hand-off (409 while busy). */
    async reset() {
      await handoff(ASSISTANT_HANDOFF);
      return { ok: true };
    },

    /** Compact the current session (no new session). */
    async compact() {
      if (status() === "busy") throw httpError(409, "assistant is busy");
      handing = true;
      try {
        const c = await rpc({ type: "compact", customInstructions: ASSISTANT_HANDOFF }, 180000);
        if (c.success === false) throw httpError(409, `compact failed: ${c.error ?? "unknown"}`);
      } finally {
        handing = false;
      }
      flushNotes().catch(() => {});
      return { ok: true };
    },

    /**
     * Model and thinking, only while idle (409). A switch to Claude hands off first (ruling 32) and is
     * refused while 127.0.0.1:8795 is taken (the child would host a second lets-code Claude proxy).
     * `set_thinking_level` follows every `set_model` (it resets the level to settings.json, A0).
     */
    async setModel({ model, thinking } = {}) {
      if (status() === "busy") throw httpError(409, "assistant is busy");
      if (!running()) throw httpError(503, "assistant not ready");
      if (model && model !== st.model) {
        const slash = model.indexOf("/");
        if (slash <= 0) throw httpError(400, `Unknown model ${JSON.stringify(model)}`);
        if (isClaudeModel(model) && !isClaudeModel(st.model)) {
          if (!(await o.portFree(ASSISTANT_CLAUDE_PROXY_PORT))) {
            throw httpError(409, `127.0.0.1:${ASSISTANT_CLAUDE_PROXY_PORT} is in use (another lets-code Claude proxy); the assistant stays on ${st.model}`);
          }
          await handoff(ASSISTANT_HANDOFF);
        }
        const r = await rpc({ type: "set_model", provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
        if (r.success === false) throw httpError(400, `set_model failed: ${r.error ?? "unknown model"}`);
        st.model = model;
        const level = thinking ?? st.thinking;
        const t = await rpc({ type: "set_thinking_level", level });
        if (t.success === false) throw httpError(400, `set_thinking_level failed: ${t.error ?? "?"}`);
        st.thinking = level;
        await engine.updateRecord(sid, (d) => {
          d.model = model;
        });
      } else if (thinking && thinking !== st.thinking) {
        const t = await rpc({ type: "set_thinking_level", level: thinking });
        if (t.success === false) throw httpError(400, `set_thinking_level failed: ${t.error ?? "?"}`);
        st.thinking = thinking;
      }
      return { model: st.model, thinking: st.thinking };
    },

    note,

    answerDialog(id, answer) {
      const sess = engine.session(sid);
      if (!sess?.answerDialog?.(id, answer)) throw httpError(404, "no such dialog");
      return { ok: true };
    },

    handoff,

    state() {
      const sess = engine.session(sid);
      const last = meta?.getMeta?.(META_LAST_RESET);
      return {
        status: status(),
        model: st.model,
        thinking: st.thinking,
        toolsLoaded: tools.n,
        toolsSource: tools.source,
        sessionFile: sess?.sessionFile ?? null,
        lastResetAt: last ? Number(last) : null,
        // The frame `assistant_restarted` goes out while the bridge starts, before a client can listen.
        lost,
      };
    },

    stop() {
      stopped = true;
      clearRespawn();
    },

    _queue: queue,
    get _noteCount() {
      return noteSeq;
    },
  };
  return assistant;
}
