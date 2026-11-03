#!/usr/bin/env node
// A stand-in for `lets-code --mode rpc` (pi RPC over JSONL on stdio) for the
// durable lets-code engine tests. No model, no network.
//
// Log ($FAKE_PI_LOG, JSONL): one `{spawn: true, argv, pid, env: {...}}` line at
// start (only the env names the tests look at), then every command received,
// as sent, plus `_pid`.
//
// Session file: `get_state` reports `{sessionId, sessionFile}` at once, but the
// file `<--session-dir>/<ISO>_<uuid>.jsonl` is written only at the first
// prompt; `--session <file>` reuses that file (and its id).
//
// Prompts (plain text):
//   HANG     streams nothing until `abort`
//   ASK      a mandate dialog (select "mandate (ask): ...\n\nAllow?")
//   FACTORY  a factory checkpoint dialog (select "Factory <id>: acceptance criteria")
//   EDITOR   an `editor` dialog
//   TOOL     a bash tool call (tool_execution_start/end), then "ok: TOOL"
//   other    "ok: <text>"
// Each run: response, agent_start, ..., agent_end. A dialog's answer ends the run.
// Slash commands answer the prompt only once handled (pi does the same for
// extension commands): `/mode orchestration|ask` → notify `mode: <m>` (unless
// FAKE_PI_NO_NOTIFY=1); `/factory start|resume …` → the FACTORY dialog, and the
// prompt response (disposition "handled") once it is answered; other `/…` → handled.
// FAKE_PI_CRASH=1: exit 137 on every prompt (a crash mid-turn).
// FAKE_PI_DIE_ONCE=<marker file>: the first prompt (across processes) exits 137
// before anything is written or answered (lets-code never accepted it);
// FAKE_PI_DIE_TEXT=<text> limits that to a prompt with exactly this text.
// FAKE_PI_CRASH_ONCE=<marker file>: the first prompt is accepted (response,
// agent_start, user message written), then the process exits 137.
//   CONFIRM  a plain `confirm` dialog ("Proceed?")
//   EXPERTS  lets-code's factory "Enable the factory's experts?" confirm
//   TOOLS25  25 bash tool calls, then "ok: TOOLS25"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LOG = process.env.FAKE_PI_LOG;
const log = (obj) => {
  if (LOG) appendFileSync(LOG, JSON.stringify(obj) + "\n");
};
const pick = (names) => Object.fromEntries(names.map((k) => [k, process.env[k]]));
log({
  spawn: true,
  argv,
  pid: process.pid,
  env: pick(["LETS_CODE_EXPERTS_ON", "LETS_CODE_MEM_WATCH", "LETS_CODE_MEM_GUARD", "BRIDGE_TOKEN", "LETS_CODE_TOKEN", "EVEN_GUARD_CWD", "LETS_CODE_SUBAGENT_CONCURRENCY", "PI_TELEMETRY", "HOME"]),
});

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// ── session file ──
let sessionFile = opt("--session");
let sessionId;
if (sessionFile && existsSync(sessionFile)) {
  const head = readFileSync(sessionFile, "utf8").split("\n")[0];
  try {
    sessionId = JSON.parse(head).id;
  } catch {
    /* below */
  }
}
if (!sessionId) sessionId = sessionFile ? sessionFile.slice(sessionFile.lastIndexOf("_") + 1, -6) : randomUUID();
if (!sessionFile) {
  const dir = opt("--session-dir") ?? join(process.cwd(), ".fake-sessions");
  sessionFile = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
}
const append = (obj) => {
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) {
    writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
  }
  if (obj) appendFileSync(sessionFile, JSON.stringify(obj) + "\n");
};
const message = (role, content) => append({ type: "message", timestamp: new Date().toISOString(), message: { role, content } });

// ── runs ──
let run = null; // { text, dialog?: {id, onAnswer} }
let uiSeq = 0;
const dialogs = new Map(); // ui request id → (response) => void

function startRun(text) {
  run = { text };
  out({ type: "agent_start" });
}
function say(text) {
  out({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
  message("assistant", [{ type: "text", text }]);
  out({ type: "turn_end", message: { usage: { input: 10, output: 3, totalTokens: 13, cost: { total: 0 } } } });
}
function endRun() {
  if (!run) return;
  run = null;
  out({ type: "agent_end" });
}
function ask(req, onAnswer) {
  const id = `ui-${++uiSeq}`;
  dialogs.set(id, onAnswer);
  out({ type: "extension_ui_request", id, ...req });
  return id;
}
const notify = (text) => out({ type: "extension_ui_request", id: `ui-${++uiSeq}`, method: "notify", message: text, notifyType: "info" });

const FACTORY_REQ = {
  method: "select",
  title: "Factory 20261103-093221-c129: acceptance criteria\n\n(none found in the ticket)",
  options: ["Confirm", "Edit", "Stop"],
};

function onPrompt(cmd) {
  const text = String(cmd.message ?? "");
  const marker = process.env.FAKE_PI_DIE_ONCE;
  const dieText = process.env.FAKE_PI_DIE_TEXT;
  if (marker && !existsSync(marker) && (!dieText || dieText === text)) {
    writeFileSync(marker, String(process.pid));
    process.exit(137);
  }
  if (process.env.FAKE_PI_CRASH === "1") {
    append();
    message("user", [{ type: "text", text }]);
    process.exit(137);
  }
  if (text.startsWith("/")) {
    const [verb, arg] = text.split(/\s+/);
    if (verb === "/mode") {
      if (process.env.FAKE_PI_NO_NOTIFY !== "1") notify(`mode: ${arg}`);
      out({ type: "response", id: cmd.id, command: "prompt", success: true, data: { disposition: "handled" } });
      return;
    }
    if (verb === "/factory") {
      ask(FACTORY_REQ, () => out({ type: "response", id: cmd.id, command: "prompt", success: true, data: { disposition: "handled" } }));
      return;
    }
    out({ type: "response", id: cmd.id, command: "prompt", success: true, data: { disposition: "handled" } });
    return;
  }
  if (run && cmd.streamingBehavior) {
    out({ type: "response", id: cmd.id, command: "prompt", success: true, data: { disposition: cmd.streamingBehavior } });
    return;
  }
  out({ type: "response", id: cmd.id, command: "prompt", success: true, data: { disposition: "started" } });
  message("user", [{ type: "text", text }]);
  startRun(text);
  const crashOnce = process.env.FAKE_PI_CRASH_ONCE;
  if (crashOnce && !existsSync(crashOnce)) {
    writeFileSync(crashOnce, String(process.pid));
    setTimeout(() => process.exit(137), 50);
    return;
  }
  if (text === "CONFIRM" || text === "EXPERTS") {
    const req = text === "CONFIRM"
      ? { method: "confirm", title: "Proceed?", message: "a plain confirm" }
      : { method: "confirm", title: "Enable the factory's experts?", message: "developer, tester\nlets-code remembers the answer yes." };
    ask(req, (r) => {
      say(r.cancelled ? "cancelled" : `confirmed: ${r.confirmed}`);
      endRun();
    });
    return;
  }
  if (text === "TOOLS25") {
    for (let i = 1; i <= 25; i++) {
      const args = { command: `echo ${i}` };
      out({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "bash", args });
      out({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "bash", result: { content: [{ type: "text", text: String(i) }] } });
    }
  }
  if (text === "HANG") return;
  if (text === "ASK") {
    ask({ method: "select", title: "mandate (ask): write outside the project: /x/out.txt\n\nAllow?", options: ["Allow once", "Allow for this session", "Deny"] }, (r) => {
      say(r.cancelled ? "cancelled" : `answer: ${r.value}`);
      endRun();
    });
    return;
  }
  if (text === "FACTORY") {
    ask(FACTORY_REQ, (r) => {
      say(r.cancelled ? "factory stopped" : `checkpoint: ${r.value}`);
      endRun();
    });
    return;
  }
  if (text === "EDITOR") {
    ask({ method: "editor", title: "Acceptance criteria" }, (r) => {
      say(r.cancelled ? "editor cancelled" : `edited: ${r.value}`);
      endRun();
    });
    return;
  }
  if (text === "TOOL") {
    const args = { command: "echo hi" };
    out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args });
    message("assistant", [{ type: "toolCall", id: "t1", name: "bash", arguments: args }]);
    out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] } });
    message("toolResult", [{ type: "text", text: "hi" }]);
  }
  say(`ok: ${text}`);
  endRun();
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    log({ ...cmd, _pid: process.pid });
    switch (cmd.type) {
      case "get_state":
        out({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionId, sessionFile, isStreaming: Boolean(run) } });
        break;
      case "prompt":
        onPrompt(cmd);
        break;
      case "abort":
        out({ type: "response", id: cmd.id, command: "abort", success: true });
        if (run) {
          for (const [id] of dialogs) dialogs.delete(id);
          endRun();
        }
        break;
      case "extension_ui_response": {
        const cb = dialogs.get(cmd.id);
        dialogs.delete(cmd.id);
        cb?.(cmd);
        break;
      }
      default:
        out({ type: "response", id: cmd.id, command: cmd.type, success: true });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
