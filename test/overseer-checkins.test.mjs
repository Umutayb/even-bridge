// The overseer's check-ins, its nightly reset and standing orders (src/overseer/checkins.mjs,
// src/overseer/actions.mjs). A real Harness on a SQLite file on a fake clock
// (HarnessOptions.now / setTimer through the provider's `clock` seam) and a local fake OpenAI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveDoc } from "@earendil-works/pi-durable";
import { createDurableProvider } from "../src/providers/durable/provider.mjs";
import { createOverseerHost } from "../src/overseer/host.mjs";
import { createOverseerExtension } from "../src/overseer/extension.mjs";
import { createOverseer, overseerProviderOptions, OverseerNotes, ROOT_CONVERSATION_ID } from "../src/overseer/overseer.mjs";
import { createOverseerActions, OverseerActions, OverseerStanding } from "../src/overseer/actions.mjs";
import {
  CHECKIN_MAX_PENDING,
  CHECKIN_MIN_GAP_MS,
  CHECKIN_MAX_PER_DAY,
  CHECKIN_TASK,
  createCheckinBox,
  createOverseerCheckins,
  hhmm,
  NIGHTLY_RESET_HOUR,
  NIGHTLY_TASK,
  OverseerCheckins,
} from "../src/overseer/checkins.mjs";
import { startFakeOpenAI } from "./helpers/fake-openai.mjs";

const quiet = { warn() {}, error() {}, log() {} };
let fake;
let root;
before(async () => {
  fake = await startFakeOpenAI();
  root = realpathSync(mkdtempSync(join(tmpdir(), "ovs-ci-")));
  const models = {
    providers: {
      fake: { baseUrl: fake.baseUrl, api: "openai-completions", apiKey: "test-key", models: [{ id: "fake-model", contextWindow: 32000, maxTokens: 1024 }] },
    },
  };
  writeFileSync(join(root, "models.json"), JSON.stringify(models));
});
after(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const newDir = () => {
  const dir = join(root, `case-${++n}`);
  mkdirSync(join(dir, "work"), { recursive: true });
  return dir;
};

/**
 * A fake Harness clock: `now()` runs with the real one plus an offset. Timers up to 5 s are real
 * (progress pacing); longer ones (sleeping tasks) fire only when `advance()` passes their due time.
 */
function fakeClock(offset = 0) {
  const waiting = new Set();
  const c = {
    get offset() {
      return offset;
    },
    now: () => Date.now() + offset,
    setTimer: (cb, delay, { background } = {}) => {
      if (delay <= 5000) {
        const h = setTimeout(cb, Math.max(0, delay));
        if (background) h.unref?.();
        return () => clearTimeout(h);
      }
      const t = { due: Date.now() + offset + delay, cb };
      waiting.add(t);
      return () => waiting.delete(t);
    },
    advance(ms) {
      offset += ms;
      for (const t of [...waiting]) {
        if (t.due <= c.now()) {
          waiting.delete(t);
          t.cb();
        }
      }
    },
    /** Move to epoch ms `t` (forward only). */
    to(t) {
      c.advance(Math.max(0, t - c.now()));
    },
    stop() {
      waiting.clear();
    },
  };
  return c;
}

/** Local `h`:`m` of the day after tomorrow, as epoch ms (well away from a day boundary of the real clock). */
const localAt = (h, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const clockAt = (t) => fakeClock(t - Date.now());

/** One bridge process as server.mjs wires it: provider, overseer, actions, check-ins. */
async function open(dir, { clock }) {
  const frames = [];
  const host = {};
  const box = createCheckinBox({ now: clock.now });
  const extension = createOverseerExtension({ host, checkins: box });
  const emit = (sid, f) => frames.push({ sid, ...f });
  const provider = createDurableProvider(emit, {
    hub: { clientCount: () => 0 },
    storePath: join(dir, "durable.sqlite"),
    modelsPath: join(root, "models.json"),
    settingsPath: join(dir, "no-settings.json"),
    defaultCwd: join(dir, "work"),
    allowedCwds: [dir],
    guard: { wrapper: "none", log: () => {} },
    log: quiet,
    agentsDir: join(dir, "no-agents"),
    overseer: overseerProviderOptions({ extension }),
    clock: { now: clock.now, setTimer: clock.setTimer },
  });
  Object.assign(host, createOverseerHost({ durable: provider, log: quiet }));
  await provider.ready;
  const overseer = createOverseer({ durable: provider, host, log: quiet });
  await overseer.ready;
  const disableFile = join(dir, "agents.disabled");
  const actions = createOverseerActions({
    durable: provider,
    host,
    overseer,
    emit,
    log: quiet,
    auditPath: join(dir, "overseer-actions.log"),
    disableFile,
    claudeSlots: async () => 8,
    now: clock.now,
  });
  await actions.ready;
  host.actions = actions;
  overseer.bindActions(actions);
  const checkins = createOverseerCheckins({ durable: provider, box, disableFile, log: quiet });
  await checkins.ready;
  const { harness, ctx } = await provider.ready;
  const close = async () => {
    overseer.close();
    await provider.stopAll();
  };
  return { provider, overseer, actions, checkins, extension, frames, harness, ctx, dir, disableFile, work: join(dir, "work"), close };
}

const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const outText = (r) => r.output.map((b) => b.text).join("");

/** Call one of the overseer's tools directly, as a run of the root would (`inputs`: the run's submissions). */
async function callTool(s, name, args, { inputs = [] } = {}) {
  const tool = s.extension.tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name}`);
  const api = {
    conversationId: ROOT_CONVERSATION_ID,
    snapshot: async (doc, id, c) => (doc === LiveDoc ? (inputs.length ? { run: { inputs } } : undefined) : s.harness.snapshot(doc, id, c)),
    commit: (fn, c) => s.harness.commit(fn, c),
  };
  return tool.execute(args, api, s.ctx);
}
const scheduled = (r) => {
  assert.ok(!r.isError, outText(r));
  return /Check-in (\S+) scheduled/.exec(outText(r))[1];
};
const byRequest = (s, requestId) => s.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId), s.ctx);
const rootUserTexts = async (s) => {
  const conv = await s.harness.root(s.ctx);
  const page = await conv.entries({}, 200, undefined, s.ctx);
  return page.items.filter((e) => e.kind === "pi.user").map((e) => JSON.stringify(e.model));
};
const taskOf = (s, id) => s.harness.commit((tx) => tx.task(id), s.ctx);
const checkinDoc = async (s) => s.harness.snapshot(OverseerCheckins, ROOT_CONVERSATION_ID, s.ctx);

test("a due check-in submits one follow-up to the root", async () => {
  const clock = clockAt(localAt(12));
  const s = await open(newDir(), { clock });
  try {
    const id = scheduled(await callTool(s, "checkin_schedule", { inMinutes: 15, about: "tests of fix-ci" }));
    assert.deepEqual((await checkinDoc(s)).pending.map((p) => [p.id, p.about]), [[id, "tests of fix-ci"]]);
    clock.advance(14 * 60000);
    await settle();
    assert.equal(await byRequest(s, `checkin:${id}`), undefined, "not before it is due");
    clock.advance(60000 + 1);
    await until(async () => (await byRequest(s, `checkin:${id}`)) != null);
    await until(async () => (await taskOf(s, id))?.state?.status === "terminal");
    const texts = (await rootUserTexts(s)).filter((t) => t.includes("check-in: tests of fix-ci"));
    assert.equal(texts.length, 1, "one follow-up");
    assert.deepEqual((await checkinDoc(s)).pending, []);
  } finally {
    clock.stop();
    await s.close();
  }
});

test("a check-in survives a restart", async () => {
  const dir = newDir();
  const c1 = clockAt(localAt(12));
  const one = await open(dir, { clock: c1 });
  const id = scheduled(await callTool(one, "checkin_schedule", { inMinutes: 20, about: "the docs agent" }));
  c1.stop();
  await one.close();
  const c2 = fakeClock(c1.offset + 21 * 60000); // the bridge was down while it came due
  const two = await open(dir, { clock: c2 });
  try {
    await until(async () => (await byRequest(two, `checkin:${id}`)) != null);
    await until(async () => (await taskOf(two, id))?.state?.status === "terminal");
    await settle();
    assert.equal((await rootUserTexts(two)).filter((t) => t.includes("check-in: the docs agent")).length, 1, "delivered once");
  } finally {
    c2.stop();
    await two.close();
  }
});

test("caps: 6 pending, 15 minutes apart, 24 a day", async () => {
  const clock = clockAt(localAt(9));
  const s = await open(newDir(), { clock });
  try {
    assert.equal(CHECKIN_MAX_PENDING, 6);
    assert.equal(CHECKIN_MIN_GAP_MS, 900000);
    assert.equal(CHECKIN_MAX_PER_DAY, 24);
    const ids = [];
    for (let i = 1; i <= 6; i++) ids.push(scheduled(await callTool(s, "checkin_schedule", { inMinutes: 15 * i, about: `round ${i}` })));
    let r = await callTool(s, "checkin_schedule", { inMinutes: 200, about: "seventh" });
    assert.equal(r.isError, true);
    assert.equal(outText(r), "at most 6 check-ins may be pending");
    for (const id of ids) assert.ok(!(await callTool(s, "checkin_cancel", { id })).isError);
    const first = (await checkinDoc(s)).count;
    const at = new Date(clock.now() + 60 * 60000).toISOString();
    scheduled(await callTool(s, "checkin_schedule", { at, about: "at an hour" }));
    r = await callTool(s, "checkin_schedule", { at: new Date(clock.now() + 65 * 60000).toISOString(), about: "five later" });
    assert.equal(outText(r), "check-ins must be at least 15 minutes apart");
    // Cancelled ones still count for the day.
    let count = first + 1;
    while (count < 24) {
      const id = scheduled(await callTool(s, "checkin_schedule", { inMinutes: 300, about: `filler ${count}` }));
      await callTool(s, "checkin_cancel", { id });
      count += 1;
    }
    r = await callTool(s, "checkin_schedule", { inMinutes: 400, about: "the 25th" });
    assert.equal(outText(r), "at most 24 check-ins a day");
    // Bad times are refused before any cap.
    assert.match(outText(await callTool(s, "checkin_schedule", { inMinutes: 5, about: "x" })), /'inMinutes' must be an integer from 15 to 720/);
    assert.match(outText(await callTool(s, "checkin_schedule", { about: "x" })), /give 'at'/);
    assert.equal(outText(await callTool(s, "checkin_cancel", { id: "nope" })), "no such pending check-in");
  } finally {
    clock.stop();
    await s.close();
  }
});

test("a run started by a check-in may schedule one check-in", async () => {
  const clock = clockAt(localAt(10));
  const s = await open(newDir(), { clock });
  try {
    const id = scheduled(await callTool(s, "checkin_schedule", { inMinutes: 15, about: "fix-ci" }));
    clock.advance(15 * 60000 + 1);
    await until(async () => (await byRequest(s, `checkin:${id}`)) != null);
    const sub = String((await byRequest(s, `checkin:${id}`)).id);
    assert.equal((await checkinDoc(s)).fromSubmission, sub);
    // During the check-in run: one more, then no more.
    scheduled(await callTool(s, "checkin_schedule", { inMinutes: 30, about: "again" }, { inputs: [sub] }));
    const r = await callTool(s, "checkin_schedule", { inMinutes: 60, about: "and again" }, { inputs: [sub] });
    assert.equal(outText(r), "a check-in run may schedule only one more check-in");
    // A run the user started is not limited by the hop rule.
    scheduled(await callTool(s, "checkin_schedule", { inMinutes: 90, about: "user asked" }, { inputs: ["sub-of-the-user"] }));
  } finally {
    clock.stop();
    await s.close();
  }
});

test("the kill switch skips due check-ins", async () => {
  const clock = clockAt(localAt(11));
  const s = await open(newDir(), { clock });
  try {
    const id = scheduled(await callTool(s, "checkin_schedule", { inMinutes: 15, about: "while off" }));
    writeFileSync(s.disableFile, "");
    clock.advance(15 * 60000 + 1);
    await until(async () => (await taskOf(s, id))?.state?.status === "terminal");
    const task = await taskOf(s, id);
    assert.equal(task.state.outcome.status, "completed", JSON.stringify(task.state));
    assert.equal(task.state.outcome.result.delivered, false);
    assert.equal(await byRequest(s, `checkin:${id}`), undefined, "nothing submitted");
    const box = await s.overseer.outbox({ since: 0 });
    assert.deepEqual(box.items.filter((i) => i.kind === "system").map((i) => i.text), ["check-in skipped: agents are switched off"]);
    assert.deepEqual((await checkinDoc(s)).pending, []);
  } finally {
    clock.stop();
    await s.close();
  }
});

/** The handoff text of the newest reset of the root, or null. */
async function lastHandoff(s) {
  const conv = await s.harness.root(s.ctx);
  const page = await conv.entries({}, 200, undefined, s.ctx);
  const reset = page.items.find((e) => e.kind === "pi.reset");
  if (!reset) return null;
  return JSON.stringify(reset);
}

test("the nightly reset hands off the notes when idle", async () => {
  const clock = clockAt(localAt(NIGHTLY_RESET_HOUR - 1, 30));
  const s = await open(newDir(), { clock });
  try {
    const live = (await s.harness.commit((tx) => tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: NIGHTLY_TASK }, 10), s.ctx)).items;
    assert.equal(live.length, 1, "one nightly task");
    assert.equal(live[0].background, true);
    await s.harness.commit(async (tx) => {
      (await tx.doc(OverseerNotes, ROOT_CONVERSATION_ID)).text = "Watching fix-ci: tests were red at 23:00.";
    }, s.ctx);
    const ci = scheduled(await callTool(s, "checkin_schedule", { inMinutes: 300, about: "fix-ci tests" }));
    clock.advance(29 * 60000);
    await settle();
    assert.equal(await lastHandoff(s), null, "not before 04:00");
    clock.advance(60000);
    await until(async () => (await lastHandoff(s)) != null);
    const conv = await s.harness.root(s.ctx);
    const view = await conv.context(s.ctx);
    const first = JSON.stringify(view.messages?.[0] ?? view);
    assert.match(first, /Watching fix-ci: tests were red at 23:00\.\\n\\nPending check-ins:\\n- \d\d:\d\d fix-ci tests \(/);
    assert.ok(first.includes(ci));
    const ix = first.indexOf("Watching fix-ci");
    assert.ok(ix >= 0 && ix < 80, "the handoff starts with the notes");
    await until(async () => (await s.overseer.outbox({ since: 0 })).items.some((i) => i.kind === "system" && /usage/.test(i.text)));
    // A second open finds the same nightly task (not a second one).
    const again = (await s.harness.commit((tx) => tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: NIGHTLY_TASK }, 10), s.ctx)).items;
    assert.equal(again.filter((t) => t.state?.status !== "terminal").length, 1);
  } finally {
    clock.stop();
    await s.close();
  }
});

test("the nightly reset waits while the overseer is busy", async () => {
  const clock = clockAt(localAt(NIGHTLY_RESET_HOUR - 1, 59));
  const s = await open(newDir(), { clock });
  try {
    fake.hold();
    const asked = s.overseer.ask("SLOW how are things?", { requestId: "busy-1", waitMs: 0 });
    await until(async () => Boolean((await s.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, s.ctx))?.run));
    clock.advance(60000 + 1);
    await settle(300);
    assert.equal(await lastHandoff(s), null, "no reset while busy");
    fake.release();
    await asked;
    await until(async () => !(await s.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, s.ctx))?.run);
    clock.advance(10 * 60000 + 1);
    await until(async () => (await lastHandoff(s)) != null);
  } finally {
    fake.release();
    clock.stop();
    await s.close();
  }
});

// ── standing orders ─────────────────────────────────────────────────────────

async function agent(s, name) {
  const { sessionId } = await s.provider.prompt(undefined, "first", s.work, { name, origin: "evenai" });
  await until(async () => (await s.provider.getSessionStatus(sessionId)) === "idle" && (await s.provider.getHistory(sessionId, 2)).length === 2);
  return sessionId;
}
const actionItems = async (s) => (await s.harness.snapshot(OverseerActions, ROOT_CONVERSATION_ID, s.ctx))?.items ?? [];
const auditLines = (s) => readFileSync(join(s.dir, "overseer-actions.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a matching standing order runs without a new confirm", async () => {
  const clock = clockAt(localAt(22));
  const s = await open(newDir(), { clock });
  try {
    const sid = await agent(s, "dur-1-docs");
    const until7 = clock.now() + 9 * 3600000;
    const o = await s.actions.propose("standing_order", { id: sid, text: "fix the failing tests", maxTimes: 2, until: until7 }, { origin: "overseer" });
    assert.equal(o.summary, `Let the overseer tell agent 'dur-1-docs' "fix the failing tests" up to 2 times until ${hhmm(until7)}?`);
    const req = s.frames.find((f) => f.type === "permission_request" && f.toolUseId === o.id);
    assert.ok(req, "the order itself is confirmed on the phone like any action");
    await s.actions.confirm(o.id, { confirmFrameId: "q1" });
    const orders = (await s.harness.snapshot(OverseerStanding, ROOT_CONVERSATION_ID, s.ctx)).orders;
    assert.deepEqual(orders.map((x) => [x.actionId, x.sid, x.text, x.maxTimes, x.used, x.until]), [[o.id, sid, "fix the failing tests", 2, 0, until7]]);
    const before = s.frames.filter((f) => f.type === "permission_request").length;
    for (const i of [1, 2]) {
      const m = await s.actions.propose("session_message", { id: sid, text: "fix the failing tests" }, { origin: "overseer" });
      assert.equal(m.standing, o.id, `use ${i} runs under the order`);
      const item = (await actionItems(s)).find((x) => x.id === m.id);
      assert.equal(item.state, "confirmed");
      assert.ok(item.result, "executed");
      assert.equal(item.confirmFrameId, `standing:${o.id}`);
    }
    assert.equal(s.frames.filter((f) => f.type === "permission_request").length, before, "no phone prompt for them");
    assert.equal((await s.harness.snapshot(OverseerStanding, ROOT_CONVERSATION_ID, s.ctx)).orders[0].used, 2);
    const lines = auditLines(s);
    assert.equal(lines.filter((l) => l.event === "standing").length, 2);
    assert.ok(lines.filter((l) => l.event === "execute" && l.kind === "session_message").every((l) => l.by === "bridge"));
    // Used up: the third is a normal proposal again.
    const third = await s.actions.propose("session_message", { id: sid, text: "fix the failing tests" }, { origin: "overseer" });
    assert.equal(third.standing, undefined);
    assert.equal((await actionItems(s)).find((x) => x.id === third.id).state, "pending");
    // Another text never matches.
    await s.actions.deny(third.id);
    const other = await s.actions.propose("session_message", { id: sid, text: "fix the failing tests now" }, { origin: "overseer" });
    assert.equal((await actionItems(s)).find((x) => x.id === other.id).state, "pending");
  } finally {
    clock.stop();
    await s.close();
  }
});

test("a standing order past its until no longer applies", async () => {
  const clock = clockAt(localAt(22));
  const s = await open(newDir(), { clock });
  try {
    const sid = await agent(s, "docs");
    const o = await s.actions.propose("standing_order", { id: sid, text: "run the tests", maxTimes: 3, until: clock.now() + 20 * 60000 }, { origin: "overseer" });
    await s.actions.confirm(o.id, { confirmFrameId: "q1" });
    clock.advance(21 * 60000);
    const m = await s.actions.propose("session_message", { id: sid, text: "run the tests" }, { origin: "overseer" });
    assert.equal(m.standing, undefined);
    assert.equal((await actionItems(s)).find((x) => x.id === m.id).state, "pending");
  } finally {
    clock.stop();
    await s.close();
  }
});

test("standing orders are bounded and checked by the host", async () => {
  const clock = clockAt(localAt(22));
  const s = await open(newDir(), { clock });
  try {
    const sid = await agent(s, "docs");
    const t = clock.now();
    const bad = [
      [{ id: sid, text: "x", maxTimes: 4, until: t + 3600000 }, /'maxTimes' must be an integer from 1 to 3/],
      [{ id: sid, text: "x", maxTimes: 1, until: t + 12 * 3600000 + 60000 }, /'until' must be within 12 hours/],
      [{ id: sid, text: "x", maxTimes: 1, until: t - 1 }, /'until' must be within 12 hours/],
      [{ id: sid, text: "/factory start x.md", maxTimes: 1, until: t + 3600000 }, /commands/],
      [{ id: sid, text: "y".repeat(141), maxTimes: 1, until: t + 3600000 }, /'text'/],
      [{ id: "dur-overseer", text: "x", maxTimes: 1, until: t + 3600000 }, /itself/],
    ];
    for (const [args, re] of bad) await assert.rejects(s.actions.propose("standing_order", args, { origin: "overseer" }), (e) => re.test(e.message), JSON.stringify(args));
    // The kill switch blocks a standing execution too: the message is refused, nothing is sent.
    const o = await s.actions.propose("standing_order", { id: sid, text: "go on", maxTimes: 1, until: t + 3600000 }, { origin: "overseer" });
    await s.actions.confirm(o.id, { confirmFrameId: "q" });
    writeFileSync(s.disableFile, "");
    await assert.rejects(s.actions.propose("session_message", { id: sid, text: "go on" }, { origin: "overseer" }), (e) => e.statusCode === 423);
  } finally {
    clock.stop();
    await s.close();
  }
});
