#!/usr/bin/env node
// Real-life smoke for the overseer (plan Task 4, step 8): a SECOND bridge instance on
// 127.0.0.1:3466 with the durable provider, the lets-code engine and the overseer on,
// an isolated store (~/tmp/ovs-smoke-overseer) and the real models (qwen). Never touches
// the live service (port 3456, ~/.even-terminal/durable.sqlite); the live bridge is only
// read once (GET /api/sessions) to show it does not list the throwaway session.
//
//   node scripts/overseer-smoke.mjs              # one lets-code agent, then the overseer is asked about it
//   node scripts/overseer-smoke.mjs --keep       # leave the store and bridge.log (mode 0600: the banner holds the token)
//   node scripts/overseer-smoke.mjs --timeout 240
//
// Checks: GET /api/agents advertises the overseer; dur-overseer is listed first by the durable
// provider and cannot be stopped (403); the overseer's answer to "Which agents are running and
// what are they doing?" names the agent (directly, or from the outbox when it took over 15 s).
// No factory, no --factory: the lets-code agent runs in ask mode.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(homedir(), "tmp", "ovs-smoke-overseer");
const WORK = join(homedir(), "sandbox", "agents", "ovs-overseer-smoke");
const TMP = join(homedir(), "tmp", "ovs-tmp");
const STORE = join(ROOT, "durable.sqlite");
const LOG = join(ROOT, "bridge.log");
const LC_BIN = join(homedir(), ".local", "bin", "lets-code");
const PORT = 3466;
const LIVE_PORT = 3456;
const CONFIG = join(homedir(), ".even-terminal", "config.json");
const LABEL = "bees-notes";
const QUESTION = "Which agents are running and what are they doing?";

if (process.argv.includes("--child")) {
  const { startServer } = await import(pathToFileURL(join(HERE, "..", "src", "server.mjs")).href);
  await startServer({ cwd: process.env.PROJECT_DIR });
  await new Promise(() => {});
}

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const TIMEOUT_MS = Number(argv[argv.indexOf("--timeout") + 1] || 0) * 1000 || 240_000;
const t0 = Date.now();
const say = (line) => console.log(`[overseer-smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class SmokeFail extends Error {}
const fail = (msg) => {
  throw new SmokeFail(msg);
};
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

function bridgeToken() {
  try {
    const t = JSON.parse(readFileSync(CONFIG, "utf8")).token;
    if (typeof t === "string" && t) return t;
  } catch (err) {
    fail(`cannot read ${CONFIG}: ${err.message}`);
  }
  fail(`no token in ${CONFIG}`);
}
/**
 * The overseer runs in the bridge process on the durable models (~/.pi/agent/models.json names
 * `$LETS_CODE_TOKEN`): from the environment, else lets-code's own config file. Never printed; the
 * lets-code children still get no token from the bridge (they read that config themselves).
 */
function letsCodeToken() {
  if (process.env.LETS_CODE_TOKEN) return process.env.LETS_CODE_TOKEN;
  const file = join(homedir(), ".config", "lets-code", "config");
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?TOKEN=(.*)$/.exec(raw);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch (err) {
    fail(`LETS_CODE_TOKEN is not set and ${file} is not readable (${err.code ?? err.message})`);
  }
  fail(`LETS_CODE_TOKEN is not set and ${file} has no TOKEN=`);
}

const TOKEN = bridgeToken();
const BASE = `http://127.0.0.1:${PORT}/api`;

async function api(method, path, body, timeoutMs = 30_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

const portInUse = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });

function banner() {
  try {
    return readFileSync(LOG, "utf8").split("\n").find((l) => l.includes("[bridge] extensions:")) ?? "";
  } catch {
    return "";
  }
}

async function waitFor(cond, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await cond();
    if (v) return v;
    await sleep(1000);
  }
  fail(`timed out waiting for ${what}`);
}

let child = null;
async function main() {
  if (await portInUse(PORT)) fail(`port ${PORT} is already in use`);
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("EVEN_BRIDGE_") || k.startsWith("EVEN_TERMINAL_EXPOSE") || k === "LETS_CODE_TOKEN") delete env[k];
  Object.assign(env, {
    PORT: String(PORT),
    BRIDGE_TOKEN: TOKEN,
    LETS_CODE_TOKEN: letsCodeToken(),
    PROJECT_DIR: WORK,
    TMPDIR: TMP,
    EVEN_BRIDGE_DURABLE_ENABLE: "1",
    EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1",
    EVEN_BRIDGE_OVERSEER_ENABLE: "1",
    EVEN_BRIDGE_DURABLE_STORE: STORE,
    EVEN_BRIDGE_DURABLE_CWDS: join(homedir(), "sandbox", "agents"),
    EVEN_BRIDGE_LC_BIN: LC_BIN,
    EVEN_BRIDGE_PI_ENABLE: "0",
    EVEN_BRIDGE_RC_ENABLE: "0",
    EVEN_BRIDGE_CC_DISABLED: "1",
    EVEN_BRIDGE_SKIP_PATCH_DIST: "1",
    EVEN_HOST_MODE: "interface",
    EVEN_HOST_INTERFACE: "lo",
    PI_TELEMETRY: "0",
  });
  const fd = openSync(LOG, "a", 0o600);
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], { cwd: WORK, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  say(`bridge on 127.0.0.1:${PORT}, store ${STORE}, cwd ${WORK}`);
  const agents0 = await waitFor(async () => {
    if (child.exitCode !== null) fail(`bridge exited during start (see ${LOG})`);
    const r = await api("GET", "/agents").catch(() => null);
    return r?.status === 200 ? r.json : null;
  }, 60_000, "the bridge");
  say(`ready: ${banner().replace(/^.*\[bridge\] /, "")}`);
  if (!/overseer=on/.test(banner())) fail("banner has no overseer=on");
  if (agents0.overseer !== true) fail(`GET /api/agents does not advertise the overseer: ${JSON.stringify(agents0)}`);

  const sessions = (await api("GET", "/sessions?provider=claude&limit=20")).json?.sessions ?? [];
  if (!sessions.some((s) => s.id === "dur-overseer")) fail("dur-overseer is not listed");
  const stop403 = await api("POST", "/agents/dur-overseer/stop");
  if (stop403.status !== 403) fail(`stopping the overseer answered ${stop403.status}`);
  say("dur-overseer listed; stopping it is 403");

  // One lets-code agent with a little work to do.
  const r1 = await api("POST", "/prompt", {
    provider: "durable",
    text: "Write bees.md with five short facts about honey bees, one per line, then list the directory.",
    cwd: WORK,
    name: LABEL,
    engine: "lets-code",
    requestId: randomUUID(),
  });
  if (r1.status !== 202) fail(`prompt ${r1.status}: ${JSON.stringify(r1.json)}`);
  const sid = r1.json.sessionId;
  say(`agent ${LABEL} started: ${sid}`);
  await sleep(4000);
  const state = (await api("GET", `/status?sessionId=${encodeURIComponent(sid)}`)).json?.state;
  say(`agent state when asking: ${state}`);

  // The question, as the shim asks it.
  const requestId = `ovs-${randomUUID().replace(/-/g, "")}`;
  let t = Date.now();
  const ask = await api("POST", "/overseer/ask", { question: QUESTION, requestId, waitMs: 15000 }, 30_000);
  if (ask.status !== 200) fail(`ask ${ask.status}: ${JSON.stringify(ask.json)}`);
  let answer;
  if (ask.json.status === "done") {
    answer = ask.json.answer;
    say(`answered within the wait (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  } else {
    say(`pending after ${((Date.now() - t) / 1000).toFixed(1)}s; reading the outbox`);
    const item = await waitFor(async () => {
      const box = (await api("GET", "/overseer/outbox?since=0")).json;
      return box?.items?.find((i) => i.requestId === requestId);
    }, TIMEOUT_MS, "the late answer in the outbox");
    answer = item.text;
    say(`late answer in the outbox after ${((Date.now() - t) / 1000).toFixed(1)}s (kind ${item.kind})`);
    const box = (await api("GET", "/overseer/outbox?since=0")).json;
    const same = box.items.filter((i) => i.requestId === requestId).length;
    if (same !== 1) fail(`the answer is in the outbox ${same} times`);
  }
  say(`answer: ${short(answer, 600)}`);
  if (!new RegExp(`${LABEL}|bees|${sid}`, "i").test(answer)) fail("the answer does not name the agent");

  // The overseer's own transcript (what the phone Terminal shows): which tools it used.
  const h = (await api("GET", "/sessions/dur-overseer/history?limit=6")).json?.history ?? [];
  for (const x of h) say(`  overseer history ${x.role}: ${short(x.text, 200)}`);

  // The live bridge does not know the throwaway session.
  const live = await fetch(`http://127.0.0.1:${LIVE_PORT}/api/sessions`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15_000) })
    .then((r) => r.text())
    .catch((err) => `error: ${err.message}`);
  if (live.includes(sid)) fail("the live bridge lists the throwaway session");
  say(`live bridge untouched (does not list ${sid})`);

  const stop = await api("POST", `/agents/${encodeURIComponent(sid)}/stop`);
  if (stop.status !== 200) fail(`stop ${stop.status}: ${JSON.stringify(stop.json)}`);
  say("agent stopped");
}

let code = 0;
try {
  await main();
  say("PASS");
} catch (err) {
  code = 1;
  say(`FAIL: ${err instanceof SmokeFail ? err.message : err.stack}`);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, sleep(10_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (!KEEP) {
    rmSync(ROOT, { recursive: true, force: true });
    rmSync(WORK, { recursive: true, force: true });
  } else say(`kept ${ROOT} (bridge.log mode 0600 holds the token)`);
}
process.exit(code);
