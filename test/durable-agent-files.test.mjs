import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentFiles, parseAgentFile, parseTimeout } from "../src/providers/durable/agent-files.mjs";

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
  assert.equal(scout.prompt, scout.body);
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
  const warned = [];
  assert.equal(parseAgentFile("---\ntimeout: soon\n---\nb", "/a/t.md", { log: { warn: (l) => warned.push(l) } }).timeout, undefined);
  assert.match(warned.join("\n"), /agent t: timeout "soon" is not seconds/);
  assert.equal(parseAgentFile("---\ntimeout: 30m\n---\nb", "/a/t.md").timeout, 1800);
  assert.deepEqual(["900", "45s", "30m", "2h", "0", "-5", "1d", ""].map(parseTimeout), [900, 45, 1800, 7200, NaN, NaN, NaN, undefined]);
});

test("append_prompt (live lets-code style) is read from the agent home and appended; unusable agents are left out", () => {
  const home = mkdtempSync(join(tmpdir(), "dur-agent-home-"));
  try {
    const agents = join(home, "agents");
    mkdirSync(join(home, "ah-app"), { recursive: true });
    mkdirSync(agents);
    writeFileSync(join(home, "ah-app", "prompt.md"), "Drive the AH app through the device farm.\n");
    writeFileSync(join(home, "outside.md"), "x");
    const fm = (name, extra) => `---\n# Written by lets-code (${name}); regenerated on launch, edits are overwritten.\nname: ${name}\ndescription: ${name} agent\n${extra}\ntimeout: 3600\n---\n`;
    writeFileSync(join(agents, "ah-app.md"), fm("ah-app", "append_prompt: ah-app/prompt.md"));
    writeFileSync(join(agents, "both.md"), fm("both", "append_prompt: ah-app/prompt.md") + "Own body first.\n");
    writeFileSync(join(agents, "missing.md"), fm("missing", "append_prompt: missing/prompt.md"));
    writeFileSync(join(agents, "escape.md"), fm("escape", "append_prompt: ../../etc/passwd"));
    writeFileSync(join(agents, "empty.md"), fm("empty", "role: readonly"));
    const warned = [];
    const map = loadAgentFiles(agents, { log: { warn: (l) => warned.push(l) } });
    assert.deepEqual([...map.keys()].sort(), ["ah-app", "both"]);
    const ah = map.get("ah-app");
    assert.equal(ah.body, "");
    assert.equal(ah.prompt, "Drive the AH app through the device farm.");
    assert.equal(ah.extra.append_prompt, "ah-app/prompt.md");
    assert.equal(ah.timeout, 3600);
    assert.equal(map.get("both").prompt, "Own body first.\n\nDrive the AH app through the device farm.");
    const log = warned.join("\n");
    assert.match(log, /agent missing: append_prompt missing\/prompt.md unreadable/);
    assert.match(log, /agent escape: append_prompt \.\.\/\.\.\/etc\/passwd leaves/);
    for (const n of ["missing", "escape", "empty"]) assert.match(log, new RegExp(`agent ${n}: no instructions .*not offered`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing directory gives an empty map", () => {
  assert.equal(loadAgentFiles(join(dir, "nope")).size, 0);
  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.equal(loadAgentFiles(empty).size, 0);
});
