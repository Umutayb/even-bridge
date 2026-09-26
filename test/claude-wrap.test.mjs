// Onboarding: the `claude` shell wrapper (rc / tmux / none) and the setup
// script that installs it into the user's shell rc files.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAP = join(REPO, "scripts", "claude-wrap.sh");
const SETUP = join(REPO, "scripts", "setup-claude-wrap.sh");
const ONBOARD = join(REPO, "scripts", "onboard.sh");

function tmp(t, name) {
  const d = mkdtempSync(join(tmpdir(), `evenbridge-${name}-`));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Fake `claude` and `tmux` that print their argv (one arg per line). */
function fakeBin(t) {
  const bin = tmp(t, "bin");
  for (const name of ["claude", "tmux"]) {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\necho "${name}"\nfor a in "$@"; do echo "[$a]"; done\n`);
    chmodSync(p, 0o755);
  }
  return bin;
}

/** Source the wrapper in bash with `mode` and run `claude <args>`. */
function runWrapped(t, mode, args, env = {}) {
  const bin = fakeBin(t);
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const out = execFileSync("bash", ["-c", `EVEN_CLAUDE_WRAP_MODE=${mode}; . "${WRAP}"; claude ${quoted}`], {
    env: { PATH: `${bin}:/usr/bin:/bin`, EVEN_CLAUDE_WRAP_ASSUME_TTY: "1", ...env },
    cwd: "/tmp",
    encoding: "utf8",
  });
  return out.trim().split("\n");
}

// ── wrapper ────────────────────────────────────────────────────────────────

test("rc mode appends --remote-control AFTER the user's args (a prompt is never eaten as the RC name)", (t) => {
  assert.deepEqual(runWrapped(t, "rc", ["fix the bug"]), ["claude", "[fix the bug]", "[--remote-control]"]);
  assert.deepEqual(runWrapped(t, "rc", ["--resume", "abc"]), ["claude", "[--resume]", "[abc]", "[--remote-control]"]);
  assert.deepEqual(runWrapped(t, "rc", []), ["claude", "[--remote-control]"]);
});

test("pass-through: print mode, help/version, subcommands, explicit RC, non-TTY, escape hatch", (t) => {
  for (const args of [
    ["-p", "hi"],
    ["--print", "hi"],
    ["--help"],
    ["-v"],
    ["--version"],
    ["mcp", "list"],
    ["update"],
    ["doctor"],
    ["--remote-control", "mine"],
    ["--remote-control=mine"],
  ]) {
    assert.deepEqual(runWrapped(t, "rc", args), ["claude", ...args.map((a) => `[${a}]`)], args.join(" "));
  }
  // Not a terminal (scripts, pipes): never wrapped.
  assert.deepEqual(runWrapped(t, "rc", ["hi"], { EVEN_CLAUDE_WRAP_ASSUME_TTY: "" }), ["claude", "[hi]"]);
  // Per-call opt-out.
  assert.deepEqual(runWrapped(t, "rc", ["hi"], { EVEN_CLAUDE_WRAP: "off" }), ["claude", "[hi]"]);
});

test("tmux mode starts claude in a new tmux session, unless already inside tmux", (t) => {
  const out = runWrapped(t, "tmux", ["--resume", "abc"]);
  assert.equal(out[0], "tmux");
  assert.deepEqual(out.slice(1, 3), ["[new-session]", "[-s]"]);
  assert.match(out[3], /^\[claude-\d+/);
  assert.deepEqual(out.slice(4, 6), ["[-c]", "[/tmp]"]);
  assert.match(out[6], /\/claude\]$/, "real claude binary path, not the function");
  assert.deepEqual(out.slice(7), ["[--resume]", "[abc]"]);
  assert.deepEqual(runWrapped(t, "tmux", ["hi"], { TMUX: "/tmp/tmux-1/default,1,0" }), ["claude", "[hi]"]);
});

test("mode none (or unknown) is a plain pass-through", (t) => {
  assert.deepEqual(runWrapped(t, "none", ["hi"]), ["claude", "[hi]"]);
  assert.deepEqual(runWrapped(t, "bogus", ["hi"]), ["claude", "[hi]"]);
});

// ── setup script ───────────────────────────────────────────────────────────

function setup(home, mode) {
  return spawnSync("bash", [SETUP, mode], { env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/bash" }, encoding: "utf8" });
}
const MARK = "# even-bridge claude wrap";
const count = (s, needle) => s.split(needle).length - 1;

test("setup installs once (idempotent), switches mode, and 'none' removes every trace", (t) => {
  const home = tmp(t, "home");
  writeFileSync(join(home, ".bashrc"), "export FOO=1\n");
  writeFileSync(join(home, ".zshrc"), "alias ll='ls -l'\n");
  const wrapFile = join(home, ".config", "even-bridge", "claude-wrap.sh");

  for (let i = 0; i < 2; i++) assert.equal(setup(home, "rc").status, 0);
  for (const rc of [".bashrc", ".zshrc"]) {
    assert.equal(count(readFileSync(join(home, rc), "utf8"), MARK), 1, `${rc}: one marker line`);
  }
  assert.match(readFileSync(wrapFile, "utf8"), /^EVEN_CLAUDE_WRAP_MODE=rc$/m);

  assert.equal(setup(home, "tmux").status, 0);
  assert.match(readFileSync(wrapFile, "utf8"), /^EVEN_CLAUDE_WRAP_MODE=tmux$/m);
  assert.equal(count(readFileSync(join(home, ".bashrc"), "utf8"), MARK), 1);

  assert.equal(setup(home, "none").status, 0);
  assert.equal(existsSync(wrapFile), false);
  assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), "export FOO=1\n", "user content untouched");
  assert.equal(readFileSync(join(home, ".zshrc"), "utf8"), "alias ll='ls -l'\n");
});

test("setup creates the login shell's rc file when none exists; rejects bad modes", (t) => {
  const home = tmp(t, "home");
  assert.equal(setup(home, "rc").status, 0);
  assert.equal(count(readFileSync(join(home, ".bashrc"), "utf8"), MARK), 1);
  const bad = setup(home, "sometimes");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /rc\|tmux\|none/);
});

test("installed wrapper file works when sourced from the rc line", (t) => {
  const home = tmp(t, "home");
  setup(home, "rc");
  const bin = fakeBin(t);
  const out = execFileSync("bash", ["-c", `. "${home}/.bashrc"; claude hi`], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, EVEN_CLAUDE_WRAP_ASSUME_TTY: "1" },
    encoding: "utf8",
  });
  assert.deepEqual(out.trim().split("\n"), ["claude", "[hi]", "[--remote-control]"]);
});

// ── onboarding flow ────────────────────────────────────────────────────────

test("onboard.sh non-interactive: applies the chosen wrap, skips services on request, prints next steps", (t) => {
  const home = tmp(t, "home");
  mkdirSync(join(home, ".even-terminal"), { recursive: true });
  writeFileSync(join(home, ".even-terminal", "config.json"), "{}"); // already initialized
  const bin = fakeBin(t);
  const r = spawnSync("bash", [ONBOARD, "--yes", "--no-services"], {
    env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: "/bin/bash", EVEN_CLAUDE_WRAP: "tmux" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(readFileSync(join(home, ".config", "even-bridge", "claude-wrap.sh"), "utf8"), /MODE=tmux/);
  assert.match(r.stdout, /skipped.*services/i);
  assert.match(r.stdout, /pair/i);
});

test("onboard.sh defaults to rc when non-interactive and no choice is given", (t) => {
  const home = tmp(t, "home");
  mkdirSync(join(home, ".even-terminal"), { recursive: true });
  writeFileSync(join(home, ".even-terminal", "config.json"), "{}");
  const bin = fakeBin(t);
  const r = spawnSync("bash", [ONBOARD, "--yes", "--no-services"], {
    env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: "/bin/bash" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(readFileSync(join(home, ".config", "even-bridge", "claude-wrap.sh"), "utf8"), /MODE=rc/);
  assert.match(r.stdout, /EVEN_CLAUDE_WRAP=none/, "tells how to opt out");
});
