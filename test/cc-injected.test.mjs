// Harness-injected / inter-agent text must never reach the glasses as the
// wearer's prompt — local Claude Code transcripts (seed, live watch, /history)
// and Remote Control (the fork's /events frames and /history rows).
// All fixtures are synthetic: same entry shapes Claude Code writes, made-up text.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cleanUserText, isInjectedUserEntry } from "../src/cc-injected.mjs";
import { ccEntriesToWire } from "../src/cc-transcripts.mjs";
import { UpstreamPump } from "../src/upstream-pump.mjs";
import { Hub } from "../src/hub.mjs";
import { createClaudeRemoteProvider } from "../src/providers/claude-remote.mjs";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";

const u = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const human = { origin: { kind: "human" }, promptSource: "typed", userType: "external", entrypoint: "cli" };

const TASK_NOTE =
  "<task-notification>\n<task-id>b1x2</task-id>\n<tool-use-id>toolu_01abc</tool-use-id>\n" +
  "<status>completed</status>\n<summary>Background command \"sleep 1\" completed</summary>\n</task-notification>";
const PEER =
  'Message from fixture-peer: <agent-message from="fixture-peer">[hand-back] synthetic work is done.</agent-message> ' +
  "Reply with SendMessage if needed.";
const REMINDER = "<system-reminder>\nSynthetic reminder body.\n</system-reminder>";

// Each local CC shape that leaked as a user_prompt before the fix.
const LOCAL_SHAPES = {
  "isMeta skill body": u([{ type: "text", text: "Base directory for this skill: /tmp/fixture-skill\n\n# Fixture skill" }], { isMeta: true }),
  "isMeta slash-command expansion": u("# /fixture - Run the fixture\n\nDo the synthetic thing.", { isMeta: true }),
  "isMeta peer hand-back": u(PEER, {
    isMeta: true,
    promptSource: "system",
    origin: { kind: "peer", from: "fixture-peer", handback: true, body: "x", senderTaskId: "t1" },
  }),
  "isMeta + sidechain system-reminder": u(REMINDER, { isMeta: true, isSidechain: true }),
  "sidechain coordinator relay": u("Fixture coordinator says: carry on.", { isMeta: true, isSidechain: true, origin: { kind: "coordinator" } }),
  "sidechain subagent prompt": u("Synthetic subagent task prompt", { isSidechain: true }),
  "task-notification (origin task-notification)": u(TASK_NOTE, { origin: { kind: "task-notification" }, promptSource: "system" }),
  "local-command-caveat": u("<local-command-caveat>Caveat: synthetic caveat text.</local-command-caveat>", { isMeta: true }),
  "local-command-stdout": u("<local-command-stdout>synthetic stdout</local-command-stdout>"),
  "bash-stdout": u("<bash-stdout>synthetic out</bash-stdout><bash-stderr></bash-stderr>"),
  "interrupt notice": u([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
  "system notification": u("[SYSTEM NOTIFICATION - NOT USER INPUT] synthetic notice body"),
  "cross-session message": u('<cross-session-message from="fixture-session">synthetic</cross-session-message>'),
  "hook output": u("<user-prompt-submit-hook>synthetic hook output</user-prompt-submit-hook>"),
  "teamName entry": u("synthetic teammate turn", { teamName: "fixture-team" }),
};

for (const [name, entry] of Object.entries(LOCAL_SHAPES)) {
  test(`local CC: ${name} is not a user_prompt`, () => {
    const wire = ccEntriesToWire([entry]);
    assert.deepEqual(wire.filter((m) => m.type === "user_prompt"), [], JSON.stringify(wire));
  });
}

test("local CC: a normal prompt and a tool round-trip are unchanged", () => {
  const entries = [
    u("  please list the fixture dir\n", human),
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Listing it." },
          { type: "tool_use", id: "toolu_fx1", name: "Bash", input: { command: "ls /tmp/fixture" } },
        ],
      },
    },
    u([{ type: "tool_result", tool_use_id: "toolu_fx1", content: "a.txt" }]),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "One file." }] } },
  ];
  assert.deepEqual(ccEntriesToWire(entries), [
    { type: "user_prompt", text: "  please list the fixture dir\n" },
    { type: "text_delta", text: "Listing it." },
    { type: "tool_start", name: "Bash", toolId: "toolu_fx1" },
    {
      type: "tool_end",
      name: "Bash",
      toolId: "toolu_fx1",
      summary: "Bash ls /tmp/fixture",
      detail: { input: { command: "ls /tmp/fixture" }, output: "a.txt" },
    },
    { type: "text_delta", text: "One file." },
  ]);
});

test("local CC: a tool_result inside an injected entry still closes its tool", () => {
  const state = {};
  ccEntriesToWire([{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fx2", name: "Read", input: { file_path: "/tmp/x" } }] } }], state);
  const wire = ccEntriesToWire([u([{ type: "tool_result", tool_use_id: "toolu_fx2", content: "x" }, { type: "text", text: REMINDER }], { isMeta: true })], state);
  assert.deepEqual(wire.map((m) => m.type), ["tool_end"]);
});

test("local CC: sidechain assistant text is not shown", () => {
  const wire = ccEntriesToWire([{ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent prose" }] } }]);
  assert.deepEqual(wire, []);
});

test("local CC: a typed slash command shows as /name args", () => {
  const wire = ccEntriesToWire([
    u("<command-message>fixture</command-message>\n<command-name>/fixture</command-name>\n<command-args>run it</command-args>", { origin: { kind: "human" } }),
  ]);
  assert.deepEqual(wire, [{ type: "user_prompt", text: "/fixture run it" }]);
});

test("local CC: prompt with an appended system-reminder keeps only the prompt", () => {
  const wire = ccEntriesToWire([u([{ type: "text", text: `fix the fixture\n\n${REMINDER}` }], human)]);
  assert.deepEqual(wire, [{ type: "user_prompt", text: "fix the fixture" }]);
});

test("local CC: prompt with a leading system-reminder keeps the human text", () => {
  const wire = ccEntriesToWire([u(`${REMINDER}\nwhat now?`, human)]);
  assert.deepEqual(wire, [{ type: "user_prompt", text: "what now?" }]);
});

test("cleanUserText leaves prose that merely mentions the tags alone", () => {
  for (const t of [
    "why does <system-reminder> leak to the glasses?",
    "the <task-notification> block and </task-notification> close show up — fix it",
    "Note: <agent-message> envelopes are inter-agent, see </agent-message>",
    "use <b>bold</b> here",
    "<pasted_content>some pasted text</pasted_content> what is this?",
    "[1] first item",
  ]) {
    assert.equal(cleanUserText(t), t, t);
  }
});

test("cleanUserText drops whole injected turns", () => {
  for (const t of [TASK_NOTE, PEER, REMINDER, "  \n" + REMINDER, "[SYSTEM NOTIFICATION - NOT USER INPUT]\nx", "[Request interrupted by user]", "<local-command-stdout></local-command-stdout>", "<some-new-harness-tag>x</some-new-harness-tag>", '<relay from="coordinator" id="1">x</relay>', "<system-reminder>unterminated"]) {
    assert.equal(cleanUserText(t), null, t);
  }
});

test("isInjectedUserEntry follows the transcript flags", () => {
  assert.equal(isInjectedUserEntry(u("x", human)), false);
  assert.equal(isInjectedUserEntry(u("x", { promptSource: "sdk" })), false);
  assert.equal(isInjectedUserEntry(u("x", { isMeta: true })), true);
  assert.equal(isInjectedUserEntry(u("x", { origin: { kind: "peer" } })), true);
  assert.equal(isInjectedUserEntry(u("x", { origin: { kind: "task-notification" } })), true);
  assert.equal(isInjectedUserEntry(u("x", { isSynthetic: true })), true);
});

// ── Remote Control (the fork's frames have no flags: text only) ────────────
function startUpstream({ frames = [], history = [] }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        frames.forEach(({ id, ...body }) => res.write(`id: ${id}\ndata: ${JSON.stringify(body)}\n\n`));
        return;
      }
      if (/^\/api\/sessions\/[^/]+\/history$/.test(url.pathname)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ history }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function waitFor(cond, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("RC live: injected user_prompt frames from the fork are dropped, real ones kept", async () => {
  const { server, url } = await startUpstream({
    frames: [
      { id: 1, type: "user_prompt", text: "real wearer prompt" },
      { id: 2, type: "user_prompt", text: "[Request interrupted by user]" },
      { id: 3, type: "user_prompt", text: "[SYSTEM NOTIFICATION - NOT USER INPUT] synthetic" },
      { id: 4, type: "user_prompt", text: PEER },
      { id: 5, type: "user_prompt", text: `typed in the CLI\n\n${REMINDER}` },
      { id: 6, type: "text_delta", text: "answer" },
      { id: 7, type: "tool_start", name: "Bash", toolId: "t1" },
      { id: 8, type: "tool_end", name: "Bash", toolId: "t1", summary: "Bash ls", detail: { input: {}, output: "x" } },
      { id: 9, type: "status", state: "idle" },
    ],
  });
  const hub = new Hub();
  const sid = "rc-injected-live";
  const pump = new UpstreamPump(sid, { baseUrl: url, hub, getState: async () => "idle" }).start();
  try {
    await waitFor(() => getMessages(sid, 0).some((m) => m.type === "status"));
    const msgs = getMessages(sid, 0);
    assert.deepEqual(
      msgs.filter((m) => m.type === "user_prompt").map((m) => m.text),
      ["real wearer prompt", "typed in the CLI"]
    );
    assert.deepEqual(msgs.map((m) => m.type), ["user_prompt", "user_prompt", "text_delta", "tool_start", "tool_end", "status"]);
    assert.equal(pump.lastUpstreamId, 9, "dropped frames still advance the water mark");
  } finally {
    await pump.stop();
    server.close();
  }
});

test("RC /history: injected user rows from the fork are dropped, real ones kept", async () => {
  const { server, url } = await startUpstream({
    history: [
      { role: "user", text: "real wearer prompt" },
      { role: "assistant", text: "answer one" },
      { role: "user", text: "Base directory for this skill: /tmp/fixture-skill" },
      { role: "user", text: PEER },
      { role: "user", text: "[Request interrupted by user for tool use]" },
      { role: "assistant", text: "answer two" },
    ],
  });
  const p = createClaudeRemoteProvider(() => {}, { hub: new Hub(), baseUrl: url, token: "" });
  try {
    const h = await p.getHistory("cse_fixture", 10);
    assert.deepEqual(h, [
      { role: "user", text: "real wearer prompt" },
      { role: "assistant", text: "answer one" },
      { role: "assistant", text: "answer two" },
    ]);
  } finally {
    server.close();
  }
});
