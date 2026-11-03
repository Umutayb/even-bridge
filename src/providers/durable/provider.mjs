// The `durable` provider: Pi Durable conversations behind the same contract as
// the pi provider (src/providers/pi/provider.mjs), so the router, the hub, SSE
// and the phone's Terminal feature treat them like any other extended session.
//
// One process owns one Harness (SQLite store, `~/.even-terminal/durable.sqlite`)
// and a SessionMap (its own SQLite file) that maps the bridge's "dur-<uuid>"
// session ids to Durable conversation ids. Every conversation runs CodingTools
// behind the guard extension (path confinement, command vetting, resource caps)
// and offers the `subagent` tool (lets-code agent files, owned child
// conversations that keep the guard and work in the parent's cwd).
//
// Wire frames come from `conversation.watch()` views through ViewTranslator.
// A watcher runs while a conversation is busy (so the ring fills without any
// client) and while SSE clients are attached (ref-counted); it stops once the
// conversation is idle and no client is left.
//
// Prompts always submit with `whenBusy: "steer"`: a prompt for a busy
// conversation joins the running work at the next tool boundary (or starts the
// next run when the current one answers first) — never a second concurrent run.
// `requestId` makes retries idempotent: Durable dedupes submissions per
// conversation, and the SessionMap remembers which session a new-session
// requestId created, so a retried "new agent" prompt finds the same session.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createRegistry, LiveDoc } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { claim, forget } from "../../ownership.mjs";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";
import { loadPiModels, thinkingLevelFor } from "./models.mjs";
import { openDurable } from "./harness.mjs";
import { SessionMap } from "./sessions.mjs";
import { ViewTranslator } from "./wire.mjs";
import { createGuardExtension, shellEnv as guardShellEnv } from "./guard.mjs";
import { loadAgentFiles } from "./agent-files.mjs";
import { allowedAgentsFrom, createSubagentExtension } from "./subagent.mjs";

const NAME = "durable";
const WIRE_PROVIDER = "claude";
const VERSION = "pi-durable 1.5.0";
export const DEFAULT_MAX_TURNS = 60;
/** Hard ceiling; the router enforces the product limit (60). */
export const MAX_TURNS_CEILING = 500;
const LIST_BATCH = 8; // listAgents lookups in flight at once
const PRUNE_EVERY_MS = 6 * 3600 * 1000;
const REATTACH = { baseMs: 1000, maxMs: 30_000, maxTries: 8 };
/** Where agents may work when no roots are configured: never "anywhere". */
export const DEFAULT_AGENT_ROOT = "~/sandbox/agents";
const HISTORY_WINDOW = 200; // entries a history read / seed looks at
const RESUME_WINDOW_S = 7 * 86400; // rows seen longer ago are not re-attached on open
const MAX_CHILD_EDGES = 2000; // in-memory child → parent edges kept (oldest dropped first)

export const AGENT_INSTRUCTIONS =
  "You are an autonomous coding agent started from smart glasses. Work in the given directory only. " +
  "Finish with a two-sentence summary of what you did and what is left. " +
  "If you need a decision from the user, ask one concise question and stop.";

const httpError = (statusCode, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { statusCode });
const notFound = () => httpError(404, "Session not found");

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
};
const roleOf = (kind) => (kind === "pi.user" ? "user" : kind === "pi.assistant" ? "assistant" : null);

/** `{role, text}` items of the user and assistant entries, oldest first (empty answers skipped). */
function historyItems(entries) {
  const out = [];
  for (const e of entries) {
    const role = roleOf(e.kind);
    if (!role) continue;
    const text = textOf(e.model?.[0]?.content).trim();
    if (text) out.push({ role, text });
  }
  return out;
}

/** The last non-empty line of the newest assistant answer in `entries`. */
function lastLineOf(entries) {
  const answer = historyItems(entries ?? []).filter((h) => h.role === "assistant").at(-1);
  return answer ? (answer.text.split("\n").filter((l) => l.trim()).at(-1) ?? "") : "";
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const expandWith = (p, home) => (p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p);

/** realpath of the deepest existing ancestor of `abs`, with the missing tail appended. */
function realish(abs) {
  let base = abs;
  const tail = [];
  while (!existsSync(base)) {
    const up = dirname(base);
    if (up === base) break;
    tail.unshift(basename(base));
    base = up;
  }
  return join(existsSync(base) ? realpathSync(base) : base, ...tail);
}

/**
 * Where a new conversation may work. The cwd must lie strictly below one of
 * the roots (a bare root is refused); no roots configured = `[~/sandbox/agents]`.
 * `~` and `/` are always refused. Symlinks are resolved on the deepest existing
 * ancestor and checked BEFORE anything is created; a missing cwd below a root
 * is then created (e.g. `~/sandbox/agents/<label>`).
 * @returns {string} the real path
 */
export function resolveAgentCwd(want, { allowedCwds = [], home = homedir() } = {}) {
  if (!want) throw httpError(400, "No working directory given for the new agent");
  const configured = allowedCwds.filter(Boolean);
  const roots = (configured.length ? configured : [DEFAULT_AGENT_ROOT]).map((r) => realish(resolve(expandWith(r, home))));
  const realHome = realish(resolve(home));
  const under = (p) => roots.some((r) => p.startsWith(r + sep));
  const check = (real) => {
    if (real === realHome || real === "/") throw httpError(400, `Refusing to run an agent in ${real}`);
    if (!under(real)) throw httpError(400, `Working directory ${real} is not under an allowed root (${roots.join(", ")})`);
  };
  const target = realish(resolve(expandWith(String(want), home)));
  check(target);
  if (!isDir(target)) {
    if (existsSync(target)) throw httpError(400, `Working directory ${target} is not a directory`);
    mkdirSync(target, { recursive: true });
  }
  const real = realpathSync(target);
  check(real); // a race may have swapped a component for a symlink
  return real;
}

function parseMaxTurns(v) {
  if (v == null || v === "") return DEFAULT_MAX_TURNS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TURNS_CEILING) throw httpError(400, `maxTurns must be an integer from 1 to ${MAX_TURNS_CEILING}`);
  return n;
}

/**
 * @param {(sessionId: string, frame: object) => void} emitRaw ring + hub feed (server.mjs `emit`).
 * @param {object} o
 * @param {{ clientCount(sid: string): number }} [o.hub]
 * @param {string} [o.storePath] Durable's SQLite store; the session map lives next to it.
 * @param {string} [o.modelsPath] lets-code's models.json.
 * @param {string} [o.settingsPath] lets-code's settings.json (per-model thinking levels).
 * @param {string} [o.defaultCwd] cwd of a new conversation when the prompt gives none.
 * @param {string[]} [o.allowedCwds] roots a new conversation's cwd must lie under (default `[~/sandbox/agents]`).
 * @param {object} [o.storage] a ready Durable Storage instead of `storePath` (tests: MemoryStorage).
 * @param {object} [o.guard] extra options for createGuardExtension (tests: `{ wrapper: "none" }`).
 * @param {object} [o.settings] extra HarnessSettings.
 * @param {number} [o.historyWindow] entries history/seed reads look at.
 * @param {string} [o.agentsDir] lets-code agent files the `subagent` tool offers. Read ONCE here, at
 *   provider start: edits to agent files (and EVEN_BRIDGE_DURABLE_AGENTS) apply at the next bridge start.
 * @param {Map<string, object>} [o.agents] ready agent definitions instead of `agentsDir` (tests).
 * @param {object} [o.subagent] extra options for createSubagentExtension (e.g. `defaultTimeoutS`).
 * @param {number} [o.maxChildEdges] subagent child edges kept in memory (oldest dropped first).
 * @param {string[]|null} [o.allowedAgents] agents the subagent tool offers (default: EVEN_BRIDGE_DURABLE_AGENTS or the
 *   built-in list; null = every loaded agent).
 * @param {{baseMs?: number, maxMs?: number, maxTries?: number}} [o.reattach] backoff for re-attaching a watch that died mid-run.
 * @param {number} [o.pruneEveryMs] how often stale requestId rows are pruned (default 6 h).
 */
export function createDurableProvider(
  emitRaw,
  {
    hub,
    storePath = "~/.even-terminal/durable.sqlite",
    modelsPath = "~/.pi/agent/models.json",
    settingsPath = "~/.pi/agent/settings.json",
    defaultCwd,
    allowedCwds = [],
    log = console,
    storage,
    guard = {},
    settings,
    env = process.env,
    historyWindow = HISTORY_WINDOW,
    agentsDir = "~/.pi/agent/agents",
    agents,
    subagent = {},
    maxChildEdges = MAX_CHILD_EDGES,
    allowedAgents = allowedAgentsFrom(env),
    reattach = {},
    pruneEveryMs = PRUNE_EVERY_MS,
  } = {},
) {
  const backoff = { ...REATTACH, ...reattach };
  const map = new SessionMap(storePath);
  const { models, refs, default: defaultRef } = loadPiModels(modelsPath, env);
  // Subagent children are owned conversations the sessions table does not know:
  // child conversation id → parent conversation id, and child → agent role.
  // Filled when the subagent tool creates (or, on a rerun, reuses) a child,
  // persisted in the session map's `children` table, and rebuilt from it on
  // open BEFORE `resume()` so a resumed child's first tool call already
  // resolves. A child resolves to its parent's cwd (its own agent cwd is a copy
  // of it); an unknown conversation stays undefined, which the guard blocks.
  const childParents = new Map();
  const childRoles = new Map();
  const cwdOf = (conversationId) => {
    let id = conversationId;
    for (let hops = 0; hops < 8; hops++) {
      const row = map.byConversation(id);
      if (row) return row.cwd;
      if (!childParents.has(id)) return undefined;
      id = childParents.get(id);
    }
    return undefined;
  };
  /** Remember a child edge in memory, oldest edges dropped beyond MAX_CHILD_EDGES. */
  const noteEdge = (childId, parentId, role) => {
    childParents.delete(childId); // re-insert: newest last
    childParents.set(childId, parentId);
    if (role) childRoles.set(childId, role);
    else childRoles.delete(childId);
    while (childParents.size > maxChildEdges) {
      const oldest = childParents.keys().next().value;
      childParents.delete(oldest);
      childRoles.delete(oldest);
    }
  };
  const readonlyOf = (conversationId) => childRoles.get(conversationId) === "readonly";
  /** The session row whose conversation (directly or through children) owns `conversationId`. */
  const rootRowOf = (conversationId) => {
    let id = conversationId;
    for (let hops = 0; hops < 8; hops++) {
      const row = map.byConversation(id);
      if (row) return row;
      if (!childParents.has(id)) return undefined;
      id = childParents.get(id);
    }
    return undefined;
  };
  const guardExt = createGuardExtension({ cwdOf, readonlyOf, ...guard });
  const subagentExt = createSubagentExtension({
    agents: agents ?? loadAgentFiles(agentsDir, { log }),
    allowed: allowedAgents,
    log,
    ...subagent,
    onChild: ({ childId, parentId, role }) => {
      noteEdge(childId, parentId, role);
      const parentRow = rootRowOf(parentId);
      if (parentRow) map.noteChild(childId, parentRow.sid, role ?? null);
      else log.warn?.(`[durable] subagent child ${childId}: parent conversation ${parentId} has no session; not persisted`);
    },
  });
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(guardExt); // after CodingTools: the guard's bash (with resource caps) wins
  registry.install(subagentExt); // children keep the guard and drop this one
  const EXTENSIONS = [CodingTools, guardExt, subagentExt];

  /**
   * Rebuild the child → parent / role maps from the session map (on open, before
   * resume). Only children of live rows seen within the resume window: older
   * parents are not resumed (their busy runs are aborted), so a stray tool call
   * of such a child finds no cwd and is blocked.
   */
  function loadChildren() {
    const since = Math.floor(Date.now() / 1000) - RESUME_WINDOW_S;
    for (const c of map.children()) {
      const parent = map.get(c.parent_sid);
      if (parent?.conversation_id == null || parent.archived || parent.last_seen < since) continue;
      noteEdge(c.child_id, parent.conversation_id, c.role);
    }
  }
  // Defense in depth: the guard's `prepare` already rebuilds the bash env from
  // its allowlist; the environment itself starts from that allowlist too.
  const shellEnv = guardShellEnv({ PI_TELEMETRY: "0" }, env);
  const envFor = ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd ?? process.cwd(), shellEnv });

  /** sid → watcher { conv, watch, translator, view, pending, stopped, starting } */
  const live = new Map();
  /** sid → attached SSE clients; outside the watcher so a re-attached watcher keeps them. */
  const clientCounts = new Map();
  const clientsOf = (sid) => clientCounts.get(sid) ?? 0;
  /** sid → consecutive failed re-attach attempts. */
  const reattachTries = new Map();
  /** sid → "busy"|"idle", the last state we saw (kept after a watcher stops). */
  const states = new Map();
  /** sid → last line of the newest answer, kept when a watcher stops (listAgents). */
  const lastLines = new Map();
  /** sid → resolvers waiting for the next `status idle` frame. */
  const idleWaiters = new Map();
  /** sid → in-flight conversation creation (concurrent retries share it). */
  const creating = new Map();
  let closed = false;
  let resumed = false;

  let durable; // { harness, ctx, close }
  // `opened`: the harness is usable. `ready`: also re-attached after a restart.
  // Internal paths await `opened` (the resume step itself needs them).
  const opened = openDurable({ storePath, storage, models, registry, envFor, settings, resume: false }).then(
    (d) => (durable = d),
    (err) => {
      throw httpError(503, `durable store failed to open: ${err.message}`, err);
    },
  );
  const ready = (async () => {
    try {
      await opened;
      // After a restart, before anything runs (openDurable did not resume):
      // 1. the guard's child maps, so a resumed child's tool call resolves;
      // 2. every live row's state from its stored `pi.live`, so getStatus never
      //    says idle for a run the harness is about to continue.
      loadChildren();
      const since = Math.floor(Date.now() / 1000) - RESUME_WINDOW_S;
      const recentBusy = [];
      const staleBusy = [];
      for (const row of map.rows()) {
        if (row.conversation_id == null) continue;
        try {
          const lv = await durable.harness.snapshot(LiveDoc, row.conversation_id, durable.ctx);
          if (lv?.run) {
            states.set(row.sid, "busy");
            (row.last_seen >= since ? recentBusy : staleBusy).push(row);
          } else states.set(row.sid, "idle");
        } catch (err) {
          log.warn?.(`[durable] resume check for ${row.sid} failed: ${err.message}`);
        }
      }
      // 3. resume; re-attach a watcher to each recent busy run so its frames
      //    reach the ring again, and abort runs nobody has looked at in 7 days.
      durable.harness.resume();
      for (const row of recentBusy) await ensureWatcher(row.sid).catch(() => {});
      await Promise.all(
        staleBusy.map(async (row) => {
          try {
            const conv = await durable.harness.conversation(row.conversation_id, durable.ctx);
            log.warn?.(`[durable] aborting ${row.sid}: unfinished run last seen over 7 days ago`);
            await conv?.abort(durable.ctx);
            states.set(row.sid, "idle");
          } catch (err) {
            log.warn?.(`[durable] aborting stale ${row.sid} failed: ${err.message}`);
          }
        }),
      );
      return durable;
    } finally {
      resumed = true;
    }
  })();
  ready.catch((err) => log.error?.(`[durable] ${err.message}`));

  const ctx = () => durable.ctx;

  // requestId rows only matter for retries; keep the table small in a long-lived bridge.
  const pruneTimer = setInterval(() => {
    try {
      const n = map.pruneRequests();
      if (n) log.log?.(`[durable] pruned ${n} stale request id(s)`);
    } catch (err) {
      log.warn?.(`[durable] request prune failed: ${err.message}`);
    }
  }, pruneEveryMs);
  pruneTimer.unref?.();

  async function conversationOf(sid) {
    const row = map.get(sid);
    if (!row || row.archived || row.conversation_id == null) return { row, conv: undefined };
    await opened;
    const conv = await durable.harness.conversation(row.conversation_id, ctx());
    return { row, conv };
  }

  function onFrame(sid, frame) {
    if (frame.type === "status" && (frame.state === "busy" || frame.state === "idle")) {
      states.set(sid, frame.state);
      if (frame.state === "idle") {
        for (const r of idleWaiters.get(sid) ?? []) r();
        idleWaiters.delete(sid);
        queueMicrotask(() => maybeStop(sid));
      }
    }
    try {
      emitRaw(sid, frame);
    } catch (err) {
      log.warn?.(`[durable] emit for ${sid} failed: ${err.message}`);
    }
  }

  /**
   * Start (or reuse) the watcher of `sid`; resolves once it has its first view.
   * `carry`: the translator of a watch that died mid-run. Reusing it means the
   * new watch's first view is diffed against what was already emitted: the
   * in-flight run's prompt and busy are not reported again, and whatever was
   * committed in between is.
   */
  function ensureWatcher(sid, carry) {
    const have = live.get(sid);
    if (have) return have.starting;
    const w = { conv: undefined, watch: undefined, translator: undefined, view: undefined, pending: 0, stopped: false };
    live.set(sid, w);
    w.starting = (async () => {
      const { conv } = await conversationOf(sid);
      if (!conv) throw notFound();
      w.conv = conv;
      const watch = await conv.watch(ctx(), { min: 20, max: 200 });
      if (w.stopped) {
        await watch.stop();
        return w;
      }
      w.watch = watch;
      // prime (default): the first view is history already in the ring; an
      // in-flight run is still reported (its prompt, busy, streamed partial).
      w.translator = carry ?? new ViewTranslator(sid, (f) => onFrame(sid, f), { log });
      w.view = watch.value;
      w.translator.apply(watch.value);
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        w.view = call.value;
        try {
          w.translator.apply(call.value, call.ops);
        } catch (err) {
          log.warn?.(`[durable] ${sid}: view translation failed: ${err.message}`);
        }
      });
      watch.closed.then((end) => {
        if (live.get(sid) !== w) return;
        live.delete(sid);
        lastLines.set(sid, lastLineOf(w.view?.entries));
        // The watch died on its own (not stopped by us) while a run is going:
        // attach a fresh one so the run keeps reaching the ring.
        if (!w.stopped && !closed && states.get(sid) === "busy") {
          log.warn?.(`[durable] watch ${sid} ended (${end?.kind}) while busy; re-attaching`);
          scheduleReattach(sid, w.translator);
        }
      });
      reattachTries.delete(sid);
      // A client may have left while we attached. A macrotask, so a prompt
      // awaiting this watcher registers its submit first.
      setTimeout(() => maybeStop(sid), 0).unref?.();
      return w;
    })();
    w.starting.catch((err) => {
      if (live.get(sid) === w) live.delete(sid);
      // The state stays as it was: a busy run is still running without a watcher.
      log.warn?.(`[durable] watch ${sid} failed: ${err.message}`);
      if (carry && !closed && states.get(sid) === "busy") scheduleReattach(sid, carry);
    });
    return w.starting;
  }

  /** Re-attach a dead watch with exponential backoff (baseMs, 2×, 4× … maxMs), giving up after maxTries. */
  function scheduleReattach(sid, translator) {
    const tries = reattachTries.get(sid) ?? 0;
    if (tries >= backoff.maxTries) {
      reattachTries.delete(sid);
      log.error?.(`[durable] watch ${sid}: giving up re-attaching after ${tries} failed attempts; its frames stop reaching the ring`);
      return;
    }
    reattachTries.set(sid, tries + 1);
    const delay = Math.min(backoff.baseMs * 2 ** tries, backoff.maxMs);
    setTimeout(() => {
      if (closed || live.has(sid) || states.get(sid) !== "busy") return;
      ensureWatcher(sid, translator).catch(() => {});
    }, delay).unref?.();
  }

  function stopWatcher(sid) {
    const w = live.get(sid);
    if (!w) return;
    live.delete(sid);
    w.stopped = true;
    lastLines.set(sid, lastLineOf(w.view?.entries));
    w.translator?.finish();
    w.watch?.stop().catch(() => {});
  }

  /**
   * Stop the watcher once nothing needs it: no client, no submit in flight,
   * not busy (a submit marks busy until the translator reports the run idle),
   * no run or queued input in the last view.
   */
  function maybeStop(sid) {
    const w = live.get(sid);
    if (!w || !w.watch || clientsOf(sid) > 0 || w.pending > 0 || hub?.clientCount?.(sid) > 0) return;
    if (states.get(sid) === "busy") return;
    const v = w.view;
    if (v?.docs?.["pi.live"]?.run || v?.docs?.["pi.inbox"]?.items?.length || w.translator?.busy) return;
    stopWatcher(sid);
  }

  /** Resolve at the next `status idle` of `sid`, or after `ms` (the waiter is then removed). */
  function untilIdle(sid, ms) {
    if (states.get(sid) !== "busy") return Promise.resolve();
    return new Promise((resolve) => {
      const list = idleWaiters.get(sid) ?? [];
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        const rest = (idleWaiters.get(sid) ?? []).filter((r) => r !== done);
        if (rest.length) idleWaiters.set(sid, rest);
        else idleWaiters.delete(sid);
        resolve();
      }, ms);
      t.unref?.();
      list.push(done);
      idleWaiters.set(sid, list);
    });
  }

  function resolveModel(name) {
    if (!name) return defaultRef;
    const ref = refs.get(name) ?? refs.get(String(name).toLowerCase());
    if (ref) return ref;
    const slash = String(name).indexOf("/");
    if (slash > 0) {
      const provider = name.slice(0, slash);
      const modelId = name.slice(slash + 1);
      if (models.getModel(provider, modelId)) return { provider, modelId };
    }
    throw httpError(400, `Unknown model ${JSON.stringify(name)}`);
  }

  const modelLabel = (row) => (row?.model_provider ? `${row.model_provider}/${row.model_id}` : null);

  function createSession(phoneCwd, opts) {
    const origin = opts.origin ?? "phone";
    if (origin !== "evenai" && origin !== "phone") throw httpError(400, `Invalid origin ${JSON.stringify(origin)}`);
    const ref = resolveModel(opts.model);
    const maxTurns = parseMaxTurns(opts.maxTurns);
    const cwd = resolveAgentCwd(phoneCwd ?? defaultCwd, { allowedCwds });
    const sid = map.create({ name: opts.name, cwd, modelRef: ref, origin, maxTurns });
    if (opts.requestId) map.noteRequest(opts.requestId, sid);
    return sid;
  }

  /** Create the Durable conversation of a row that has none yet (fresh, or a crash between the two steps). */
  function ensureConversation(sid) {
    if (map.get(sid).conversation_id != null) return Promise.resolve();
    let p = creating.get(sid);
    if (!p) {
      p = createConversationFor(sid).finally(() => creating.delete(sid));
      creating.set(sid, p);
    }
    return p;
  }

  async function createConversationFor(sid) {
    const row = map.get(sid);
    await opened;
    const ref = { provider: row.model_provider, modelId: row.model_id };
    // From the row, validated when it was created: a repair after a crash uses the same budget.
    const maxTurns = parseMaxTurns(row.max_turns);
    const conv = await durable.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: ref,
          thinkingLevel: thinkingLevelFor(ref, settingsPath),
          cwd: row.cwd,
          maxTurns,
          instructions: AGENT_INSTRUCTIONS,
          extensions: EXTENSIONS,
        },
      },
      ctx(),
    );
    map.setConversation(sid, conv.id);
  }

  async function stateOf(sid, conversationId) {
    if (live.has(sid)) return states.get(sid) ?? "idle";
    const lv = await durable.harness.snapshot(LiveDoc, conversationId, ctx());
    const state = lv?.run ? "busy" : "idle";
    if (!live.has(sid)) states.set(sid, state);
    return state;
  }

  const provider = {
    name: NAME,
    wireProvider: WIRE_PROVIDER,
    ready,

    /** Sync ownership probe: a "dur-" id the session map knows. */
    probe(sessionId) {
      if (typeof sessionId !== "string" || !sessionId.startsWith("dur-")) return false;
      const row = map.get(sessionId);
      if (!row || row.archived) return false;
      claim(sessionId, NAME);
      return true;
    },

    listSessions(limit = 10, cwd) {
      return map
        .list({ limit, cwd })
        .filter((r) => r.conversation_id != null)
        .map((r) => ({ id: r.sid, title: r.name, timestamp: r.last_seen * 1000, cwd: r.cwd, provider: WIRE_PROVIDER, status: null }));
    },

    async getSessionStatus(sessionId) {
      try {
        const { conv } = await conversationOf(sessionId);
        if (!conv) return "idle";
        return await stateOf(sessionId, conv.id);
      } catch {
        return "idle";
      }
    },

    async getInfo() {
      return {
        account: { loggedIn: true, email: "durable", scope: "local" },
        model: defaultRef.modelId,
        version: VERSION,
        provider: WIRE_PROVIDER,
      };
    },

    async getHistory(sessionId, limit = 10) {
      const { conv } = await conversationOf(sessionId);
      if (!conv) return [];
      claim(sessionId, NAME);
      const page = await conv.entries({}, historyWindow, undefined, ctx());
      const entries = [...page.items].reverse(); // newest first → oldest first
      return historyItems(entries).slice(-limit);
    },

    /**
     * Seed the ring with the finished part of the transcript when it is empty
     * (after a restart, or a session never loaded in this process). Each run
     * is replayed as its own complete turn (one user_prompt per run). Entries
     * before the window's first `pi.user` (the tail of a run whose prompt fell
     * outside the window) and a run still in flight are left out.
     */
    async seedTranscript(sessionId) {
      if (!sessionId || live.has(sessionId)) return;
      if (getMessages(sessionId, 0).length > 0) return;
      const { conv } = await conversationOf(sessionId).catch(() => ({}));
      if (!conv) return;
      const page = await conv.entries({}, historyWindow, undefined, ctx());
      let entries = [...page.items].reverse();
      const lv = await durable.harness.snapshot(LiveDoc, conv.id, ctx());
      if (lv?.run?.first !== undefined) entries = entries.filter((e) => e.id < lv.run.first);
      const firstUser = entries.findIndex((e) => e.kind === "pi.user");
      entries = firstUser < 0 ? [] : entries.slice(firstUser);
      if (getMessages(sessionId, 0).length > 0 || live.has(sessionId)) return; // raced with a live feed
      const tr = new ViewTranslator(sessionId, (f) => emitRaw(sessionId, f), { prime: false, log });
      const starts = entries.map((e, i) => (e.kind === "pi.user" ? i : -1)).filter((i) => i >= 0);
      for (let n = 0; n < starts.length; n++) {
        const end = starts[n + 1] ?? entries.length;
        tr.apply({ conversation: { id: conv.id }, entries: entries.slice(0, end), docs: {} });
      }
      claim(sessionId, NAME);
    },

    watchTranscript(sessionId) {
      if (!map.get(sessionId)) return;
      clientCounts.set(sessionId, clientsOf(sessionId) + 1);
      ensureWatcher(sessionId).catch(() => {});
    },

    unwatchTranscript(sessionId) {
      const n = clientsOf(sessionId) - 1;
      if (n > 0) clientCounts.set(sessionId, n);
      else clientCounts.delete(sessionId);
      maybeStop(sessionId);
    },

    /**
     * Submit a prompt. New session (no sessionId): create the row and the
     * conversation, attach the watcher, then submit. Existing session: submit
     * with `whenBusy: "steer"`. A `requestId` seen before returns the same
     * session and the same submission.
     */
    async prompt(sessionId, text, cwd, opts = {}) {
      if (closed) throw httpError(503, "durable provider is shut down");
      await ready;
      let sid = sessionId;
      if (!sid && opts.requestId) sid = map.sidForRequest(opts.requestId);
      if (sid) {
        const row = map.get(sid);
        if (!row || row.archived) throw notFound();
      } else {
        sid = createSession(cwd, opts);
      }
      await ensureConversation(sid);
      claim(sid, NAME);
      // Watch before submitting: the first view is the history, so the new
      // input arrives as a change and is reported exactly once.
      const w = await ensureWatcher(sid);
      w.pending += 1; // keeps the watcher until the run this starts is visible
      let submission;
      try {
        submission = await w.conv.submit(
          { type: "input", content: text, requestId: opts.requestId ?? randomUUID(), whenBusy: "steer" },
          ctx(),
        );
        const rec = await submission.status(ctx());
        // Busy at once (the phone polls /status right after the 202), unless this was a
        // retry of a request that has already settled.
        if (rec.status === "queued" || rec.status === "placed") states.set(sid, "busy");
      } finally {
        w.pending -= 1;
      }
      maybeStop(sid); // a deduped retry of a settled request starts nothing
      map.touch(sid);
      return { sessionId: sid, provider: WIRE_PROVIDER, submissionId: submission.id };
    },

    respondPermission() {
      return false; // Durable has no permission dialogs
    },

    /** A question ends the run (the agent stops); the answer is the next input. */
    respondQuestion(sessionId, answer) {
      return provider.prompt(sessionId, answer);
    },

    interrupt(sessionId) {
      const row = map.get(sessionId);
      if (!row || row.archived || row.conversation_id == null) throw notFound();
      conversationOf(sessionId)
        .then(({ conv }) => conv?.abort(ctx()))
        .catch((err) => log.warn?.(`[durable] interrupt ${sessionId} failed: ${err.message}`));
    },

    /**
     * Sync. Unknown or archived → null. Before the restart re-attachment has
     * finished, a row whose state is not known yet reports `busy` (it may be
     * a run being resumed); the phone polls again.
     */
    getStatus(sessionId) {
      const row = map.get(sessionId);
      if (!row || row.archived) return null;
      const state = states.get(sessionId) ?? (resumed ? "idle" : "busy");
      return { state, provider: WIRE_PROVIDER };
    },

    /**
     * Unlike pi's (which only drops a dead subprocess), this ARCHIVES the
     * session: it leaves every list and its id stops resolving. A busy
     * conversation is aborted first (fire and forget).
     */
    forgetSession(sessionId) {
      const row = map.get(sessionId);
      if (states.get(sessionId) === "busy" && row?.conversation_id != null && durable) {
        durable.harness
          .conversation(row.conversation_id, ctx())
          .then((conv) => conv?.abort(ctx()))
          .catch((err) => log.warn?.(`[durable] abort on forget ${sessionId} failed: ${err.message}`));
      }
      stopWatcher(sessionId);
      map.archive(sessionId);
      states.delete(sessionId);
      lastLines.delete(sessionId);
      forget(sessionId);
    },

    /** Abort and archive (the shim's reaper / stop endpoint). */
    async stopSession(sessionId) {
      const { row, conv } = await conversationOf(sessionId);
      if (!row || row.archived) throw notFound();
      if (conv) {
        await conv.abort(ctx());
        await untilIdle(sessionId, 2000); // let the watcher deliver the aborted run's result
      }
      states.set(sessionId, "idle"); // aborted: nothing left to abort on forget
      provider.forgetSession(sessionId);
    },

    /**
     * Live (non-archived) agents seen in the last 7 days (`{all:true}`: every one),
     * newest first; status and last-line lookups run in batches of 8.
     */
    async listAgents({ all = false } = {}) {
      await opened;
      const seenSince = all ? 0 : Math.floor(Date.now() / 1000) - RESUME_WINDOW_S;
      const rows = [...map.rows({ seenSince })].filter((r) => r.conversation_id != null).reverse(); // newest first
      const out = [];
      for (let i = 0; i < rows.length; i += LIST_BATCH) {
        out.push(...(await Promise.all(rows.slice(i, i + LIST_BATCH).map(agentRow))));
      }
      return out;

      async function agentRow(r) {
        let state = states.get(r.sid) ?? "idle";
        let lastLine = "";
        try {
          state = await stateOf(r.sid, r.conversation_id);
          const w = live.get(r.sid);
          if (w?.view) lastLine = lastLineOf(w.view.entries);
          else if (lastLines.has(r.sid)) lastLine = lastLines.get(r.sid);
          else {
            const conv = await durable.harness.conversation(r.conversation_id, ctx());
            const page = conv ? await conv.entries({}, 20, undefined, ctx()) : { items: [] };
            lastLine = lastLineOf([...page.items].reverse());
            lastLines.set(r.sid, lastLine);
          }
        } catch (err) {
          log.warn?.(`[durable] listAgents ${r.sid}: ${err.message}`);
        }
        return {
          sid: r.sid,
          name: r.name,
          cwd: r.cwd,
          model: modelLabel(r),
          state,
          origin: r.origin,
          createdAt: r.created_at * 1000,
          lastSeen: r.last_seen * 1000,
          lastLine,
        };
      }
    },

    /**
     * Bridge shutdown. By default runs are NOT aborted: closing leaves them
     * pending in the store and the next start resumes them (restart safety).
     * `{ abort: true }` aborts every busy conversation first.
     */
    async stopAll({ abort = false } = {}) {
      if (closed) return;
      closed = true;
      clearInterval(pruneTimer);
      try {
        await ready;
      } catch {
        map.close();
        return;
      }
      if (abort) {
        const busy = [...states].filter(([, s]) => s === "busy").map(([sid]) => sid);
        await Promise.all(
          busy.map(async (sid) => {
            const { conv } = await conversationOf(sid).catch(() => ({}));
            await conv?.abort(durable.ctx).catch(() => {});
          }),
        );
      }
      for (const sid of [...live.keys()]) stopWatcher(sid);
      await durable.close();
      map.close();
    },

    _map: map,
    get _harness() {
      return durable?.harness;
    },
    _live: live,
    _childParents: childParents,
    _childRoles: childRoles,
    _noteEdge: noteEdge,
    _childRoles: childRoles,
    _clientCounts: clientCounts,
    _lastLines: lastLines,
    _idleWaiters: idleWaiters,
    _untilIdle: untilIdle,
  };

  return provider;
}
