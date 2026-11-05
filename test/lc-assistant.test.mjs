// The Even AI assistant profile of the lets-code engine (plan Task A1): a real Harness on a SQLite file
// (restarts are real), the fake lets-code (test/helpers/fake-pi-rpc.mjs) as the child, no scope wrapper.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDurableProvider, ASSISTANT_SID as PROVIDER_SID, ASSISTANT_TITLE as PROVIDER_TITLE, ASSISTANT_CWD as PROVIDER_CWD } from "../src/providers/durable/provider.mjs";
import { fakeModelsJson } from "./helpers/fake-openai.mjs";
import { LcSessionDoc } from "../src/providers/durable/lc/record.mjs";
import { LC_CRASH_PROMPT, LC_CUTOFF_PROMPT, LC_RUN_TASK } from "../src/providers/durable/lc/task.mjs";
import { assistantLaunch, assistantScopeUnit } from "../src/providers/durable/lc/launch.mjs";
import {
  ASSISTANT_ABORT_GRACE_MS,
  ASSISTANT_CWD,
  ASSISTANT_HANDOFF,
  ASSISTANT_KEEP_RECENT_TOKENS,
  ASSISTANT_LOST,
  ASSISTANT_MAX_TOOL_CALLS,
  ASSISTANT_MODEL,
  ASSISTANT_MODULE_ENV,
  ASSISTANT_NIGHTLY_TASK,
  ASSISTANT_NO_SUMMARY_NOTE,
  ASSISTANT_NOTE_CMD,
  ASSISTANT_RESET_HOUR,
  ASSISTANT_RESET_RETRY_MS,
  ASSISTANT_RESTART_NOTE,
  ASSISTANT_RUN_DEADLINE_S,
  ASSISTANT_SID,
  ASSISTANT_THINKING,
  ASSISTANT_TITLE,
  ASSISTANT_TOOLS,
  nextResetAt,
  portIsFree,
} from "../src/providers/durable/lc/assistant.mjs";

const FAKE = fileURLToPath(new URL("./helpers/fake-pi-rpc.mjs", import.meta.url));
chmodSync(FAKE, 0o755);
const QUIET = { warn() {}, error() {}, log() {} };

let root;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lc-assistant-")));
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

/** A fake Harness clock (as in overseer-checkins.test.mjs): timers > 5 s fire only on advance(). */
function fakeClock(offset = 0) {
  const waiting = new Set();
  const c = {
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
    stop() {
      waiting.clear();
    },
  };
  return c;
}
const localAt = (h, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

let n = 0;
/**
 * A case dir; `open()` builds a provider with the assistant on its store (call again for a "restart").
 * `noLc`: the agent engine flag off (the engine serves the assistant only).
 */
function makeCase({ lc = {}, assistant = {}, env = {}, noLc = false, clock } = {}) {
  const dir = join(root, `case-${++n}`);
  const work = join(dir, "agents", "work");
  mkdirSync(work, { recursive: true });
  const logFile = join(dir, "fake.log");
  const frames = [];
  const providers = [];
  const registryRoot = join(dir, "lc-registry");
  mkdirSync(registryRoot, { recursive: true });
  const engineSeams = {
    bin: FAKE,
    caps: { memoryMax: "500M", cpuQuota: "200%" },
    wrapper: "none",
    memoryController: false,
    crashDelayMs: 0,
    registryRoot,
    runsRoot: join(dir, "lc-runs"),
    childEnv: { FAKE_PI_LOG: logFile, ...env },
    trustFile: join(dir, "trust.json"),
    stateFile: join(dir, "lc-state.json"),
  };
  const open = ({ noLc: noLcNow = noLc } = {}) => {
    const noLc = noLcNow;
    const p = createDurableProvider((sid, frame) => frames.push({ sid, ...frame }), {
      hub: { clientCount: () => 0 },
      storePath: join(dir, "durable.sqlite"),
      modelsPath: join(root, "models.json"),
      settingsPath: join(dir, "no-settings.json"),
      defaultCwd: work,
      allowedCwds: [join(dir, "agents")],
      guard: { wrapper: "none", log: () => {} },
      log: QUIET,
      agentsDir: join(dir, "no-agents"),
      scopeRunner: () => ({ status: 0 }),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BRIDGE_TOKEN: "bridge-secret", LETS_CODE_TOKEN: "lc-secret" },
      ...(noLc ? {} : { lc: { ...engineSeams, maxLive: 1, sandbox: false, idleKeepMs: 60_000, ...lc } }),
      assistant: {
        toolsUrl: "http://127.0.0.1:9",
        tokenFile: join(dir, "token"),
        ext: join(dir, "even-assistant.ts"),
        cwd: join(dir, "assistant"),
        bin: FAKE,
        toolsWaitMs: 1500,
        portFree: async () => true,
        ...(noLc ? { engine: engineSeams } : {}),
        ...assistant,
      },
      ...(clock ? { clock: { now: clock.now, setTimer: clock.setTimer } } : {}),
    });
    providers.push(p);
    return p;
  };
  const log = () => readLog(logFile);
  const mine = () => frames.filter((f) => f.sid === ASSISTANT_SID);
  return {
    dir,
    work,
    logFile,
    frames,
    open,
    log,
    mine,
    spawns: () => log().filter((l) => l.spawn && l.argv.includes("--tools")),
    agentSpawns: () => log().filter((l) => l.spawn && !l.argv.includes("--tools")),
    prompts: () => log().filter((l) => l.type === "prompt"),
    notes: () => log().filter((l) => "note" in l),
    types: () => log().filter((l) => l.type && l.type !== "get_state").map((l) => (l.type === "prompt" && String(l.message).startsWith("/") ? String(l.message).split(" ")[0] : l.type)),
    closeAll: async () => {
      for (const p of providers) await p.stopAll().catch(() => {});
    },
  };
}

/** Open, wait for the store and the warm child. */
async function warm(c) {
  const p = c.open();
  await p.ready;
  await p.assistant.ready;
  return p;
}
/** The `count`-th run of the assistant ended (its result frame and the idle after it). */
const idleAfter = (c, count = 1) =>
  until(() => c.mine().filter((f) => f.type === "result").length >= count && c.mine().at(-1)?.state === "idle", 8000, `assistant run #${count} idle`);
async function recordOf(p) {
  const { ctx } = await p.ready;
  return p._harness.snapshot(LcSessionDoc, p._map.get(ASSISTANT_SID).conversation_id, ctx);
}
const childPid = (p) => p._lc.session(ASSISTANT_SID)?.childPid;
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("constants", () => {
  assert.equal(ASSISTANT_SID, "dur-assistant");
  assert.equal(ASSISTANT_TITLE, "Even AI");
  assert.equal(ASSISTANT_CWD, "~/sandbox/assistant");
  assert.equal(ASSISTANT_MODEL, "lets-code/qwen3.8-27b");
  assert.equal(ASSISTANT_THINKING, "medium");
  assert.equal(ASSISTANT_RESET_HOUR, 4);
  assert.equal(ASSISTANT_RESET_RETRY_MS, 600000);
  assert.match(ASSISTANT_RESTART_NOTE, /^\(bridge restarted; your last answer was lost\./);
  assert.match(ASSISTANT_RESTART_NOTE, /do not answer or continue that interrupted request unless the user asks for it again/i);
  assert.equal(ASSISTANT_LOST, "I lost that one, please ask again.");
  assert.match(ASSISTANT_HANDOFF, /^Keep open questions, pending tasks and the user's stated plans\./);
  assert.match(ASSISTANT_HANDOFF, /Do not copy calendar events, notes, quick-list items or any other phone data/, "the summary must not carry phone data (A0, A1 real run)");
  assert.equal(ASSISTANT_NOTE_CMD, "/even-note");
  assert.equal(ASSISTANT_NIGHTLY_TASK, "even.assistant-nightly");
  assert.equal(ASSISTANT_RUN_DEADLINE_S, 20);
  assert.equal(ASSISTANT_MAX_TOOL_CALLS, 8);
  assert.equal(ASSISTANT_TOOLS.length, 17);
  assert.equal(ASSISTANT_TOOLS.at(-1), "memory");
  assert.equal(ASSISTANT_MODULE_ENV.LETS_CODE_CORE_MEMORY, "true");
  assert.equal(ASSISTANT_MODULE_ENV.LETS_CODE_SUBAGENTS, "false");
  assert.ok(!Object.keys(ASSISTANT_MODULE_ENV).some((k) => k.endsWith("_ON")), "lets-code ignores the _ON names (A0)");
  // The provider mirrors them (it must not import assistant.mjs with the flag off).
  assert.equal(PROVIDER_SID, ASSISTANT_SID);
  assert.equal(PROVIDER_TITLE, ASSISTANT_TITLE);
  assert.equal(PROVIDER_CWD, ASSISTANT_CWD);
});

test("assistant argv has no mandate, sandbox or subagents and loads only its extensions", () => {
  const l = assistantLaunch({
    cwd: "/h/sandbox/assistant",
    sessionDir: "/s/lc-sessions/dur-assistant",
    bin: "lets-code",
    extDir: "/h/.pi/agent/extensions/lets-code",
    assistantExt: "/b/src/providers/durable/lc/even-assistant.ts",
    tools: ["fetch_calendar", "memory"],
    thinking: "medium",
    caps: { memoryMax: null, cpuQuota: "200%" },
    wrapper: "none",
    moduleEnv: {},
    toolsUrl: "http://127.0.0.1:8814",
    tokenFile: "/k/token",
  });
  // The plan's argv plus A0's `--no-mandate` (no env switch removes the mandate module) and `--approve`
  // (pi reads <cwd>/.pi/settings.json, the small keepRecentTokens the reset's compact needs).
  assert.deepEqual(l.extraArgs, [
    "-ne", "-e", "/h/.pi/agent/extensions/lets-code", "-e", "/b/src/providers/durable/lc/even-assistant.ts",
    "--tools", "fetch_calendar,memory", "--thinking", "medium", "--session-dir", "/s/lc-sessions/dur-assistant",
    "--no-mandate", "--approve", "--no-skills", "--no-prompt-templates", "--no-context-files",
  ]);
  for (const f of ["--mandate", "--sandbox", "--subagents"]) assert.ok(!l.extraArgs.includes(f), f);
  assert.deepEqual(l.wrap, []);
  assert.equal(l.resume, undefined);
  const r = assistantLaunch({ cwd: "/a", sessionDir: "/s", assistantExt: "/x.ts", sessionFile: "/s/f.jsonl", model: "lets-code/other", bin: "/opt/lets-code" });
  assert.equal(r.resume, "/s/f.jsonl", "--session is PiRpcClient's resume");
  assert.deepEqual(r.extraArgs.slice(-2), ["--model", "other"], "lets-code strips its own prefix");
  const w = assistantLaunch({ cwd: "/a", sessionDir: "/s", assistantExt: "/x.ts", wrapper: "systemd-run", unit: "even-lc-dur-assistant-0123abcd", caps: { memoryMax: "500M", cpuQuota: "200%" } });
  assert.deepEqual(w.wrap, ["systemd-run", "--user", "--scope", "-q", "--collect", "--unit=even-lc-dur-assistant-0123abcd", "-p", "MemoryMax=500M", "-p", "MemorySwapMax=0", "-p", "CPUQuota=200%", "--"]);
});

test("assistant env carries the token file path, no token, and keeps pi in the scope", () => {
  const l = assistantLaunch({
    cwd: "/h/sandbox/assistant",
    sessionDir: "/s",
    assistantExt: "/x.ts",
    moduleEnv: { LETS_CODE_CORE_MEMORY: "true", LETS_CODE_SUBAGENTS: "false" },
    toolsUrl: "http://127.0.0.1:8814",
    tokenFile: "/k/token",
    schemaCache: "/s/assistant-tools-schema.json",
    baseEnv: { PATH: "/usr/bin", HOME: "/h", BRIDGE_TOKEN: "b", LETS_CODE_TOKEN: "l", ANTHROPIC_API_KEY: "k", EVEN_ASSISTANT_TOOLS_TOKEN: "t" },
  });
  assert.equal(l.env.EVEN_ASSISTANT_TOOLS_TOKEN_FILE, "/k/token");
  assert.equal(l.env.EVEN_ASSISTANT_TOOLS_URL, "http://127.0.0.1:8814");
  assert.equal(l.env.EVEN_ASSISTANT_SCHEMA_CACHE, "/s/assistant-tools-schema.json");
  assert.deepEqual(Object.keys(l.env).filter((k) => /TOKEN$|_KEY$/.test(k)), []);
  assert.equal(l.env.LETS_CODE_MEM_WATCH, "false");
  assert.equal(l.env.LETS_CODE_MEM_GUARD, "false");
  assert.equal(l.env.PI_TELEMETRY, "0");
  assert.equal("EVEN_GUARD_CWD" in l.env, false, "no guard");
  assert.equal(l.env.LETS_CODE_CORE_MEMORY, "true");
  assert.equal(l.env.LETS_CODE_SUBAGENTS, "false");
  // The scope carries the store: a throwaway bridge never touches the live bridge's assistant.
  const a = assistantScopeUnit("/home/ay/.even-terminal");
  assert.match(a, /^even-lc-dur-assistant-[0-9a-f]{8}$/);
  assert.notEqual(a, assistantScopeUnit("/home/ay/tmp/ovs-a1-store"));
  assert.equal(a, assistantScopeUnit("/home/ay/.even-terminal/"), "the same store, the same unit");
});

test("the assistant is warm at start and respawns with --session after an exit", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  assert.equal(c.spawns().length, 1, "one warm child, no prompt needed");
  assert.equal(p.assistant.state().status, "idle");
  assert.equal(p.assistant.state().toolsLoaded, ASSISTANT_TOOLS.length);
  assert.equal(p.assistant.state().toolsSource, "live");
  const spawn = c.spawns()[0];
  assert.equal(spawn.cwd, join(c.dir, "assistant"));
  assert.equal(spawn.env.EVEN_ASSISTANT_TOOLS_TOKEN_FILE, join(c.dir, "token"));
  assert.equal(spawn.env.LETS_CODE_TOKEN, undefined);
  assert.equal(spawn.env.BRIDGE_TOKEN, undefined);
  // The reset's compact needs a small kept tail: the project settings pi reads with --approve.
  const settings = JSON.parse(readFileSync(join(c.dir, "assistant", ".pi", "settings.json"), "utf8"));
  assert.equal(settings.compaction.keepRecentTokens, ASSISTANT_KEEP_RECENT_TOKENS);
  assert.equal(statSync(join(c.dir, "lc-sessions", "dur-assistant-notes")).mode & 0o777, 0o700);
  await p.assistant.prompt("hi", { requestId: "w1" });
  await idleAfter(c);
  const rec = await recordOf(p);
  assert.ok(rec.piSessionFile && existsSync(rec.piSessionFile));
  const pid = childPid(p);
  const killedAt = Date.now();
  process.kill(pid, "SIGKILL");
  await until(() => c.spawns().length === 2, 10000, "respawn");
  assert.ok(Date.now() - killedAt >= 1800, "after the 2 s backoff");
  const again = c.spawns()[1];
  assert.equal(again.argv[again.argv.indexOf("--session") + 1], rec.piSessionFile);
  assert.equal(again.argv[again.argv.indexOf("--thinking") + 1], "medium", "medium on every respawn");
  await until(() => p.assistant.state().status === "idle", 5000, "idle again");
});

test("the assistant takes no agent slot", async (t) => {
  const c = makeCase({ lc: { maxLive: 1 } });
  t.after(c.closeAll);
  const p = await warm(c);
  const pid = childPid(p);
  const { sessionId: sid } = await p.prompt(undefined, "HANG", c.work, { engine: "lets-code", name: "agent1" });
  await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "agent HANG");
  await sleep(300);
  // The warm assistant is never the idle child that makes room for an agent at the live limit.
  assert.equal(childPid(p), pid, "the assistant child was not stopped");
  assert.equal(c.spawns().length, 1, "and not respawned");
  assert.equal(p.assistant.state().status, "idle");
  assert.equal(p._lc.liveCount(), 1, "only the agent counts");
  const agents = await p.listAgents();
  assert.deepEqual(agents.map((a) => a.sid), [sid]);
  assert.equal(c.agentSpawns().length, 1);
  assert.equal(c.agentSpawns()[0].argv.includes("--mandate"), true);
});

test("the assistant is never idle-stopped", async (t) => {
  const c = makeCase({ lc: { idleKeepMs: 200 } });
  t.after(c.closeAll);
  const p = await warm(c);
  const pid = childPid(p);
  await p.assistant.prompt("hi", { requestId: "k1" });
  await idleAfter(c);
  await sleep(1000);
  assert.equal(childPid(p), pid, "still the same child 1 s after a run (idle keep 200 ms)");
  assert.equal(c.spawns().length, 1);
  assert.equal(p.assistant.state().status, "idle");
});

test("a respawn comes back on qwen at medium, also after a Claude switch", async (t) => {
  const c = makeCase({ env: { FAKE_PI_RESTORE_MODEL: "1" } });
  t.after(c.closeAll);
  const p = await warm(c);
  const first = c.spawns()[0];
  assert.equal(first.argv[first.argv.indexOf("--model") + 1], ASSISTANT_MODEL, "--model always (pi would restore the session's model)");
  await p.assistant.prompt("hi", { requestId: "q1" });
  await idleAfter(c);
  await p.assistant.setModel({ model: "Anthropic/claude-sonnet-4-6", thinking: "low" });
  assert.equal(p.assistant.state().model, "Anthropic/claude-sonnet-4-6");
  const mark = c.log().length;
  process.kill(childPid(p), "SIGKILL");
  await until(() => c.spawns().length === 2, 10000, "respawn");
  await until(() => p.assistant.state().status === "idle", 5000, "idle");
  const again = c.spawns()[1];
  assert.equal(again.argv[again.argv.indexOf("--model") + 1], ASSISTANT_MODEL);
  // The fake restored claude from the session file anyway: the bridge set qwen again, then the level.
  const after = c.log().slice(mark).filter((l) => l.type === "set_model" || l.type === "set_thinking_level");
  assert.deepEqual(after.map((l) => l.type), ["set_model", "set_thinking_level"], JSON.stringify(c.log().slice(mark).map((l) => l.type ?? (l.spawn ? "spawn" : Object.keys(l)[0]))));
  assert.deepEqual([after[0].provider, after[0].modelId], ["lets-code", "qwen3.8-27b"]);
  assert.equal(after[1].level, "medium");
  assert.deepEqual([p.assistant.state().model, p.assistant.state().thinking], [ASSISTANT_MODEL, "medium"]);
});

test("every spawn sets the thinking level and reports the child's real model", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  const sent = c.log().filter((l) => l.type === "set_model" || l.type === "set_thinking_level");
  assert.deepEqual(sent.map((l) => [l.type, l.level ?? null]), [["set_thinking_level", "medium"]], "the model was right: only the level");
  assert.equal(p.assistant.state().model, ASSISTANT_MODEL);
});

test("lets-code agent rows get no child from the assistant's engine while the agent engine is off", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = await warm(c);
  // An agent row started under the agent engine (sandboxed), left with a pending run.
  const { sessionId: sid } = await a.prompt(undefined, "HANG", c.work, { engine: "lets-code", name: "agentx" });
  await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "agent HANG");
  await a.stopAll();
  const before = c.agentSpawns().length;
  const mark = c.log().length;
  // The operator rolled the agent engine back but kept the assistant.
  const b = c.open({ noLc: true });
  await b.ready;
  await b.assistant.ready;
  await Promise.race([b.prompt(sid, "again").catch(() => {}), sleep(1500)]);
  await sleep(500);
  assert.equal(c.agentSpawns().length, before, "no agent child was spawned");
  assert.ok(!c.log().slice(mark).some((l) => l.spawn && (l.argv.includes("--no-sandbox") || l.argv.includes("--mandate"))), "no agent child, never --no-sandbox");
  assert.ok(!c.prompts().some((x) => x.message === "again" || x.message === LC_CUTOFF_PROMPT), "nothing reached a lets-code child");
  assert.equal(b._lc.liveCount(), 0);
});

test("a retried requestId is accepted once", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  assert.deepEqual(await p.assistant.prompt("hi", { requestId: "t1" }), { ok: true, requestId: "t1", deduped: false });
  await idleAfter(c);
  assert.deepEqual(await p.assistant.prompt("hi", { requestId: "t1" }), { ok: true, requestId: "t1", deduped: true });
  await sleep(150);
  assert.equal(c.prompts().filter((x) => x.message === "hi").length, 1);
});

test("a prompt while busy steers by default and follows up when asked", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("HANG", { requestId: "s1" });
  await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "HANG");
  await until(() => c.mine().some((f) => f.type === "status" && f.state === "busy"), 5000, "busy");
  await p.assistant.prompt("a", { requestId: "s2" });
  await p.assistant.prompt("b", { requestId: "s3", whenBusy: "followUp" });
  await until(() => c.prompts().some((x) => x.message === "b"), 5000, "b");
  assert.equal(c.prompts().find((x) => x.message === "a").streamingBehavior, "steer");
  assert.equal(c.prompts().find((x) => x.message === "b").streamingBehavior, "followUp");
  p.assistant.interrupt();
  await idleAfter(c);
});

test("a restart mid-turn writes the lost note and does not resume", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = await warm(c);
  await a.assistant.prompt("HANG", { requestId: "r1" });
  await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "HANG");
  const pid = childPid(a);
  await a.stopAll(); // closing leaves the run task pending, as a bridge restart does
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await until(() => gone(pid), 5000, "child gone");
  const b = await warm(c);
  await until(() => c.notes().some((x) => x.note === ASSISTANT_RESTART_NOTE), 8000, "restart note");
  assert.equal(c.notes().length, 1, "one note");
  assert.ok(!existsSync(c.notes()[0].file), "the extension deleted the note file");
  assert.ok(!c.prompts().some((x) => x.message === LC_CUTOFF_PROMPT || x.message === LC_CRASH_PROMPT), "no cut-off prompt");
  assert.equal(c.prompts().filter((x) => x.message === "HANG").length, 1, "the cut prompt is not sent again");
  assert.ok(c.mine().some((f) => f.type === "error" && f.code === "assistant_restarted" && f.message === "I lost that one, please ask again."));
  const { ctx } = await b.ready;
  await until(async () => !(await b._harness.inspect(ctx)).tasks.some((x) => x.record.kind === LC_RUN_TASK), 5000, "run task ended");
  assert.equal(b.getStatus(ASSISTANT_SID).state, "idle");
  // The frame went out before any client could listen: the state names the lost request too.
  assert.equal(b.assistant.state().lost?.requestId, "r1");
  // The next prompt works on the respawned child.
  await b.assistant.prompt("hi", { requestId: "r2" });
  await until(() => c.mine().some((f) => f.type === "text_delta" && f.text === "ok: hi"), 5000, "answer");
});

test("model and thinking switch only when idle", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("HANG", { requestId: "m1" });
  await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "HANG");
  await assert.rejects(p.assistant.setModel({ thinking: "low" }), (e) => e.statusCode === 409 && e.message === "assistant is busy");
  p.assistant.interrupt();
  await idleAfter(c);
  assert.deepEqual(await p.assistant.setModel({ thinking: "low" }), { model: ASSISTANT_MODEL, thinking: "low" });
  assert.ok(c.log().some((l) => l.type === "set_thinking_level" && l.level === "low"));
  assert.equal(p.assistant.state().thinking, "low");
  // A model switch is always followed by set_thinking_level (set_model resets it, A0).
  const before = c.log().length;
  assert.deepEqual(await p.assistant.setModel({ model: "lets-code/other-27b" }), { model: "lets-code/other-27b", thinking: "low" });
  const after = c.log().slice(before).filter((l) => l.type === "set_model" || l.type === "set_thinking_level");
  assert.deepEqual(after.map((l) => l.type), ["set_model", "set_thinking_level"]);
  assert.equal(after[1].level, "low");
  assert.ok(!c.log().slice(before).some((l) => l.type === "compact"), "no hand-off between qwen models");
});

test("switching to Claude hands off a summary first", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("hi", { requestId: "c1" });
  await idleAfter(c);
  const fileBefore = (await recordOf(p)).piSessionFile;
  const mark = c.log().length;
  const r = await p.assistant.setModel({ model: "Anthropic/claude-sonnet-4-6" });
  assert.deepEqual(r, { model: "Anthropic/claude-sonnet-4-6", thinking: "medium" });
  const order = c.types().slice(c.log().slice(0, mark).filter((l) => l.type && l.type !== "get_state").length).filter((x) => ["compact", "new_session", "/even-note", "set_model", "set_thinking_level"].includes(x));
  assert.deepEqual(order, ["compact", "new_session", "/even-note", "set_model", "set_thinking_level"]);
  const compact = c.log().find((l) => l.type === "compact");
  assert.equal(compact.customInstructions, ASSISTANT_HANDOFF);
  assert.equal(c.notes()[0].note, "Summary of the earlier conversation:\n## Goal\nfake summary");
  const sm = c.log().find((l) => l.type === "set_model");
  assert.deepEqual([sm.provider, sm.modelId], ["Anthropic", "claude-sonnet-4-6"]);
  assert.equal(c.log().slice(mark).find((l) => l.type === "set_thinking_level").level, "medium", "the level set_model reset is set again");
  const rec = await recordOf(p);
  assert.notEqual(rec.piSessionFile, fileBefore, "a new session file");
  assert.equal(p.assistant.state().sessionFile, rec.piSessionFile);
  assert.equal(rec.model, "Anthropic/claude-sonnet-4-6");
  // Back to qwen keeps the new session (no second hand-off).
  const n0 = c.log().filter((l) => l.type === "compact").length;
  await p.assistant.setModel({ model: ASSISTANT_MODEL });
  assert.equal(c.log().filter((l) => l.type === "compact").length, n0);
});

test("a Claude switch is refused while 127.0.0.1:8795 is in use", async (t) => {
  const c = makeCase({ assistant: { portFree: async (port) => port !== 8795 } });
  t.after(c.closeAll);
  const p = await warm(c);
  await assert.rejects(p.assistant.setModel({ model: "Anthropic/claude-sonnet-4-6" }), (e) => e.statusCode === 409 && /127\.0\.0\.1:8795 is in use/.test(e.message));
  assert.ok(!c.log().some((l) => l.type === "compact" || l.type === "set_model"), "nothing was sent");
  assert.equal(p.assistant.state().model, ASSISTANT_MODEL);
});

test("portIsFree sees a listener", async (t) => {
  const s = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address();
  assert.equal(await portIsFree(port), false);
  await new Promise((r) => s.close(r));
  assert.equal(await portIsFree(port), true);
});

test("the 04:00 reset hands off when idle and retries when busy", async (t) => {
  // Idle at 04:00.
  {
    const clock = fakeClock(localAt(3, 59) - Date.now());
    const c = makeCase({ clock });
    t.after(async () => {
      clock.stop();
      await c.closeAll();
    });
    const p = await warm(c);
    assert.ok(nextResetAt(clock.now()) - clock.now() <= 60_000);
    clock.advance(30_000);
    await sleep(200);
    assert.ok(!c.log().some((l) => l.type === "compact"), "not before 04:00");
    clock.advance(30_001);
    await until(() => c.log().some((l) => l.type === "compact"), 5000, "compact at 04:00");
    assert.equal(c.log().find((l) => l.type === "compact").customInstructions, ASSISTANT_HANDOFF);
    await until(() => c.notes().length === 1, 5000, "summary note");
    assert.ok(c.log().some((l) => l.type === "new_session"));
    assert.ok(p.assistant.state().lastResetAt >= localAt(4));
  }
  // Busy at 04:00: nothing; idle at 04:10: the hand-off.
  {
    const clock = fakeClock(localAt(3, 59) - Date.now());
    const c = makeCase({ clock });
    t.after(async () => {
      clock.stop();
      await c.closeAll();
    });
    const p = await warm(c);
    await p.assistant.prompt("HANG", { requestId: "n1" });
    await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "HANG");
    clock.advance(60_001);
    await sleep(400);
    assert.ok(!c.log().some((l) => l.type === "compact"), "busy at 04:00: no reset");
    p.assistant.interrupt();
    await idleAfter(c);
    clock.advance(ASSISTANT_RESET_RETRY_MS);
    await until(() => c.log().some((l) => l.type === "compact"), 5000, "compact at 04:10");
  }
});

test("a failed compact still resets: new_session and a note without a summary", async (t) => {
  const c = makeCase({ env: { FAKE_PI_COMPACT_FAIL: "1" } });
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("hi", { requestId: "f1" });
  await idleAfter(c);
  const before = (await recordOf(p)).piSessionFile;
  assert.deepEqual(await p.assistant.reset(), { ok: true });
  assert.ok(c.log().some((l) => l.type === "new_session"));
  assert.deepEqual(c.notes().map((x) => x.note), [ASSISTANT_NO_SUMMARY_NOTE]);
  assert.notEqual((await recordOf(p)).piSessionFile, before);
  assert.ok(p.assistant.state().lastResetAt > 0);
});

test("notes queue while busy and go out after the run", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  assert.deepEqual(p.assistant.note("idle note"), { queued: false });
  await until(() => c.notes().length === 1, 5000, "idle note sent");
  await p.assistant.prompt("HANG", { requestId: "q1" });
  await until(() => c.prompts().some((x) => x.message === "HANG"), 5000, "HANG");
  assert.deepEqual(p.assistant.note("x"), { queued: true });
  await sleep(200);
  assert.equal(c.notes().length, 1, "not while busy");
  const notesDir = join(c.dir, "lc-sessions", "dur-assistant-notes");
  const pending = p.assistant._queue[0];
  assert.ok(pending.startsWith(notesDir));
  assert.equal(statSync(pending).mode & 0o777, 0o600);
  p.assistant.interrupt();
  await until(() => c.notes().length === 2, 5000, "note after agent_end");
  const lines = c.log();
  const abortAt = lines.findIndex((l) => l.type === "abort");
  const noteAt = lines.findIndex((l) => l.note === "x");
  assert.ok(abortAt >= 0 && noteAt > abortAt, "after the run ended");
  assert.ok(!c.mine().some((f) => f.type === "user_prompt" && /even-note/.test(f.text)), "a note shows nothing on the glasses");
});

test("dialogs become assistant_dialog frames, never permission_request", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("ASK", { requestId: "d1" });
  await until(() => c.mine().some((f) => f.type === "assistant_dialog"), 5000, "dialog frame");
  const d = c.mine().find((f) => f.type === "assistant_dialog");
  assert.equal(d.method, "select");
  assert.deepEqual(d.options, ["Allow once", "Allow for this session", "Deny"]);
  assert.match(d.title, /^mandate \(ask\): /);
  assert.ok(!c.mine().some((f) => f.type === "permission_request" || f.type === "user_question"));
  assert.equal(p.respondPermission(ASSISTANT_SID, "allow"), false, "the phone cannot answer it");
  assert.throws(() => p.assistant.answerDialog("ui-nope", { value: "Deny" }), (e) => e.statusCode === 404);
  p.assistant.answerDialog(d.id, { value: "Deny" });
  await until(() => c.log().some((l) => l.type === "extension_ui_response" && l.id === d.id && l.value === "Deny"), 5000, "answer reached the child");
  await idleAfter(c);
  assert.ok(c.mine().some((f) => f.type === "text_delta" && f.text === "answer: Deny"));
  // A confirm has Yes/No and takes confirmed.
  await p.assistant.prompt("CONFIRM", { requestId: "d2" });
  await until(() => c.mine().filter((f) => f.type === "assistant_dialog").length === 2, 5000, "confirm frame");
  const cf = c.mine().filter((f) => f.type === "assistant_dialog")[1];
  assert.deepEqual([cf.method, cf.options], ["confirm", ["Yes", "No"]]);
  p.assistant.answerDialog(cf.id, { confirmed: true });
  await idleAfter(c, 2);
  assert.ok(c.mine().some((f) => f.type === "text_delta" && f.text === "confirmed: true"));
});

test("dur-assistant is listed read-only as Even AI", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("hi", { requestId: "l1" });
  await idleAfter(c);
  const row = p.listSessions(10).find((s) => s.id === ASSISTANT_SID);
  assert.deepEqual({ id: row.id, title: row.title, readOnly: row.readOnly, cwd: row.cwd }, { id: "dur-assistant", title: "Even AI", readOnly: true, cwd: join(c.dir, "assistant") });
  assert.equal(p.probe(ASSISTANT_SID), true);
  const ro = (e) => e.statusCode === 403 && e.message === "Even AI is read-only here";
  await assert.rejects(p.prompt(ASSISTANT_SID, "x"), ro);
  await assert.rejects(p.stopSession(ASSISTANT_SID), ro);
  assert.throws(() => p.forgetSession(ASSISTANT_SID), ro);
  assert.throws(() => p.interrupt(ASSISTANT_SID), ro);
  assert.throws(() => p.respondQuestion(ASSISTANT_SID, "y"), ro);
  const history = await p.getHistory(ASSISTANT_SID, 10);
  assert.ok(JSON.stringify(history).includes("ok: hi"), JSON.stringify(history));
  assert.equal(p.getStatus(ASSISTANT_SID).state, "idle");
  assert.ok(!(await p.listAgents({ all: true })).some((a) => a.sid === ASSISTANT_SID));
  assert.equal(c.prompts().filter((x) => x.message === "x").length, 0);
});

test("prompt is refused while tools are not loaded", async (t) => {
  const c = makeCase({ env: { FAKE_PI_TOOLS: "0" } });
  t.after(c.closeAll);
  const p = await warm(c);
  await assert.rejects(p.assistant.prompt("hi", { requestId: "z1" }), (e) => e.statusCode === 503 && e.message === "assistant tools not loaded");
  assert.equal(p.assistant.state().toolsLoaded, 0);
  assert.equal(p.assistant.state().toolsSource, "none");
  assert.equal(c.prompts().filter((x) => x.message === "hi").length, 0);
});

test("without the extension's tools line no note is sent as a prompt", async (t) => {
  const c = makeCase({ env: { FAKE_PI_TOOLS_LINE: "0" }, assistant: { toolsWaitMs: 300 } });
  t.after(c.closeAll);
  const p = await warm(c);
  assert.deepEqual(p.assistant.note("held"), { queued: true });
  await sleep(300);
  assert.equal(c.prompts().length, 0, "`/even-note` never reaches a child without the extension");
  await assert.rejects(p.assistant.prompt("hi", { requestId: "z2" }), (e) => e.statusCode === 503);
});

test("a run past the deadline is aborted and the next prompt works", async (t) => {
  const c = makeCase({ assistant: { deadlineMs: 400 } });
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("HANG", { requestId: "dl1" });
  await until(() => c.log().some((l) => l.type === "abort"), 5000, "abort");
  assert.ok(c.mine().some((f) => f.type === "error" && f.code === "assistant_deadline"));
  await idleAfter(c);
  assert.equal(c.spawns().length, 1, "the child honoured the abort: no respawn");
  await p.assistant.prompt("hi", { requestId: "dl2" });
  await until(() => c.mine().some((f) => f.type === "text_delta" && f.text === "ok: hi"), 5000, "answer");
});

test("a run past the tool-call cap is aborted at the 9th call", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("LOOPTOOL", { requestId: "tc1" });
  await until(() => c.log().some((l) => l.aborted), 5000, "abort");
  assert.equal(c.log().find((l) => l.aborted).loopTurns, ASSISTANT_MAX_TOOL_CALLS + 1);
  const e = c.mine().find((f) => f.type === "error" && f.code === "assistant_tool_cap");
  assert.match(e.message, /more than 8 tool calls/);
  await idleAfter(c);
  await p.assistant.prompt("hi", { requestId: "tc2" });
  await until(() => c.mine().some((f) => f.type === "text_delta" && f.text === "ok: hi"), 5000, "answer");
});

test("a child that ignores the abort is stopped after the grace and respawned with --session", async (t) => {
  assert.equal(ASSISTANT_ABORT_GRACE_MS, 2000);
  const c = makeCase({ env: { FAKE_PI_IGNORE_ABORT: "1" }, assistant: { deadlineMs: 300, abortGraceMs: 300 } });
  t.after(c.closeAll);
  const p = await warm(c);
  await p.assistant.prompt("HANG", { requestId: "ig1" });
  await until(() => c.log().some((l) => l.abortIgnored), 5000, "abort ignored");
  await until(() => c.spawns().length === 2, 5000, "respawn");
  const rec = await recordOf(p);
  const again = c.spawns()[1];
  assert.equal(again.argv[again.argv.indexOf("--session") + 1], rec.piSessionFile);
  await until(() => p.assistant.state().status === "idle", 5000, "idle");
  await p.assistant.prompt("hi", { requestId: "ig2" });
  await until(() => c.mine().some((f) => f.type === "text_delta" && f.text === "ok: hi"), 5000, "answer, not 'already processing'");
});

test("the assistant runs without the agent engine flag; agents still need it", async (t) => {
  const c = makeCase({ noLc: true });
  t.after(c.closeAll);
  const p = await warm(c);
  assert.deepEqual(p.engines, ["native"]);
  assert.equal(p.lcBanner, "off");
  await p.assistant.prompt("hi", { requestId: "nl1" });
  await idleAfter(c);
  await assert.rejects(p.prompt(undefined, "x", c.work, { engine: "lets-code" }), (e) => e.statusCode === 400 && /lets-code engine is off/.test(e.message));
});

test("one nightly task per store, across a restart", async (t) => {
  const c = makeCase();
  t.after(c.closeAll);
  const a = await warm(c);
  await a.stopAll();
  const b = await warm(c);
  const { ctx } = await b.ready;
  const tasks = (await b._harness.inspect(ctx)).tasks.filter((x) => x.record.kind === ASSISTANT_NIGHTLY_TASK);
  assert.equal(tasks.length, 1);
  assert.equal(b.getStatus(ASSISTANT_SID).state, "idle", "the sleeping reset does not make it busy");
  assert.equal(b._map.get(ASSISTANT_SID).conversation_id, a._map.get(ASSISTANT_SID).conversation_id, "the same record conversation");
});

test("assistant off: no dur-assistant, nothing listed", async (t) => {
  const dir = join(root, "off");
  mkdirSync(join(dir, "agents", "w"), { recursive: true });
  const p = createDurableProvider(() => {}, {
    hub: { clientCount: () => 0 },
    storePath: join(dir, "durable.sqlite"),
    modelsPath: join(root, "models.json"),
    settingsPath: join(dir, "no-settings.json"),
    defaultCwd: join(dir, "agents", "w"),
    allowedCwds: [join(dir, "agents")],
    guard: { wrapper: "none", log: () => {} },
    log: QUIET,
    agentsDir: join(dir, "no-agents"),
  });
  t.after(() => p.stopAll());
  await p.ready;
  assert.equal(p.assistant, null);
  assert.equal(p.probe(ASSISTANT_SID), false);
  assert.deepEqual(p.listSessions(10), []);
  assert.equal(p._lc, null, "no engine is built");
});
