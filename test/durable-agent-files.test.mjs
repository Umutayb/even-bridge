import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentFiles, parseAgentFile } from "../src/providers/durable/agent-files.mjs";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "dur-agents-"));
  // Shaped like the live ~/.pi/agent/agents/scout.md.
  writeFileSync(
    join(dir, "scout.md"),
    [
      "---",
      "name: scout",
      "description: Fast read-only recon of a codebase; returns the files, line ranges and key code another agent needs",
      "tools: read, grep, find, ls, bash",
      "role: readonly",
      "---",
      "Investigate quickly and report for an agent that has not seen the files.",
      "",
      "Output:",
      "## Files",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "notes.md"), "Just some notes, no frontmatter.\n");
  writeFileSync(join(dir, "bad.md"), "---\nname: ../evil\n---\nbody\n");
  writeFileSync(
    join(dir, "worker.md"),
    [
      "---",
      "# To keep your own version, delete this line",
      "description: \"Makes a delegated change\"",
      "tools: [read, bash, edit, write]",
      "disallowed: write",
      "thinking: high",
      "timeout: 1800",
      "use_for: changes",
      "brief:",
      "  - goal (required)",
      "---",
      "Complete the assigned task.",
    ].join("\r\n"),
  );
  // A second file claiming "scout": the first in name order wins.
  writeFileSync(join(dir, "zz-scout.md"), "---\nname: scout\ndescription: impostor\n---\nx\n");
  writeFileSync(join(dir, "README.txt"), "---\nname: txt\n---\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("loader parses the scout fixture: name, description, tools, role, body", () => {
  const agents = loadAgentFiles(dir);
  const scout = agents.get("scout");
  assert.equal(scout.name, "scout");
  assert.match(scout.description, /^Fast read-only recon/);
  assert.deepEqual(scout.tools, ["read", "grep", "find", "ls", "bash"]);
  assert.equal(scout.role, "readonly");
  assert.equal(scout.body, "Investigate quickly and report for an agent that has not seen the files.\n\nOutput:\n## Files");
  assert.equal(scout.thinking, undefined);
  assert.equal(scout.timeout, undefined);
  assert.equal(scout.disallowed, undefined);
  assert.deepEqual(scout.extra, {});
});

test("a file without frontmatter, a bad name and non-.md files are ignored", () => {
  const agents = loadAgentFiles(dir);
  assert.deepEqual([...agents.keys()].sort(), ["scout", "worker"]);
  assert.equal(parseAgentFile("no frontmatter here", "/x/notes.md"), null);
  assert.equal(agents.get("scout").description.includes("impostor"), false, "first file in name order wins");
});

test("name defaults to the file name; quotes, brackets, CRLF, thinking, timeout and unknown keys", () => {
  const w = loadAgentFiles(dir).get("worker");
  assert.equal(w.name, "worker");
  assert.equal(w.description, "Makes a delegated change");
  assert.deepEqual(w.tools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(w.disallowed, ["write"]);
  assert.equal(w.thinking, "high");
  assert.equal(w.timeout, 1800);
  assert.equal(w.body, "Complete the assigned task.");
  assert.deepEqual(w.extra, { use_for: "changes", brief: "" });
  assert.equal(parseAgentFile("---\ntimeout: soon\n---\nb", "/a/t.md").timeout, undefined);
});

test("a missing directory gives an empty map", () => {
  assert.equal(loadAgentFiles(join(dir, "nope")).size, 0);
  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.equal(loadAgentFiles(empty).size, 0);
});
