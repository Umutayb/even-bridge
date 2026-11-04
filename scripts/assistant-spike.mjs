#!/usr/bin/env node
// Assistant spike (overseer plan, Task A0): a warm assistant-profile lets-code
// RPC child against a stub tool server; prints JSON. Runtime code is untouched.
//
//   node scripts/assistant-spike.mjs --thinking medium|low --tools 0|1|2 --n 20 [--keep]
//   node scripts/assistant-spike.mjs --cold 3 [--pins]     cold spawns (spawn -> get_state)
//   node scripts/assistant-spike.mjs --modules             default env vs ASSISTANT_MODULE_ENV
//   node scripts/assistant-spike.mjs --checks              plan Task A0 Step 4 (a)-(e)
//   node scripts/assistant-spike.mjs --compact [--keep-recent N] [--approve]   model switch + compact reply
//   matrix options: [--prompt-v1] (the first, unrouted system prompt) [--max-tool-calls 8]
//   common: [--root ~/tmp/ovs-a0] [--port 8815] [--bin ~/.local/bin/lets-code] [--no-module-env]
//
// Layout under --root: assistant/ (the cwd, no git), sessions/ (--session-dir),
// token (0600), probe-assistant.ts (a throwaway version of plan Task A2),
// notes/, log.jsonl (every event), probe.jsonl (what the extension saw),
// runs/<name>.json (each summary). Binds only 127.0.0.1:<port> (the stub tool
// server). The child runs in the user scope even-lc-a0; nothing else is
// stopped or touched. --keep leaves the scope running at the end.

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { LineSplitter } from "../src/providers/pi/framing.mjs";
import { shellEnv } from "../src/providers/durable/guard.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(name);
const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());

const ROOT = resolve(expand(opt("--root", "~/tmp/ovs-a0")));
const CWD = join(ROOT, "assistant");
const SESS = join(ROOT, "sessions");
const NOTES = join(ROOT, "notes");
const RUNS = join(ROOT, "runs");
const TOKEN_FILE = join(ROOT, "token");
const EXT = join(ROOT, "probe-assistant.ts");
const LOG = join(ROOT, "log.jsonl");
const PROBE_LOG = join(ROOT, "probe.jsonl");
const PORT = Number(opt("--port", "8815"));
const BIN = expand(opt("--bin", "~/.local/bin/lets-code"));
const LC_EXT = join(homedir(), ".pi/agent/extensions/lets-code");
const UNIT = "even-lc-a0";
const TOOLS = "fetch_calendar,fetch_notes,memory";
const KEEP = has("--keep");
const THINKING = opt("--thinking", "medium");
const NTOOLS = Number(opt("--tools", "0"));
const N = Number(opt("--n", "20"));

// The env that leaves lets-code's core memory, agent guard and grounding on
// and every other module off (the launcher reads LETS_CODE_<X>, not the
// LETS_CODE_<X>_ON switches, which it unsets and derives itself). The
// mandate module has no env switch that removes it: LETS_CODE_MANDATE=false
// still loads it with plan mode dormant; the launcher flag --no-mandate
// (MANDATE_FLAG) removes it.
export const ASSISTANT_MODULE_ENV = {
  LETS_CODE_SUBAGENTS: "false", LETS_CODE_EXPERTS: "false", LETS_CODE_SESSIONS: "false",
  LETS_CODE_CLAUDE_CODE: "false", LETS_CODE_MANDATE: "false", LETS_CODE_SANDBOX: "false",
  LETS_CODE_GIT_GUARD: "false", LETS_CODE_SESSION_TAG: "false", LETS_CODE_METRICS: "false",
  LETS_CODE_CORE_MEMORY: "true", LETS_CODE_AGENT_GUARD: "true", LETS_CODE_GROUNDING: "true",
};
const MANDATE_FLAG = "--no-mandate";
// v1 (the first matrix run) was only the first two sentences: qwen then answered calendar
// questions from `memory search` ("no calendar connected") and, at low, looped on
// memory search 519 times in one run. v2 routes the tools by name.
const SYSTEM_APPEND = "You are Even AI, the voice assistant on the user's smart glasses. Answer in one or two short spoken sentences. "
  + "Facts about the user's calendar and notes come only from tool results of this turn: call the tool again whenever they ask, even if you answered before. "
  + (has("--prompt-v1") ? "" : "For anything about the user's schedule, call fetch_calendar with explicit dates; for their notes, call fetch_notes. "
  + "The memory tool holds only what the user asked you to remember: never use it for calendar or notes, and search it at most once per question.");
const MAX_TOOL_CALLS = Number(opt("--max-tool-calls", "8"));

for (const d of [ROOT, CWD, SESS, NOTES, RUNS, join(ROOT, "..", "ovs-tmp")]) mkdirSync(d, { recursive: true });
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
chmodSync(TOKEN_FILE, 0o600);
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();

// ---- the probe extension (throwaway plan Task A2) ---------------------------
writeFileSync(EXT, `// assistant spike probe: schema from the tool server, HTTP tools, stale-data context hook, /even-note
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
const URL = process.env.EVEN_ASSISTANT_TOOLS_URL ?? "";
const TOKF = process.env.EVEN_ASSISTANT_TOOLS_TOKEN_FILE ?? "";
const LOG = process.env.EVEN_A0_PROBE_LOG ?? "";
const log = (kind: string, data: any = {}) => { if (LOG) try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), kind, ...data }) + "\\n"); } catch { /* best effort */ } };
const MAX_CALLS = Number(process.env.EVEN_A0_MAX_TOOL_CALLS ?? "8");
const stub = (label: string) => \`[\${label} result of an earlier turn removed: fetch again]\`;
export default async function (pi: any) {
  const t0 = Date.now();
  log("load", { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^LETS_CODE_.*_ON$/.test(k))) });
  let schema: any = { tools: [] };
  try { const r = await fetch(\`\${URL}/tools/schema\`, { signal: AbortSignal.timeout(3000) }); schema = await r.json(); }
  catch (e) { log("schema_error", { e: String(e) }); }
  log("schema", { n: schema.tools?.length ?? 0, ms: Date.now() - t0, rememberPattern: schema.rememberPattern });
  let token = ""; try { token = readFileSync(TOKF, "utf8").trim(); } catch { /* none */ }
  const labels = new Map<string, string>();
  for (const t of schema.tools ?? []) {
    if (t.phoneData) labels.set(t.name, t.stubLabel ?? t.name);
    pi.registerTool({
      name: t.name, label: t.name, description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {} },
      async execute(toolCallId: string, params: any, signal?: AbortSignal) {
        const sigs = [AbortSignal.timeout(12000), ...(signal ? [signal] : [])];
        const r = await fetch(\`\${URL}/tools/\${t.name}\`, { method: "POST", signal: AbortSignal.any(sigs),
          headers: { "content-type": "application/json", authorization: \`Bearer \${token}\` },
          body: JSON.stringify({ args: params ?? {}, toolCallId }) });
        if (!r.ok) throw new Error(\`tool server answered \${r.status}\`);
        const j: any = await r.json();
        return { content: [{ type: "text", text: String(j.text ?? j.error ?? "") }], details: undefined };
      },
    });
  }
  let calls = 0;
  pi.on("agent_start", async () => { calls = 0; });
  pi.on("tool_call", async (event: any) => {
    calls++;
    if (calls > MAX_CALLS) { log("tool_cap", { calls, tool: event?.toolName }); return { block: true, reason: \`at most \${MAX_CALLS} tool calls per answer: answer now with what you have\` }; }
  });
  pi.on("session_start", async () => {
    log("active_tools", { active: pi.getActiveTools(), all: pi.getAllTools().map((x: any) => x.name) });
  });
  pi.on("context", async (event: any) => {
    const msgs = event.messages ?? [];
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") { lastUser = i; break; }
    let n = 0;
    const out = msgs.map((m: any, i: number) => {
      if (i < lastUser && m?.role === "toolResult" && labels.has(m.toolName)) { n++; return { ...m, content: [{ type: "text", text: stub(labels.get(m.toolName)!) }] }; }
      return m;
    });
    log("context", { messages: msgs.length, stubbed: n, roles: msgs.map((m: any) => m?.role === "toolResult" ? \`tool:\${m.toolName}\` : m?.role).slice(-12) });
    return n ? { messages: out } : undefined;
  });
  pi.on("before_provider_request", async (event: any) => {
    const p = event?.payload ?? {};
    const s = JSON.stringify(p);
    const tools = Array.isArray(p.tools) ? p.tools.map((t: any) => t?.function?.name ?? t?.name) : null;
    log("provider_request", { stubs: (s.match(/earlier turn removed: fetch again/g) ?? []).length, lasagna: (s.match(/Lasagna/g) ?? []).length,
      tools, bytes: s.length, model: p.model, thinking: p.chat_template_kwargs ?? p.reasoning_effort ?? p.thinking ?? null,
      maxTokens: p.max_tokens ?? p.max_completion_tokens ?? null });
  });
  pi.registerCommand("even-note", {
    description: "send a host note to the model without a turn",
    handler: async (args: string) => {
      const f = String(args ?? "").trim();
      let content = "";
      try { content = readFileSync(f, "utf8"); unlinkSync(f); } catch (e) { log("note_error", { f, e: String(e) }); return; }
      pi.sendMessage({ customType: "even-note", content, display: true }, { triggerTurn: false });
      log("note_sent", { bytes: content.length });
    },
  });
}
`);

const t0 = Date.now();
const log = (kind, data) => appendFileSync(LOG, JSON.stringify({ t: Date.now() - t0, at: new Date().toISOString(), kind, ...data }) + "\n");
const probeLines = (since) => {
  try { return readFileSync(PROBE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.t >= since); } catch { return []; }
};

// ---- stub tool server --------------------------------------------------------
const toolHits = [];
const SCHEMA = {
  tools: [
    { name: "fetch_calendar", description: "Fetch calendar events between two dates (YYYY-MM-DD).",
      parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
      untrusted: false, phoneData: true, stubLabel: "calendar" },
    { name: "fetch_notes", description: "Fetch the user's notes from the phone.",
      parameters: { type: "object", properties: {} }, untrusted: false, phoneData: true, stubLabel: "notes" },
  ],
  rememberPattern: "\\b(remember|note|save)\\b",
};
const server = createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url === "/tools/schema") return send(200, SCHEMA);
  const m = /^\/tools\/([a-z_]+)$/.exec(req.url ?? "");
  if (req.method !== "POST" || !m) return send(404, { error: "not found" });
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const authOk = req.headers.authorization === `Bearer ${TOKEN}`;
    let args = {};
    try { args = JSON.parse(body || "{}").args ?? {}; } catch { /* bad body */ }
    toolHits.push({ t: Date.now(), tool: m[1], authOk, args });
    log("tool_hit", { tool: m[1], authOk, args });
    if (!authOk) return send(401, { error: "bad token" });
    setTimeout(() => {
      if (m[1] === "fetch_calendar") return send(200, { text: `window: ${args.from ?? "?"} 00:00 to ${args.to ?? "?"} 24:00 (local)\n18:00 Lasagna` });
      if (m[1] === "fetch_notes") return send(200, { text: "notes (2): Buy oat milk · Call Anna about Saturday" });
      return send(404, { error: "unknown tool" });
    }, 1000);
  });
});
await new Promise((r, j) => { server.once("error", j); server.listen(PORT, "127.0.0.1", r); });

// ---- process memory (no memory cgroup on borealis: sum the process tree) -------
function procTree(root) {
  const kids = new Map();
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = readFileSync(`/proc/${n}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(n));
    } catch { /* gone */ }
  }
  const out = [];
  const walk = (p) => { out.push(p); for (const k of kids.get(p) ?? []) walk(k); };
  walk(root);
  return out;
}
function treeMem(root) {
  let rss = 0, pss = 0, swap = 0; const cmds = [];
  for (const pid of procTree(root)) {
    try {
      for (const l of readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").split("\n")) {
        const m = /^(Rss|Pss|Swap):\s+(\d+) kB/.exec(l);
        if (m) { const v = Number(m[2]) * 1024; if (m[1] === "Rss") rss += v; else if (m[1] === "Pss") pss += v; else swap += v; }
      }
      cmds.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, 3).join(" ").slice(0, 80));
    } catch { /* gone */ }
  }
  const MB = (b) => Math.round(b / 1048576);
  return { rssMB: MB(rss), pssMB: MB(pss), swapMB: MB(swap), procs: cmds.length, cmds };
}
function memAvailableMB() {
  const m = /MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

// ---- the child ---------------------------------------------------------------
let child = null;
const pending = new Map();
const listeners = new Set();
const stderrLines = [];

function childEnv({ moduleEnv = !has("--no-module-env"), pins = false } = {}) {
  const own = {
    LETS_CODE_MEM_WATCH: "false", LETS_CODE_MEM_GUARD: "false", PI_TELEMETRY: "0",
    TMPDIR: join(ROOT, "..", "ovs-tmp"),
    EVEN_ASSISTANT_TOOLS_URL: `http://127.0.0.1:${PORT}`, EVEN_ASSISTANT_TOOLS_TOKEN_FILE: TOKEN_FILE,
    EVEN_A0_PROBE_LOG: PROBE_LOG, EVEN_A0_MAX_TOOL_CALLS: String(MAX_TOOL_CALLS),
    ...(moduleEnv ? ASSISTANT_MODULE_ENV : {}),
    // the values the launcher detects today; pinned, it skips the two probe model calls
    ...(pins ? { LETS_CODE_REASONING: "true", LETS_CODE_VISION: "true" } : {}),
  };
  return shellEnv(own); // allowlisted base env, no *_TOKEN/*_KEY: the launcher reads TOKEN from ~/.config/lets-code/config
}

function stopScope() {
  try { execFileSync("systemctl", ["--user", "stop", `${UNIT}.scope`], { stdio: "ignore" }); } catch { /* not running */ }
  try { execFileSync("systemctl", ["--user", "reset-failed", `${UNIT}.scope`], { stdio: "ignore" }); } catch { /* none */ }
}

function spawnChild({ thinking = THINKING, resumeFile = null, moduleEnv, pins, extraArgs = [] } = {}) {
  stopScope();
  const useModules = moduleEnv ?? !has("--no-module-env");
  const args = ["--user", "--scope", "-q", `--unit=${UNIT}`, "-p", "CPUQuota=200%", "--", BIN,
    "--mode", "rpc", "-ne", "-e", LC_EXT, "-e", EXT, "--tools", TOOLS, "--thinking", thinking,
    "--session-dir", SESS, "--append-system-prompt", SYSTEM_APPEND, ...(useModules ? [MANDATE_FLAG] : []), ...extraArgs];
  if (resumeFile) args.push("--session", resumeFile);
  const env = childEnv({ moduleEnv: useModules, pins });
  log("spawn", { argv: ["systemd-run", ...args], envKeys: Object.keys(env).sort() });
  const c = spawn("systemd-run", args, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
  child = c;
  const out = new LineSplitter();
  c.stdout.on("data", (chunk) => { for (const line of out.push(chunk.toString())) onLine(line); });
  const err = new LineSplitter();
  c.stderr.on("data", (chunk) => { for (const line of err.push(chunk.toString())) { stderrLines.push(line); log("stderr", { line }); } });
  c.on("exit", (code, signal) => {
    log("exit", { code, signal });
    for (const [, p] of pending) p.reject(new Error(`child exited code=${code} signal=${signal}`));
    pending.clear();
    for (const l of listeners) l({ type: "__exit", code, signal });
  });
  return c;
}

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { log("malformed", { line: line.slice(0, 300) }); return; }
  if (msg.type === "response") {
    log("response", { msg: trim(msg) });
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p.resolve(msg); }
    return;
  }
  if (msg.type === "extension_ui_request") {
    log("ui", { method: msg.method, title: msg.title, message: msg.message });
    if (["select", "confirm", "input", "editor"].includes(msg.method)) write({ type: "extension_ui_response", id: msg.id, cancelled: true });
  } else if (msg.type !== "message_update") {
    log("event", { msg: trim(msg) });
  }
  for (const l of listeners) l(msg);
}
const trim = (m) => { const s = JSON.stringify(m); return s.length > 3000 ? { truncated: s.slice(0, 3000) } : m; };
const write = (obj) => child?.stdin.write(JSON.stringify(obj) + "\n");
function send(cmd, ms = 60_000) {
  const id = randomUUID();
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`${cmd.type} timed out`)); }, ms);
    pending.set(id, { resolve: (r) => { clearTimeout(t); res(r); }, reject: (e) => { clearTimeout(t); rej(e); } });
    write({ ...cmd, id });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// spawn -> the first get_state answer (one is queued at spawn, then one every 250 ms)
async function waitReady(spawnedAt) {
  let done = false;
  const tries = [];
  const one = () => { const p = send({ type: "get_state" }, 180_000).then((r) => { if (r.success && !done) { done = true; return r; } return null; }); tries.push(p); return p; };
  const first = one();
  const winner = new Promise((res, rej) => {
    first.then((r) => r && res(r), rej);
    const iv = setInterval(() => { if (done) return clearInterval(iv); one().then((r) => r && (clearInterval(iv), res(r)), () => {}); }, 250);
    setTimeout(() => { clearInterval(iv); if (!done) rej(new Error("child never answered get_state")); }, 180_000);
  });
  const r = await winner;
  return { state: r.data, readyMs: Date.now() - spawnedAt };
}

const HEADER = () => {
  const d = new Date();
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" });
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Amsterdam" }).replace(",", "");
  return `[${hm} ${day}, Europe/Amsterdam · lang en · style brief]`;
};

// one prompt, timed from the write to agent_end
function prompt(text, { ms = 180_000, header = true, until } = {}) {
  return new Promise((res, rej) => {
    const sent = Date.now();
    const r = { text, tThink: null, tText: null, tTool: null, tFinalText: null, tEnd: null, tools: [], thinkingChars: 0,
      usage: { input: 0, output: 0, reasoning: 0, reasoningReported: false, cacheRead: 0, requests: 0 }, final: "", stopReasons: [] };
    let lastToolEnd = null; let open = 0;
    const at = () => Date.now() - sent;
    const stop = (e) => { clearTimeout(t); listeners.delete(l); r.wallMs = at(); e ? rej(e) : res(r); };
    // a run past the deadline is aborted, so the next prompt is not refused as busy
    const t = setTimeout(() => { r.timedOut = true; send({ type: "abort" }, 15_000).catch(() => {}); setTimeout(() => stop(), 5000); }, ms);
    const l = (m) => {
      if (m.type === "__exit") { r.exited = { code: m.code, signal: m.signal }; return stop(); }
      if (m.type === "message_update") {
        const a = m.assistantMessageEvent ?? {};
        if ((a.type === "thinking_start" || a.type === "thinking_delta") && r.tThink == null) r.tThink = at();
        if (a.type === "thinking_delta") r.thinkingChars += String(a.delta ?? "").length;
        if (a.type === "text_delta" && a.delta) {
          if (r.tText == null) r.tText = at();
          if (r.tFinalText == null && open === 0 && (lastToolEnd != null || r.tools.length === 0)) r.tFinalText = at();
        }
      }
      if (m.type === "tool_execution_start") { open++; if (r.tTool == null) r.tTool = at(); r.tools.push(m.toolName); r.tFinalText = null; }
      if (m.type === "tool_execution_end") { open = Math.max(0, open - 1); lastToolEnd = at(); r.toolResults ??= []; r.toolResults.push({ tool: m.toolName, isError: m.isError, text: JSON.stringify(m.result?.content ?? m.result ?? "").slice(0, 400) }); }
      if (m.type === "message_end" && m.message?.role === "assistant") {
        const u = m.message.usage ?? {};
        r.usage.requests++; r.usage.input += u.input ?? 0; r.usage.output += u.output ?? 0; r.usage.cacheRead += u.cacheRead ?? 0;
        if (typeof u.reasoning === "number") { r.usage.reasoning += u.reasoning; r.usage.reasoningReported = true; }
        r.stopReasons.push(m.message.stopReason);
        const txt = (m.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
        if (txt) r.final = txt.slice(0, 600);
      }
      if (until && until(m)) { r.matched = true; return stop(); }
      if (m.type === "agent_end") { r.tEnd = at(); stop(); }
    };
    listeners.add(l);
    send({ type: "prompt", message: header ? `${HEADER()}\n${text}` : text }, ms).then((ack) => {
      r.ackMs = at(); r.ack = { success: ack.success, error: ack.error };
      if (!ack.success) stop();
    }).catch((e) => stop(e));
  });
}

// ---- stats ---------------------------------------------------------------------
const pct = (xs, p) => { const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); if (!v.length) return null; return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))]; };
const stat = (xs) => ({ n: xs.filter((x) => typeof x === "number").length, p50: pct(xs, 50), p90: pct(xs, 90), min: pct(xs, 0), max: pct(xs, 100) });

const PROMPTS = {
  0: "Say something nice about Tuesdays.",
  1: "What's on my calendar Friday?",
  2: "What's on my calendar Friday, and what's in my notes?",
};

function finish(name, summary) {
  summary.toolServerHits = toolHits.length;
  summary.toolServerAuthFailures = toolHits.filter((h) => !h.authOk).length;
  writeFileSync(join(RUNS, `${name}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!KEEP) { try { child?.stdin.end(); } catch { /* gone */ } stopScope(); }
  server.close();
  process.exit(0);
}

// ---- modes -----------------------------------------------------------------------
if (has("--cold")) {
  const runs = [];
  const pins = has("--pins");
  for (let i = 0; i < Number(opt("--cold", "3")); i++) {
    const since = Date.now();
    const s0 = Date.now();
    spawnChild({ pins });
    const { state, readyMs } = await waitReady(s0);
    await sleep(3000);
    const mem = treeMem(child.pid);
    runs.push({ readyMs, idle: { rssMB: mem.rssMB, pssMB: mem.pssMB, procs: mem.procs, cmds: mem.cmds }, model: state.model?.id, thinking: state.thinkingLevel,
      probe: probeLines(since).filter((x) => ["schema", "active_tools", "load"].includes(x.kind)) });
    try { child.stdin.end(); } catch { /* gone */ }
    stopScope();
    await sleep(1500);
  }
  finish(`cold${pins ? "-pins" : ""}`, { mode: "cold", pins, readyMs: stat(runs.map((r) => r.readyMs)), runs, banner: stderrLines.filter((l) => /context ·|lets-code/.test(l)).slice(0, 6), memAvailableMB: memAvailableMB() });
}

if (has("--modules")) {
  const out = {};
  for (const [label, moduleEnv] of [["default", false], ["assistant", true]]) {
    const since = Date.now();
    stderrLines.length = 0;
    const s0 = Date.now();
    spawnChild({ moduleEnv });
    const { state, readyMs } = await waitReady(s0);
    await sleep(3000);
    const mem = treeMem(child.pid);
    const probe = probeLines(since);
    out[label] = { readyMs, rssMB: mem.rssMB, pssMB: mem.pssMB, procs: mem.procs, cmds: mem.cmds, thinking: state.thinkingLevel,
      banner: stderrLines.slice(-8), onSwitches: probe.find((x) => x.kind === "load")?.env, tools: probe.find((x) => x.kind === "active_tools") };
    try { child.stdin.end(); } catch { /* gone */ }
    stopScope();
    await sleep(1500);
  }
  finish("modules", { mode: "modules", moduleEnv: ASSISTANT_MODULE_ENV, mandateFlag: MANDATE_FLAG, ...out });
}

if (has("--checks")) {
  const out = { mode: "checks" };
  const s0 = Date.now();
  const since0 = Date.now();
  spawnChild({ thinking: "medium" });
  const ready = await waitReady(s0);
  out.startup = { readyMs: ready.readyMs, sessionFile: ready.state.sessionFile, sessionId: ready.state.sessionId, model: ready.state.model?.id, thinking: ready.state.thinkingLevel };
  await sleep(1500);
  // (a) the active tools
  out.a = { probe: probeLines(since0).filter((x) => ["load", "schema", "active_tools", "schema_error"].includes(x.kind)) };
  // (b) stale phone data: the earlier fetch is stubbed and the model fetches again
  {
    const since = Date.now();
    const p1 = await prompt("What's on Friday?");
    const mark = Date.now();
    const p2 = await prompt("And Thursday?");
    const pr = probeLines(mark);
    out.b = { turn1: { tools: p1.tools, final: p1.final, tEnd: p1.tEnd }, turn2: { tools: p2.tools, final: p2.final, tEnd: p2.tEnd, toolResults: p2.toolResults },
      turn2Context: pr.filter((x) => x.kind === "context").map((x) => ({ messages: x.messages, stubbed: x.stubbed, roles: x.roles })),
      turn2ProviderRequests: pr.filter((x) => x.kind === "provider_request").map((x) => ({ stubs: x.stubs, lasagna: x.lasagna, tools: x.tools, thinking: x.thinking, maxTokens: x.maxTokens })),
      turn1ProviderRequests: probeLines(since).filter((x) => x.kind === "provider_request" && x.t < mark).map((x) => ({ stubs: x.stubs, lasagna: x.lasagna, tools: x.tools, thinking: x.thinking })),
      calendarHits: toolHits.filter((h) => h.t >= since && h.tool === "fetch_calendar").map((h) => h.args) };
  }
  // (c) the memory store, and whether a hand-appended line is seen without a respawn
  {
    const root = CWD; // no .git above it: the project root is the cwd itself
    const storeDir = join(homedir(), ".pi/agent/core-memory/projects", `${basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`);
    const globalFile = join(homedir(), ".pi/agent/core-memory/global.jsonl");
    const globalBefore = existsSync(globalFile) ? readFileSync(globalFile, "utf8") : null;
    const tea = await prompt("Remember that I like tea.");
    const found = execFileSync("find", [join(homedir(), ".pi"), "-newer", TOKEN_FILE, "-name", "*.jsonl", "-path", "*memory*"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const storeFile = join(storeDir, "memory.jsonl");
    const before = existsSync(storeFile) ? readFileSync(storeFile, "utf8") : "";
    const now = Date.now();
    appendFileSync(storeFile, JSON.stringify({ id: "a0cofe", t: now, u: now, kind: "preference", gist: "The user drinks their coffee black, no sugar", refs: [], by: "user", n: 1 }) + "\n");
    const coffee = await prompt("What do you remember about coffee?");
    const ns = await send({ type: "new_session" });
    const coffee2 = await prompt("What do you remember about coffee?");
    const globalAfter = existsSync(globalFile) ? readFileSync(globalFile, "utf8") : null;
    out.c = { expectedStoreDir: storeDir, storeFile, storeExists: existsSync(storeFile), findNewer: found, storeLinesBeforeAppend: before.split("\n").filter(Boolean),
      tea: { tools: tea.tools, toolResults: tea.toolResults, final: tea.final },
      coffeeSameSession: { tools: coffee.tools, toolResults: coffee.toolResults, final: coffee.final, sawAppendedLine: JSON.stringify(coffee.toolResults ?? []).includes("black") || /black/i.test(coffee.final) },
      newSessionReply: ns, coffeeAfterNewSession: { tools: coffee2.tools, toolResults: coffee2.toolResults, final: coffee2.final, sawAppendedLine: JSON.stringify(coffee2.toolResults ?? []).includes("black") || /black/i.test(coffee2.final) },
      globalStoreChanged: globalBefore !== globalAfter };
  }
  // (d) RPC shapes: thinking, model switch without a prompt, compact, new_session, /even-note
  {
    const d = {};
    const st = async () => { const r = await send({ type: "get_state" }); return { model: `${r.data?.model?.provider}/${r.data?.model?.id}`, thinking: r.data?.thinkingLevel, sessionFile: r.data?.sessionFile, isStreaming: r.data?.isStreaming }; };
    const evs = []; const lt = (m) => { if (m.type !== "message_update") evs.push(m.type + (m.level ? `:${m.level}` : "")); }; listeners.add(lt);
    d.before = await st();
    d.setThinkingLow = await send({ type: "set_thinking_level", level: "low" }); d.afterLow = await st();
    d.setThinkingMedium = await send({ type: "set_thinking_level", level: "medium" });
    d.setModelClaude = trimModel(await send({ type: "set_model", provider: "Anthropic", modelId: "claude-haiku" })); d.afterClaude = await st();
    d.setModelQwen = trimModel(await send({ type: "set_model", provider: "lets-code", modelId: "qwen3.8-27b" })); d.afterQwen = await st();
    // something to compact in this (new) session
    await prompt("What's on my calendar Friday?");
    const c0 = Date.now(); d.compact = await send({ type: "compact", customInstructions: "Keep open questions." }, 180_000); d.compactMs = Date.now() - c0;
    d.afterCompact = await st();
    const fileBefore = d.afterCompact.sessionFile;
    d.newSession = await send({ type: "new_session" }); d.afterNewSession = await st();
    d.newSessionFileChanged = d.afterNewSession.sessionFile !== fileBefore;
    d.newSessionFileExistsBeforePrompt = existsSync(d.afterNewSession.sessionFile ?? "");
    const noteFile = join(NOTES, `${Date.now()}.txt`);
    writeFileSync(noteFile, "(host note) At 07:30 the user said goodbye and Even AI was switched off.", { mode: 0o600 });
    evs.length = 0;
    const n0 = Date.now(); d.noteAck = await send({ type: "prompt", message: `/even-note ${noteFile}` }); d.noteAckMs = Date.now() - n0;
    await sleep(3000);
    d.noteEvents = [...evs];
    const msgs = (await send({ type: "get_messages" })).data?.messages ?? [];
    d.messagesAfterNote = msgs.map((m) => ({ role: m.role, customType: m.customType, text: JSON.stringify(m.content ?? "").slice(0, 160) }));
    d.noteFileDeleted = !existsSync(noteFile);
    d.noteStreaming = (await st()).isStreaming;
    const q = await prompt("What happened at 07:30?");
    d.noteSeenByModel = { final: q.final, mentionsGoodbye: /goodbye|switched off|said bye/i.test(q.final) };
    listeners.delete(lt);
    out.d = d;
  }
  // (e) SIGKILL mid-turn, respawn with --session
  {
    const st0 = await send({ type: "get_state" });
    const file = st0.data?.sessionFile;
    const k = await prompt("What's on my calendar Friday?", { until: (m) => m.type === "tool_execution_start" });
    const killedAt = Date.now();
    try { execFileSync("systemctl", ["--user", "kill", "-s", "SIGKILL", `${UNIT}.scope`]); } catch (e) { log("kill_err", { e: String(e) }); }
    await sleep(2000);
    const s1 = Date.now();
    spawnChild({ thinking: "medium", resumeFile: file });
    const r = await waitReady(s1);
    const msgs = (await send({ type: "get_messages" })).data?.messages ?? [];
    await sleep(2000);
    const mem = treeMem(child.pid);
    out.e = { toolStarted: !!k.matched, killToRespawnMs: s1 - killedAt, respawnReadyMs: r.readyMs, sameSessionFile: r.state.sessionFile === file, thinkingAfterRespawn: r.state.thinkingLevel,
      lastRoles: msgs.slice(-4).map((m) => `${m.role}:${JSON.stringify(m.content ?? "").slice(0, 140)}`), idleAfterRespawn: { rssMB: mem.rssMB, pssMB: mem.pssMB, procs: mem.procs },
      lcSessionsLeftovers: existsSync(join(homedir(), ".pi/agent/lets-code-sessions")) ? readdirSync(join(homedir(), ".pi/agent/lets-code-sessions")).filter((f) => statSync(join(homedir(), ".pi/agent/lets-code-sessions", f)).mtimeMs >= since0) : [] };
  }
  finish("checks", out);
}

// compact over RPC needs more than compaction.keepRecentTokens (pi default 20000) of
// history, else "Nothing to compact (session too small)"; --keep-recent N writes the
// project settings <cwd>/.pi/settings.json {compaction:{keepRecentTokens:N}} first
if (has("--compact")) {
  const out = { mode: "compact" };
  const keep = opt("--keep-recent", null);
  const projSettings = join(CWD, ".pi", "settings.json");
  if (keep != null) { mkdirSync(join(CWD, ".pi"), { recursive: true }); writeFileSync(projSettings, JSON.stringify({ compaction: { keepRecentTokens: Number(keep) } }) + "\n"); }
  out.projectSettings = existsSync(projSettings) ? JSON.parse(readFileSync(projSettings, "utf8")) : null;
  // RPC mode cannot ask the trust question: without --approve (or a saved /trust
  // decision) pi skips the project settings
  out.approve = has("--approve");
  const s0 = Date.now();
  spawnChild({ thinking: "medium", extraArgs: out.approve ? ["--approve"] : [] });
  await waitReady(s0);
  const st = async () => { const r = await send({ type: "get_state" }); return { model: `${r.data?.model?.provider}/${r.data?.model?.id}`, thinking: r.data?.thinkingLevel, sessionFile: r.data?.sessionFile }; };
  // a model switch from a non-default level: does the level survive the round trip?
  await send({ type: "set_thinking_level", level: "low" });
  out.switch = { low: await st() };
  await send({ type: "set_model", provider: "Anthropic", modelId: "claude-haiku" }); out.switch.claude = await st();
  await send({ type: "set_model", provider: "lets-code", modelId: "qwen3.8-27b" }); out.switch.qwenAgain = await st();
  await send({ type: "set_thinking_level", level: "medium" });
  for (const q of ["What's on my calendar Friday?", "Remind me what's in my notes.", "I might go to Anna's on Saturday, not sure yet."]) await prompt(q);
  const before = await st();
  const c0 = Date.now();
  const r = await send({ type: "compact", customInstructions: "Keep open questions, pending tasks and the user's stated plans." }, 180_000);
  out.compactMs = Date.now() - c0;
  out.compact = { success: r.success, error: r.error, dataKeys: Object.keys(r.data ?? {}), summary: r.data?.summary, firstKeptEntryId: r.data?.firstKeptEntryId, tokensBefore: r.data?.tokensBefore, estimatedTokensAfter: r.data?.estimatedTokensAfter, usage: r.data?.usage };
  out.afterCompact = await st(); out.sameFileAfterCompact = out.afterCompact.sessionFile === before.sessionFile;
  out.messagesAfterCompact = ((await send({ type: "get_messages" })).data?.messages ?? []).map((m) => `${m.role}${m.customType ? `:${m.customType}` : ""}`);
  const ns = await send({ type: "new_session" }); out.newSession = ns; out.afterNewSession = await st();
  out.messagesAfterNewSession = ((await send({ type: "get_messages" })).data?.messages ?? []).length;
  finish(`compact${keep != null ? `-keep${keep}` : ""}${out.approve ? "-approve" : ""}`, out);
}

function trimModel(r) { return { type: r.type, command: r.command, success: r.success, error: r.error, dataKeys: Object.keys(r.data ?? {}), data: r.data ? { provider: r.data.provider, id: r.data.id, api: r.data.api, reasoning: r.data.reasoning } : null }; }

// default: one matrix cell
{
  const name = `matrix-${THINKING}-${NTOOLS}`;
  const s0 = Date.now();
  spawnChild({ thinking: THINKING });
  const ready = await waitReady(s0);
  await sleep(3000);
  const idle = treeMem(child.pid);
  const rows = [];
  let peakRss = idle.rssMB;
  for (let i = 0; i < N; i++) {
    const r = await prompt(PROMPTS[NTOOLS]);
    const mem = treeMem(child.pid);
    peakRss = Math.max(peakRss, mem.rssMB);
    rows.push({ i, ...r, rssMB: mem.rssMB, pssMB: mem.pssMB, toolsOk: r.tools.length === NTOOLS });
    log("row", rows.at(-1));
    await sleep(500);
  }
  const ok = rows.filter((r) => r.toolsOk && !r.timedOut);
  const pick = (k, set = ok) => set.map((r) => r[k]);
  const reasoning = ok.map((r) => (r.usage.reasoningReported ? r.usage.reasoning : null));
  finish(name, {
    mode: "matrix", thinking: THINKING, tools: NTOOLS, n: N, prompt: PROMPTS[NTOOLS], startupReadyMs: ready.readyMs, startThinking: ready.state.thinkingLevel,
    idle: { rssMB: idle.rssMB, pssMB: idle.pssMB, procs: idle.procs }, peakRssMB: peakRss,
    toolCountMismatches: rows.filter((r) => !r.toolsOk).map((r) => ({ i: r.i, tools: r.tools, final: r.final.slice(0, 160) })),
    stats: {
      firstThinkingMs: stat(pick("tThink")), firstTextMs: stat(pick("tText")), firstToolMs: stat(pick("tTool")),
      finalTextFirstMs: stat(pick("tFinalText")), endMs: stat(pick("tEnd")),
      outputTokens: stat(ok.map((r) => r.usage.output)), reasoningTokens: stat(reasoning), thinkingChars: stat(pick("thinkingChars")),
      requests: stat(ok.map((r) => r.usage.requests)), inputTokens: stat(ok.map((r) => r.usage.input)), cacheRead: stat(ok.map((r) => r.usage.cacheRead)),
    },
    allEndMs: stat(pick("tEnd", rows)),
    rows: rows.map((r) => ({ i: r.i, think: r.tThink, text: r.tText, tool: r.tTool, finalText: r.tFinalText, end: r.tEnd, tools: r.tools, out: r.usage.output, reasoning: r.usage.reasoning, thinkingChars: r.thinkingChars, req: r.usage.requests, cacheRead: r.usage.cacheRead, input: r.usage.input, final: r.final.slice(0, 120) })),
  });
}
