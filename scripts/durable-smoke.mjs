#!/usr/bin/env node
// Real-life smoke for the durable provider: a SECOND bridge instance against
// the real vLLM, with an isolated scratch store. Never touches the live
// service (port 3456, ~/.even-terminal/durable.sqlite).
//
//   node scripts/durable-smoke.mjs                  # two prompts: create a file, then a guard-blocked read
//   node scripts/durable-smoke.mjs --kill-mid-turn  # stop the bridge 2 s into a turn, restart, resume
//   node scripts/durable-smoke.mjs --engine lets-code                 # (a) a file, (a2) a mandate ask denied, (c) scope, (d) banner
//   node scripts/durable-smoke.mjs --engine lets-code --kill-mid-turn --kill-signal SIGKILL   # (b) restart mid-turn
//
// --engine lets-code: the durable lets-code engine (an owned lets-code RPC child per
// session, plan Task 2). Store ~/tmp/ovs-smoke-store, cwd ~/sandbox/agents/ovs-smoke,
// bin ~/.local/bin/lets-code; the bridge gets no LETS_CODE_TOKEN (lets-code reads its
// own config), and the child's /proc environ is checked for tokens.
//
// Options:
//   --kill-signal SIGKILL  with --kill-mid-turn: crash instead of the graceful close (default SIGTERM)
//   --keep                 leave /tmp/durable-smoke in place (bridge.log, store) for inspection;
//                          bridge.log holds the full bridge token (banner), mode 0600
//   --timeout <s>          max wait for one turn to go idle (default 300)
//
// The bridge runs as a child process of this script (`--child` role): its
// output (banner and pairing QR included) goes to /tmp/durable-smoke/bridge.log,
// never to this script's stdout, and SIGTERM goes through the server's real
// shutdown path (durable stopAll = harness close, runs left pending).
//
// Secrets: BRIDGE_TOKEN comes from ~/.even-terminal/config.json, LETS_CODE_TOKEN
// from the environment (export it before running), falling back to the systemd
// drop-in of the live service only when that file is readable. Neither is ever printed.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, closeSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = (() => {
  const i = process.argv.indexOf("--engine");
  return i >= 0 ? process.argv[i + 1] : "native";
})();
const LC = ENGINE === "lets-code";
const ROOT = LC ? join(homedir(), "tmp", "ovs-smoke-store") : "/tmp/durable-smoke";
const WORK = LC ? join(homedir(), "sandbox", "agents", "ovs-smoke") : join(ROOT, "work");
const LC_BIN = join(homedir(), ".local", "bin", "lets-code");
const OUTSIDE = join(homedir(), "tmp", "ovs-outside.txt");
const STORE = join(ROOT, "durable.sqlite");
const LOG = join(ROOT, "bridge.log");
const PORT = 3466;
const LIVE_PORT = 3456;
const DROP_IN = "/etc/systemd/system/even-bridge.service.d/pi-lets-code.conf";
const CONFIG = join(homedir(), ".even-terminal", "config.json");

// ── child role: the bridge itself ───────────────────────────────────────────
if (process.argv.includes("--child")) {
  const { startServer } = await import(pathToFileURL(join(HERE, "..", "src", "server.mjs")).href);
  await startServer({ cwd: process.env.PROJECT_DIR });
  await new Promise(() => {}); // until the parent's SIGTERM
}

// ── parent role: the smoke ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const KILL_MID_TURN = flag("--kill-mid-turn");
const KILL_SIGNAL = opt("--kill-signal", "SIGTERM");
const KEEP = flag("--keep");
const TURN_TIMEOUT_MS = Number(opt("--timeout", "300")) * 1000;

const t0 = Date.now();
const say = (line) => console.log(`[smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class SmokeFail extends Error {}
const fail = (msg) => {
  throw new SmokeFail(msg);
};

/** The live service's LETS_CODE_TOKEN (systemd `Environment=` line, optionally quoted). */
function letsCodeToken() {
  if (process.env.LETS_CODE_TOKEN) return process.env.LETS_CODE_TOKEN;
  let text;
  try {
    text = readFileSync(DROP_IN, "utf8");
  } catch (err) {
    fail(`LETS_CODE_TOKEN is not set and ${DROP_IN} is not readable (${err.code ?? err.message}); export LETS_CODE_TOKEN first`);
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("Environment=")) continue;
    let v = line.slice("Environment=".length).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.startsWith("LETS_CODE_TOKEN=")) return v.slice("LETS_CODE_TOKEN=".length);
  }
  fail(`LETS_CODE_TOKEN not found in ${DROP_IN}`);
}

function bridgeToken() {
  try {
    const t = JSON.parse(readFileSync(CONFIG, "utf8")).token;
    if (typeof t === "string" && t) return t;
  } catch (err) {
    fail(`cannot read ${CONFIG}: ${err.message}`);
  }
  fail(`no token in ${CONFIG}`);
}

function portInUse(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });
}

/** VmRSS / VmHWM of a pid, in MiB. */
function rssOf(pid) {
  try {
    const st = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (k) => Number(st.match(new RegExp(`^${k}:\\s+(\\d+) kB`, "m"))?.[1] ?? NaN);
    return { rss: kb("VmRSS") / 1024, hwm: kb("VmHWM") / 1024 };
  } catch {
    return { rss: NaN, hwm: NaN };
  }
}
const mib = (n) => `${n.toFixed(1)} MiB`;

const TOKEN = bridgeToken();
const BASE = `http://127.0.0.1:${PORT}/api`;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

let child = null;
function startBridge(env) {
  const fd = openSync(LOG, "a", 0o600); // the banner prints the full bridge token
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    cwd: WORK,
    env,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  c.exited = new Promise((r) => c.once("exit", (code, signal) => r({ code, signal })));
  child = c;
  return c;
}

async function waitReady(c, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (c.exitCode !== null || c.signalCode !== null) fail(`bridge exited during start (see ${LOG})`);
    try {
      const r = await api("GET", "/agents");
      if (r.status === 200) return r.json.agents;
      if (r.status === 404) fail("bridge is up but the durable provider is not enabled (GET /api/agents 404)");
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  fail("bridge did not become ready in time");
}

async function stopBridge(c, signal = "SIGTERM") {
  if (!c || c.exitCode !== null || c.signalCode !== null) return c ? c.exited : undefined;
  c.kill(signal);
  const r = await Promise.race([c.exited, sleep(10_000).then(() => null)]);
  if (r) return r;
  c.kill("SIGKILL");
  return c.exited;
}

async function waitIdle(sid, { sawBusy = false } = {}) {
  const until = Date.now() + TURN_TIMEOUT_MS;
  let busy = sawBusy;
  let last;
  while (Date.now() < until) {
    const r = await api("GET", `/status?sessionId=${encodeURIComponent(sid)}`);
    if (r.status !== 200) fail(`status ${r.status}: ${JSON.stringify(r.json)}`);
    last = r.json.state;
    if (last === "busy") busy = true;
    else if (last === "idle" && busy) return;
    else if (last === "idle") {
      // A turn that finishes between two polls never shows busy; the history decides.
      await sleep(1000);
      const again = await api("GET", `/status?sessionId=${encodeURIComponent(sid)}`);
      if (again.json?.state === "idle") return;
    }
    await sleep(1000);
  }
  fail(`session ${sid} still ${last} after ${TURN_TIMEOUT_MS / 1000}s`);
}

async function history(sid) {
  const r = await api("GET", `/sessions/${encodeURIComponent(sid)}/history?limit=50`);
  if (r.status !== 200) fail(`history ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json.history;
}

async function prompt(body) {
  const r = await api("POST", "/prompt", { provider: "durable", ...body });
  if (r.status !== 202 || !r.json?.ok) fail(`prompt ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}

const short = (s, n = 160) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, " ⏎ ");
function printHistory(h) {
  for (const item of h) say(`  history ${item.role}: ${short(item.text, 300)}`);
}

function guardLines() {
  try {
    return readFileSync(LOG, "utf8")
      .split("\n")
      .filter((l) => l.includes("[durable:guard] blocked"));
  } catch {
    return [];
  }
}

// Prompts: tool use spelled out (the agent instructions already ask for a
// two-sentence summary at the end).
const CREATE_TEXT =
  "Create hello.txt containing 'hi' and list the directory. " +
  "Use the write tool for the file and the bash tool (ls -la) for the listing.";
// The model refuses both a bare "run: cat ~/.ssh/id_ed25519" and an
// "authorized test" wording on its own (it never calls the tool, so the guard
// is never exercised). Piping the key into `wc -c` keeps its content out of the
// answer, so the model makes the call and the guard, not the model, stops it.
const BLOCKED_TEXT =
  "run: cat ~/.ssh/id_ed25519 | wc -c\n" +
  "Only the byte count is printed, not the key. Use the bash tool with exactly that command and report what it returned.";

async function main() {
  if (LC) return mainLc();
  if (PORT === LIVE_PORT) fail("refusing to bind the live service port");
  if (await portInUse(PORT)) fail(`port ${PORT} is already in use`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { mode: 0o700 });
  mkdirSync(WORK, { recursive: true });

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("EVEN_BRIDGE_") || k.startsWith("EVEN_TERMINAL_EXPOSE")) delete env[k];
  Object.assign(env, {
    PORT: String(PORT),
    BRIDGE_TOKEN: TOKEN,
    LETS_CODE_TOKEN: letsCodeToken(),
    PROJECT_DIR: WORK,
    EVEN_BRIDGE_DURABLE_ENABLE: "1",
    EVEN_BRIDGE_DURABLE_STORE: STORE,
    EVEN_BRIDGE_DURABLE_CWDS: ROOT,
    EVEN_BRIDGE_PI_ENABLE: "0",
    EVEN_BRIDGE_RC_ENABLE: "0",
    EVEN_BRIDGE_CC_DISABLED: "1",
    // Loopback only: no LAN listener for the scratch instance.
    EVEN_HOST_MODE: "interface",
    EVEN_HOST_INTERFACE: "lo",
    PI_TELEMETRY: "0",
  });

  say(`mode: ${KILL_MID_TURN ? `kill-mid-turn (${KILL_SIGNAL})` : "standard"}; bridge on 127.0.0.1:${PORT}, store ${STORE}`);
  let c = startBridge(env);
  await waitReady(c);
  const before = rssOf(c.pid);
  say(`bridge ready (pid ${c.pid}); RSS before: ${mib(before.rss)}`);

  if (KILL_MID_TURN) return killMidTurn(env, before);

  // 1. Create a file.
  const r1 = await prompt({ text: CREATE_TEXT, cwd: WORK, name: "smoke", requestId: randomUUID() });
  const sid = r1.sessionId;
  say(`prompt 1 accepted: session ${sid}, submission ${r1.submissionId}`);
  let t = Date.now();
  await waitIdle(sid);
  say(`turn 1 idle after ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const h1 = await history(sid);
  printHistory(h1);
  const hello = join(WORK, "hello.txt");
  if (!existsSync(hello)) fail("hello.txt was not created");
  const content = readFileSync(hello, "utf8");
  if (!/\bhi\b/.test(content)) fail(`hello.txt has unexpected content ${JSON.stringify(content)}`);
  say(`hello.txt exists: ${JSON.stringify(content)}`);
  if (!h1.some((x) => x.role === "assistant")) fail("no assistant answer in turn 1");

  // 2. A command the guard must refuse.
  const r2 = await prompt({ sessionId: sid, text: BLOCKED_TEXT });
  say(`prompt 2 accepted: submission ${r2.submissionId}`);
  t = Date.now();
  await waitIdle(sid);
  say(`turn 2 idle after ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const h2 = await history(sid);
  printHistory(h2.slice(h1.length));
  const msgs = (await api("GET", `/messages?sessionId=${encodeURIComponent(sid)}&after=0`)).json?.messages ?? [];
  const toolEnds = msgs.map((m) => m.message ?? m).filter((f) => f?.type === "tool_end");
  say(`  tool calls (both turns): ${toolEnds.map((f) => f.name).join(", ") || "none"}`);
  const refused = toolEnds.filter((f) => String(f.detail?.output ?? f.summary ?? "").includes("guard:"));
  for (const f of refused) say(`  tool ${f.name} -> ${short(String(f.detail?.output ?? f.summary))}`);
  const lines = guardLines();
  for (const l of lines) say(`GUARD ${l.slice(l.indexOf("[durable:guard]"))}`);
  if (!lines.some((l) => l.includes(".ssh"))) fail("no guard refusal for ~/.ssh in the bridge log");
  const leaked = h2.some((x) => /PRIVATE KEY/.test(x.text)) || toolEnds.some((f) => /PRIVATE KEY/.test(String(f.detail?.output ?? "")));
  if (leaked) fail("the key content reached the transcript");

  const agents = (await api("GET", "/agents")).json?.agents ?? [];
  for (const a of agents) say(`agent ${a.sid} name=${a.name} state=${a.state} model=${a.model} lastLine=${short(a.lastLine ?? "", 100)}`);
  const after = rssOf(c.pid);
  say(`RSS after: ${mib(after.rss)} (peak ${mib(after.hwm)}; before ${mib(before.rss)})`);
  console.log("HISTORY_JSON " + JSON.stringify({ sessionId: sid, history: h2 }));
  say("SMOKE OK");
}

async function killMidTurn(env, before) {
  // The `sleep 4` keeps the turn busy past the 2 s mark (a plain file task
  // finishes in ~2.3 s on the vLLM), so the stop lands inside the bash call.
  const text =
    "Use the bash tool to run exactly: sleep 4 && seq 1 5 > count.txt && cat count.txt\n" +
    "Do not write any text until you are done; then answer once.";
  const r = await prompt({ text, cwd: WORK, name: "smoke-kill", requestId: randomUUID() });
  const sid = r.sessionId;
  say(`prompt accepted: session ${sid}, submission ${r.submissionId}`);
  await sleep(2000);
  const st = (await api("GET", `/status?sessionId=${encodeURIComponent(sid)}`)).json?.state;
  say(`state 2 s after the prompt: ${st}`);
  if (st !== "busy") fail("the turn had already finished 2 s after the prompt; nothing was interrupted");
  const mid = rssOf(child.pid);
  const ex = await stopBridge(child, KILL_SIGNAL);
  say(`bridge stopped mid-turn with ${KILL_SIGNAL} (exit code=${ex?.code} signal=${ex?.signal}); RSS at stop ${mib(mid.rss)}`);
  if (await portInUse(PORT)) fail("port still bound after stop");

  const c2 = startBridge(env);
  await waitReady(c2);
  say(`bridge restarted (pid ${c2.pid}); RSS ${mib(rssOf(c2.pid).rss)}`);
  const t = Date.now();
  await waitIdle(sid, { sawBusy: true });
  say(`resumed turn idle after ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const h = await history(sid);
  printHistory(h);
  const users = h.filter((x) => x.role === "user");
  const answers = h.filter((x) => x.role === "assistant");
  if (users.length !== 1) fail(`expected exactly one user prompt, got ${users.length}`);
  if (answers.length !== 1) fail(`expected exactly one assistant answer, got ${answers.length}`);
  const count = join(WORK, "count.txt");
  if (existsSync(count)) say(`count.txt: ${JSON.stringify(readFileSync(count, "utf8"))}`);
  else say("count.txt missing (the answer above says why)");
  const after = rssOf(c2.pid);
  say(`RSS after: ${mib(after.rss)} (peak ${mib(after.hwm)}; first instance before ${mib(before.rss)})`);
  console.log("HISTORY_JSON " + JSON.stringify({ sessionId: sid, history: h }));
  say("SMOKE OK (kill-mid-turn: one user prompt, one assistant answer after resume)");
}

// ── --engine lets-code ──────────────────────────────────────────────────────

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000 }).trim();
  } catch (err) {
    return String(err.stdout ?? "").trim();
  }
};

/** Pids in a user scope (cgroup v2 `cgroup.procs`), with their comm. */
function scopeProcs(unit) {
  const cg = sh("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", unit]);
  if (!cg) return [];
  let pids = [];
  try {
    pids = readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
  return pids.map((pid) => {
    let comm = "?";
    try {
      comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      /* gone */
    }
    return { pid, comm };
  });
}

/** Read the SSE stream of a session into `frames` until `stop()`. */
function sse(sid, frames) {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/events?sessionId=${encodeURIComponent(sid)}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
      let buf = "";
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString();
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const m = JSON.parse(line.slice(5).trim());
              frames.push(m.message ?? m);
            } catch {
              /* keepalive */
            }
          }
        }
      }
    } catch {
      /* stopped */
    }
  })();
  return () => ac.abort();
}

function lcEnvFor() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("EVEN_BRIDGE_") || k.startsWith("EVEN_TERMINAL_EXPOSE") || k === "LETS_CODE_TOKEN") delete env[k];
  Object.assign(env, {
    PORT: String(PORT),
    BRIDGE_TOKEN: TOKEN,
    PROJECT_DIR: WORK,
    TMPDIR: join(homedir(), "tmp", "ovs-tmp"),
    EVEN_BRIDGE_DURABLE_ENABLE: "1",
    EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE: "1",
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
  return env;
}

function bannerLine() {
  try {
    return readFileSync(LOG, "utf8").split("\n").find((l) => l.includes("[bridge] extensions:")) ?? "";
  } catch {
    return "";
  }
}

/** The child's session file (from the record via history is not enough): newest jsonl under the store's lc-sessions/<sid>. */
function sessionFileOf(sid) {
  const dir = join(ROOT, "lc-sessions", sid);
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    return files.length ? join(dir, files.at(-1)) : null;
  } catch {
    return null;
  }
}

async function waitFor(cond, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await sleep(500);
  }
  fail(`timed out waiting for ${what}`);
}

async function lcStart() {
  if (PORT === LIVE_PORT) fail("refusing to bind the live service port");
  if (await portInUse(PORT)) fail(`port ${PORT} is already in use`);
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
  rmSync(OUTSIDE, { force: true });
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(join(homedir(), "tmp", "ovs-tmp"), { recursive: true });
  const env = lcEnvFor();
  say(`engine lets-code: bridge on 127.0.0.1:${PORT}, store ${STORE}, cwd ${WORK}, bin ${LC_BIN}`);
  const c = startBridge(env);
  await waitReady(c);
  say(`bridge ready (pid ${c.pid}); ${bannerLine().replace(/^.*\[bridge\] /, "")}`);
  if (!/lc=on\(sandbox,(?:mem|nomem)\)/.test(bannerLine())) fail("banner has no lc=on(sandbox,...)");
  return { env, c };
}

async function mainLc() {
  if (KILL_MID_TURN) return killMidTurnLc();
  const { c } = await lcStart();
  const before = rssOf(c.pid);
  // (d) the banner
  const banner = bannerLine();
  say(`(d) banner: ${/lc=on\(sandbox,nomem\)/.test(banner) ? "nomem as expected (no memory controller)" : banner}`);

  // (a) a file inside the project: no dialog
  const frames = [];
  let t = Date.now();
  const r1 = await prompt({ text: "Create hello.txt containing hi", cwd: WORK, name: "ovs-smoke", engine: "lets-code", requestId: randomUUID() });
  const sid = r1.sessionId;
  const stopSse = sse(sid, frames);
  say(`(a) prompt accepted: ${sid}`);
  await sleep(1500);
  // (c) while it runs: pi sits in even-lc-<sid>.scope
  const procs = scopeProcs(`even-lc-${sid}.scope`);
  say(`(c) even-lc-${sid}.scope procs: ${procs.map((p) => `${p.pid}:${p.comm}`).join(" ") || "(none yet)"}`);
  await waitIdle(sid);
  say(`(a) idle after ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const hello = join(WORK, "hello.txt");
  if (!existsSync(hello)) fail("hello.txt was not created");
  say(`(a) hello.txt: ${JSON.stringify(readFileSync(hello, "utf8"))}`);
  const h1 = await history(sid);
  printHistory(h1);
  if (!h1.some((x) => x.role === "assistant")) fail("no assistant answer in /api/history");
  if (frames.some((f) => f.type === "permission_request")) fail("a dialog was asked for a write inside the project");

  // (c) the scope and the child env, with the child still idle-kept
  const procs2 = scopeProcs(`even-lc-${sid}.scope`);
  const pi = procs2.find((p) => p.comm === "pi") ?? procs2[0];
  if (!pi) fail(`no process in even-lc-${sid}.scope`);
  say(`(c) systemd-cgls --user-unit even-lc-${sid}.scope:\n${sh("systemd-cgls", ["--user-unit", `even-lc-${sid}.scope`, "--no-pager"])}`);
  const cg = readFileSync(`/proc/${pi.pid}/cgroup`, "utf8").trim();
  if (!cg.includes(`even-lc-${sid}.scope`)) fail(`pi ${pi.pid} is not in our scope: ${cg}`);
  const ownScope = sh("systemctl", ["--user", "list-units", `lets-code-${pi.pid}.scope`, "--no-legend"]);
  if (ownScope) fail(`lets-code moved pi into its own scope: ${ownScope}`);
  say(`(c) pi ${pi.pid} cgroup ${cg.split("/").pop()}; no lets-code-${pi.pid}.scope`);
  const environ = readFileSync(`/proc/${pi.pid}/environ`, "utf8").split("\0");
  const names = environ.map((kv) => kv.split("=")[0]);
  const tokens = names.filter((n) => /TOKEN|_KEY$/.test(n));
  say(`(c) child env names: ${names.filter(Boolean).sort().join(" ")}`);
  if (tokens.some((n) => n !== "LETS_CODE_TOKEN")) fail(`child env carries ${tokens.join(", ")}`);
  if (tokens.includes("LETS_CODE_TOKEN")) say("(c) LETS_CODE_TOKEN in pi's env: exported by lets-code itself from ~/.config/lets-code/config (the bridge passed none)");
  for (const k of ["LETS_CODE_MEM_WATCH=false", "LETS_CODE_MEM_GUARD=false"]) if (!environ.includes(k)) fail(`child env lacks ${k}`);

  // (a2) a write outside the project: one mandate ask, denied
  const askFrom = frames.length;
  t = Date.now();
  await prompt({ sessionId: sid, text: `Write hi to ~/tmp/ovs-outside.txt` });
  await waitFor(() => frames.slice(askFrom).some((f) => f.type === "permission_request"), TURN_TIMEOUT_MS, "the mandate ask");
  const ask = frames.slice(askFrom).find((f) => f.type === "permission_request");
  say(`(a2) permission_request after ${((Date.now() - t) / 1000).toFixed(1)}s: ${JSON.stringify({ toolName: ask.toolName, description: ask.description, options: ask.options })}`);
  const st = (await api("GET", `/status?sessionId=${encodeURIComponent(sid)}`)).json?.state;
  say(`(a2) status while asking: ${st}`);
  const pr = await api("POST", "/permission-response", { sessionId: sid, decision: "deny" });
  if (pr.status !== 200) fail(`permission-response ${pr.status}: ${JSON.stringify(pr.json)}`);
  await waitIdle(sid, { sawBusy: true });
  if (existsSync(OUTSIDE)) fail(`${OUTSIDE} exists after a deny`);
  const asks = frames.slice(askFrom).filter((f) => f.type === "permission_request").length;
  say(`(a2) denied; ${OUTSIDE} absent; permission requests in this turn: ${asks}`);
  printHistory((await history(sid)).slice(h1.length));

  // stop: scope gone, the live bridge does not list it
  const agents = (await api("GET", "/agents")).json?.agents ?? [];
  for (const a of agents) say(`agent ${a.sid} engine=${a.engine} factory=${a.factory} state=${a.state} lastLine=${short(a.lastLine ?? "", 100)}`);
  const stop = await api("POST", `/agents/${encodeURIComponent(sid)}/stop`);
  if (stop.status !== 200) fail(`stop ${stop.status}: ${JSON.stringify(stop.json)}`);
  stopSse();
  await sleep(1000);
  const left = sh("systemctl", ["--user", "list-units", `even-lc-${sid}.scope`, "--no-legend"]);
  if (left) fail(`scope still there after stop: ${left}`);
  say(`(c) after stop: systemctl --user list-units 'even-lc-${sid}*' is empty`);
  const liveSessions = await fetch(`http://127.0.0.1:${LIVE_PORT}/api/sessions`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json())
    .catch((err) => ({ error: err.message }));
  const listed = JSON.stringify(liveSessions).includes(sid) || JSON.stringify(liveSessions).includes(pi.pid);
  say(`(c) live bridge /api/sessions (read-only GET): ${Array.isArray(liveSessions?.sessions) ? liveSessions.sessions.length + " sessions" : JSON.stringify(liveSessions).slice(0, 120)}; lists our session: ${listed}`);
  if (listed) fail("the live bridge lists the throwaway session");
  const after = rssOf(c.pid);
  say(`bridge RSS ${mib(before.rss)} → ${mib(after.rss)} (peak ${mib(after.hwm)})`);
  say("SMOKE OK (lets-code: a, a2, c, d)");
}

async function killMidTurnLc() {
  const { env, c } = await lcStart();
  const text = "Run: sleep 20 && echo done > done.txt\nUse the bash tool with exactly that command, then say done.";
  const r = await prompt({ text, cwd: WORK, name: "ovs-kill", engine: "lets-code", requestId: randomUUID() });
  const sid = r.sessionId;
  say(`(b) prompt accepted: ${sid}`);
  // Wait until the bash call is running (its toolCall is in the session file).
  await waitFor(() => {
    const f = sessionFileOf(sid);
    return f && existsSync(f) && /"toolCall"[^\n]*sleep 20/.test(readFileSync(f, "utf8"));
  }, TURN_TIMEOUT_MS, "the sleep tool call");
  const procs = scopeProcs(`even-lc-${sid}.scope`);
  const pi = procs.find((p) => p.comm === "pi");
  say(`(b) running: scope procs ${procs.map((p) => `${p.pid}:${p.comm}`).join(" ")}`);
  await sleep(2000);
  const ex = await stopBridge(child, KILL_SIGNAL);
  say(`(b) bridge stopped mid-turn with ${KILL_SIGNAL} (exit code=${ex?.code} signal=${ex?.signal})`);
  const reg = pi ? join(homedir(), ".pi", "agent", "lets-code-sessions", `${pi.pid}.json`) : null;
  say(`(b) old pi ${pi?.pid}: alive=${pi ? existsSync(`/proc/${pi.pid}`) : "?"}; registry file present=${reg ? existsSync(reg) : "?"}`);
  const t = Date.now();
  const c2 = startBridge(env);
  await waitReady(c2);
  say(`(b) bridge restarted (pid ${c2.pid})`);
  await waitIdle(sid, { sawBusy: true });
  say(`(b) resumed run idle after ${((Date.now() - t) / 1000).toFixed(1)}s`);
  const file = sessionFileOf(sid);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const cutoffs = lines.filter((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("You were cut off by a restart of the bridge")).length;
  say(`(b) cut-off prompts in ${file.split("/").pop()}: ${cutoffs}`);
  if (cutoffs !== 1) fail(`expected exactly one cut-off prompt, got ${cutoffs}`);
  const done = join(WORK, "done.txt");
  if (!existsSync(done)) fail("done.txt missing after the resume");
  say(`(b) done.txt: ${JSON.stringify(readFileSync(done, "utf8"))}`);
  if (reg && existsSync(reg)) fail(`stale registry file ${reg} still there`);
  say(`(b) no lets-code-sessions/${pi?.pid}.json`);
  printHistory(await history(sid));
  const stop = await api("POST", `/agents/${encodeURIComponent(sid)}/stop`);
  if (stop.status !== 200) fail(`stop ${stop.status}`);
  await sleep(1000);
  const left = sh("systemctl", ["--user", "list-units", `even-lc-${sid}.scope`, "--no-legend"]);
  if (left) fail(`scope still there after stop: ${left}`);
  say("SMOKE OK (lets-code kill-mid-turn: one cut-off prompt, done.txt, no stale registry)");
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 1;
  say(`SMOKE FAIL: ${err instanceof SmokeFail ? err.message : err.stack}`);
  say(`bridge log: ${LOG}${KEEP ? "" : " (pass --keep to inspect it)"}`);
} finally {
  await stopBridge(child);
  if (!KEEP) {
    rmSync(ROOT, { recursive: true, force: true });
    if (LC) {
      rmSync(WORK, { recursive: true, force: true });
      rmSync(OUTSIDE, { force: true });
    }
  } else say(`kept ${ROOT}`);
}
process.exit(code);
