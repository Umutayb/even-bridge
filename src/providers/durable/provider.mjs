// The `durable` provider: Pi Durable conversations behind the same contract as
// the pi provider (src/providers/pi/provider.mjs), so the router, the hub, SSE
// and the phone's Terminal feature treat them like any other extended session.
//
// One process owns one Harness (SQLite store, `~/.even-terminal/durable.sqlite`)
// and a SessionMap (its own SQLite file) that maps the bridge's "dur-<uuid>"
// session ids to Durable conversation ids. Every conversation runs CodingTools
// behind the guard extension (path confinement, command vetting, resource caps).
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
import { resolve, sep } from "node:path";
import { createRegistry, LiveDoc } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { claim, forget } from "../../ownership.mjs";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";
import { expandHome, loadPiModels, thinkingLevelFor } from "./models.mjs";
import { openDurable } from "./harness.mjs";
import { SessionMap } from "./sessions.mjs";
import { ViewTranslator } from "./wire.mjs";
import { createGuardExtension } from "./guard.mjs";

const NAME = "durable";
const WIRE_PROVIDER = "claude";
const VERSION = "pi-durable 1.5.0";
export const DEFAULT_MAX_TURNS = 60;
const HISTORY_WINDOW = 200; // entries a history read / seed looks at

export const AGENT_INSTRUCTIONS =
  "You are an autonomous coding agent started from smart glasses. Work in the given directory only. " +
  "Finish with a two-sentence summary of what you did and what is left. " +
  "If you need a decision from the user, ask one concise question and stop.";

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
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

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where a new conversation may work. `allowedCwds` are roots: the cwd must lie
 * strictly below one of them (a bare root is refused); empty = any existing
 * directory. The home directory itself is always refused. A missing cwd below
 * an allowed root is created (e.g. `~/sandbox/agents/<label>`).
 * @returns {string} the real path
 */
export function resolveAgentCwd(want, { allowedCwds = [], home = homedir() } = {}) {
  if (!want) throw httpError(400, "No working directory given for the new agent");
  const abs = resolve(expandHome(String(want)));
  const realHome = existsSync(home) ? realpathSync(home) : home;
  const roots = allowedCwds.filter(Boolean).map((r) => {
    const a = resolve(expandHome(r));
    return existsSync(a) ? realpathSync(a) : a;
  });
  const under = (p) => roots.some((r) => p.startsWith(r + sep));
  if (!isDir(abs)) {
    if (roots.length && under(abs) && abs !== home) mkdirSync(abs, { recursive: true });
    else throw httpError(400, `Working directory ${abs} does not exist`);
  }
  const real = realpathSync(abs);
  if (real === realHome || real === "/") throw httpError(400, `Refusing to run an agent in ${real}`);
  if (roots.length && !under(real)) throw httpError(400, `Working directory ${real} is not under an allowed root (${roots.join(", ")})`);
  return real;
}

/**
 * @param {(sessionId: string, frame: object) => void} emitRaw ring + hub feed (server.mjs `emit`).
 * @param {object} o
 * @param {{ clientCount(sid: string): number }} [o.hub]
 * @param {string} [o.storePath] Durable's SQLite store; the session map lives next to it.
 * @param {string} [o.modelsPath] lets-code's models.json.
 * @param {string} [o.settingsPath] lets-code's settings.json (per-model thinking levels).
 * @param {string} [o.defaultCwd] cwd of a new conversation when the prompt gives none.
 * @param {string[]} [o.allowedCwds] roots a new conversation's cwd must lie under (empty = anywhere but ~).
 * @param {object} [o.storage] a ready Durable Storage instead of `storePath` (tests: MemoryStorage).
 * @param {object} [o.guard] extra options for createGuardExtension (tests: `{ wrapper: "none" }`).
 * @param {object} [o.settings] extra HarnessSettings.
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
  } = {},
) {
  const map = new SessionMap(storePath);
  const { models, refs, default: defaultRef } = loadPiModels(modelsPath, env);
  const guardExt = createGuardExtension({
    cwdOf: (conversationId) => map.byConversation(conversationId)?.cwd,
    ...guard,
  });
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(guardExt); // after CodingTools: the guard's bash (with resource caps) wins
  const EXTENSIONS = [CodingTools, guardExt];
  const shellEnv = { ...env, PI_TELEMETRY: "0" };
  const envFor = ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd ?? process.cwd(), shellEnv });

  /** sid → watcher { conv, watch, translator, clients, pending, stopped, starting } */
  const live = new Map();
  /** sid → "busy"|"idle", the last state we saw (kept after a watcher stops). */
  const states = new Map();
  /** sid → last committed view (kept after a watcher stops; listAgents' last line). */
  const lastViews = new Map();
  let closed = false;

  let durable; // { harness, ctx, close }
  // `opened`: the harness is usable. `ready`: also re-attached after a restart.
  // Internal paths await `opened` (the resume step itself needs them).
  const opened = openDurable({ storePath, storage, models, registry, envFor, settings }).then((d) => (durable = d));
  const ready = (async () => {
    await opened;
    // Resume after a restart: Durable continues unfinished runs (openDurable
    // calls resume()); re-attach a watcher to each busy one so its frames
    // reach the ring again.
    for (const row of map.list({ limit: 1000 })) {
      if (row.conversation_id == null) continue;
      try {
        const lv = await durable.harness.snapshot(LiveDoc, row.conversation_id, durable.ctx);
        if (lv?.run) {
          states.set(row.sid, "busy");
          await ensureWatcher(row.sid);
        }
      } catch (err) {
        log.warn?.(`[durable] resume check for ${row.sid} failed: ${err.message}`);
      }
    }
    return durable;
  })();
  ready.catch((err) => log.error?.(`[durable] harness failed to open: ${err.message}`));

  const ctx = () => durable.ctx;

  async function conversationOf(sid) {
    const row = map.get(sid);
    if (!row || row.archived || row.conversation_id == null) return { row, conv: undefined };
    await opened;
    const conv = await durable.harness.conversation(row.conversation_id, ctx());
    return { row, conv };
  }

  /** sid → resolvers waiting for the next `status idle` frame. */
  const idleWaiters = new Map();

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

  /** Start (or reuse) the watcher of `sid`; resolves once it has its first view. */
  function ensureWatcher(sid) {
    const have = live.get(sid);
    if (have) return have.starting;
    const w = { conv: undefined, watch: undefined, translator: undefined, clients: 0, pending: 0, stopped: false };
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
      w.translator = new ViewTranslator(sid, (f) => onFrame(sid, f), { log });
      w.translator.apply(watch.value);
      lastViews.set(sid, watch.value);
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        lastViews.set(sid, call.value);
        try {
          w.translator.apply(call.value, call.ops);
        } catch (err) {
          log.warn?.(`[durable] ${sid}: view translation failed: ${err.message}`);
        }
      });
      watch.closed.then(() => {
        if (live.get(sid) === w) live.delete(sid);
      });
      // A client may have left while we attached. A macrotask, so a prompt
      // awaiting this watcher registers its submit first.
      setTimeout(() => maybeStop(sid), 0).unref?.();
      return w;
    })();
    w.starting.catch((err) => {
      if (live.get(sid) === w) live.delete(sid);
      log.warn?.(`[durable] watch ${sid} failed: ${err.message}`);
    });
    return w.starting;
  }

  function stopWatcher(sid) {
    const w = live.get(sid);
    if (!w) return;
    live.delete(sid);
    w.stopped = true;
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
    if (!w || !w.watch || w.clients > 0 || w.pending > 0 || hub?.clientCount?.(sid) > 0) return;
    if (states.get(sid) === "busy") return;
    const v = lastViews.get(sid);
    if (v?.docs?.["pi.live"]?.run || v?.docs?.["pi.inbox"]?.items?.length || w.translator?.busy) return;
    stopWatcher(sid);
  }

  /** Resolve at the next `status idle` of `sid`, or after `ms`. */
  function untilIdle(sid, ms) {
    if (states.get(sid) !== "busy") return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      const list = idleWaiters.get(sid) ?? [];
      list.push(() => {
        clearTimeout(t);
        resolve();
      });
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

  async function createSession(text, phoneCwd, opts) {
    const origin = opts.origin ?? "phone";
    if (origin !== "evenai" && origin !== "phone") throw httpError(400, `Invalid origin ${JSON.stringify(origin)}`);
    const ref = resolveModel(opts.model);
    const maxTurns = opts.maxTurns == null ? DEFAULT_MAX_TURNS : Number(opts.maxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw httpError(400, "maxTurns must be an integer of 1 or more");
    const cwd = resolveAgentCwd(phoneCwd ?? defaultCwd, { allowedCwds });
    const sid = map.create({ name: opts.name, cwd, modelRef: ref, origin });
    if (opts.requestId) map.noteRequest(opts.requestId, sid);
    return sid;
  }

  /** sid → in-flight conversation creation (concurrent retries share it). */
  const creating = new Map();

  /** Create the Durable conversation of a row that has none yet (fresh, or a crash between the two steps). */
  function ensureConversation(sid, opts) {
    if (map.get(sid).conversation_id != null) return Promise.resolve();
    let p = creating.get(sid);
    if (!p) {
      p = createConversationFor(sid, opts).finally(() => creating.delete(sid));
      creating.set(sid, p);
    }
    return p;
  }

  async function createConversationFor(sid, opts) {
    const row = map.get(sid);
    await opened;
    const ref = { provider: row.model_provider, modelId: row.model_id };
    const maxTurns = opts.maxTurns == null ? DEFAULT_MAX_TURNS : Number(opts.maxTurns);
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
      const { conv } = await conversationOf(sessionId).catch(() => ({}));
      if (!conv) return "idle";
      const lv = await durable.harness.snapshot(LiveDoc, conv.id, ctx());
      const state = lv?.run ? "busy" : "idle";
      if (!live.has(sessionId)) states.set(sessionId, state);
      return state;
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
      const page = await conv.entries({}, HISTORY_WINDOW, undefined, ctx());
      const entries = [...page.items].reverse(); // newest first → oldest first
      return historyItems(entries).slice(-limit);
    },

    /**
     * Seed the ring with the finished part of the transcript when it is empty
     * (after a restart, or a session never loaded in this process). Each run
     * is replayed as its own complete turn (one user_prompt per run). A run
     * still in flight is left to the watcher.
     */
    async seedTranscript(sessionId) {
      if (!sessionId || live.has(sessionId)) return;
      if (getMessages(sessionId, 0).length > 0) return;
      const { conv } = await conversationOf(sessionId).catch(() => ({}));
      if (!conv) return;
      const page = await conv.entries({}, HISTORY_WINDOW, undefined, ctx());
      let entries = [...page.items].reverse();
      const lv = await durable.harness.snapshot(LiveDoc, conv.id, ctx());
      if (lv?.run?.first !== undefined) entries = entries.filter((e) => e.id < lv.run.first);
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
      const p = ensureWatcher(sessionId);
      const w = live.get(sessionId);
      if (w) w.clients += 1;
      p.catch(() => {});
    },

    unwatchTranscript(sessionId) {
      const w = live.get(sessionId);
      if (!w) return;
      w.clients = Math.max(0, w.clients - 1);
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
        sid = await createSession(text, cwd, opts);
      }
      await ensureConversation(sid, opts);
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

    getStatus(sessionId) {
      const row = map.get(sessionId);
      if (!row || row.archived) return null;
      return { state: states.get(sessionId) ?? "idle", provider: WIRE_PROVIDER };
    },

    forgetSession(sessionId) {
      stopWatcher(sessionId);
      map.archive(sessionId);
      states.delete(sessionId);
      lastViews.delete(sessionId);
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
      provider.forgetSession(sessionId);
    },

    async listAgents() {
      const out = [];
      for (const r of map.list({ limit: 1000 })) {
        if (r.conversation_id == null) continue;
        let state = states.get(r.sid);
        if (!live.has(r.sid)) state = await provider.getSessionStatus(r.sid).catch(() => state ?? "idle");
        let lastLine = "";
        let entries = lastViews.get(r.sid)?.entries;
        if (!entries) {
          const { conv } = await conversationOf(r.sid).catch(() => ({}));
          entries = conv ? [...(await conv.entries({}, 20, undefined, ctx())).items].reverse() : [];
        }
        const answer = historyItems(entries).filter((h) => h.role === "assistant").at(-1);
        if (answer) lastLine = answer.text.split("\n").filter((l) => l.trim()).at(-1) ?? "";
        out.push({
          sid: r.sid,
          name: r.name,
          cwd: r.cwd,
          model: modelLabel(r),
          state: state ?? "idle",
          origin: r.origin,
          createdAt: r.created_at * 1000,
          lastSeen: r.last_seen * 1000,
          lastLine,
        });
      }
      return out;
    },

    /**
     * Bridge shutdown. By default runs are NOT aborted: closing leaves them
     * pending in the store and the next start resumes them (restart safety).
     * `{ abort: true }` aborts every busy conversation first.
     */
    async stopAll({ abort = false } = {}) {
      if (closed) return;
      closed = true;
      try {
        await ready;
      } catch {
        map.close();
        return;
      }
      if (abort) {
        for (const [sid, state] of states) {
          if (state !== "busy") continue;
          const { conv } = await conversationOf(sid).catch(() => ({}));
          await conv?.abort(durable.ctx).catch(() => {});
        }
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
  };

  return provider;
}
