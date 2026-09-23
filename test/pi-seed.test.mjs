// seedTranscript: pi sessions must be readable via /messages (ring) even when
// they were never loaded live in this bridge instance (e.g. after a restart).
// The seeder parses the on-disk transcript and feeds the official ring with
// the same wire shapes the live provider emits (user_prompt / text_delta /
// tool_start / tool_end).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createPiProvider } from "../src/providers/pi/provider.mjs";
import { Hub } from "../src/hub.mjs";
import { encodeCwdDir } from "../src/providers/pi/session-files.mjs";
import { getMessages } from "@evenrealities/even-terminal/dist/routes/events.js";

function makeTranscript(uuid) {
  const dirName = encodeCwdDir("/tmp/proj");
  // agentDir = <tmp>/pi-seed-<uuid>/agent ; transcripts live under <agentDir>/sessions/
  const agent = join(tmpdir(), `pi-seed-${uuid}`, "agent");
  const file = join(agent, "sessions", dirName);
  mkdirSync(file, { recursive: true });
  const lines = [
    { type: "session", version: 1, id: uuid, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/proj" },
    {
      type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello world" }], timestamp: "2026-01-01T00:00:01.000Z" },
    },
    {
      type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think", thinkingSignature: "sig" },
          { type: "text", text: "hi there" },
          { type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "ls" } },
        ],
        model: "test-model", timestamp: "2026-01-01T00:00:02.000Z",
      },
    },
    {
      type: "message", id: "m3", parentId: "m2", timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "toolResult", toolCallId: "tc_1", toolName: "bash", isError: false,
        content: [{ type: "text", text: "file_a\nfile_b" }], timestamp: "2026-01-01T00:00:03.000Z",
      },
    },
    {
      type: "message", id: "m4", parentId: "m3", timestamp: "2026-01-01T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done, two files found" }],
        model: "test-model", timestamp: "2026-01-01T00:00:04.000Z",
      },
    },
    { type: "compaction", id: "c1", parentId: "m4", timestamp: "2026-01-01T00:01:00.000Z", summary: "ignored" },
  ];
  writeFileSync(
    join(file, `2026-01-01T00-00-00-000Z_${uuid}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  return agent;
}

test("seedTranscript feeds the ring with live wire shapes, in order", async () => {
  const uuid = randomUUID();
  const agentDir = makeTranscript(uuid);
  const hub = new Hub();
  const p = createPiProvider((sid, msg) => hub.feed(sid, msg), {
    hub,
    pi: { enabled: true, bin: "pi", model: "", allCwds: true, agentDir },
    cwd: "/tmp/proj",
    defaultCwd: "/tmp/proj",
  });

  await p.seedTranscript(uuid);

  const msgs = getMessages(uuid, 0);
  assert.deepEqual(
    msgs.map((m) => m.type),
    ["user_prompt", "text_delta", "tool_start", "tool_end", "text_delta"],
  );
  assert.equal(msgs[0].text, "hello world");
  assert.equal(msgs[1].text, "hi there");
  assert.equal(msgs[2].name, "bash");
  assert.equal(msgs[2].toolId, "tc_1");
  assert.equal(msgs[3].toolId, "tc_1");
  assert.equal(msgs[3].detail.input.command, "ls");
  assert.equal(msgs[3].detail.output, "file_a\nfile_b");
  assert.ok(msgs[3].summary.length > 0);
  assert.match(msgs[3].summary, /^[ -~]+$/); // ASCII-only (phone HUD font)
  assert.equal(msgs[4].text, "done, two files found");
});

test("seedTranscript is idempotent (second call adds nothing)", async () => {
  const uuid = randomUUID();
  const agentDir = makeTranscript(uuid);
  const hub = new Hub();
  const p = createPiProvider((sid, msg) => hub.feed(sid, msg), {
    hub,
    pi: { enabled: true, bin: "pi", model: "", allCwds: true, agentDir },
    cwd: "/tmp/proj",
    defaultCwd: "/tmp/proj",
  });

  await p.seedTranscript(uuid);
  const n = getMessages(uuid, 0).length;
  assert.ok(n > 0);
  await p.seedTranscript(uuid);
  assert.equal(getMessages(uuid, 0).length, n);
});

test("seedTranscript is a no-op for unknown sessions", async () => {
  const hub = new Hub();
  const p = createPiProvider((sid, msg) => hub.feed(sid, msg), {
    hub,
    pi: { enabled: true, bin: "pi", model: "", allCwds: true, agentDir: tmpdir() },
    cwd: "/tmp/proj",
    defaultCwd: "/tmp/proj",
  });
  await p.seedTranscript(randomUUID());
  assert.ok(true); // must not throw
});
