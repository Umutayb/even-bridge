// The lets-code engine of the durable provider, end to end: a real Harness on a
// SQLite file (so restarts are real), the fake lets-code (test/helpers/fake-pi-rpc.mjs)
// as the child, no scope wrapper, a recording fake for systemctl.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDurableProvider } from "../src/providers/durable/provider.mjs";
import { getOwner } from "../src/ownership.mjs";
import { fakeModelsJson } from "./helpers/fake-openai.mjs";
import { LcSessionDoc } from "../src/providers/durable/lc/record.mjs";
import { LC_CUTOFF_PROMPT, LC_RESTART_LIMIT, LC_RUN_TASK } from "../src/providers/durable/lc/task.mjs";
import { LC_IDLE_KEEP_MS, LC_MAX_LIVE_DEFAULT, LC_MODE_ACK_MS } from "../src/providers/durable/lc/engine.mjs";

const FAKE = fileURLToPath(new URL("./helpers/fake-pi-rpc.mjs", import.meta.url));
chmodSync(FAKE, 0o755);
const QUIET = { warn() {}, error() {}, log() {} };

let root;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lc-engine-")));
  writeFileSync(join(root, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
});
after(() => rmSync(root, { recursive: true, force: true }));

const until = async (cond, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

let n = 0;
/** A case dir; `open()` builds a provider on its store (call again for a "restart"). */
function makeCase({ lc = {}, extra = {}, warn } = {}) {
  const dir = join(root, `case-${++n}`);
  const work = join(dir, "agents", "work");
  mkdirSync(work, { recursive: true });
  const logFile = join(dir, "fake.log");
  const runs = [];
  const warnings = [];
  const frames = [];
  const providers = [];
  const factoryRoot = join(dir, "factory");
  const registryRoot = join(dir, "lc-registry");
  const runsRoot = join(dir, "lc-runs");
  mkdirSync(registryRoot, { recursive: true });
  const open = (more = {}) => {
    const p = createDurableProvider((sid, frame) => frames.push({ sid, ...frame }), {
      hub: { clientCount: () => 0 },
      storePath: join(dir, "durable.sqlite"),
      modelsPath: join(root, "models.json"),
      settingsPath: join(dir, "no-settings.json"),
      defaultCwd: work,
      allowedCwds: [join(dir, "agents")],
      guard: { wrapper: "none", log: () => {} },
      log: { ...QUIET, warn: (l) => (warnings.push(l), warn?.(l)) },
      agentsDir: join(dir, "no-agents"),
      scopeRunner: (argv) => (runs.push(argv), { status: 0 }),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_TOKEN: "bridge-secret", LETS_CODE_TOKEN: "lc-secret", ANTHROPIC_API_KEY: "k", LETS_CODE_EXPERTS_ON: "1" },
      lc: {
        bin: FAKE,
        caps: { memoryMax: "500M", cpuQuota: "200%" },
        maxLive: LC_MAX_LIVE_DEFAULT,
        sandbox: false,
        wrapper: "none",
        memoryController: false,
        idleKeepMs: 60_000,
        crashDelayMs: 0,
        factoryRoot,
        registryRoot,
        runsRoot,
        childEnv: { FAKE_PI_LOG: logFile },
        ...lc,
        ...(more.lc ?? {}),
      },
      ...extra,
      ...Object.fromEntries(Object.entries(more).filter(([k]) => k !== "lc")),
    });
    providers.push(p);
    return p;
  };
  const log = () => readLog(logFile);
  return {
    dir,
    work,
    logFile,
    runs,
    warnings,
    frames,
    factoryRoot,
    registryRoot,
    runsRoot,
    open,
    log,
    spawns: () => log().filter((l) => l.spawn),
    prompts: () => log().filter((l) => l.type === "prompt"),
    closeAll: async () => {
      for (const p of providers) await p.stopAll().catch(() => {});
    },
  };
}

async function recordOf(p, sid) {
  const { ctx } = await p.ready;
  return p._harness.snapshot(LcSessionDoc, p._map.get(sid).conversation_id, ctx);
}
async function entriesOf(p, sid) {
  const { ctx } = await p.ready;
  const conv = await p._harness.conversation(p._map.get(sid).conversation_id, ctx);
  const page = await conv.entries({}, 50, undefined, ctx);
  return [...page.items].reverse().filter((e) => e.kind.startsWith("lc."));
}
/** The `count`-th run of `sid` ended (its result frame; a child stopped while idle adds an idle frame of its own). */
const idleAfter = (c, sid, count = 1) =>
  until(() => c.frames.filter((f) => f.sid === sid && f.type === "result").length >= count && c.frames.filter((f) => f.sid === sid).at(-1)?.state === "idle", 8000, `run #${count} idle`);
const ledger = (c, id, repo, status, updated) => {
  mkdirSync(join(c.factoryRoot, id), { recursive: true });
  writeFileSync(join(c.factoryRoot, id, "ledger.json"), JSON.stringify({ v: 1, id, repo, status, updated }));
};

test("constants", () => {
  assert.equal(LC_IDLE_KEEP_MS, 120_000);
  assert.equal(LC_MODE_ACK_MS, 5000);
  assert.equal(LC_MAX_LIVE_DEFAULT, 1);
  assert.equal(LC_RUN_TASK, "even.lc-run");
  assert.equal(LC_RESTART_LIMIT, 5);
  assert.match(LC_CUTOFF_PROMPT, /^You were cut off by a restart of the bridge\. Your last tool call may have no result/);
});

test("engine lets-code is refused when the engine is off", async (t) => {
  const c = makeCase();
  const p = createDurableProvider(() => {}, {
    hub: { clientCount: () => 0 },
    storePath: join(c.dir, "off.sqlite"),
    modelsPath: join(root, "models.json"),
    settingsPath: join(c.dir, "no-settings.json"),
    defaultCwd: c.work,
    allowedCwds: [join(c.dir, "agents")],
    guard: { wrapper: "none", log: () => {} },
    log: QUIET,
    agentsDir: join(c.dir, "no-agents"),
  });
  t.after(() => p.stopAll());
  assert.deepEqual(p.engines, ["native"]);
  await assert.rejects(p.prompt(undefined, "hi", c.work, { engine: "lets-code" }), (e) => e.statusCode === 400 && /lets-code engine is off/.test(e.message));
  assert.equal([...p._map.rows()].length, 0, "no row was created");
});

test("lets-code prompt spawns one child and records lc.user and lc.answer", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  assert.deepEqual(p.engines, ["native", "lets-code"]);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code", name: "lc1" });
  assert.match(sid, /^dur-/);
  await idleAfter(c, sid);
  const mine = c.frames.filter((f) => f.sid === sid);
  assert.ok(mine.some((f) => f.type === "user_prompt" && f.text === "hello"));
  assert.equal(mine.filter((f) => f.type === "text_delta").map((f) => f.text).join(""), "ok: hello");
  assert.ok(mine.some((f) => f.type === "result"));
  await until(async () => (await entriesOf(p, sid)).length === 2, 5000, "entries");
  const entries = await entriesOf(p, sid);
  assert.deepEqual(entries.map((e) => e.kind), ["lc.user", "lc.answer"]);
  assert.deepEqual(entries.map((e) => e.data.text), ["hello", "ok: hello"]);
  await until(async () => (await recordOf(p, sid)).runs === 1, 5000, "runs 1");
  const rec = await recordOf(p, sid);
  const spawns = c.spawns();
  assert.equal(spawns.length, 1);
  assert.equal(rec.runs, 1);
  assert.equal(rec.childPid, spawns[0].pid);
  assert.equal(rec.cwd, c.work);
  assert.equal(rec.lastLine, "ok: hello");
  assert.ok(rec.piSessionId);
  assert.equal(getOwner(rec.piSessionId), "durable");
  assert.equal(getOwner(sid), "durable");
  const argv = spawns[0].argv;
  assert.equal(argv[argv.indexOf("--session-dir") + 1], join(c.dir, "lc-sessions", sid));
  assert.deepEqual(argv.slice(0, 2), ["--mode", "rpc"]);
  assert.ok(argv.includes("--mandate") && argv.includes("--subagents") && argv.includes("--no-sandbox"));
  assert.equal(argv[argv.indexOf("-e") + 1], fileURLToPath(new URL("../src/providers/durable/lc/even-guard.ts", import.meta.url)));
  assert.equal(p.getStatus(sid).state, "idle");
  assert.equal(p._map.get(sid).engine, "lets-code");
  const agents = await p.listAgents();
  assert.equal(agents[0].engine, "lets-code");
  assert.equal(agents[0].factory, false);
  assert.equal(agents[0].lastLine, "ok: hello");
});

test("a tool call becomes an lc.tool entry", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "TOOL", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await until(async () => (await entriesOf(p, sid)).length === 3, 5000, "entries");
  assert.deepEqual((await entriesOf(p, sid)).map((e) => [e.kind, e.data.text]), [["lc.user", "TOOL"], ["lc.tool", "Bash echo hi"], ["lc.answer", "ok: TOOL"]]);
});

test("prompt while busy steers the child", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await until(() => c.prompts().length === 1, 5000, "first prompt");
  assert.equal(p.getStatus(sid).state, "busy");
  await p.prompt(sid, "use pnpm");
  await until(() => c.prompts().length === 2, 5000, "steer");
  assert.deepEqual(
    c.prompts().map(({ type, message, streamingBehavior }) => ({ type, message, streamingBehavior })),
    [{ type: "prompt", message: "HANG", streamingBehavior: undefined }, { type: "prompt", message: "use pnpm", streamingBehavior: "steer" }],
  );
  assert.equal(c.spawns().length, 1);
});

test("prompt after the child exited respawns with --session and sends once", async (t) => {
  const c = makeCase({ lc: { idleKeepMs: 0 } });
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "a", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await until(() => p._lc.liveCount() === 0, 5000, "idle stop");
  const file = (await recordOf(p, sid)).piSessionFile;
  assert.ok(existsSync(file));
  await p.prompt(sid, "b");
  await idleAfter(c, sid, 2);
  const spawns = c.spawns();
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].argv[spawns[1].argv.indexOf("--session") + 1], file);
  assert.ok(!spawns[0].argv.includes("--session"));
  assert.equal(c.prompts().filter((x) => x.message === "b").length, 1);
  await until(async () => (await recordOf(p, sid)).runs === 2, 5000, "runs 2");
});

test("a child killed before its first prompt respawns without --session", async (t) => {
  const c = makeCase();
  const marker = join(c.dir, "die-once");
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_DIE_ONCE: marker } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "result"), 8000, "result");
  const spawns = c.spawns();
  assert.equal(spawns.length, 2);
  assert.ok(!spawns[1].argv.includes("--session"), "the first file was never written");
  const rec = await recordOf(p, sid);
  assert.ok(existsSync(rec.piSessionFile));
  assert.equal(c.prompts().filter((x) => x._pid === spawns[1].pid).map((x) => x.message).join("|"), "hello", "nothing reached the model: the prompt itself is sent again");
});

test("a child with an open dialog is not idle-stopped", async (t) => {
  const c = makeCase({ lc: { idleKeepMs: 0 } });
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "FACTORY", c.work, { engine: "lets-code" });
  await until(() => p.getStatus(sid).state === "awaiting", 5000, "awaiting");
  await sleep(1000);
  assert.equal(p._lc.liveCount(), 1);
  assert.equal(p.getStatus(sid).state, "awaiting");
});

test("a retried requestId is not delivered twice", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "first", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.prompt(sid, "x", undefined, { requestId: "r1" });
  await p.prompt(sid, "x", undefined, { requestId: "r1" });
  await idleAfter(c, sid, 2);
  await sleep(200);
  assert.equal(c.prompts().filter((x) => x.message === "x").length, 1);
  // A new session's retried requestId finds the same session.
  const a = await p.prompt(undefined, "y", c.work, { engine: "lets-code", requestId: "new-1" });
  const b = await p.prompt(undefined, "y", c.work, { engine: "lets-code", requestId: "new-1" });
  assert.equal(a.sessionId, b.sessionId);
});

test("restart mid-turn re-spawns with --session and sends the cut-off prompt once", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = c.open();
  const { sessionId: sid } = await a.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await until(() => c.prompts().length === 1, 5000, "HANG");
  const rec = await recordOf(a, sid);
  const pid = rec.childPid;
  writeFileSync(join(c.registryRoot, `${pid}.json`), "{}");
  await a.stopAll();
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000, "child gone");
  const b = c.open();
  await b.ready;
  assert.equal(b.getStatus(sid).state, "busy");
  await until(() => c.prompts().some((x) => x.message === LC_CUTOFF_PROMPT), 8000, "cut-off prompt");
  await idleAfter(c, sid);
  const spawns = c.spawns();
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].argv[spawns[1].argv.indexOf("--session") + 1], rec.piSessionFile);
  assert.equal(c.prompts().filter((x) => x.message === LC_CUTOFF_PROMPT).length, 1);
  assert.ok(!existsSync(join(c.registryRoot, `${pid}.json`)), "the dead pid's registry file is removed");
  assert.equal((await recordOf(b, sid)).restarts, 1);
});

test("a factory run is resumed with /factory resume after a restart", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = c.open();
  const { sessionId: sid } = await a.prompt(undefined, "first", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await a.setFactory(sid, true);
  await until(() => c.prompts().some((x) => x.message === "/mode orchestration"), 5000, "mode");
  await a.prompt(sid, "HANG");
  await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "HANG");
  ledger(c, "20261103-0901-bbbb", c.work, "waiting", 2);
  await a.stopAll();
  const before = c.prompts().length;
  const b = c.open();
  await b.ready;
  await until(() => c.prompts().slice(before).some((x) => x.message.startsWith("/factory resume")), 8000, "resume");
  const after = c.prompts().slice(before).map((x) => x.message);
  assert.deepEqual(after.slice(0, 2), ["/mode orchestration", "/factory resume 20261103-0901-bbbb"]);
  assert.ok(!after.includes(LC_CUTOFF_PROMPT));
});

test("a stopped factory run is not resumed after a restart", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = c.open();
  const { sessionId: sid } = await a.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await until(() => c.prompts().length === 1, 5000, "HANG");
  ledger(c, "20261103-0902-cccc", c.work, "stopped", 3);
  await a.stopAll();
  const b = c.open();
  await b.ready;
  await until(() => c.prompts().some((x) => x.message === LC_CUTOFF_PROMPT), 8000, "cut-off");
  assert.ok(!c.prompts().some((x) => x.message.startsWith("/factory resume")));
  await idleAfter(c, sid);
});

test("the sixth restart in a row ends the run", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_CRASH: "1" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "boom", c.work, { engine: "lets-code" });
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "error" && /restarted 5 times/.test(f.message)), 15000, "restart limit");
  assert.equal(c.spawns().length, LC_RESTART_LIMIT + 1);
  await until(() => p.getStatus(sid).state === "idle", 5000, "idle");
  const { ctx } = await p.ready;
  const tasks = (await p._harness.inspect(ctx)).tasks.filter((x) => x.record.kind === LC_RUN_TASK);
  assert.equal(tasks.length, 0, "the run task is terminal");
});

test("interrupt cancels open dialogs then aborts", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "ASK", c.work, { engine: "lets-code" });
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "permission_request"), 5000, "ask");
  p.interrupt(sid);
  await until(() => c.log().some((l) => l.type === "abort"), 5000, "abort");
  const seq = c.log().filter((l) => l.type === "extension_ui_response" || l.type === "abort");
  assert.equal(seq[0].type, "extension_ui_response");
  assert.equal(seq[0].cancelled, true);
  assert.equal(seq[1].type, "abort");
  await idleAfter(c, sid);
});

test("interrupt during a factory checkpoint says the run stopped", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "FACTORY", c.work, { engine: "lets-code" });
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "user_question"), 5000, "checkpoint");
  p.interrupt(sid);
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "error"), 5000, "error frame");
  assert.equal(
    c.frames.find((f) => f.sid === sid && f.type === "error").message,
    "factory run 20261103-093221-c129 stopped at the acceptance criteria checkpoint; /factory resume 20261103-093221-c129 continues it",
  );
});

test("a second live child is refused at the default limit", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  await p.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await until(() => c.prompts().length === 1, 5000, "HANG");
  const rows = [...p._map.rows()].length;
  await assert.rejects(p.prompt(undefined, "HANG", c.work, { engine: "lets-code" }), (e) => e.statusCode === 429 && e.message === "1 lets-code agent is working; wait for it or stop it");
  assert.equal([...p._map.rows()].length, rows, "no row for a refused start");
});

test("maxLive 2 allows two", async (t) => {
  const c = makeCase({ lc: { maxLive: 2 } });
  const p = c.open();
  t.after(c.closeAll);
  await p.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await p.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await until(() => c.prompts().length === 2, 5000, "two HANGs");
  await assert.rejects(p.prompt(undefined, "HANG", c.work, { engine: "lets-code" }), (e) => e.statusCode === 429 && e.message === "2 lets-code agents are working; wait for one or stop one");
});

test("an idle-kept child makes room for a new one", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: a } = await p.prompt(undefined, "one", c.work, { engine: "lets-code" });
  await idleAfter(c, a);
  assert.equal(p._lc.liveCount(), 1, "kept for the idle grace");
  const { sessionId: b } = await p.prompt(undefined, "two", c.work, { engine: "lets-code" });
  await idleAfter(c, b);
  assert.equal(p._lc.liveCount(), 1);
});

test("stop aborts, stops the scope and archives", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await until(() => c.prompts().length === 1, 5000, "HANG");
  await p.stopSession(sid);
  assert.ok(c.log().some((l) => l.type === "abort"));
  assert.ok(c.runs.some((r) => r.join(" ") === `systemctl --user stop even-lc-${sid}.scope`), JSON.stringify(c.runs));
  assert.equal(p.getStatus(sid), null);
  assert.equal(p._lc.liveCount(), 0);
  const { ctx } = await p.ready;
  await until(async () => (await p._harness.inspect(ctx)).tasks.filter((x) => x.record.kind === LC_RUN_TASK).length === 0, 5000, "task ended");
});

test("forget removes the subagent runs dir", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  const rec = await recordOf(p, sid);
  const runsDir = join(c.runsRoot, rec.piSessionId);
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, "r1.pi.jsonl"), "{}\n");
  p.forgetSession(sid);
  await until(() => !existsSync(runsDir), 5000, "runs dir removed");
  assert.equal(p.getStatus(sid), null);
});

test("startup stops scopes of its own lets-code rows only", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = c.open();
  const { sessionId: lc1 } = await a.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, lc1);
  const native = a._map.create({ name: "n", cwd: c.work, modelRef: { provider: "fake", modelId: "fake-model" }, origin: "phone" });
  await a.stopAll();
  c.runs.length = 0;
  const b = c.open();
  await b.ready;
  const lcStops = c.runs.filter((r) => r[0] === "systemctl" && r.some((x) => x.startsWith("even-lc-")));
  assert.deepEqual(lcStops, [["systemctl", "--user", "stop", `even-lc-${lc1}.scope`]]);
  assert.ok(!c.runs.some((r) => r.some((x) => x.includes(native))));
});

test("getHistory and seedTranscript read the child's session file", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = c.open();
  const { sessionId: sid } = await a.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.deepEqual(await a.getHistory(sid, 10), [{ role: "user", text: "hello" }, { role: "assistant", text: "ok: hello" }]);
  await a.stopAll();
  c.frames.length = 0;
  const b = c.open();
  await b.ready;
  await b.seedTranscript(sid);
  const mine = c.frames.filter((f) => f.sid === sid);
  assert.ok(mine.some((f) => f.type === "user_prompt" && f.text === "hello"), JSON.stringify(mine));
  assert.ok(mine.some((f) => f.type === "text_delta" && f.text.includes("ok: hello")));
  assert.deepEqual(await b.getHistory(sid, 1), [{ role: "assistant", text: "ok: hello" }]);
});

test("the child env keeps pi in the scope and carries no token", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  const env = c.spawns()[0].env;
  assert.equal(env.BRIDGE_TOKEN, undefined);
  assert.equal(env.LETS_CODE_TOKEN, undefined);
  assert.equal(env.LETS_CODE_MEM_WATCH, "false");
  assert.equal(env.LETS_CODE_MEM_GUARD, "false");
  assert.equal(env.LETS_CODE_EXPERTS_ON, undefined);
  assert.equal(env.EVEN_GUARD_CWD, c.work);
  assert.equal(env.PI_TELEMETRY, "0");
});

test("no /experts command is ever sent", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Fix the CI", howToRun: "test -f hello.txt" });
  await until(() => c.prompts().some((x) => x.message.startsWith("/factory start")), 5000, "factory start");
  const start = c.prompts().find((x) => x.message.startsWith("/factory start")).message;
  assert.match(start, /^\/factory start \.factory\/ticket-\d+\.md test -f hello\.txt$/);
  const ticket = join(c.work, start.split(" ")[2]);
  assert.equal(readFileSync(ticket, "utf8"), "Fix the CI");
  assert.ok(!c.prompts().some((x) => x.message.startsWith("/experts")));
});

test("the memory cap follows the controller", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const off = c.open({ lc: { wrapper: "systemd-run", memoryController: false, spawnWrap: () => [] } });
  const { sessionId: s1 } = await off.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, s1);
  const w1 = off._lc._launches.get(s1).wrap;
  assert.ok(w1.includes(`--unit=even-lc-${s1}`));
  assert.ok(!w1.some((x) => x.startsWith("MemoryMax=")));
  assert.equal(c.warnings.filter((l) => /no memory cgroup controller; MemoryMax not applied/.test(l)).length, 1);
  await off.stopAll();
  const on = c.open({ lc: { wrapper: "systemd-run", memoryController: true, spawnWrap: () => [] } });
  const { sessionId: s2 } = await on.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, s2);
  assert.ok(on._lc._launches.get(s2).wrap.includes("MemoryMax=500M"));
  assert.equal(on.lcBanner, "on(nosandbox,mem)");
  assert.equal(off.lcBanner, "on(nosandbox,nomem)");
});

test("without bwrap and socat the lets-code engine answers 503", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { sandbox: true, sandboxAvailable: false } });
  t.after(c.closeAll);
  await assert.rejects(p.prompt(undefined, "hello", c.work, { engine: "lets-code" }), (e) => e.statusCode === 503 && e.message === "lets-code sandbox unavailable: install bubblewrap and socat");
  assert.equal(p.lcBanner, "on(sandbox-missing,nomem)");
});

test("native sessions are unchanged next to the engine", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const native = p._map.create({ name: "n", cwd: c.work, modelRef: { provider: "fake", modelId: "fake-model" }, origin: "phone" });
  assert.equal(p._map.get(native).engine, "native");
  const rows = await p.listAgents();
  assert.equal(rows.length, 0, "no conversation yet: not listed");
});
