import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chmodSync } from "node:fs";
import { ASSISTANT_API_TOKEN_MIN, assistantApiToken, createAssistantAuth, assistantEnabled, assistantOptions, cwdAllowed, durableEnabled, durableOptions, DURABLE_DEFAULT_ROOT, overseerEnabled } from "../src/server.mjs";
import { fakeModelsJson } from "./helpers/fake-openai.mjs";

const CHILD = fileURLToPath(new URL("./helpers/server-child.mjs", import.meta.url));
const TOKEN = "test-token-durable";

test("durable is off unless EVEN_BRIDGE_DURABLE_ENABLE=1", () => {
  assert.equal(durableEnabled({}), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "0" }), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "true" }), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }), true);
  assert.equal(durableOptions({}), null, "flag unset: no durable provider is built");
});

test("durable options come from the env; CWDS is colon-separated", () => {
  assert.deepEqual(
    durableOptions(
      {
        EVEN_BRIDGE_DURABLE_ENABLE: "1",
        EVEN_BRIDGE_DURABLE_STORE: "/tmp/d/durable.sqlite",
        EVEN_BRIDGE_DURABLE_MODELS: "/tmp/d/models.json",
        EVEN_BRIDGE_DURABLE_CWDS: "~/sandbox/agents: ~/scratch::",
      },
    ),
    {
      defaultCwd: "~/sandbox/agents/glasses",
      allowedCwds: ["~/sandbox/agents", "~/scratch"],
      storePath: "/tmp/d/durable.sqlite",
      modelsPath: "/tmp/d/models.json",
    },
  );
  // Unset store/models: the provider's own defaults apply (keys absent, not undefined).
  assert.deepEqual(durableOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }), {
    defaultCwd: "~/sandbox/agents/glasses",
    allowedCwds: [],
  });
  // An explicit default cwd wins; PROJECT_DIR is never used.
  assert.equal(
    durableOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1", EVEN_BRIDGE_DURABLE_DEFAULT_CWD: "/w/x", PROJECT_DIR: "/p" }).defaultCwd,
    "/w/x",
  );
});

test("lc options only with EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE=1", () => {
  const on = { EVEN_BRIDGE_DURABLE_ENABLE: "1" };
  assert.equal(durableOptions(on).lc, undefined, "engine flag unset: no lc key at all");
  assert.equal(durableOptions({ ...on, EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "0" }).lc, undefined);
  assert.equal(durableOptions({ EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1" }), null, "needs durable");
  assert.deepEqual(
    durableOptions({
      ...on,
      EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1",
      EVEN_BRIDGE_LC_BIN: "/opt/lc/lets-code",
      EVEN_BRIDGE_PI_BIN: "/home/ay/.local/bin/pi-inference",
      EVEN_BRIDGE_LC_MEMORY_MAX: "700M",
      EVEN_BRIDGE_LC_MAX_LIVE: "2",
      EVEN_BRIDGE_LC_SANDBOX: "0",
    }).lc,
    { bin: "/opt/lc/lets-code", caps: { memoryMax: "700M", cpuQuota: "200%" }, maxLive: 2, sandbox: false },
  );
  assert.deepEqual(durableOptions({ ...on, EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1" }).lc, {
    bin: "lets-code",
    caps: { memoryMax: "500M", cpuQuota: "200%" },
    maxLive: 1,
    sandbox: true,
  });
  assert.equal(
    durableOptions({ ...on, EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1", EVEN_BRIDGE_PI_BIN: "/home/ay/.local/bin/lets-code" }).lc.bin,
    "/home/ay/.local/bin/lets-code",
  );
  assert.equal(durableOptions({ ...on, EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1", EVEN_BRIDGE_LC_MAX_LIVE: "x" }).lc.maxLive, 1, "a bad number keeps the default");
});

test("EVEN_BRIDGE_LC_MAX_TURNS reaches the engine only with the engine on; unset adds no key", () => {
  const on = { EVEN_BRIDGE_DURABLE_ENABLE: "1" };
  assert.equal(durableOptions({ ...on, EVEN_BRIDGE_LC_MAX_TURNS: "12" }).lc, undefined, "engine off: nothing");
  assert.equal("maxTurns" in durableOptions({ ...on, EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1" }).lc, false);
  assert.equal(durableOptions({ ...on, EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1", EVEN_BRIDGE_LC_MAX_TURNS: "12" }).lc.maxTurns, "12");
});

test("cwdAllowed: strictly below a root, never ~ or /, ~ roots expand", (t) => {
  const home = mkdtempSync(join(tmpdir(), "durable-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "x", "y"), { recursive: true });
  assert.equal(cwdAllowed("~/x/y", ["~/x"], home), true);
  assert.equal(cwdAllowed(join(home, "x", "y"), ["~/x"], home), true);
  assert.equal(cwdAllowed("~/x", ["~/x"], home), false, "a bare root is refused");
  assert.equal(cwdAllowed("~/xy", ["~/x"], home), false, "prefix is not containment");
  assert.equal(cwdAllowed("/etc", ["~/x"], home), false);
  assert.equal(cwdAllowed(home, [], home), false, "never ~");
  assert.equal(cwdAllowed("/", [], home), false, "never /");
  assert.equal(cwdAllowed("/etc", [], home), false, "no roots = the default root only");
  assert.equal(cwdAllowed("~/sandbox/agents/a", [], home), true, "default root");
  assert.equal(cwdAllowed(undefined, [], home), false);
});

test("the mirrored default root matches the provider's", async () => {
  const { DEFAULT_AGENT_ROOT } = await import("../src/providers/durable/provider.mjs");
  assert.equal(DURABLE_DEFAULT_ROOT, DEFAULT_AGENT_ROOT);
});

test("a ~ root from EVEN_BRIDGE_DURABLE_CWDS reaches the provider's resolveAgentCwd and accepts ~/x/y", async (t) => {
  const { resolveAgentCwd } = await import("../src/providers/durable/provider.mjs");
  const home = mkdtempSync(join(tmpdir(), "durable-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home; // homedir() follows $HOME on POSIX
  t.after(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(join(home, "x", "y"), { recursive: true });
  const { allowedCwds } = durableOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1", EVEN_BRIDGE_DURABLE_CWDS: "~/x" });
  assert.equal(resolveAgentCwd("~/x/y", { allowedCwds, home }), join(home, "x", "y"));
  assert.throws(() => resolveAgentCwd("~/x", { allowedCwds, home }), /not under an allowed root/);
});

// ── The real server in a child process (isolated HOME, loopback, random port) ──

async function freePort() {
  const s = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startChild(t, extraEnv) {
  const home = mkdtempSync(join(tmpdir(), "durable-srv-"));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PORT: String(port),
    BRIDGE_TOKEN: TOKEN,
    EVEN_HOST_MODE: "interface",
    EVEN_HOST_INTERFACE: "lo",
    EVEN_BRIDGE_PI_ENABLE: "0",
    EVEN_BRIDGE_RC_ENABLE: "0",
    EVEN_BRIDGE_CC_DISABLED: "1",
    EVEN_BRIDGE_SKIP_PATCH_DIST: "1", // never touch the shared node_modules from a test child
    PROJECT_DIR: home,
    ...(typeof extraEnv === "function" ? extraEnv(home) : extraEnv),
  };
  const child = spawn(process.execPath, [CHILD], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await fetch(`${base}/api/agents`);
      break;
    } catch {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`child did not start:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const stop = async () => {
    child.kill("SIGTERM");
    const res = await exited;
    return { ...res, out };
  };
  return { base, home, output: () => out, stop };
}

const authed = { headers: { Authorization: `Bearer ${TOKEN}` } };

test("server, flag unset: durable never imported, durable=off, /api/agents is auth-gated then falls through to the old 404", async (t) => {
  const s = await startChild(t, {});
  let r = await fetch(`${s.base}/api/agents`);
  assert.equal(r.status, 401, "no token");
  r = await fetch(`${s.base}/api/agents`, authed);
  assert.equal(r.status, 404);
  assert.doesNotMatch(await r.text(), /Durable agents are not enabled/, "not the bridge's JSON: the official router answers");
  r = await fetch(`${s.base}/api/agents/dur-1/stop`, { method: "POST", ...authed });
  assert.equal(r.status, 404);
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /\[bridge\] extensions: .*durable=off/);
  assert.doesNotMatch(out, /LOADED-DURABLE/, "src/providers/durable/* was imported with the flag off");
  assert.doesNotMatch(out, /LOADED-OVERSEER/, "src/overseer/* was imported with the flag off");
  assert.doesNotMatch(out, /overseer=/, "the banner is the one of before");
  assert.doesNotMatch(out, /assistant=/);
});

test("server, flag on: durable=on after ready, the default cwd is <root>/glasses, SIGTERM waits for the store to close", async (t) => {
  const s = await startChild(t, (home) => {
    mkdirSync(join(home, "x", "y"), { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
    return {
      EVEN_BRIDGE_DURABLE_ENABLE: "1",
      EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
      EVEN_BRIDGE_DURABLE_MODELS: join(home, "models.json"),
      EVEN_BRIDGE_DURABLE_CWDS: "~/x",
      PROJECT_DIR: join(home, "x", "y"),
    };
  });
  let r = await fetch(`${s.base}/api/agents`);
  assert.equal(r.status, 401, "no token");
  r = await fetch(`${s.base}/api/agents`, authed);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { agents: [] });
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /\[bridge\] extensions: .*durable=on wrapper=(?:systemd-run|bwrap|none) lc=off/);
  assert.doesNotMatch(out, /LOADED-DURABLE .*\/lc\//, "flag off loads no lc module");
  assert.doesNotMatch(out, /LOADED-OVERSEER/, "overseer flag unset: no overseer module");
  assert.doesNotMatch(out, /LOADED-DURABLE .*\/lc\/assistant\.mjs/, "assistant flag unset: no assistant module");
  assert.doesNotMatch(out, /assistant=/, "the banner is the one of before");
  assert.doesNotMatch(out, /default cwd .* is not under EVEN_BRIDGE_DURABLE_CWDS/);
  assert.match(out, /\[bridge\] durable store closed/);
});

test("server, lets-code engine on: the banner says lc=on(...) and GET /api/agents still answers", async (t) => {
  const s = await startChild(t, (home) => {
    mkdirSync(join(home, "x", "y"), { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
    return {
      EVEN_BRIDGE_DURABLE_ENABLE: "1",
      EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1",
      EVEN_BRIDGE_LC_SANDBOX: "0",
      EVEN_BRIDGE_LC_BIN: join(home, "no-such-lets-code"),
      EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
      EVEN_BRIDGE_DURABLE_MODELS: join(home, "models.json"),
      EVEN_BRIDGE_DURABLE_CWDS: "~/x",
    };
  });
  const r = await fetch(`${s.base}/api/agents`, authed);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { agents: [], engines: ["native", "lets-code"] });
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /\[bridge\] extensions: .*durable=on wrapper=(?:systemd-run|bwrap|none) lc=on\(nosandbox,(?:mem|nomem)\)/);
  assert.match(out, /LOADED-DURABLE .*\/lc\/engine\.mjs/);
});

test("server, flag on: warns when the default cwd is outside the roots", async (t) => {
  const s = await startChild(t, (home) => {
    mkdirSync(join(home, "x"), { recursive: true });
    mkdirSync(join(home, "elsewhere"), { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
    return {
      EVEN_BRIDGE_DURABLE_ENABLE: "1",
      EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
      EVEN_BRIDGE_DURABLE_MODELS: join(home, "models.json"),
      EVEN_BRIDGE_DURABLE_CWDS: "~/x",
      EVEN_BRIDGE_DURABLE_DEFAULT_CWD: join(home, "elsewhere"),
    };
  });
  const { out } = await s.stop();
  assert.match(out, /durable: default cwd .*elsewhere is not under EVEN_BRIDGE_DURABLE_CWDS \(~\/x\)/);
});

test("server, flag on but the provider fails: durable=failed, the bridge stays up without /api/agents", async (t) => {
  const s = await startChild(t, (home) => ({
    EVEN_BRIDGE_DURABLE_ENABLE: "1",
    EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
    EVEN_BRIDGE_DURABLE_MODELS: join(home, "missing-models.json"),
  }));
  const r = await fetch(`${s.base}/api/agents`, authed);
  assert.equal(r.status, 404);
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /\[bridge\] extensions: .*durable=failed: models\.json/);
});

test("overseer options only with EVEN_BRIDGE_OVERSEER_ENABLE=1 and durable on", () => {
  assert.equal(overseerEnabled({}), false);
  assert.equal(overseerEnabled({ EVEN_BRIDGE_OVERSEER_ENABLE: "1" }), false, "needs durable");
  assert.equal(overseerEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }), false);
  assert.equal(overseerEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "1", EVEN_BRIDGE_OVERSEER_ENABLE: "true" }), false);
  assert.equal(overseerEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "1", EVEN_BRIDGE_OVERSEER_ENABLE: "1" }), true);
  assert.equal(durableOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1", EVEN_BRIDGE_OVERSEER_ENABLE: "1" }).overseer, undefined, "durable options stay as before");
});

test("server, overseer on: dur-overseer is listed, /api/overseer answers, the agents list stays without it", async (t) => {
  const s = await startChild(t, (home) => {
    mkdirSync(join(home, "x", "y"), { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
    return {
      EVEN_BRIDGE_DURABLE_ENABLE: "1",
      EVEN_BRIDGE_OVERSEER_ENABLE: "1",
      EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
      EVEN_BRIDGE_DURABLE_MODELS: join(home, "models.json"),
      EVEN_BRIDGE_DURABLE_CWDS: "~/x",
    };
  });
  let r = await fetch(`${s.base}/api/overseer/outbox`);
  assert.equal(r.status, 401, "auth-gated");
  r = await fetch(`${s.base}/api/overseer/outbox?since=0`, authed);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { seq: 0, readUpTo: 0, items: [] });
  r = await fetch(`${s.base}/api/overseer/ask`, {
    method: "POST",
    headers: { ...authed.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ question: "what runs?", requestId: "ovs-1", waitMs: 0 }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "pending", requestId: "ovs-1", actions: [] }, "the actions it proposed (none)");
  r = await fetch(`${s.base}/api/overseer/actions?state=pending`, authed);
  assert.deepEqual(await r.json(), { actions: [] });
  r = await fetch(`${s.base}/api/overseer/actions/act-nope/confirm`, { method: "POST", headers: { ...authed.headers, "Content-Type": "application/json" }, body: JSON.stringify({ confirmFrameId: "f" }) });
  assert.equal(r.status, 404);
  r = await fetch(`${s.base}/api/agents`, authed);
  assert.deepEqual(await r.json(), { agents: [], overseer: true }, "advertised; the overseer is not an agent (the reaper never sees it)");
  r = await fetch(`${s.base}/api/sessions?provider=claude&limit=50`, authed);
  const sessions = (await r.json()).sessions;
  assert.ok(sessions.some((x) => x.id === "dur-overseer" && x.title === "Overseer"), JSON.stringify(sessions));
  r = await fetch(`${s.base}/api/agents/dur-overseer/stop`, { method: "POST", ...authed });
  assert.equal(r.status, 403);
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /\[bridge\] extensions: .*durable=on wrapper=(?:systemd-run|bwrap|none) lc=off, overseer=on/);
  assert.match(out, /LOADED-OVERSEER .*\/overseer\.mjs/);
});

test("assistant options only with EVEN_BRIDGE_ASSISTANT_ENABLE=1 and durable on", () => {
  assert.equal(assistantEnabled({}), false);
  assert.equal(assistantEnabled({ EVEN_BRIDGE_ASSISTANT_ENABLE: "1" }), false, "needs durable");
  assert.equal(assistantEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "1", EVEN_BRIDGE_ASSISTANT_ENABLE: "true" }), false);
  assert.equal(assistantOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }), null);
  assert.equal(durableOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }).assistant, undefined, "flag unset: no key");
  const on = { EVEN_BRIDGE_DURABLE_ENABLE: "1", EVEN_BRIDGE_ASSISTANT_ENABLE: "1" };
  assert.deepEqual(assistantOptions(on), { toolsUrl: "http://127.0.0.1:8814", tokenFile: "~/even-app/shim-data/assistant_tools.token" });
  assert.deepEqual(durableOptions(on).assistant, assistantOptions(on));
  assert.equal(durableOptions(on).lc, undefined, "the agent engine flag stays its own");
  assert.deepEqual(
    assistantOptions({
      ...on,
      EVEN_BRIDGE_ASSISTANT_TOOLS_URL: "http://127.0.0.1:8815",
      EVEN_BRIDGE_ASSISTANT_TOKEN_FILE: "/k/token",
      EVEN_BRIDGE_PI_BIN: "/home/ay/.local/bin/lets-code",
      EVEN_BRIDGE_ASSISTANT_EXT: "/tmp/probe.ts",
      EVEN_BRIDGE_ASSISTANT_DEADLINE_S: "3",
      EVEN_BRIDGE_ASSISTANT_CWD: "/home/ay/tmp/ovs-a1/assistant",
    }),
    { toolsUrl: "http://127.0.0.1:8815", tokenFile: "/k/token", bin: "/home/ay/.local/bin/lets-code", ext: "/tmp/probe.ts", cwd: "/home/ay/tmp/ovs-a1/assistant", deadlineMs: 3000 },
  );
  assert.equal(assistantOptions({ ...on, EVEN_BRIDGE_LC_BIN: "/a", EVEN_BRIDGE_PI_BIN: "/b" }).bin, "/a");
  assert.equal("deadlineMs" in assistantOptions({ ...on, EVEN_BRIDGE_ASSISTANT_DEADLINE_S: "x" }), false);
  assert.equal(assistantOptions({ ...on, EVEN_BRIDGE_ASSISTANT_DEADLINE_S: "25" }).deadlineMs, 25000);
  assert.equal("deadlineMs" in assistantOptions(on), false, "unset: the profile's own default (ASSISTANT_RUN_DEADLINE_S)");
});

test("server, assistant on: routes answer, Even AI is listed read-only, not an agent; the banner says assistant=on", async (t) => {
  const s = await startChild(t, (home) => {
    mkdirSync(join(home, "x", "y"), { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
    return {
      EVEN_BRIDGE_DURABLE_ENABLE: "1",
      EVEN_BRIDGE_ASSISTANT_ENABLE: "1",
      EVEN_BRIDGE_LC_BIN: "/bin/false", // never a real lets-code in a test: the child exits at once
      EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
      EVEN_BRIDGE_DURABLE_MODELS: join(home, "models.json"),
      EVEN_BRIDGE_DURABLE_CWDS: "~/x",
    };
  });
  let r = await fetch(`${s.base}/api/assistant/state`);
  assert.equal(r.status, 401, "auth-gated");
  // The phone's (bridge) token never reaches the assistant routes: only the assistant API token does.
  r = await fetch(`${s.base}/api/assistant/state`, authed);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /assistant API token/);
  r = await fetch(`${s.base}/api/assistant/prompt`, { method: "POST", headers: { ...authed.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", requestId: "p1" }) });
  assert.equal(r.status, 403);
  const tokFile = join(s.home, ".even-terminal", "assistant-api.token");
  assert.equal(statSync(tokFile).mode & 0o777, 0o600, "created 0600 by the bridge");
  const asTok = readFileSync(tokFile, "utf8").trim();
  assert.match(asTok, /^[0-9a-f]{48}$/);
  const asAuthed = { headers: { Authorization: `Bearer ${asTok}` } };
  r = await fetch(`${s.base}/api/agents`, asAuthed);
  assert.equal(r.status, 401, "the assistant token opens only /api/assistant/*");
  r = await fetch(`${s.base}/api/assistant/state`, asAuthed);
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.equal(st.model, "lets-code/qwen3.8-27b");
  assert.equal(st.toolsLoaded, 0);
  r = await fetch(`${s.base}/api/assistant/prompt`, { method: "POST", headers: { ...asAuthed.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", requestId: "a1" }) });
  assert.equal(r.status, 503, "no child (it exits at once): the shim falls back to its loop");
  r = await fetch(`${s.base}/api/assistant/prompt`, { method: "POST", headers: { ...asAuthed.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", requestId: "a1", whenBusy: "now" }) });
  assert.equal(r.status, 400);
  r = await fetch(`${s.base}/api/agents`, authed);
  assert.deepEqual(await r.json(), { agents: [] }, "not an agent; no engines advertised without the agent engine flag");
  r = await fetch(`${s.base}/api/sessions?provider=claude&limit=50`, authed);
  const row = (await r.json()).sessions.find((x) => x.id === "dur-assistant");
  assert.equal(row?.title, "Even AI");
  assert.equal(row?.readOnly, true);
  r = await fetch(`${s.base}/api/agents/dur-assistant/stop`, { method: "POST", ...authed });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "Even AI is read-only here" });
  r = await fetch(`${s.base}/api/prompt`, { method: "POST", headers: { ...authed.headers, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "dur-assistant", text: "hi" }) });
  assert.equal(r.status, 403);
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /\[bridge\] extensions: .*durable=on wrapper=(?:systemd-run|bwrap|none) lc=off assistant=on/);
  assert.match(out, /LOADED-DURABLE .*\/lc\/assistant\.mjs/);
});

test("server, durable on and the assistant flag unset: /api/assistant/* falls through to the official 404", async (t) => {
  const s = await startChild(t, (home) => {
    mkdirSync(join(home, "x", "y"), { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
    return {
      EVEN_BRIDGE_DURABLE_ENABLE: "1",
      EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
      EVEN_BRIDGE_DURABLE_MODELS: join(home, "models.json"),
      EVEN_BRIDGE_DURABLE_CWDS: "~/x",
    };
  });
  let r = await fetch(`${s.base}/api/assistant/state`, authed);
  assert.equal(r.status, 404);
  r = await fetch(`${s.base}/api/assistant/prompt`, { method: "POST", headers: { ...authed.headers, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi", requestId: "a1" }) });
  assert.equal(r.status, 404);
  r = await fetch(`${s.base}/api/sessions?provider=claude&limit=50`, authed);
  assert.ok(!(await r.json()).sessions.some((x) => x.id === "dur-assistant"));
  const { out } = await s.stop();
  assert.doesNotMatch(out, /LOADED-DURABLE .*\/lc\//, "no lc module at all");
  assert.doesNotMatch(out, /assistant=/);
});

test("the assistant API token file: created 0600; empty, short, unreadable or uncreatable means no token", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "as-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(ASSISTANT_API_TOKEN_MIN, 16);
  const at = (f) => ({ EVEN_BRIDGE_ASSISTANT_API_TOKEN_FILE: f });
  // missing: created
  const fresh = join(dir, "sub", "fresh.token");
  const r = assistantApiToken(at(fresh));
  assert.match(r(), /^[0-9a-f]{48}$/);
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
  // empty, whitespace, short
  for (const [name, body] of [["empty", ""], ["blank", "  \n"], ["short", "abc123"], ["fifteen", "x".repeat(15)]]) {
    const f = join(dir, `${name}.token`);
    writeFileSync(f, body);
    assert.equal(assistantApiToken(at(f))(), null, name);
  }
  // unreadable: a directory where the file should be, or a file made unreadable after start
  mkdirSync(join(dir, "isdir.token"));
  assert.equal(assistantApiToken(at(join(dir, "isdir.token")))(), null);
  const later = join(dir, "later.token");
  const rl = assistantApiToken(at(later));
  assert.ok(rl());
  chmodSync(later, 0o000);
  if (process.getuid?.() !== 0) assert.equal(rl(), null, "unreadable after a rotation");
  // creation fails (the parent is a regular file): it throws; the server then refuses every request
  writeFileSync(join(dir, "afile"), "x");
  assert.throws(() => assistantApiToken(at(join(dir, "afile", "token"))));
});

async function authApp(t, reader) {
  const app = express();
  const reached = [];
  app.use("/api/assistant", createAssistantAuth({ reader, allowedTokens: new Set(["bridge-token-0123456789"]), warn: () => {} }));
  app.use((req, res) => {
    reached.push(req.originalUrl);
    res.json({ ok: true, authed: Boolean(req.evenAssistantAuth) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, reached };
}

test("no usable assistant token: every /api/assistant request gets 503, with no, an empty or any token", async (t) => {
  for (const reader of [() => null, () => "", () => "short", undefined]) {
    const { base, reached } = await authApp(t, reader);
    for (const [path, headers] of [
      ["/api/assistant/state", {}],
      ["/api/assistant/state?token=", {}],
      ["/api/assistant/state?token=short", {}],
      ["/api/assistant/state", { Authorization: "Bearer " }],
      ["/api/assistant/state", { Authorization: "Bearer bridge-token-0123456789" }],
      ["/api/assistant/prompt?token=x", {}],
    ]) {
      const r = await fetch(base + path, { headers });
      assert.equal(r.status, 503, `${path} ${JSON.stringify(headers)}`);
      assert.deepEqual(await r.json(), { error: "the assistant API token is not set up" });
    }
    assert.deepEqual(reached, [], "no request reached a route");
  }
});

test("a usable assistant token: only it passes; empty, wrong and bridge tokens are refused", async (t) => {
  const tok = "a".repeat(48);
  const { base, reached } = await authApp(t, () => tok);
  const st = async (path, headers = {}) => (await fetch(base + path, { headers })).status;
  assert.equal(await st("/api/assistant/state"), 401);
  assert.equal(await st("/api/assistant/state?token="), 401, "an empty token never matches");
  assert.equal(await st("/api/assistant/state", { Authorization: "Bearer " }), 401);
  assert.equal(await st("/api/assistant/state?token=" + "a".repeat(47)), 401);
  assert.equal(await st("/api/assistant/state", { Authorization: "Bearer bridge-token-0123456789" }), 403);
  assert.equal(reached.length, 0);
  assert.equal(await st("/api/assistant/state", { Authorization: `Bearer ${tok}` }), 200);
  assert.equal(await st(`/api/assistant/state?token=${tok}`), 200);
  assert.equal(reached.length, 2);
});

test("the overseer host is built for the assistant alone", async (t) => {
  const s = await startChild(t, (home) => {
    mkdirSync(join(home, "x", "y"), { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(fakeModelsJson("http://127.0.0.1:9/v1")));
    return {
      EVEN_BRIDGE_DURABLE_ENABLE: "1",
      EVEN_BRIDGE_ASSISTANT_ENABLE: "1",
      EVEN_BRIDGE_LC_BIN: "/bin/false",
      EVEN_BRIDGE_DURABLE_STORE: join(home, "durable.sqlite"),
      EVEN_BRIDGE_DURABLE_MODELS: join(home, "models.json"),
      EVEN_BRIDGE_DURABLE_CWDS: "~/x",
    };
  });
  const asTok = readFileSync(join(s.home, ".even-terminal", "assistant-api.token"), "utf8").trim();
  const asAuthed = { headers: { Authorization: `Bearer ${asTok}` } };
  let r = await fetch(`${s.base}/api/assistant/sessions`, authed);
  assert.equal(r.status, 403, "the read routes take the assistant API token too");
  r = await fetch(`${s.base}/api/assistant/sessions`, asAuthed);
  assert.equal(r.status, 200);
  const { sessions } = await r.json();
  assert.ok(Array.isArray(sessions));
  assert.ok(!sessions.some((x) => x.id === "dur-assistant"), JSON.stringify(sessions));
  r = await fetch(`${s.base}/api/assistant/sessions/dur-nope?n=3`, asAuthed);
  assert.deepEqual(await r.json(), { text: "No session dur-nope." });
  r = await fetch(`${s.base}/api/assistant/outbox?since=0`, asAuthed);
  assert.deepEqual(await r.json(), { seq: 0, items: [] }, "no overseer: an empty outbox");
  r = await fetch(`${s.base}/api/overseer/sessions`, authed);
  assert.equal(r.status, 404, "the overseer routes stay off");
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /LOADED-OVERSEER .*\/overseer\/host\.mjs/);
  assert.doesNotMatch(out, /LOADED-OVERSEER .*\/overseer\/overseer\.mjs/);
  assert.doesNotMatch(out, /LOADED-OVERSEER .*\/overseer\/(?:actions|extension|checkins)\.mjs/);
  assert.doesNotMatch(out, /overseer=/, "the banner is the one of before");
});
