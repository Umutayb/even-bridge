// External-driver detection for pi sessions (and, further down, local
// Claude Code: findExternalClaude / findClaudeTmuxPane reuse the same
// /proc + tmux patterns).
//
// pi session files are shared append-only logs: a terminal TUI (`pi` in a
// shell) and a bridge-spawned `pi --mode rpc` can both attach to the same
// file, but only ONE of them can actually drive the conversation — the
// second one wedges and silently drops prompts (observed: a bridge child
// spawned while a terminal pi was mid-turn ACKed RPC commands but never
// processed them, eating every glasses prompt for hours).
//
// Before driving a session, the bridge must know whether a terminal pi for
// the session's cwd is alive. If it is, the only safe delivery path is
// `tmux send-keys` into that pane (single writer); if the terminal is not
// under tmux the bridge must say so instead of spawning a wedged second
// writer.

import { execFile } from "node:child_process";
import { readdir, readFile, readlink, rm, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Find running `pi` processes whose cwd matches `cwd` (i.e. a terminal pi
 * that could be driving a session of that project). Excludes the given pids
 * (our own bridge-spawned children) and this process.
 *
 * @returns {Promise<Array<{pid: number, cwd: string}>>}
 */
export async function findExternalPi(cwd, { excludePids = [], procRoot = "/proc", myPid = process.pid } = {}) {
  if (!cwd) return [];
  const skip = new Set([myPid, ...excludePids]);
  let entries;
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const found = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    let comm;
    try {
      comm = (await readFile(join(procRoot, name, "comm"), "utf8")).trim();
    } catch {
      continue;
    }
    if (comm !== "pi") continue;
    // A STOPPED pi (Ctrl+Z / SIGSTOP, state T) is suspended: it reads no
    // input and drives nothing, so it must not count as the external driver.
    // (Observed: a stopped duplicate pi in the same cwd made the bridge
    // believe a non-tmux terminal owned the session and blocked every
    // glasses prompt until the zombie was killed.)
    let stat;
    try {
      stat = await readFile(join(procRoot, name, "stat"), "utf8");
    } catch {
      continue;
    }
    // comm in /proc/PID/stat is parenthesized and may itself contain " )",
    // so anchor on the LAST close-paren; the state is the char after the
    // following space ("pid (comm) STATE ppid ...").
    const closeParen = stat.lastIndexOf(")");
    const state = closeParen >= 0 ? stat.slice(closeParen + 2, closeParen + 3) : "";
    if (state === "T" || state === "t") continue;
    let pcwd;
    try {
      pcwd = await readlink(join(procRoot, name, "cwd"));
    } catch {
      continue;
    }
    if (pcwd === cwd) found.push({ pid, cwd: pcwd });
  }
  return found;
}

/**
 * Find a tmux pane running `pi` with its current path == `cwd`.
 * @returns {Promise<string|null>} pane id (e.g. "%7") or null.
 */
export async function findPiTmuxPane(cwd, { tmuxBin = "tmux", procRoot = "/proc" } = {}) {
  if (!cwd) return null;
  const fmt = "#{session_name} #{window_index} #{pane_id} #{pane_current_command} #{pane_current_path}";
  let out;
  try {
    const { stdout } = await new Promise((resolve, reject) =>
      execFile(tmuxBin, ["list-panes", "-a", "-F", fmt], { timeout: 5000 }, (err, stdout) =>
        err ? reject(err) : resolve({ stdout: String(stdout ?? "") })
      )
    );
    out = stdout;
  } catch {
    return null; // tmux missing / no server / no panes
  }
  // The pane command for a pi process is "pi" (its bin name); match leniently
  // in case a wrapper shows up (e.g. "node").
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const paneId = parts[2];
    const command = parts[3];
    const path = parts.slice(4).join(" ");
    if (path !== cwd) continue;
    if (command === "pi" || command.endsWith("/pi")) return paneId;
  }
  return null;
}

/**
 * Deliver `text` to a tmux pane's foreground program (the pi TUI) as if typed,
 * then press Enter. Multi-line text is pasted verbatim via a load-buffer so
 * newlines land inside the prompt, not as submits.
 *
 * @returns {Promise<void>} rejects when tmux is unavailable.
 */
export async function tmuxDeliver(paneId, text, { tmuxBin = "tmux" } = {}) {
  const singleLine = !text.includes("\n");
  if (singleLine) {
    await runTmux(tmuxBin, ["send-keys", "-t", paneId, text, "Enter"]);
    return;
  }
  // Multi-line: paste the whole text, then submit once.
  const dir = await mkdtemp(join(tmpdir(), "evenbridge-tmux-"));
  const file = join(dir, "prompt.txt");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, text, "utf8");
    await runTmux(tmuxBin, ["load-buffer", "-b", "evenbridge", file]);
    await runTmux(tmuxBin, ["paste-buffer", "-b", "evenbridge", "-t", paneId]);
    await runTmux(tmuxBin, ["send-keys", "-t", paneId, "Enter"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runTmux(tmuxBin, args) {
  return new Promise((resolve, reject) =>
    execFile(tmuxBin, args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()))
  );
}

/**
 * Capture a pane's visible screen as text (for deciding which conversation
 * the terminal TUI is actually showing).
 * @returns {Promise<string|null>}
 */
export async function capturePane(paneId, { tmuxBin = "tmux" } = {}) {
  const { stdout } = await new Promise((resolve, reject) =>
    execFile(tmuxBin, ["capture-pane", "-p", "-t", paneId], { timeout: 5000 }, (err, stdout) =>
      err ? reject(err) : resolve({ stdout: String(stdout ?? "") })
    )
  );
  return stdout;
}

/**
 * Does a captured pane screen show one of the session's recent prompt
 * fragments? Whitespace-normalized both sides (the TUI wraps/indents).
 * @param {string} screen raw capturePane output
 * @param {string[]} fragments from recentPromptFragments()
 */
export function screenShowsFragments(screen, fragments) {
  if (!screen) return false;
  const s = screen.replace(/\s+/g, "");
  for (const f of fragments ?? []) if (f && s.includes(f)) return true;
  return false;
}

// ── Claude Code (local, non-RC) ──────────────────────────────────────────────

/**
 * Find running `claude` (Claude Code) processes whose cwd matches `cwd` —
 * i.e. a terminal CC that could be driving a session of that project.
 *
 * Excluded: the CC background daemon family (`claude daemon run`,
 * `bg-pty-host`, `bg-spare` — they host, not drive), RC sessions
 * (`--remote-control` — owned by the claude-remote fork), STOPPED
 * processes (state T — suspended, driving nothing), and bridge children
 * (ancestor chain reaching this process — the official dist spawns those,
 * so they are NOT external drivers).
 *
 * Each hit carries the conversation it is driving when Claude Code's own
 * per-process record (`~/.claude/sessions/<pid>.json`: sessionId + busy/idle
 * status) is present and its cwd matches (a mismatch means a reused pid /
 * stale record). No record -> sessionId undefined: the caller must treat the
 * process as possibly driving ANY session in the cwd.
 *
 * @returns {Promise<Array<{pid: number, cwd: string, sessionId?: string, status?: string}>>}
 */
export async function findExternalClaude(
  cwd,
  { excludePids = [], procRoot = "/proc", myPid = process.pid, sessionsDir = join(homedir(), ".claude", "sessions") } = {}
) {
  if (!cwd) return [];
  const skip = new Set([myPid, ...excludePids]);
  let entries;
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const found = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (skip.has(pid)) continue;
    let comm, cmdline, stat;
    try {
      comm = (await readFile(join(procRoot, name, "comm"), "utf8")).trim();
      cmdline = (await readFile(join(procRoot, name, "cmdline"), "utf8")).replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (comm !== "claude") continue;
    if (/daemon|bg-pty-host|bg-spare|--remote-control/.test(cmdline)) continue;
    try {
      stat = await readFile(join(procRoot, name, "stat"), "utf8");
    } catch {
      continue;
    }
    // Same parsing as findExternalPi: last ")" anchors past a comm that
    // contains ")"; fields after it are "STATE ppid pgrp ...".
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) continue;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const state = fields[0]?.[0] ?? "";
    if (state === "T" || state === "t") continue;
    const ppid = Number(fields[1] ?? 0);
    let pcwd;
    try {
      pcwd = await readlink(join(procRoot, name, "cwd"));
    } catch {
      continue;
    }
    if (pcwd !== cwd) continue;
    if (await isBridgeDescendant(ppid, procRoot, myPid)) continue; // bridge-spawned child
    found.push({ pid, cwd: pcwd, ...(await readClaudeSessionRecord(sessionsDir, pid, pcwd)) });
  }
  return found;
}

/** {sessionId, status} from ~/.claude/sessions/<pid>.json, or {} when absent/stale. */
async function readClaudeSessionRecord(sessionsDir, pid, cwd) {
  try {
    const rec = JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), "utf8"));
    if (rec.pid !== pid || rec.cwd !== cwd || typeof rec.sessionId !== "string") return {};
    return { sessionId: rec.sessionId, ...(typeof rec.status === "string" ? { status: rec.status } : {}) };
  } catch {
    return {};
  }
}

/** True when `ppid`'s ancestor chain (<= 32 hops) reaches `myPid`. */
async function isBridgeDescendant(ppid, procRoot, myPid) {
  let cur = ppid;
  for (let i = 0; i < 32 && cur > 1; i++) {
    if (cur === myPid) return true;
    let stat;
    try {
      stat = await readFile(join(procRoot, String(cur), "stat"), "utf8");
    } catch {
      return false; // chain breaks — not ours
    }
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return false;
    const next = Number(stat.slice(closeParen + 2).trim().split(/\s+/)[1] ?? 0);
    if (!next || next === cur) return false;
    cur = next;
  }
  return false;
}

/**
 * Find a tmux pane running `claude` with its current path == `cwd`. With
 * `pid`, only the pane hosting THAT claude process (pane_pid is the process
 * or one of its ancestors) — several claudes can share a cwd.
 * @returns {Promise<string|null>} pane id (e.g. "%7") or null.
 */
export async function findClaudeTmuxPane(cwd, { tmuxBin = "tmux", pid, procRoot = "/proc" } = {}) {
  if (!cwd) return null;
  const fmt = "#{session_name} #{window_index} #{pane_id} #{pane_pid} #{pane_current_command} #{pane_current_path}";
  let out;
  try {
    const { stdout } = await new Promise((resolve, reject) =>
      execFile(tmuxBin, ["list-panes", "-a", "-F", fmt], { timeout: 5000 }, (err, stdout) =>
        err ? reject(err) : resolve({ stdout: String(stdout ?? "") })
      )
    );
    out = stdout;
  } catch {
    return null; // tmux missing / no server / no panes
  }
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const paneId = parts[2];
    const panePid = Number(parts[3]);
    const command = parts[4];
    const path = parts.slice(5).join(" ");
    if (path !== cwd) continue;
    if (!(command === "claude" || command.endsWith("/claude"))) continue;
    if (pid == null || (panePid && (await isBridgeDescendant(pid, procRoot, panePid)))) return paneId;
  }
  return null;
}
