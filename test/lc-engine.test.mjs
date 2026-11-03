// The lets-code engine of the durable provider, end to end: a real Harness on a
// SQLite file (so restarts are real), the fake lets-code (test/helpers/fake-pi-rpc.mjs)
// as the child, no scope wrapper, a recording fake for systemctl.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDurableProvider } from "../src/providers/durable/provider.mjs";
import { getOwner } from "../src/ownership.mjs";
import { fakeModelsJson } from "./helpers/fake-openai.mjs";
import { LcSessionDoc } from "../src/providers/durable/lc/record.mjs";
import { LC_CRASH_PROMPT, LC_CUTOFF_PROMPT, LC_RESTART_LIMIT, LC_RUN_TASK } from "../src/providers/durable/lc/task.mjs";
import { FACTORY_EXPERTS } from "../src/providers/durable/lc/launch.mjs";
import {
  LC_IDLE_KEEP_MS,
  LC_MAX_LIVE_DEFAULT,
  LC_MAX_TURNS_CEILING,
  LC_MAX_TURNS_DEFAULT,
  LC_MODE_ACK_MS,
  LC_REPEAT_MAX,
  lcRepeatCapMessage,
  lcTurnCap,
  lcTurnCapMessage,
} from "../src/providers/durable/lc/engine.mjs";
import { createOverseerHost } from "../src/overseer/host.mjs";
import { createAuditLog, lcCapAuditEvent } from "../src/overseer/actions.mjs";

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
  // lets-code's host-wide state with the factory's experts on (the operator's job, ruling 4).
  const stateFile = join(dir, "lets-code-state.json");
  writeFileSync(stateFile, JSON.stringify({ experts: Object.fromEntries(FACTORY_EXPERTS.map((x) => [x, true])) }));
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
        stateFile,
        trustFile: join(dir, "trust.json"), // never the real ~/.pi/agent/trust.json
        factoryWatchMs: 50,
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
    stateFile,
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

// ── Task 3: the factory toggle ─────────────────────────────────────────────

/** The prompts one child (by its spawn index) received. */
const promptsOf = (c, i) => {
  const pid = c.spawns()[i]?.pid;
  return c.prompts().filter((x) => x._pid === pid).map((x) => x.message);
};
/** Answer the open factory checkpoint and wait for the session to go idle. */
async function confirmCheckpoint(c, p, sid) {
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "user_question"), 5000, "checkpoint");
  await p.respondQuestion(sid, "Confirm");
  await until(() => p.getStatus(sid).state === "idle", 5000, "idle after checkpoint");
}

test("factory on sends /mode orchestration and is kept across a respawn", async (t) => {
  const c = makeCase({ lc: { idleKeepMs: 300 } });
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "a", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.deepEqual(await p.setFactory(sid, true), { factory: true, mode: "orchestration" });
  assert.deepEqual(promptsOf(c, 0), ["a", "/mode orchestration"]);
  await until(() => p._lc.liveCount() === 0, 5000, "idle stop");
  await p.prompt(sid, "b");
  await idleAfter(c, sid, 2);
  assert.equal(c.spawns().length, 2);
  assert.deepEqual(promptsOf(c, 1), ["/mode orchestration", "b"]);
  const rec = await recordOf(p, sid);
  assert.equal(rec.factory, true);
  assert.equal(rec.mode, "orchestration");
  assert.equal((await p.listAgents())[0].factory, true);
});

test("factory with a ticket writes .factory/ticket-<ms>.md and starts it", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.deepEqual(await p.setFactory(sid, true, { ticket: "Fix the CI\n\nIt fails on main." }), { factory: true, mode: "orchestration" });
  await until(() => c.prompts().some((x) => x.message.startsWith("/factory start")), 5000, "factory start");
  const start = c.prompts().find((x) => x.message.startsWith("/factory start")).message;
  const m = /^\/factory start (\.factory\/ticket-\d+\.md)$/.exec(start);
  assert.ok(m, start);
  assert.equal(readFileSync(join(c.work, m[1]), "utf8"), "Fix the CI\n\nIt fails on main.");
  assert.deepEqual(promptsOf(c, 0), ["hello", "/mode orchestration", start]);
  await confirmCheckpoint(c, p, sid);
});

test("the how-to-run goes unquoted", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Add hello.txt", howToRun: "test -f hello.txt" });
  await until(() => c.prompts().some((x) => x.message.startsWith("/factory start")), 5000, "factory start");
  assert.match(c.prompts().find((x) => x.message.startsWith("/factory start")).message, /^\/factory start \.factory\/ticket-\d+\.md test -f hello\.txt$/);
  await confirmCheckpoint(c, p, sid);
});

test("factory off sends /mode ask", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true);
  assert.deepEqual(await p.setFactory(sid, false), { factory: false, mode: "ask" });
  assert.deepEqual(promptsOf(c, 0), ["hello", "/mode orchestration", "/mode ask"]);
  assert.equal((await recordOf(p, sid)).factory, false);
});

test("the mode comes from the notify", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true);
  assert.equal((await recordOf(p, sid)).mode, "orchestration");

  const c2 = makeCase();
  const q = c2.open({ lc: { modeAckMs: 50, childEnv: { FAKE_PI_LOG: c2.logFile, FAKE_PI_NO_NOTIFY: "1" } } });
  t.after(c2.closeAll);
  const { sessionId: sid2 } = await q.prompt(undefined, "hello", c2.work, { engine: "lets-code" });
  await idleAfter(c2, sid2);
  const before = (await recordOf(q, sid2)).mode;
  const t0 = Date.now();
  await assert.rejects(q.setFactory(sid2, true), (err) => err.statusCode === 504 && err.message === "lets-code did not confirm the mode");
  assert.ok(Date.now() - t0 < 2000, "gave up after modeAckMs");
  assert.equal((await recordOf(q, sid2)).mode, before);
  assert.equal((await recordOf(q, sid2)).factory, false, "an unconfirmed toggle is not kept for the next spawn");
});

test("new session with factory:true sends /mode orchestration before the first prompt", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code", factory: true });
  await idleAfter(c, sid);
  assert.deepEqual(promptsOf(c, 0), ["/mode orchestration", "hello"]);
  const rec = await recordOf(p, sid);
  assert.equal(rec.factory, true);
  assert.equal(rec.mode, "orchestration");
  await assert.rejects(p.prompt(undefined, "x", c.work, { factory: true }), (err) => err.statusCode === 400 && err.message === "'factory' needs engine lets-code");
});

test("the factory never enables experts: lets-code's experts question is answered No and the refusal is reported", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_FACTORY_EXPERTS_ASK: "1" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Fix the CI", howToRun: "npm test" });
  await until(async () => (await recordOf(p, sid)).lastError?.text === "factory experts must be enabled by the operator", 5000, "lastError");
  await until(() => p.getStatus(sid).state === "idle", 5000, "idle");
  assert.ok(!c.frames.some((f) => f.sid === sid && f.type === "permission_request"), "the experts question never reaches the phone");
  const errors = c.frames.filter((f) => f.sid === sid && f.type === "error");
  assert.deepEqual(errors.map((f) => f.message), ["factory experts must be enabled by the operator"], "one error frame");
  const answers = c.log().filter((l) => l.type === "extension_ui_response");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].confirmed, false);
  assert.ok(!c.prompts().some((x) => x.message.startsWith("/experts")));
});

test("an unrelated warning while a factory start is pending is no refusal", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_FACTORY_WARN: "1" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Fix the CI" });
  await confirmCheckpoint(c, p, sid); // the run reached its checkpoint
  assert.ok(!c.frames.some((f) => f.sid === sid && f.type === "error"), "no error frame");
  assert.equal((await recordOf(p, sid)).lastError, null);
});

test("a single-expert question is answered No too", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "EXPERT1", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.ok(!c.frames.some((f) => f.sid === sid && f.type === "permission_request"));
  assert.equal(c.log().find((l) => l.type === "extension_ui_response").confirmed, false);
});

test("a refused factory start reaches the record and the agents list", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_FACTORY_REFUSE: "1" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Fix the CI" });
  const msg = "The factory needs these experts enabled: developer, tester (/experts enable <name>).";
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "error" && f.message === `lets-code refused the factory start: ${msg}`), 5000, "error frame");
  await until(async () => (await recordOf(p, sid)).lastError?.text === msg, 5000, "lastError");
  const row = (await p.listAgents()).find((a) => a.sid === sid);
  assert.equal(row.lastError.text, msg);
  assert.equal(typeof row.lastError.at, "number");
  // a later toggle clears it
  await until(() => p.getStatus(sid).state === "idle", 5000, "idle");
  await p.setFactory(sid, false);
  assert.equal((await recordOf(p, sid)).lastError, null);
});

/** The first run ended (a mode notify may come after its idle frame). */
const ranOnce = (c, p, sid) => until(() => c.frames.some((f) => f.sid === sid && f.type === "result") && p.getStatus(sid).state === "idle", 8000, "run ended");

test("setFactory on while the child starts waits for the start: the child ends in orchestration", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_START_DELAY_MS: "300" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await until(() => c.spawns().length === 1, 5000, "spawn");
  const r = await p.setFactory(sid, true); // the child is still starting
  assert.deepEqual(r, { factory: true, mode: "orchestration" });
  await ranOnce(c, p, sid);
  assert.ok(promptsOf(c, 0).includes("/mode orchestration"));
  assert.equal((await recordOf(p, sid)).mode, "orchestration");
});

test("setFactory off while a factory child starts: the last mode sent is ask", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_START_DELAY_MS: "300" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code", factory: true });
  await until(() => c.spawns().length === 1, 5000, "spawn");
  assert.deepEqual(await p.setFactory(sid, false), { factory: false, mode: "ask" });
  await ranOnce(c, p, sid);
  const modes = promptsOf(c, 0).filter((m) => m.startsWith("/mode"));
  assert.equal(modes.at(-1), "/mode ask");
  const rec = await recordOf(p, sid);
  assert.equal(rec.factory, false);
  assert.equal(rec.mode, "ask");
});

test("setFactory without a live child records the flag and reports no mode", async (t) => {
  const c = makeCase({ lc: { idleKeepMs: 0 } });
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await until(() => p._lc.liveCount() === 0, 5000, "idle stop");
  assert.deepEqual(await p.setFactory(sid, true), { factory: true, mode: null });
  assert.deepEqual(await p.setFactory(sid, false), { factory: false, mode: null });
});

test("provider-level factory guards: native 409, archived 404, a factory flag on an existing agent 400", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: nat } = await p.prompt(undefined, "hello", c.work, { name: "nat" });
  await assert.rejects(p.setFactory(nat, true), (e) => e.statusCode === 409 && e.message === "the factory needs the lets-code engine");
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await assert.rejects(p.prompt(sid, "x", undefined, { factory: true }), (e) => e.statusCode === 400 && /'factory' is set when an agent starts/.test(e.message));
  await p.stopSession(sid);
  await assert.rejects(p.setFactory(sid, true), (e) => e.statusCode === 404);
  await assert.rejects(p.setFactory("dur-nope", true), (e) => e.statusCode === 404);
});

test("a new agent with the factory on is refused 409 while the experts are off, and leaves no row", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  writeFileSync(c.stateFile, JSON.stringify({ experts: { developer: true } }));
  const count = () => [...p._map.rows({ seenSince: 0 })].length;
  const before = count();
  await assert.rejects(p.prompt(undefined, "hello", c.work, { engine: "lets-code", factory: true }), (e) => e.statusCode === 409 && e.reason === "experts_disabled");
  assert.equal(count(), before);
  assert.equal(c.spawns().length, 0);
});

test("factory worktrees get the project guard, a git exclude and pi trust; forget removes the trust entries", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_FACTORY_WORK: c.factoryRoot } } });
  t.after(c.closeAll);
  const trust = join(c.dir, "trust.json");
  writeFileSync(trust, JSON.stringify({ "/somewhere/else": true, [realpathSync(c.work)]: true }, null, 2));
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Fix the CI" });
  const work = join(c.factoryRoot, "20261103-093221-c129", "work");
  await until(() => existsSync(join(work, ".pi", "extensions", "even-guard.ts")), 5000, "worktree guard");
  const guard = readFileSync(join(work, ".pi", "extensions", "even-guard.ts"), "utf8");
  assert.match(guard, /guardDecision/);
  await until(() => JSON.parse(readFileSync(trust, "utf8"))[realpathSync(work)] === true, 5000, "trust entry");
  assert.ok(!existsSync(`${trust}.lock`), "the trust lock is released");
  await until(async () => (await recordOf(p, sid)).trusted?.includes(work), 5000, "record.trusted");
  // a plant in the worktree's .pi and a tampered guard are undone on the next watch tick
  const ext = join(work, ".pi", "extensions");
  writeFileSync(join(ext, "evil.ts"), "export default () => {}");
  writeFileSync(join(ext, "even-guard.ts"), "// gone");
  await until(() => !existsSync(join(ext, "evil.ts")) && /guardDecision/.test(readFileSync(join(ext, "even-guard.ts"), "utf8")), 5000, "sealed");
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "error" && /removed \.pi\/extensions\/evil\.ts/.test(f.message)), 5000, "removal frame");
  assert.ok(c.frames.some((f) => f.sid === sid && f.type === "error" && /was changed; restored/.test(f.message)));
  assert.ok(readdirSync(join(c.dir, "lc-quarantine", sid)).some((n) => n.endsWith("evil.ts")));
  await confirmCheckpoint(c, p, sid);
  await p.forgetSession(sid);
  await until(() => !(realpathSync(work) in JSON.parse(readFileSync(trust, "utf8"))), 5000, "trust removed");
  const left = JSON.parse(readFileSync(trust, "utf8"));
  assert.deepEqual(left, { "/somewhere/else": true }, "the session cwd and its worktree are gone; others stay");
});

// ── fix round 1 ──────────────────────────────────────────────────────────────

test("a prompt lets-code never accepted is sent again after a crash, never replaced by a cut-off prompt", async (t) => {
  const c = makeCase({ lc: { idleKeepMs: 0 } });
  const marker = join(c.dir, "die-once");
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_DIE_ONCE: marker, FAKE_PI_DIE_TEXT: "b" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "a", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await until(() => p._lc.liveCount() === 0, 5000, "idle stop");
  assert.ok(existsSync((await recordOf(p, sid)).piSessionFile), "the session file exists: the old heuristic would have sent the cut-off prompt");
  await p.prompt(sid, "b");
  await idleAfter(c, sid, 2);
  assert.ok(existsSync(marker), "the child died at prompt b");
  const spawns = c.spawns();
  assert.equal(spawns.length, 3);
  assert.deepEqual(c.prompts().filter((x) => x._pid === spawns[2].pid).map((x) => x.message), ["b"]);
  assert.ok(!c.prompts().some((x) => x.message === LC_CUTOFF_PROMPT || x.message === LC_CRASH_PROMPT));
  assert.equal(c.frames.filter((f) => f.sid === sid && f.type === "text_delta").map((f) => f.text).join("|"), "ok: a|ok: b");
});

test("a crash after lets-code accepted the prompt continues with the crash prompt and says so", async (t) => {
  const c = makeCase();
  const marker = join(c.dir, "crash-once");
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_CRASH_ONCE: marker } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "work", c.work, { engine: "lets-code" });
  await until(() => c.prompts().some((x) => x.message === LC_CRASH_PROMPT), 8000, "crash prompt");
  await idleAfter(c, sid);
  assert.equal(c.prompts().filter((x) => x.message === "work").length, 1, "never re-sent");
  assert.equal(c.prompts().filter((x) => x.message === LC_CRASH_PROMPT).length, 1);
  assert.ok(!c.prompts().some((x) => x.message === LC_CUTOFF_PROMPT), "not a bridge restart");
  assert.ok(c.frames.some((f) => f.sid === sid && f.type === "error" && /^lets-code exited mid-turn; starting it again \(attempt 2 of 6\)$/.test(f.message)));
  assert.equal((await recordOf(p, sid)).sentTaskId != null, true);
});

test("a respawn first resets a failed scope of the same name, and the scope is collected", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { wrapper: "systemd-run", spawnWrap: () => [] } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.ok(c.runs.some((r) => r.join(" ") === `systemctl --user reset-failed even-lc-${sid}.scope`), JSON.stringify(c.runs));
  assert.ok(p._lc._launches.get(sid).wrap.includes("--collect"));
});

test("the spawn writes the project-local guard for the subagents", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  const f = join(c.work, ".pi", "extensions", "even-guard.ts");
  assert.ok(existsSync(f));
  assert.match(readFileSync(f, "utf8"), /guard-core\.mjs/);
});

test("an idle-kept child is stopped before the new one is admitted (admit is awaited)", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: a } = await p.prompt(undefined, "one", c.work, { engine: "lets-code" });
  await idleAfter(c, a);
  assert.equal(p._lc.liveCount(), 1);
  await p.prompt(undefined, "two", c.work, { engine: "lets-code" });
  assert.equal(p._lc._states.get(a).session, null, "stopped by the time the prompt returned");
});

test("two new agents at once at the limit: one 429 and no empty row", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const results = await Promise.allSettled([
    p.prompt(undefined, "HANG", c.work, { engine: "lets-code" }),
    p.prompt(undefined, "HANG", c.work, { engine: "lets-code" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.statusCode, 429);
  assert.equal([...p._map.rows()].length, 1, "the refused start left no row");
});

test("a run resumed after a restart counts toward the live limit", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile } } });
  await a.prompt(undefined, "HANG", c.work, { engine: "lets-code" });
  await until(() => c.prompts().length === 1, 5000, "HANG");
  await a.stopAll();
  const b = c.open();
  await b.ready;
  await assert.rejects(b.prompt(undefined, "x", c.work, { engine: "lets-code" }), (e) => e.statusCode === 429);
});

test("a child stopped while idle leaves no lets-code-sessions/<pid>.json", async (t) => {
  const c = makeCase({ lc: { idleKeepMs: 400 } });
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  const pid = (await recordOf(p, sid)).childPid;
  const reg = join(c.registryRoot, `${pid}.json`);
  writeFileSync(reg, "{}");
  await until(() => p._lc.liveCount() === 0, 5000, "idle stop");
  await until(() => !existsSync(reg), 3000, "registry file removed");
});

test("lc.tool entries are capped per run", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "TOOLS25", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await until(async () => (await entriesOf(p, sid)).some((e) => e.kind === "lc.answer"), 5000, "answer");
  await sleep(200);
  const tools = (await entriesOf(p, sid)).filter((e) => e.kind === "lc.tool").map((e) => e.data.text);
  assert.equal(tools.length, 21);
  assert.equal(tools.at(-1), "(+5 more tool calls)");
});

test("a retried requestId whose first try failed before its commit is accepted", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "first", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  const h = p._harness;
  const orig = h.commit.bind(h);
  let fail = true;
  h.commit = (fn, ...rest) => (fail ? ((fail = false), Promise.reject(new Error("store hiccup"))) : orig(fn, ...rest));
  await assert.rejects(p.prompt(sid, "x", undefined, { requestId: "r9" }), /store hiccup/);
  h.commit = orig;
  await p.prompt(sid, "x", undefined, { requestId: "r9" });
  await idleAfter(c, sid, 2);
  assert.equal(c.prompts().filter((x) => x.message === "x").length, 1);
});

test("setFactory with a ticket is refused 409 experts_disabled while the experts are off; nothing is written or sent", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  writeFileSync(c.stateFile, JSON.stringify({ experts: { researcher: true, developer: true } }));
  const before = readFileSync(c.stateFile, "utf8");
  await assert.rejects(p.setFactory(sid, true, { ticket: "Fix the CI" }), (e) => e.statusCode === 409 && e.reason === "experts_disabled" && /factory experts must be enabled by the operator/.test(e.message));
  assert.ok(!existsSync(join(c.work, ".factory")), "no ticket written");
  assert.ok(!c.prompts().some((x) => x.message.startsWith("/factory") || x.message.startsWith("/mode")));
  assert.equal(readFileSync(c.stateFile, "utf8"), before, "the state file is only read");
  assert.equal((await recordOf(p, sid)).factory, false);
  // Orchestration without the stage experts is refused too (Task 3 fix round); off always works.
  await assert.rejects(p.setFactory(sid, true), (e) => e.statusCode === 409 && e.reason === "experts_disabled");
  assert.deepEqual(await p.setFactory(sid, false), { factory: false, mode: "ask" });
});


test("a plant in the session cwd's .pi is quarantined after the next tool call", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  writeFileSync(join(c.work, ".pi", "settings.json"), "{}"); // e.g. unpacked by a bash command
  await p.prompt(sid, "TOOL");
  await idleAfter(c, sid, 2);
  assert.ok(!existsSync(join(c.work, ".pi", "settings.json")));
  assert.ok(c.frames.some((f) => f.sid === sid && f.type === "error" && /removed \.pi\/settings\.json/.test(f.message)));
});

test("the trust of a factory run that ended is dropped", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_FACTORY_WORK: c.factoryRoot } } });
  t.after(c.closeAll);
  const trust = join(c.dir, "trust.json");
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Fix the CI" });
  const id = "20261103-093221-c129";
  const work = join(c.factoryRoot, id, "work");
  await until(() => existsSync(trust) && JSON.parse(readFileSync(trust, "utf8"))[realpathSync(work)] === true, 5000, "trusted");
  const L = JSON.parse(readFileSync(join(c.factoryRoot, id, "ledger.json"), "utf8"));
  writeFileSync(join(c.factoryRoot, id, "ledger.json"), JSON.stringify({ ...L, status: "done" }));
  await until(() => !(realpathSync(work) in JSON.parse(readFileSync(trust, "utf8"))), 5000, "trust dropped");
  await until(async () => ((await recordOf(p, sid)).trusted ?? []).length === 0, 5000, "record.trusted empty");
  await confirmCheckpoint(c, p, sid);
});


// ── fix round 3 ──────────────────────────────────────────────────────────────

test("the cwd's .pi is sealed on a timer while a child lives, outside any factory run", async (t) => {
  const c = makeCase({ lc: { sealMs: 50 } });
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.equal(p._lc.liveCount(), 1, "the child is idle-kept");
  writeFileSync(join(c.work, ".pi", "extensions", "evil.ts"), "export default () => {}");
  await until(() => !existsSync(join(c.work, ".pi", "extensions", "evil.ts")), 3000, "timer seal");
  assert.ok(c.frames.some((f) => f.sid === sid && f.type === "error" && /removed \.pi\/extensions\/evil\.ts/.test(f.message)));
  const spawn = c.spawns()[0];
  assert.ok(spawn, "spawned");
});

test("the child gets EVEN_GUARD_QUARANTINE for its own seal", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.equal(c.spawns()[0].env.EVEN_GUARD_QUARANTINE, join(c.dir, "lc-quarantine", sid));
});

test("a repo that tracks a .pi dir gets no lets-code agent (409 repo_tracks_pi, no row, no spawn)", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const git = (args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: c.work, stdio: ["ignore", "pipe", "ignore"] });
  mkdirSync(join(c.work, ".pi"), { recursive: true });
  writeFileSync(join(c.work, ".pi", "settings.json"), "{}");
  git(["init", "-q"]);
  git(["add", ".pi/settings.json"]);
  git(["commit", "-q", "-m", "tracks .pi"]);
  const rows = () => [...p._map.rows({ seenSince: 0 })].length;
  const before = rows();
  await assert.rejects(p.prompt(undefined, "hello", c.work, { engine: "lets-code" }), (e) => e.statusCode === 409 && e.reason === "repo_tracks_pi" && /tracks a \.pi dir/.test(e.message));
  assert.equal(rows(), before);
  assert.equal(c.spawns().length, 0);
  assert.ok(existsSync(join(c.work, ".pi", "settings.json")), "the tracked file is left alone");
});

test("a cwd whose .pi cannot be sealed gets no child: error frame, failed run", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(async () => {
    chmodSync(join(c.work, ".pi", "extensions"), 0o755);
    await c.closeAll();
  });
  mkdirSync(join(c.work, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(c.work, ".pi", "extensions", "evil.ts"), "export default () => {}");
  chmodSync(join(c.work, ".pi", "extensions"), 0o555); // neither movable nor removable
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await until(() => c.frames.some((f) => f.sid === sid && f.type === "error" && /could not seal .*lets-code was not started/.test(f.message)), 5000, "seal error");
  await until(() => p.getStatus(sid).state === "idle", 5000, "idle");
  assert.equal(c.spawns().length, 0, "no child");
});

// ── per-run caps: turns (EVEN_BRIDGE_LC_MAX_TURNS / the agent's maxTurns) and identical consecutive tool calls ──

test("the turn cap: default 40, at most 200, a bad value keeps the default", () => {
  assert.equal(LC_MAX_TURNS_DEFAULT, 40);
  assert.equal(LC_MAX_TURNS_CEILING, 200);
  assert.equal(LC_REPEAT_MAX, 8);
  const bad = [];
  const warn = (m) => bad.push(m);
  assert.equal(lcTurnCap(undefined, warn), 40);
  assert.equal(lcTurnCap("", warn), 40);
  assert.equal(lcTurnCap("12", warn), 12);
  assert.equal(lcTurnCap(" 7 ", warn), 7);
  assert.equal(bad.length, 0);
  assert.equal(lcTurnCap("0", warn), 40);
  assert.equal(lcTurnCap("x", warn), 40);
  assert.equal(lcTurnCap("-3", warn), 40);
  assert.equal(lcTurnCap("2.5", warn), 40);
  assert.equal(lcTurnCap("201", warn), 200);
  assert.equal(lcTurnCap("5000", warn), 200);
  assert.equal(bad.length, 6);
  assert.equal(lcTurnCapMessage(40), "lets-code run stopped after 40 turns (cap)");
});

/** The run of `sid` stopped at a cap: its error frame and the end of the run (idle). */
const cappedRun = (c, p, sid, re) =>
  until(() => c.frames.some((f) => f.sid === sid && f.type === "error" && re.test(f.message)) && p.getStatus(sid).state === "idle", 8000, "capped run");
const lcTasks = async (p) => {
  const { ctx } = await p.ready;
  return (await p._harness.inspect(ctx)).tasks.filter((x) => x.record.kind === LC_RUN_TASK);
};

test("a looping child is stopped at exactly the turn cap: aborted (not killed), error frame, record, agent row, session_read, audit", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { maxTurns: "6" } });
  const audit = createAuditLog(join(c.dir, "audit.log"));
  const caps = [];
  p.onLcCap = (ev) => (caps.push(ev), audit.write(lcCapAuditEvent(ev)));
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "LOOPVARY", c.work, { engine: "lets-code", name: "looper" });
  const msg = lcTurnCapMessage(6);
  assert.equal(msg, "lets-code run stopped after 6 turns (cap)");
  await cappedRun(c, p, sid, /stopped after 6 turns \(cap\)/);
  const mine = c.frames.filter((f) => f.sid === sid);
  assert.deepEqual(mine.filter((f) => f.type === "error").map((f) => f.message), [msg], "one error frame");
  // The bridge counted exactly 6 turns, then aborted the turn once; the child was not killed.
  const aborts = c.log().filter((l) => l.type === "abort");
  assert.equal(aborts.length, 1);
  const aborted = c.log().find((l) => l.aborted);
  assert.ok(aborted.loopTurns >= 6 && aborted.loopTurns <= 8, `abort after ${aborted.loopTurns} loop turns`);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].turns, 6);
  assert.equal(caps[0].cap, 6);
  assert.equal(caps[0].reason, "turns");
  assert.equal(caps[0].label, "looper");
  assert.equal(c.spawns().length, 1);
  assert.ok(p._lc._states.get(sid).session?.running, "the child stays (idle-kept)");
  // record, agent row, task outcome
  await until(async () => (await recordOf(p, sid)).lastError?.text === msg, 5000, "lastError");
  assert.equal((await recordOf(p, sid)).lastError.reason, "cap");
  const row = (await p.listAgents()).find((a) => a.sid === sid);
  assert.equal(row.lastError.text, msg);
  assert.equal(row.state, "idle");
  await until(async () => (await lcTasks(p)).length === 0, 5000, "task terminal");
  // the overseer's session_read
  const host = createOverseerHost({ durable: p, log: QUIET });
  const read = await host.sessionRead(sid, 5);
  assert.match(read, /\nstatus: idle\nlast error: lets-code run stopped after 6 turns \(cap\)\n/);
  // the audit line
  const lines = readFileSync(join(c.dir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { ...lines[0], ts: 0 },
    { ts: 0, event: "lc_cap", sid, label: "looper", reason: "turns", turns: 6, cap: 6, summary: msg, by: "bridge" },
  );
});

test("an agent's own lower maxTurns wins; a higher one does not raise the cap", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { maxTurns: "5" } });
  t.after(c.closeAll);
  const { sessionId: low } = await p.prompt(undefined, "LOOPVARY", c.work, { engine: "lets-code", maxTurns: 3 });
  await cappedRun(c, p, low, /stopped after 3 turns \(cap\)/);
  await until(async () => (await lcTasks(p)).length === 0, 5000, "task terminal");
  await p.stopSession(low).catch(() => {});
  const { sessionId: high } = await p.prompt(undefined, "LOOPVARY", c.work, { engine: "lets-code", maxTurns: 50 });
  await cappedRun(c, p, high, /stopped after 5 turns \(cap\)/);
  assert.equal(p._map.get(high).max_turns, 50);
});

test("the default turn cap is 40; a lets-code row without its own maxTurns keeps none", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  await p.ready;
  assert.equal(p._lc.turnCap, 40);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.equal(p._map.get(sid).max_turns, null);
});

test("identical consecutive tool calls stop the run at the 8th, through the same abort path", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { maxTurns: "100" } });
  const caps = [];
  p.onLcCap = (ev) => caps.push(ev);
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "LOOP", c.work, { engine: "lets-code" });
  const msg = lcRepeatCapMessage("write", 8);
  assert.equal(msg, "lets-code run stopped: repeated tool call (write, 8 times in a row)");
  await cappedRun(c, p, sid, /repeated tool call/);
  assert.deepEqual(c.frames.filter((f) => f.sid === sid && f.type === "error").map((f) => f.message), [msg]);
  assert.equal(c.log().filter((l) => l.type === "abort").length, 1);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].reason, "repeat");
  assert.equal(caps[0].tool, "write");
  assert.equal(caps[0].repeats, 8);
  await until(async () => (await recordOf(p, sid)).lastError?.text === msg, 5000, "lastError");
  assert.equal(c.spawns().length, 1);
  await until(async () => (await lcTasks(p)).length === 0, 5000, "task terminal");
});

test("varying args never trip the repeat cap", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { maxTurns: "12" } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "LOOPVARY", c.work, { engine: "lets-code" });
  await cappedRun(c, p, sid, /stopped after 12 turns/);
  assert.ok(!c.frames.some((f) => f.sid === sid && /repeated tool call/.test(f.message ?? "")));
});

test("both caps leave the record resumable: the next prompt starts a new run on the same child and clears the cap error", async (t) => {
  for (const [loop, re] of [
    ["LOOPVARY", /stopped after 4 turns/],
    ["LOOP", /repeated tool call/],
  ]) {
    const c = makeCase();
    const p = c.open({ lc: { maxTurns: loop === "LOOP" ? "50" : "4" } });
    t.after(c.closeAll);
    const { sessionId: sid } = await p.prompt(undefined, loop, c.work, { engine: "lets-code" });
    await cappedRun(c, p, sid, re);
    await until(async () => (await lcTasks(p)).length === 0, 5000, "task terminal");
    await until(async () => (await recordOf(p, sid)).lastError?.reason === "cap", 5000, "lastError");
    const results = c.frames.filter((f) => f.sid === sid && f.type === "result").length;
    await p.prompt(sid, "hello again");
    await idleAfter(c, sid, results + 1);
    const rec = await recordOf(p, sid);
    assert.equal(rec.lastError, null, `${loop}: the new run cleared the cap error`);
    assert.equal(rec.lastLine, "ok: hello again");
    assert.equal(rec.runs, 2);
    assert.equal(c.spawns().length, 1, `${loop}: same child`);
    assert.equal(c.frames.filter((f) => f.sid === sid && f.type === "error").length, 1, `${loop}: no second error`);
    // a new loop gets the full budget again (the counters are per run)
    const before = c.frames.filter((f) => f.sid === sid && f.type === "error").length;
    await p.prompt(sid, loop);
    await until(() => c.frames.filter((f) => f.sid === sid && f.type === "error").length === before + 1, 8000, "second cap");
    assert.match(c.frames.filter((f) => f.sid === sid && f.type === "error").at(-1).message, re);
  }
});

test("a factory refusal's lastError is not cleared by the next run (only a cap's is)", async (t) => {
  const c = makeCase();
  const p = c.open({ lc: { childEnv: { FAKE_PI_LOG: c.logFile, FAKE_PI_FACTORY_REFUSE: "1" } } });
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  await p.setFactory(sid, true, { ticket: "Fix the CI" });
  await until(async () => /factory needs these experts/.test((await recordOf(p, sid)).lastError?.text ?? ""), 5000, "lastError");
  await until(() => p.getStatus(sid).state === "idle", 5000, "idle");
  const results = c.frames.filter((f) => f.sid === sid && f.type === "result").length;
  await p.prompt(sid, "hello");
  await idleAfter(c, sid, results + 1);
  assert.match((await recordOf(p, sid)).lastError.text, /factory needs these experts/);
});

test("session_read of an agent without a last error is unchanged; native rows have none", async (t) => {
  const c = makeCase();
  const p = c.open();
  t.after(c.closeAll);
  const { sessionId: sid } = await p.prompt(undefined, "hello", c.work, { engine: "lets-code" });
  await idleAfter(c, sid);
  assert.equal(await p.lastError(sid), null);
  const host = createOverseerHost({ durable: p, log: QUIET });
  const read = await host.sessionRead(sid, 5);
  assert.doesNotMatch(read, /last error/);
  assert.match(read, /\nstatus: idle\n/);
});
