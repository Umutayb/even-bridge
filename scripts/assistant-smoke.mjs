#!/usr/bin/env node
// Plan Task A2 Step 4: the real run of the even-assistant extension. A throwaway bridge on 127.0.0.1:3466
// (store ~/tmp/ovs-a2-store, cwd ~/tmp/ovs-a2/assistant, EVEN_BRIDGE_DURABLE_ENABLE=1
// EVEN_BRIDGE_ASSISTANT_ENABLE=1) with the real lets-code + vLLM and this repo's even-assistant.ts, and
// test/helpers/fake-tool-server.mjs on 127.0.0.1:8815 with dated fixtures (Lasagna Fri 13 Nov 18:00,
// Thu 5 Nov nothing, Fri 6 Nov "12:30 Team lunch"). Checks:
//   (a) "What am I eating on Friday the 13th?" → one fetch_calendar 2026-11-13, the answer names Lasagna;
//   (b) "And on Thursday?" → a second fetch_calendar, no Lasagna in the answer (the old result is stubbed);
//   (c) "Remember that I like tea." → the core-memory store gains a fact; "I like coffee." → no write;
//   (d) the bridge SIGKILLed mid-turn and restarted → `assistant_restarted` (frame or state.lost), and the
//       next turn does not resume the cut request (A2 ruling 1);
//   (e) POST /api/assistant/reset → a new session file, and a memory search still finds tea.
//   (c) passes with tea stored or an honest "not saved" answer, never a run the tool cap ended.
// Usage: node scripts/assistant-smoke.mjs [--keep]. Prints JSON lines and never prints a token; writes a
// summary and the extension log (counts only) to ~/tmp/assistant-a2-run/, then removes ~/tmp/ovs-a2*
// and the throwaway cwd's core-memory dir (unless --keep). Never touches the live bridge (3456).
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const H = homedir();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(H, "tmp", "ovs-a2");
const STORE_DIR = join(H, "tmp", "ovs-a2-store");
const STORE = join(STORE_DIR, "durable.sqlite");
const CWD = join(ROOT, "assistant");
const TOKEN_FILE = join(ROOT, "token");
const BRIDGE_LOG = join(ROOT, "bridge.log");
const EXT_LOG = join(STORE_DIR, "lc-sessions", "assistant-ext.jsonl");
const OUT_DIR = join(H, "tmp", "assistant-a2-run");
const PORT = 3466;
const TOOLS_PORT = 8815;
const KEEP = process.argv.includes("--keep");
const ASSISTANT_EXT = join(REPO, "src", "providers", "durable", "lc", "even-assistant.ts");

if (process.argv.includes("--child")) {
  const { startServer } = await import(join(REPO, "src", "server.mjs"));
  await startServer({ cwd: CWD });
  await new Promise(() => {});
}

const { startFakeToolServer } = await import(join(REPO, "test", "helpers", "fake-tool-server.mjs"));
const out = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 23), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  out({ fail: m });
  throw new Error(m);
};
const portInUse = (port) =>
  new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
const extLog = () => {
  try {
    return readFileSync(EXT_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

for (const p of [PORT, TOOLS_PORT]) if (await portInUse(p)) fail(`port ${p} in use`);
rmSync(ROOT, { recursive: true, force: true });
rmSync(STORE_DIR, { recursive: true, force: true });
for (const d of [ROOT, CWD, STORE_DIR, OUT_DIR, join(H, "tmp", "ovs-tmp")]) mkdirSync(d, { recursive: true, mode: 0o700 });
writeFileSync(TOKEN_FILE, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
chmodSync(TOKEN_FILE, 0o600);
const BRIDGE_TOKEN = randomBytes(24).toString("hex");
// /api/assistant/* takes only the assistant API token (A1 fix round 1); its own file, never the live one.
const API_TOKEN_FILE = join(ROOT, "assistant-api.token");
const API_TOKEN = randomBytes(24).toString("hex");
writeFileSync(API_TOKEN_FILE, `${API_TOKEN}\n`, { mode: 0o600 });
// lets-code's core-memory store for this cwd (A0: `<basename>-<sha1(cwd)[0:8]>`).
const CORE_MEM = join(H, ".pi", "agent", "core-memory", "projects", `assistant-${createHash("sha1").update(CWD).digest("hex").slice(0, 8)}`);
const MEM_FILE = join(CORE_MEM, "memory.jsonl");
const coreMemExisted = existsSync(CORE_MEM);
const memLines = () => {
  try {
    return readFileSync(MEM_FILE, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const tools = await startFakeToolServer({ port: TOOLS_PORT, tokenFile: TOKEN_FILE });
const BASE = `http://127.0.0.1:${PORT}/api`;
const auth = { authorization: `Bearer ${BRIDGE_TOKEN}` };
async function api(method, path, body, ms = 30000) {
  const t0 = Date.now();
  const who = path.startsWith("/assistant/") ? { authorization: `Bearer ${API_TOKEN}` } : auth;
  const r = await fetch(BASE + path, { method, headers: { ...who, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* no body */
  }
  return { status: r.status, json, ms: Date.now() - t0 };
}
function bridgeEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("EVEN_BRIDGE_") || k.startsWith("EVEN_ASSISTANT_") || k.startsWith("EVEN_TERMINAL_EXPOSE") || /TOKEN$|_KEY$/.test(k)) delete env[k];
  return {
    ...env,
    PORT: String(PORT),
    BRIDGE_TOKEN,
    PROJECT_DIR: CWD,
    TMPDIR: join(H, "tmp", "ovs-tmp"),
    EVEN_BRIDGE_DURABLE_ENABLE: "1",
    EVEN_BRIDGE_ASSISTANT_ENABLE: "1",
    EVEN_BRIDGE_DURABLE_STORE: STORE,
    EVEN_BRIDGE_LC_BIN: join(H, ".local", "bin", "lets-code"),
    EVEN_BRIDGE_ASSISTANT_TOOLS_URL: `http://127.0.0.1:${TOOLS_PORT}`,
    EVEN_BRIDGE_ASSISTANT_TOKEN_FILE: TOKEN_FILE,
    EVEN_BRIDGE_ASSISTANT_CWD: CWD,
    EVEN_BRIDGE_ASSISTANT_API_TOKEN_FILE: API_TOKEN_FILE,
    EVEN_BRIDGE_PI_ENABLE: "0",
    EVEN_BRIDGE_RC_ENABLE: "0",
    EVEN_BRIDGE_CC_DISABLED: "1",
    EVEN_BRIDGE_SKIP_PATCH_DIST: "1",
    EVEN_HOST_MODE: "interface",
    EVEN_HOST_INTERFACE: "lo",
    PI_TELEMETRY: "0",
  };
}
let bridge = null;
function startBridge() {
  const fd = openSync(BRIDGE_LOG, "a", 0o600);
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], { cwd: CWD, env: bridgeEnv(), stdio: ["ignore", fd, fd] });
  closeSync(fd);
  c.exited = new Promise((r) => c.once("exit", (code, signal) => r({ code, signal })));
  bridge = c;
}
async function stopBridge(signal = "SIGTERM") {
  const c = bridge;
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  c.kill(signal);
  const r = await Promise.race([c.exited, sleep(10000).then(() => null)]);
  if (!r) {
    c.kill("SIGKILL");
    await c.exited;
  }
}
async function waitState(pred, ms, what) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try {
      const r = await api("GET", "/assistant/state", null, 5000);
      last = r.json;
      if (r.status === 200 && pred(r.json)) return r.json;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  fail(`timed out: ${what} (last ${JSON.stringify(last)})`);
}

// ---- SSE ----
const frames = [];
let sseAbort = null;
async function sse() {
  const ac = new AbortController();
  sseAbort = ac;
  const r = await fetch(`${BASE}/events?sessionId=dur-assistant`, { headers: auth, signal: ac.signal });
  if (r.status !== 200) fail(`SSE ${r.status}`);
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const f = JSON.parse(line.slice(5).trim());
              frames.push({ t: Date.now(), ...(f.message && typeof f.message === "object" ? f.message : f) });
            } catch {
              /* not JSON */
            }
          }
        }
      }
    } catch {
      /* closed */
    }
  })();
}

const pad = (n) => String(n).padStart(2, "0");
const header = () => {
  const d = new Date();
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" });
  const mo = d.toLocaleDateString("en-GB", { month: "short" });
  return `[${pad(d.getHours())}:${pad(d.getMinutes())} ${wd} ${d.getDate()} ${mo} ${d.getFullYear()}, Europe/Amsterdam · lang en · style brief]`;
};

/** One turn through /api/assistant/prompt + SSE. */
async function turn(label, words, { ms = 60000, ignore = [] } = {}) {
  const from = frames.length;
  const c0 = tools.calls.length;
  const t0 = Date.now();
  const r = await api("POST", "/assistant/prompt", { text: `${header()} ${words}`, requestId: `${label}-${t0}` });
  if (r.status !== 202) {
    out({ turn: label, status: r.status, body: r.json });
    return { label, status: r.status, calls: [], text: "", toolNames: [] };
  }
  const since = () => frames.slice(from);
  while (Date.now() - t0 < ms) {
    const s = since();
    if (s.some((f) => f.type === "result") && s.at(-1)?.type === "status" && s.at(-1)?.state === "idle") break;
    if (s.some((f) => f.type === "error" && !ignore.includes(f.code)) && s.some((f) => f.type === "status" && f.state === "idle")) break;
    await sleep(50);
  }
  const at = (f) => (f ? f.t - t0 : null);
  const s = since();
  const res = {
    label,
    status: r.status,
    first_tool_ms: at(s.find((f) => f.type === "tool_start")),
    first_text_ms: at(s.find((f) => f.type === "text_delta")),
    result_ms: at(s.find((f) => f.type === "result")),
    errors: s.filter((f) => f.type === "error").map((f) => f.code ?? f.message),
    toolNames: s.filter((f) => f.type === "tool_start").map((f) => f.name),
    calls: tools.calls.slice(c0).map((c) => ({ tool: c.tool, args: c.args, authOk: c.authOk })),
    text: s.filter((f) => f.type === "text_delta").map((f) => f.text).join("").trim(),
  };
  out({ turn: label, ...res, text: res.text.slice(0, 240) });
  return res;
}

const summary = { checks: {} };
const check = (k, ok, detail) => {
  summary.checks[k] = { ok: Boolean(ok), ...detail };
  out({ check: k, ok: Boolean(ok), ...detail });
};
try {
  const t0 = Date.now();
  startBridge();
  const ready = await waitState((s) => s.status === "idle" && s.toolsLoaded > 0, 60000, "warm assistant");
  summary.cold_start_ms = Date.now() - t0;
  out({ step: "warm", ms: summary.cold_start_ms, toolsLoaded: ready.toolsLoaded, toolsSource: ready.toolsSource });
  summary.schema = extLog().find((x) => x.kind === "schema") ?? null;
  await sse();
  await sleep(300);

  // (a) + (b): stale phone data
  const a = await turn("a-friday13", "What am I eating on Friday the 13th?");
  const aCal = a.calls.filter((c) => c.tool === "fetch_calendar");
  check("a", aCal.length === 1 && aCal[0].args.from === "2026-11-13" && aCal[0].args.to === "2026-11-13" && /lasagna/i.test(a.text), { calendarCalls: aCal.map((c) => c.args), ms: a.result_ms, text: a.text.slice(0, 160) });
  const logB = extLog().length;
  const b = await turn("b-thursday", "And on Thursday?");
  const bCal = b.calls.filter((c) => c.tool === "fetch_calendar");
  const bCtx = extLog().slice(logB).filter((x) => x.kind === "context");
  check("b", bCal.length >= 1 && !/lasagna/i.test(b.text), { calendarCalls: bCal.map((c) => c.args), staleStubbed: bCtx.reduce((n, x) => Math.max(n, x.stale ?? 0), 0), ms: b.result_ms, text: b.text.slice(0, 160) });

  // (c): memory on request only
  const m0 = memLines().length;
  const logT = extLog().length;
  const c1 = await turn("c-tea", "Remember that I like tea.");
  const m1 = memLines();
  const noGist = extLog().slice(logT).filter((x) => x.kind === "memory_no_gist").length;
  const teaStored = m1.length > m0 && m1.slice(m0).some((l) => /tea/i.test(l));
  // Re-review N1: tea stored, or an honest "not saved" answer; never a run the tool cap ended.
  const honest = /\b(not|n't|never)\b[^.]{0,40}\b(saved|stored|remembered|save|store)\b|\bcould(n't| not)\b/i.test(c1.text);
  const logC = extLog().length;
  const c2 = await turn("c-coffee", "I like coffee.");
  const m2 = memLines();
  const blocked = extLog().slice(logC).filter((x) => x.kind === "memory_blocked").length;
  check("c", (teaStored || honest) && !c1.errors.includes("assistant_tool_cap") && m2.length === m1.length && !m2.some((l) => /coffee/i.test(l)), {
    teaEntries: m1.length - m0,
    teaNoGistBlocks: noGist,
    teaErrors: c1.errors,
    teaText: c1.text.slice(0, 120),
    coffeeWrites: m2.length - m1.length,
    coffeeBlockedCalls: blocked,
    teaTools: c1.toolNames,
    coffeeTools: c2.toolNames,
    coffeeText: c2.text.slice(0, 120),
  });

  // (d): restart mid-turn, then the cut request must not be resumed
  tools.delays.web_search = 8000;
  const from = frames.length;
  const cut = await api("POST", "/assistant/prompt", { text: `${header()} Search the web for "aurora tonight" and tell me what you find.`, requestId: `kill-${Date.now()}` });
  const tk = Date.now();
  while (Date.now() - tk < 30000 && !tools.calls.some((c) => c.tool === "web_search")) await sleep(100);
  const reachedTool = tools.calls.some((c) => c.tool === "web_search");
  await sleep(500);
  sseAbort?.abort();
  await stopBridge("SIGKILL");
  out({ step: "bridge SIGKILLed mid-turn", accepted: cut.status, reachedTool });
  delete tools.delays.web_search;
  await sleep(1500);
  const t1 = Date.now();
  const webBefore = tools.calls.filter((c) => c.tool === "web_search").length;
  startBridge();
  const st = await waitState((s) => s.status === "idle" && s.toolsLoaded > 0, 60000, "warm after restart");
  summary.restart_warm_ms = Date.now() - t1;
  await sse();
  await sleep(1500);
  const logD = extLog().length;
  // The `assistant_restarted` frame is replayed late (A1 finding 6): it may arrive inside this turn.
  const d = await turn("d-after-restart", "Say something nice about Fridays.", { ignore: ["assistant_restarted"] });
  await waitState((s) => s.status === "idle", 60000, "idle after the restart turn");
  await sleep(500);
  const restartedFrame = frames.slice(from).some((f) => f.type === "error" && f.code === "assistant_restarted");
  const webAfter = tools.calls.filter((c) => c.tool === "web_search").length;
  const cutStubbed = extLog().slice(logD).filter((x) => x.kind === "context").reduce((n, x) => Math.max(n, x.cut ?? 0), 0);
  const noteSent = extLog().some((x) => x.kind === "note" && x.restart === true);
  check("d", (restartedFrame || st.lost?.requestId) && webAfter === webBefore && cutStubbed >= 1 && !/aurora/i.test(d.text), {
    restartedFrame,
    lost: st.lost ? { requestId: String(st.lost.requestId ?? "").replace(/-\d+$/, "-…") } : null,
    restartNoteSent: noteSent,
    cutStubbed,
    resumedWebSearch: webAfter - webBefore,
    tools: d.toolNames,
    warm_ms: summary.restart_warm_ms,
    text: d.text.slice(0, 160),
  });

  // (e): reset, then memory still knows the tea
  const before = await waitState((s) => s.status === "idle", 60000, "idle before the reset");
  const rs = await api("POST", "/assistant/reset", {}, 240000);
  const after = (await api("GET", "/assistant/state")).json;
  const e = await turn("e-memory", "Search your memory: what do I like to drink?");
  check("e", rs.status === 200 && before.sessionFile !== after.sessionFile && e.toolNames.includes("memory") && /tea/i.test(e.text), {
    resetStatus: rs.status,
    reset_ms: rs.ms,
    newSessionFile: before.sessionFile !== after.sessionFile,
    tools: e.toolNames,
    text: e.text.slice(0, 160),
  });

  // The prompt section in the session file and the token cap in the provider requests.
  try {
    const sess = readFileSync(after.sessionFile, "utf8");
    summary.instructionsInSession = sess.includes("only from this turn's tool results");
  } catch {
    summary.instructionsInSession = null;
  }
  const reqs = extLog().filter((x) => x.kind === "provider_request");
  summary.providerRequests = { n: reqs.length, capped: reqs.filter((x) => x.capped).length, maxTokens: [...new Set(reqs.map((x) => x.max_tokens ?? x.max_completion_tokens))] };
  summary.toolCap = extLog().filter((x) => x.kind === "tool_cap").length;
  summary.turns = { a, b, c1, c2, d, e };
  out({ instructionsInSession: summary.instructionsInSession, providerRequests: summary.providerRequests });
} catch (err) {
  out({ error: String(err?.stack ?? err).slice(0, 400) });
  process.exitCode = 1;
} finally {
  sseAbort?.abort();
  await stopBridge("SIGTERM");
  await tools.close();
  await sleep(1000);
  let leftover = "";
  try {
    leftover = execFileSync("systemctl", ["--user", "list-units", "--no-legend", "even-lc-dur-assistant-*"], { encoding: "utf8" }).trim();
  } catch {
    /* none */
  }
  // Only this run's scope may be left: the live bridge's assistant (if any) runs under another store hash.
  summary.teardown = { scopes: leftover || null, port3466: await portInUse(PORT), port8815: await portInUse(TOOLS_PORT) };
  try {
    copyFileSync(EXT_LOG, join(OUT_DIR, "assistant-ext.jsonl"));
  } catch {
    /* no log */
  }
  try {
    // hex runs of 32+ (the bridge and tool tokens) are masked
    writeFileSync(join(OUT_DIR, "bridge.log"), readFileSync(BRIDGE_LOG, "utf8").replace(/[0-9a-f]{32,}/g, "<hex>"), { mode: 0o600 });
  } catch {
    /* no log */
  }
  if (!KEEP) {
    rmSync(ROOT, { recursive: true, force: true });
    rmSync(STORE_DIR, { recursive: true, force: true });
    if (!coreMemExisted) rmSync(CORE_MEM, { recursive: true, force: true });
  }
  summary.removed = !KEEP;
  const ok = Object.values(summary.checks).every((c) => c.ok) && Object.keys(summary.checks).length === 5;
  summary.ok = ok && process.exitCode !== 1;
  writeFileSync(join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  out({ teardown: summary.teardown, removed: summary.removed, ok: summary.ok });
  if (!summary.ok) process.exitCode = 1;
}
