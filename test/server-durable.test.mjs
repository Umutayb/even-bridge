import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cwdAllowed, durableEnabled, durableOptions } from "../src/server.mjs";
import { fakeModelsJson } from "./helpers/fake-openai.mjs";

const CHILD = fileURLToPath(new URL("./helpers/server-child.mjs", import.meta.url));
const TOKEN = "test-token-durable";

test("durable is off unless EVEN_BRIDGE_DURABLE_ENABLE=1", () => {
  assert.equal(durableEnabled({}), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "0" }), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "true" }), false);
  assert.equal(durableEnabled({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }), true);
  assert.equal(durableOptions({}, { cwd: "/p" }), null, "flag unset: no durable provider is built");
});

test("durable options come from the env; CWDS is colon-separated", () => {
  assert.deepEqual(
    durableOptions(
      {
        EVEN_BRIDGE_DURABLE_ENABLE: "1",
        EVEN_BRIDGE_DURABLE_STORE: "/tmp/d/durable.sqlite",
        EVEN_BRIDGE_DURABLE_MODELS: "/tmp/d/models.json",
        EVEN_BRIDGE_DURABLE_CWDS: "~/github: ~/sandbox/agents::",
      },
      { cwd: "/home/u/github/proj" },
    ),
    {
      defaultCwd: "/home/u/github/proj",
      allowedCwds: ["~/github", "~/sandbox/agents"],
      storePath: "/tmp/d/durable.sqlite",
      modelsPath: "/tmp/d/models.json",
    },
  );
  // Unset store/models: the provider's own defaults apply (keys absent, not undefined).
  assert.deepEqual(durableOptions({ EVEN_BRIDGE_DURABLE_ENABLE: "1" }, { cwd: "/p" }), {
    defaultCwd: "/p",
    allowedCwds: [],
  });
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
  assert.equal(cwdAllowed("/etc", [], home), true, "no roots = anywhere else");
  assert.equal(cwdAllowed(undefined, [], home), false);
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

test("server, flag unset: durable never imported, durable=off, /api/agents is auth-gated then JSON 404", async (t) => {
  const s = await startChild(t, {});
  let r = await fetch(`${s.base}/api/agents`);
  assert.equal(r.status, 401, "no token");
  r = await fetch(`${s.base}/api/agents`, authed);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "Durable agents are not enabled" });
  r = await fetch(`${s.base}/api/agents/dur-1/stop`, { method: "POST", ...authed });
  assert.equal(r.status, 404);
  const { code, out } = await s.stop();
  assert.equal(code, 0);
  assert.match(out, /\[bridge\] extensions: .*durable=off/);
  assert.doesNotMatch(out, /LOADED-DURABLE/, "src/providers/durable/* was imported with the flag off");
});

test("server, flag on: durable=on after ready, ~ root accepts the default cwd, SIGTERM waits for the store to close", async (t) => {
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
  assert.match(out, /\[bridge\] extensions: .*durable=on/);
  assert.doesNotMatch(out, /default cwd .* is not under EVEN_BRIDGE_DURABLE_CWDS/);
  assert.match(out, /\[bridge\] durable store closed/);
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
      PROJECT_DIR: join(home, "elsewhere"),
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
