#!/usr/bin/env node
// Phase-0 spike (overseer plan, Task 1): drive one lets-code RPC child inside a
// memory-capped user scope and print JSON measurements. Runtime code is untouched.
//
//   node scripts/lc-spike.mjs [--cwd ~/sandbox/agents/lc-spike] [--memory-max 1500M]
//                             [--steps a,b,c,d,e,f,g,h] [--bin pi-inference] [--keep]
//                             [--no-own-scope] [--turn-timeout <s>]
//
// Steps (plan Task 1 Step 4):
//   a get_state (session id + file: --session-dir layout)
//   b "Say hi." (idle memory after)
//   c one scout subagent run (peak memory with one subagent)
//   d "Run: echo SPIKE_BLOCK" (the -e probe extension blocks it)
//   e "Create notes.txt containing hi" (inside: no question), then a write
//     outside the project twice: deny the mandate ask, then allow it
//   f /mode orchestration, get_state (notify text)
//   g /experts enable x5, /factory start ticket.md <how-to-run, unquoted:
//     the handler joins the words; quotes stay in>, cancel the first checkpoint,
//     /factory resume <id>, cancel again
//   h SIGKILL the scope mid-turn, re-spawn with --session <file>, get_messages
//
// Writes /tmp/ovs-spike/log.jsonl (every event, ui request, stderr line, memory
// sample) and prints one JSON summary on stdout. Never binds a port, never
// touches the live bridge, its store or its children. --keep leaves the scope
// and /tmp/ovs-spike in place.

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LineSplitter } from "../src/providers/pi/framing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;
const ROOT = "/tmp/ovs-spike";
const LOG = join(ROOT, "log.jsonl");
const SESS = join(ROOT, "sessions");
const EXT = join(ROOT, "probe-ext.ts");
const UNIT = "even-lc-spike";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());
const CWD = resolve(expand(opt("--cwd", "~/sandbox/agents/lc-spike")));
const MEM_MAX = opt("--memory-max", "1500M");
const STEPS = new Set(opt("--steps", "a,b,c,d,e,f,g,h").split(","));
const BIN = opt("--bin", join(homedir(), ".local/bin/pi-inference"));
const KEEP = argv.includes("--keep");
const NO_OWN_SCOPE = argv.includes("--no-own-scope");
const TURN_MS = Number(opt("--turn-timeout", "900")) * 1000;

if (!CWD.startsWith(join(homedir(), "sandbox/agents") + "/")) {
  console.error(`--cwd must be below ~/sandbox/agents (got ${CWD})`);
  process.exit(2);
}

mkdirSync(SESS, { recursive: true });
mkdirSync(CWD, { recursive: true });
writeFileSync(EXT, `// spike probe: blocks any bash command containing SPIKE_BLOCK
export default function (pi: any) {
  pi.on("tool_call", async (event: any) => {
    const cmd = String(event?.input?.command ?? "");
    if (event?.toolName === "bash" && cmd.includes("SPIKE_BLOCK")) {
      return { block: true, reason: "even-guard spike" };
    }
  });
}
`);

const t0 = Date.now();
const log = (kind, data) => appendFileSync(LOG, JSON.stringify({ t: Date.now() - t0, kind, ...data }) + "\n");
const summary = { unit: UNIT, memoryMax: MEM_MAX, cwd: CWD, bin: BIN, steps: {}, ui: [], stderrNotes: [] };
let step = "init";

// ---- memory sampling (cgroup v2 files of the scope) ------------------------
function cgroupDir() {
  try {
    const cg = execFileSync("systemctl", ["--user", "show", `${UNIT}.scope`, "-p", "ControlGroup", "--value"], { encoding: "utf8" }).trim();
    return cg ? join("/sys/fs/cgroup", cg) : null;
  } catch { return null; }
}
const MB = (b) => (b == null ? null : Math.round(b / 1048576));
// Process-tree sampling: borealis boots with cgroup_disable=memory, so a
// scope has no memory.* files and MemoryMax is not enforced; the tree of the
// child (systemd-run --scope execs in place, so child.pid ends up being pi)
// is summed instead: RSS, PSS (smaps_rollup) and VmSwap per process.
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
function procMem(pid) {
  const r = { pid, rss: 0, pss: 0, swap: 0, cmd: "", cgroup: "" };
  try {
    for (const l of readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").split("\n")) {
      const m = /^(Rss|Pss|Swap):\s+(\d+) kB/.exec(l);
      if (m) r[m[1].toLowerCase()] = Number(m[2]) * 1024;
    }
    r.cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, 4).join(" ").slice(0, 120);
    r.cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().replace(/^0::.*\//, "");
  } catch { /* gone */ }
  return r;
}
function sysMem() {
  const m = {};
  for (const l of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const x = /^(MemAvailable|SwapFree|SwapTotal):\s+(\d+)/.exec(l);
    if (x) m[x[1]] = Math.round(Number(x[2]) / 1024);
  }
  return m;
}
const peaks = {};
let sampler = null;
const cgroupsSeen = new Set();
function startSampler() {
  sampler = setInterval(() => {
    if (!child?.pid) return;
    const procs = procTree(child.pid).map(procMem).filter((p) => p.cmd);
    if (!procs.length) return;
    const sum = (k) => MB(procs.reduce((a, p) => a + p[k], 0));
    for (const p of procs) cgroupsSeen.add(p.cgroup);
    const dir = cgroupDir();
    const s = { step, rssMB: sum("rss"), pssMB: sum("pss"), swapMB: sum("swap"), procs: procs.length,
      scopeHasMemoryFiles: !!dir && existsSync(join(dir, "memory.current")), sys: sysMem(),
      tree: procs.map((p) => `${p.pid} ${MB(p.rss)}M ${p.cgroup} ${p.cmd}`) };
    log("mem", s);
    const p = (peaks[step] ??= { maxRssMB: 0, maxPssMB: 0, maxSwapMB: 0, maxProcs: 0, minMemAvailableMB: Infinity });
    p.maxRssMB = Math.max(p.maxRssMB, s.rssMB); p.maxPssMB = Math.max(p.maxPssMB, s.pssMB);
    p.maxSwapMB = Math.max(p.maxSwapMB, s.swapMB); p.maxProcs = Math.max(p.maxProcs, s.procs);
    p.minMemAvailableMB = Math.min(p.minMemAvailableMB, s.sys.MemAvailable ?? Infinity);
    p.lastRssMB = s.rssMB; p.lastPssMB = s.pssMB;
  }, 1000);
}

// ---- the child --------------------------------------------------------------
let child = null;
const pending = new Map();
const listeners = new Set();
let dialogHandler = null;

function spawnChild(resumeFile) {
  const args = [
    "--user", "--scope", "-q", `--unit=${UNIT}`,
    "-p", `MemoryMax=${MEM_MAX}`, "-p", "CPUQuota=200%",
    "--", BIN, "--mandate", "ask", "--subagents", "--sandbox",
    "--mode", "rpc", "--session-dir", SESS, "-e", EXT,
  ];
  if (resumeFile) args.push("--session", resumeFile);
  const env = { ...process.env, LETS_CODE_EXPERTS_ON: "1", LETS_CODE_SUBAGENT_CONCURRENCY: "1", PI_TELEMETRY: "0" };
  // --no-own-scope: lets-code's RAM watcher (default on) re-execs pi into its own
  // user scope lets-code-<pid> unless an ancestor cgroup has a finite memory.max,
  // which never holds while the kernel has the memory controller disabled
  if (NO_OWN_SCOPE) { env.LETS_CODE_MEM_WATCH = "false"; env.LETS_CODE_MEM_GUARD = "false"; }
  delete env.BRIDGE_TOKEN; delete env.LETS_CODE_TOKEN;
  log("spawn", { argv: ["systemd-run", ...args] });
  summary.launch ??= ["systemd-run", ...args].join(" ");
  const c = spawn("systemd-run", args, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
  child = c;
  const out = new LineSplitter();
  c.stdout.on("data", (chunk) => { for (const line of out.push(chunk.toString())) onLine(line); });
  const err = new LineSplitter();
  c.stderr.on("data", (chunk) => {
    for (const line of err.push(chunk.toString())) {
      log("stderr", { line });
      if (/memory-limited|scope|sandbox|bwrap|socat|expert|subagent|mandate|note:|warn|error/i.test(line)) summary.stderrNotes.push(line.slice(0, 300));
    }
  });
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
  try { msg = JSON.parse(line); } catch { log("malformed", { line: line.slice(0, 500) }); return; }
  if (msg.type === "response") {
    log("response", { msg: trim(msg) });
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p.resolve(msg); }
    return;
  }
  if (msg.type === "extension_ui_request") {
    const rec = { step, method: msg.method, title: msg.title, options: msg.options, message: msg.message, notifyType: msg.notifyType, statusKey: msg.statusKey, statusText: msg.statusText };
    log("ui", rec);
    if (["select", "confirm", "input", "editor"].includes(msg.method)) {
      summary.ui.push({ step, method: msg.method, title: String(msg.title ?? "").slice(0, 400), options: msg.options });
      const res = dialogHandler ? dialogHandler(msg) : { cancelled: true };
      log("ui_answer", { id: msg.id, res });
      write({ type: "extension_ui_response", id: msg.id, ...res });
    } else if (msg.method === "notify") {
      (summary.steps[step] ??= {}).notify = [...(summary.steps[step]?.notify ?? []), String(msg.message ?? "").slice(0, 600)];
    }
    for (const l of listeners) l(msg);
    return;
  }
  log("event", { msg: trim(msg) });
  for (const l of listeners) l(msg);
}

function trim(m) {
  const s = JSON.stringify(m);
  return s.length > 4000 ? { truncated: s.slice(0, 4000) } : m;
}
const write = (obj) => child?.stdin.write(JSON.stringify(obj) + "\n");

function send(cmd, ms = 60_000) {
  const id = randomUUID();
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`${cmd.type} timed out`)); }, ms);
    pending.set(id, { resolve: (r) => { clearTimeout(t); res(r); }, reject: (e) => { clearTimeout(t); rej(e); } });
    write({ ...cmd, id });
  });
}

// prompt and wait for agent_end; collect tool results and the last assistant text
function prompt(message, { ms = TURN_MS, until } = {}) {
  return new Promise((res, rej) => {
    const got = { toolResults: [], text: "", ended: false };
    const stop = (v, e) => { clearTimeout(t); listeners.delete(l); e ? rej(e) : res(v); };
    const t = setTimeout(() => stop(got, null), ms);
    const l = (m) => {
      if (m.type === "__exit") return stop({ ...got, exited: m }, null);
      if (m.type === "tool_execution_end") got.toolResults.push({ tool: m.toolName, isError: m.isError, result: JSON.stringify(m.result ?? "").slice(0, 600) });
      if (m.type === "message_end" && m.message?.role === "assistant") {
        got.text = (m.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 1200);
      }
      if (until && until(m)) return stop({ ...got, matched: true }, null);
      if (m.type === "agent_end") { got.ended = true; stop(got, null); }
    };
    listeners.add(l);
    // an extension command (/factory start) answers only when its handler returns
    send({ type: "prompt", message }, ms).then((r) => {
      log("prompt_ack", { message, success: r.success, error: r.error });
      got.ack = { success: r.success, error: r.error };
      // an extension command that starts no run answers and ends at once
      if (r.success && message.startsWith("/")) setTimeout(() => { if (!got.ended && !until) stop(got, null); }, 4000);
    }).catch((e) => stop(got, e));
  });
}

const snap = () => ({ ...(peaks[step] ?? {}) });
async function run(name, fn) {
  if (!STEPS.has(name)) return;
  step = name;
  const s0 = Date.now();
  try {
    const r = await fn();
    summary.steps[name] = { ...(summary.steps[name] ?? {}), ...r, ms: Date.now() - s0, mem: snap() };
  } catch (e) {
    summary.steps[name] = { ...(summary.steps[name] ?? {}), error: String(e?.message ?? e), ms: Date.now() - s0, mem: snap() };
  }
  log("step", { name, result: summary.steps[name] });
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { const r = await send({ type: "get_state" }, 5000); if (r.success) return r; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("child never answered get_state");
}

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) listFiles(p, out); else out.push(p);
  }
  return out;
}

// ---- the scenario -----------------------------------------------------------
const piSessions = join(homedir(), ".pi/agent/sessions");
const marker = Date.now();
startSampler();
const ts = Date.now();
spawnChild(null);
step = "startup";
const st0 = await waitReady();
summary.startupMs = Date.now() - ts;
let sessionFile = st0.data?.sessionFile;
summary.firstState = { sessionId: st0.data?.sessionId, sessionFile, model: st0.data?.model?.id, thinking: st0.data?.thinkingLevel };

await run("a", async () => {
  const r = await send({ type: "get_state" });
  sessionFile = r.data?.sessionFile ?? sessionFile;
  return { sessionId: r.data?.sessionId, sessionFile, filesInSessionDir: listFiles(SESS) };
});
await run("b", async () => {
  const r = await prompt("Say hi.");
  await new Promise((r2) => setTimeout(r2, 5000)); // settle, then the idle sample
  return { text: r.text, ended: r.ended, filesInSessionDir: listFiles(SESS) };
});
await run("c", async () => {
  dialogHandler = (m) => (m.method === "confirm" ? { confirmed: true } : m.method === "select" ? { value: (m.options ?? []).find((o) => /allow once/i.test(o)) ?? m.options?.[0] } : { cancelled: true });
  const r = await prompt("Use the subagent tool with the scout agent to list the files here, then answer in one line.");
  dialogHandler = null;
  return { text: r.text, ended: r.ended, tools: r.toolResults.map((x) => `${x.tool}${x.isError ? "!" : ""}`) };
});
await run("d", async () => {
  dialogHandler = (m) => (m.method === "select" ? { value: (m.options ?? []).find((o) => /allow once/i.test(o)) ?? m.options?.[0] } : m.method === "confirm" ? { confirmed: true } : { cancelled: true });
  const r = await prompt("Run: echo SPIKE_BLOCK");
  dialogHandler = null;
  return { text: r.text, toolResults: r.toolResults, blockedByExtension: r.toolResults.some((x) => /even-guard spike/.test(x.result)) };
});
await run("e", async () => {
  const seen = [];
  dialogHandler = (m) => {
    seen.push({ method: m.method, title: m.title, options: m.options });
    if (m.method === "confirm") return { confirmed: false };
    if (m.method === "select") return { value: (m.options ?? []).find((o) => /^deny/i.test(o)) ?? m.options?.at(-1) };
    return { cancelled: true };
  };
  // mode ask lets writes inside the project through without a question
  // ("confirms sudo, recursive deletes, installs and writes outside the
  // project"): the inside write is the control, the outside one must ask
  const inside = await prompt("Create notes.txt containing hi");
  const insideAsked = seen.length;
  const OUT = join(ROOT, "outside.txt");
  const deny = await prompt(`Create the file ${OUT} containing hi`);
  const afterDeny = existsSync(OUT);
  dialogHandler = (m) => {
    seen.push({ method: m.method, title: m.title, options: m.options, second: true });
    if (m.method === "confirm") return { confirmed: true };
    if (m.method === "select") return { value: (m.options ?? []).find((o) => /^allow once/i.test(o)) ?? m.options?.[0] };
    return { cancelled: true };
  };
  const allow = await prompt(`Create the file ${OUT} containing hi`);
  dialogHandler = null;
  return { insideWritten: existsSync(join(CWD, "notes.txt")), insideAsked, insideText: inside.text, dialogs: seen, afterDeny, afterAllow: existsSync(OUT), denyText: deny.text, allowText: allow.text, allowTools: allow.toolResults };
});
await run("f", async () => {
  const r = await prompt("/mode orchestration");
  const s = await send({ type: "get_state" });
  return { ack: r.ack, stateKeys: Object.keys(s.data ?? {}), state: { model: s.data?.model?.id, isStreaming: s.data?.isStreaming } };
});
await run("g", async () => {
  writeFileSync(join(CWD, "ticket.md"), "Add a file hello.txt containing hi. Test: test -f hello.txt\n");
  const enable = [];
  dialogHandler = (m) => ({ cancelled: true, _m: m.title });
  for (const n of ["developer", "expert-reviewer", "design-reviewer", "tester", "acceptance-judge"]) {
    const r = await prompt(`/experts enable ${n}`, { ms: 120_000 });
    enable.push({ n, ack: r.ack });
  }
  let checkpoint = null;
  dialogHandler = (m) => {
    if (m.method === "select" && /^Factory \S+:/.test(String(m.title ?? ""))) checkpoint ??= { title: String(m.title).slice(0, 400), options: m.options };
    return { cancelled: true };
  };
  const start = await prompt("/factory start ticket.md test -f hello.txt", { until: (m) => m.type === "extension_ui_request" && m.method === "select" && /^Factory \S+:/.test(String(m.title ?? "")) });
  // let the cancel settle (the run stops at its checkpoint)
  await new Promise((r) => setTimeout(r, 8000));
  const fdir = join(homedir(), ".pi/agent/lets-code-factory");
  const runs = existsSync(fdir) ? readdirSync(fdir) : [];
  const id = checkpoint ? /^Factory (\S+):/.exec(checkpoint.title)?.[1] : runs[0];
  let ledger = null;
  try {
    const L = JSON.parse(readFileSync(join(fdir, id, "ledger.json"), "utf8"));
    ledger = { id: L.id, status: L.status, repo: L.repo, waiting: L.waiting, stage: L.stage, keys: Object.keys(L) };
  } catch (e) { ledger = { error: String(e.message) }; }
  let again = null;
  dialogHandler = (m) => {
    if (m.method === "select" && /^Factory \S+:/.test(String(m.title ?? ""))) again ??= { title: String(m.title).slice(0, 400), options: m.options };
    return { cancelled: true };
  };
  const resume = id ? await prompt(`/factory resume ${id}`, { ms: 300_000, until: (m) => m.type === "extension_ui_request" && m.method === "select" && /^Factory \S+:/.test(String(m.title ?? "")) }) : null;
  await new Promise((r) => setTimeout(r, 8000));
  let ledger2 = null;
  try { const L = JSON.parse(readFileSync(join(fdir, id, "ledger.json"), "utf8")); ledger2 = { status: L.status, waiting: L.waiting }; } catch { /* none */ }
  dialogHandler = null;
  return { enable, startMatched: !!start.matched, checkpoint, factoryRuns: runs, ledger, resumeMatched: !!resume?.matched, again, ledgerAfterResume: ledger2, sameCheckpoint: !!(checkpoint && again && checkpoint.title === again.title) };
});
await run("h", async () => {
  // drop out of orchestration first so a plain bash command may run
  dialogHandler = (m) => (m.method === "select" ? { value: (m.options ?? []).find((o) => /allow once/i.test(o)) ?? m.options?.[0] } : m.method === "confirm" ? { confirmed: true } : { cancelled: true });
  await prompt("/mode ask");
  const before = await send({ type: "get_messages" });
  const nBefore = before.data?.messages?.length ?? null;
  const p = prompt("Run: sleep 20 && echo done", { until: (m) => m.type === "tool_execution_start" });
  const started = await p;
  await new Promise((r) => setTimeout(r, 3000));
  const killedAt = Date.now();
  try { execFileSync("systemctl", ["--user", "kill", "-s", "SIGKILL", `${UNIT}.scope`]); } catch (e) { log("kill_err", { e: String(e) }); }
  await new Promise((r) => setTimeout(r, 3000));
  let scopeGone = false;
  try { execFileSync("systemctl", ["--user", "is-active", `${UNIT}.scope`]); } catch { scopeGone = true; }
  const fileOk = sessionFile && existsSync(sessionFile);
  const ts2 = Date.now();
  spawnChild(sessionFile);
  const st = await waitReady();
  const respawnMs = Date.now() - ts2;
  const after = await send({ type: "get_messages" });
  const msgs = after.data?.messages ?? [];
  dialogHandler = null;
  return {
    toolStarted: !!started.matched, nBefore, nAfter: msgs.length, scopeGoneAfterKill: scopeGone, sessionFileKept: fileOk,
    sameSessionId: st.data?.sessionId === summary.firstState.sessionId, respawnMs, killDelayMs: ts2 - killedAt,
    lastRoles: msgs.slice(-4).map((m) => `${m.role}:${JSON.stringify(m.content ?? "").slice(0, 120)}`),
  };
});

step = "end";
summary.peaks = peaks;
summary.cgroupsSeen = [...cgroupsSeen];
summary.newPiSessionFiles = listFiles(piSessions).filter((f) => statSync(f).mtimeMs >= marker);
summary.sessionDirFiles = listFiles(SESS);
clearInterval(sampler);
if (!KEEP) {
  try { child?.stdin.end(); } catch { /* gone */ }
  try { execFileSync("systemctl", ["--user", "stop", `${UNIT}.scope`]); } catch { /* gone */ }
}
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
