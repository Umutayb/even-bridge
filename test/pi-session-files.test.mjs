import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeCwdDir,
  listSessionFiles,
  findSessionFile,
  readHistory,
  readSessionCwd,
} from "../src/providers/pi/session-files.mjs";

let root;
let agentDir;
let cwdA;
let cwdB;

test.before(() => {
  root = mkdtempSync(join(tmpdir(), "even-bridge-pi-test-"));
  agentDir = join(root, "agent");
  cwdA = join(root, "proj", "a");
  cwdB = join(root, "proj", "b");
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });
});

test.after(() => rmSync(root, { recursive: true, force: true }));

function writeSession(cwd, id, ts, { name, messages } = {}) {
  const dir = join(agentDir, "sessions", encodeCwdDir(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ts}_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd }),
  ];
  if (name) lines.push(JSON.stringify({ type: "session_info", name }));
  for (const m of messages ?? []) lines.push(JSON.stringify({ type: "message", timestamp: ts, message: m }));
  writeFileSync(file, lines.join("\n") + "\n");
  // Distinct mtimes so newest-first ordering is deterministic.
  const mtime = new Date(ts);
  utimesSync(file, mtime, mtime);
  return file;
}

const ID_A = "11111111-aaaa-bbbb-cccc-00000000000a";
const ID_B = "22222222-aaaa-bbbb-cccc-00000000000b";
const ID_C = "33333333-aaaa-bbbb-cccc-00000000000c";

test.before(() => {
  writeSession(cwdA, ID_A, "2025-01-01T00:00:00.000Z", {
    name: "feature-x",
    messages: [
      { role: "user", content: "build the widget" },
      { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "toolCall", id: "t1" }] },
      { role: "user", content: [{ type: "text", text: "and make it blue" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ],
  });
  writeSession(cwdB, ID_B, "2025-02-01T00:00:00.000Z", {
    messages: [{ role: "user", content: "fix the flaky test" }],
  });
  writeSession(cwdB, ID_C, "2025-03-01T00:00:00.000Z", {
    name: "refactor",
    messages: [{ role: "user", content: "refactor auth" }],
  });
});

test("encodeCwdDir matches pi's scheme", () => {
  const encoded = encodeCwdDir(cwdA);
  assert.match(encoded, /^--.+--$/);
  assert.ok(!encoded.includes("/"));
  assert.ok(encoded.includes("-"));
});

test("listSessionFiles: all cwds, newest first, tagged claude", () => {
  const all = listSessionFiles(10, undefined, agentDir);
  assert.deepEqual(
    all.map((s) => s.id),
    [ID_C, ID_B, ID_A]
  );
  assert.ok(all.every((s) => s.provider === "claude"));
  const a = all.find((s) => s.id === ID_A);
  assert.equal(a.title, "feature-x");
  assert.equal(a.cwd, cwdA);
});

test("listSessionFiles: scoped to a cwd", () => {
  const onlyB = listSessionFiles(10, realpathSync(cwdB), agentDir);
  assert.deepEqual(onlyB.map((s) => s.id).sort(), [ID_B, ID_C].sort());
});

test("listSessionFiles: limit respected", () => {
  assert.equal(listSessionFiles(1, undefined, agentDir).length, 1);
});

test("findSessionFile / readSessionCwd", () => {
  const file = findSessionFile(ID_A, agentDir);
  assert.ok(file && file.endsWith(`_${ID_A}.jsonl`));
  assert.equal(readSessionCwd(ID_A, agentDir), cwdA);
  assert.equal(findSessionFile("nope", agentDir), null);
});

test("readHistory: user/assistant text turns only", () => {
  const h = readHistory(ID_A, 10, agentDir);
  assert.deepEqual(h, [
    { role: "user", text: "build the widget" },
    { role: "assistant", text: "On it." },
    { role: "user", text: "and make it blue" },
    { role: "assistant", text: "Done." },
  ]);
  const limited = readHistory(ID_A, 2, agentDir);
  assert.equal(limited.length, 2);
  assert.equal(limited[0].role, "user");
});
