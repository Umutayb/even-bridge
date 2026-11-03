// The overseer's check-ins and its nightly reset (EVEN_BRIDGE_OVERSEER_ENABLE=1 only).
//
// checkin_schedule {at | inMinutes, about} creates one background task `even.overseer-checkin`
// owned by the root conversation. It sleeps (stored, so it survives restarts) until `at`, then
// submits ONE follow-up input "check-in: <about>" to the root with requestId "checkin:<taskId>"
// (Durable dedupes a rerun). The caps live in the `even.overseer.checkins` doc and are checked in
// the commit that creates the task: at most 6 pending, at least 15 minutes apart, at most 24 a day,
// and a run started by a check-in may schedule only one more (the hop rule against loops).
// The kill switch (agents.disabled) skips a due check-in with a `system` outbox item.
//
// `even.overseer-nightly` is one background task of the root that never ends: it sleeps until the
// next 04:00 local, then resets the root's context with a handoff (its notes + the pending
// check-ins) when the root is idle (else it tries again in 10 minutes), and writes the day's usage
// to the outbox as a `system` item.
//
// Nothing here acts on a session: check-ins only wake the overseer, whose actions stay gated.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineDoc, defineTask, defineTool, LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { OverseerNotes, OverseerOutbox, pushOutbox } from "./docs.mjs";

export const CHECKIN_MAX_PENDING = 6;
export const CHECKIN_MIN_GAP_MS = 900000;
export const CHECKIN_MAX_PER_DAY = 24;
export const NIGHTLY_RESET_HOUR = 4;
export const NIGHTLY_RETRY_MS = 600000;
export const CHECKIN_TASK = "even.overseer-checkin";
export const NIGHTLY_TASK = "even.overseer-nightly";
export const CHECKIN_ABOUT_MAX = 200;
export const CHECKIN_IN_MINUTES = Object.freeze({ min: 15, max: 720 });
export const CHECKIN_PREFIX = "check-in: ";
export const CHECKIN_SKIPPED = "check-in skipped: agents are switched off";
export const CHECKIN_ERRORS = Object.freeze({
  pending: `at most ${CHECKIN_MAX_PENDING} check-ins may be pending`,
  gap: "check-ins must be at least 15 minutes apart",
  day: `at most ${CHECKIN_MAX_PER_DAY} check-ins a day`,
  hop: "a check-in run may schedule only one more check-in",
});
export const DEFAULT_DISABLE_FILE = "~/.even-terminal/agents.disabled";

const latest = { scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => true };
/**
 * `{ day: "YYYY-MM-DD", count, fromCheckin: false|true|"spent", fromSubmission, pending: [{id, at, about}], usage }`.
 * `fromSubmission` is the input the last delivered check-in submitted (its run is "a check-in run");
 * `usage` the session totals at the last nightly report (the next one reports the difference).
 */
export const OverseerCheckins = defineDoc({
  kind: "even.overseer.checkins",
  version: 1,
  ...latest,
  initial: () => ({ day: "", count: 0, fromCheckin: false, fromSubmission: null, pending: [], usage: null }),
});

const pad = (n) => String(n).padStart(2, "0");
/** Local calendar day of epoch ms `t`, "YYYY-MM-DD". */
export const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Local "HH:MM" of epoch ms `t`. */
export const hhmm = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** The next local `hour`:00 strictly after `t`. */
export function nextResetAt(t, hour = NIGHTLY_RESET_HOUR) {
  const d = new Date(t);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime();
}
const expand = (p, home = homedir()) => (p === "~" ? home : String(p).startsWith("~/") ? home + String(p).slice(1) : String(p));

/** The handoff the nightly reset starts the new context with: the notes first, then the pending check-ins. */
export function nightlyHandoff(notes, pending = []) {
  const head = String(notes ?? "").trim() || "(no notes)";
  const rows = pending.map((p) => `- ${hhmm(p.at)} ${p.about} (${p.id})`);
  return `${head}\n\nPending check-ins:\n${rows.length ? rows.join("\n") : "(none)"}`;
}

/** Totals of a `harness.usage()` value: `{ tokens, cost }`. */
export function usageTotals(state) {
  let tokens = 0;
  let cost = 0;
  for (const bucket of [state?.models, state?.tools]) {
    for (const u of Object.values(bucket ?? {})) {
      tokens += Number(u?.totalTokens ?? (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0)) || 0;
      cost += Number(u?.cost?.total ?? 0) || 0;
    }
  }
  return { tokens, cost };
}

/** The outbox line of a nightly report (host text). */
export function usageText(now, before) {
  const tokens = Math.max(0, now.tokens - (before?.tokens ?? 0));
  const cost = Math.max(0, now.cost - (before?.cost ?? 0));
  return `The day's usage of the agents and the overseer: ${tokens} tokens, $${cost.toFixed(2)}.`;
}

/**
 * What the tasks need from the running bridge, bound once the overseer is up (a task resumed
 * earlier waits for it). `now` is the Harness clock (tests: a fake one).
 */
export function createCheckinBox({ now = Date.now } = {}) {
  let deps = null;
  let bindIt;
  const bound = new Promise((r) => (bindIt = r));
  return {
    now: () => now(),
    tasks: null,
    /** `{ disabled(), resetRoot(handoff), usage(), onOutbox(item) }` */
    bind(d) {
      deps = d;
      bindIt(d);
    },
    get deps() {
      return deps;
    },
    wait(signal) {
      if (deps) return Promise.resolve(deps);
      return new Promise((res, rej) => {
        bound.then(res);
        signal?.addEventListener("abort", () => rej(signal.reason ?? new Error("aborted")), { once: true });
      });
    },
  };
}

const told = (deps, item) => {
  try {
    deps?.onOutbox?.(item);
  } catch {
    /* a listener never fails a task */
  }
};

/** The two task definitions (registered by the overseer's extension); also stored as `box.tasks`. */
export function createCheckinTasks(box) {
  const checkin = defineTask({
    name: CHECKIN_TASK,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
      deliver: async (task, runtime, context) => {
        const deps = await box.wait(runtime.signal);
        const off = Boolean(deps.disabled());
        const handle = off ? null : await runtime.conversation(runtime.conversationId, context);
        let item = null;
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(OverseerCheckins, runtime.conversationId);
          const i = (doc.pending ?? []).findIndex((p) => p.id === String(task.id)); // task ids are numbers, the doc keeps strings
          if (i < 0) return { status: "terminal", outcome: { status: "completed", result: { delivered: false, reason: "cancelled" } } };
          if (off) {
            doc.pending.splice(i, 1);
            item = { ...pushOutbox(await tx.doc(OverseerOutbox, runtime.conversationId), { kind: "system", text: CHECKIN_SKIPPED, at: box.now() }) };
            return { status: "terminal", outcome: { status: "completed", result: { delivered: false, reason: "disabled" } } };
          }
          // One follow-up input; a rerun of this phase finds the same submission by its requestId.
          const submissionId = await handle.submit(tx, {
            type: "input",
            content: CHECKIN_PREFIX + task.input.about,
            requestId: `checkin:${task.id}`,
            whenBusy: "followUp",
          });
          doc.pending.splice(i, 1);
          doc.fromCheckin = true;
          doc.fromSubmission = String(submissionId);
          return { status: "terminal", outcome: { status: "completed", result: { delivered: true, submissionId: String(submissionId) } } };
        }, context);
        if (item) told(deps, item);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(OverseerCheckins, runtime.conversationId);
        doc.pending = (doc.pending ?? []).filter((p) => p.id !== String(task.id));
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });

  const nightly = defineTask({
    name: NIGHTLY_TASK,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (_task, runtime, context) => runtime.sleepUntil(nextResetAt(box.now()), { phase: "reset" }, context),
      reset: async (_task, runtime, context) => {
        const deps = await box.wait(runtime.signal);
        const t = box.now();
        const conv = runtime.conversationId;
        const live = await runtime.snapshot(LiveDoc, conv, context);
        if (live?.run) {
          await runtime.sleepUntil(t + NIGHTLY_RETRY_MS, { phase: "reset" }, context); // busy: again in 10 minutes
          return;
        }
        const notes = (await runtime.snapshot(OverseerNotes, conv, context))?.text ?? "";
        const pending = (await runtime.snapshot(OverseerCheckins, conv, context))?.pending ?? [];
        await deps.resetRoot(nightlyHandoff(notes, pending));
        let totals = null;
        try {
          totals = usageTotals(await deps.usage());
        } catch {
          /* no usage line tonight */
        }
        let item = null;
        await runtime.commit(async (tx) => {
          if (totals) {
            const doc = await tx.doc(OverseerCheckins, conv);
            const text = usageText(totals, doc.usage);
            doc.usage = totals;
            item = { ...pushOutbox(await tx.doc(OverseerOutbox, conv), { kind: "system", text, at: t }) };
          }
          return { status: "sleeping", until: nextResetAt(t), checkpoint: { phase: "reset" } };
        }, context);
        if (item) told(deps, item);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  box.tasks = { checkin, nightly };
  return box.tasks;
}

const text = (t) => [{ type: "text", text: t }];
const ok = (t) => ({ output: text(t) });
const fail = (t) => ({ isError: true, output: text(t) });

/** `at` (ISO-8601) or `inMinutes` → epoch ms, or an error text. */
function dueAt(args, t) {
  const lo = t + CHECKIN_IN_MINUTES.min * 60000;
  const hi = t + CHECKIN_IN_MINUTES.max * 60000;
  if (args.inMinutes != null) {
    const m = args.inMinutes;
    if (!Number.isInteger(m) || m < CHECKIN_IN_MINUTES.min || m > CHECKIN_IN_MINUTES.max) {
      return { error: `'inMinutes' must be an integer from ${CHECKIN_IN_MINUTES.min} to ${CHECKIN_IN_MINUTES.max}` };
    }
    return { at: t + m * 60000 };
  }
  if (typeof args.at !== "string" || !args.at.trim()) return { error: "give 'at' (ISO-8601) or 'inMinutes'" };
  const at = Date.parse(args.at);
  if (!Number.isFinite(at)) return { error: "'at' must be an ISO-8601 time" };
  if (at < lo || at > hi) return { error: `'at' must be ${CHECKIN_IN_MINUTES.min} minutes to 12 hours from now` };
  return { at };
}

/** checkin_schedule and checkin_cancel (free for the overseer, capped by the host). */
export function createCheckinTools(box) {
  const schedule = defineTool({
    name: "checkin_schedule",
    description:
      "Schedule a check-in: at that time you get the follow-up message \"check-in: <about>\" and can look at the " +
      `sessions again. At most ${CHECKIN_MAX_PENDING} pending, at least 15 minutes apart, at most ${CHECKIN_MAX_PER_DAY} a day.`,
    parameters: {
      type: "object",
      properties: {
        at: { type: "string", description: "ISO-8601 time, 15 minutes to 12 hours from now" },
        inMinutes: { type: "integer", minimum: CHECKIN_IN_MINUTES.min, maximum: CHECKIN_IN_MINUTES.max },
        about: { type: "string", maxLength: CHECKIN_ABOUT_MAX, description: "what to look at then (short)" },
      },
      required: ["about"],
      additionalProperties: false,
    },
    // Not replay-safe: a rerun would schedule a second check-in.
    async execute(args, api, context) {
      const tasks = box.tasks;
      if (!tasks) return fail("check-ins are not available");
      const about = String(args.about ?? "").replace(/\s+/g, " ").trim();
      if (!about) return fail("'about' is required");
      if (about.length > CHECKIN_ABOUT_MAX) return fail(`'about' is limited to ${CHECKIN_ABOUT_MAX} characters`);
      const t = box.now();
      const due = dueAt(args, t);
      if (due.error) return fail(due.error);
      const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
      const inputs = (run?.inputs ?? []).map(String);
      const r = await api.commit(async (tx) => {
        const doc = await tx.doc(OverseerCheckins, api.conversationId);
        doc.pending ??= [];
        const day = dayOf(t);
        if (doc.day !== day) {
          doc.day = day;
          doc.count = 0;
        }
        if (doc.pending.length >= CHECKIN_MAX_PENDING) return { error: CHECKIN_ERRORS.pending };
        if (doc.pending.some((p) => Math.abs(p.at - due.at) < CHECKIN_MIN_GAP_MS)) return { error: CHECKIN_ERRORS.gap };
        if (doc.count >= CHECKIN_MAX_PER_DAY) return { error: CHECKIN_ERRORS.day };
        const hop = doc.fromSubmission != null && inputs.includes(String(doc.fromSubmission));
        if (hop && doc.fromCheckin === "spent") return { error: CHECKIN_ERRORS.hop };
        const id = await tx.createTask(tasks.checkin, { at: due.at, about }, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
        doc.pending.push({ id: String(id), at: due.at, about });
        doc.count += 1;
        if (hop) doc.fromCheckin = "spent";
        return { id: String(id) };
      }, context);
      if (r.error) return fail(r.error);
      return ok(`Check-in ${r.id} scheduled for ${hhmm(due.at)}.`);
    },
  });

  const cancel = defineTool({
    name: "checkin_cancel",
    description: "Cancel a pending check-in by its id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    replay: "safe",
    async execute(args, api, context) {
      const id = String(args.id ?? "");
      const gone = await api.commit(async (tx) => {
        const doc = await tx.doc(OverseerCheckins, api.conversationId);
        const n = (doc.pending ?? []).length;
        doc.pending = (doc.pending ?? []).filter((p) => p.id !== id);
        return doc.pending.length < n;
      }, context);
      // The sleeping task finds itself gone from `pending` when due and delivers nothing.
      return gone ? ok(`Check-in ${id} cancelled.`) : fail("no such pending check-in");
    },
  });
  return [schedule, cancel];
}

/**
 * Binds the tasks to this bridge and makes sure the nightly task exists (one per store).
 * @param {object} o
 * @param {object} o.durable the durable provider (ready → { harness, ctx })
 * @param {object} o.box createCheckinBox() (the one the extension got)
 */
export function createOverseerCheckins({ durable, box, disableFile = DEFAULT_DISABLE_FILE, home = homedir(), onOutbox = () => {}, log = console } = {}) {
  let harness;
  let ctx;
  const ready = (async () => {
    const d = await durable.ready;
    harness = d.harness;
    ctx = d.ctx;
    if (!box?.tasks) throw new Error("the overseer extension has no check-in tasks");
    box.bind({
      disabled: () => existsSync(resolve(expand(disableFile, home))),
      resetRoot: async (handoff) => (await harness.root(ctx)).reset(handoff, ctx),
      usage: () => harness.usage(ctx),
      onOutbox,
    });
    await harness.commit(async (tx) => {
      const page = await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: NIGHTLY_TASK }, 20);
      if (page.items.some((t) => t.state?.status !== "terminal")) return;
      await tx.createTask(box.tasks.nightly, {}, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true });
    }, ctx);
  })();
  ready.catch((err) => log.error?.(`[overseer] check-ins: ${err.message}`));
  return {
    ready,
    /** The pending check-ins `[{id, at, about}]`. */
    async pending() {
      await ready;
      return ((await harness.snapshot(OverseerCheckins, ROOT_CONVERSATION_ID, ctx))?.pending ?? []).map((p) => ({ ...p }));
    },
  };
}
