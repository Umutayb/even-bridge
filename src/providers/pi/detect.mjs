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

/** The cgroup of a durable lets-code child (`even-lc-<sid>.scope`): the bridge drives it, never a terminal. */
export const LC_CGROUP_RE = /\/even-lc-[^/]*\.scope$/m;

/**
 * Find running `pi` processes whose cwd matches `cwd` (i.e. a terminal pi
 * that could be driving a session of that project). Excludes the given pids
 * (our own bridge-spawned children), this process, and any process whose
 * `/proc/<pid>/cgroup` matches `skipCgroup` (the durable provider's lets-code
 * children; `null` turns the check off; a missing cgroup file never skips).
 *
 * @returns {Promise<Array<{pid: number, cwd: string}>>}
 */
export async function findExternalPi(cwd, { excludePids = [], procRoot = "/proc", myPid = process.pid, skipCgroup = LC_CGROUP_RE } = {}) {
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
    if (pcwd !== cwd) continue;
    if (skipCgroup) {
      let cg = "";
      try {
        cg = await readFile(join(procRoot, name, "cgroup"), "utf8");
      } catch {
        /* no cgroup file: not one of ours */
      }
      if (skipCgroup.test(cg)) continue;
    }
    found.push({ pid, cwd: pcwd });
  }
  return found;
}

/**
 * Find a tmux pane running `pi` with its current path == `cwd`. With `pid`, only the pane hosting THAT pi
 * process (pane_pid is the process or one of its ancestors): two pi terminals can share a cwd.
 * @returns {Promise<string|null>} pane id (e.g. "%7") or null.
 */
export async function findPiTmuxPane(cwd, { tmuxBin = "tmux", procRoot = "/proc", pid } = {}) {
  if (!cwd) return null;
  if (pid != null) return findPaneFor(cwd, pid, ["pi"], { tmuxBin, procRoot });
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

/** Characters a single typed line may never carry: C0/C1 controls, DEL, line and paragraph separators. */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Prompts, menus and dialogs (a fast reject, applied only to the input region the allowlist found, never to the
 * transcript above it): pi's selectors ("→ Yes", "↑↓ navigate  enter select  escape cancel", "Enter to select ·
 * Esc to go back", "Press Enter to continue"), Claude Code's permission and trust menus ("❯ 1. Yes", "Esc to
 * cancel", "Yes, I trust this folder"), y/n prompts. Two numbered lines in a row count as a menu too.
 */
export const MENU_HINT_RE = new RegExp(
  [
    "\\bnavigate\\b",
    "\\benter\\b.{0,4}\\b(?:select|confirm|continue)\\b",
    "\\besc(?:ape)?\\b.{0,4}\\b(?:cancel|go back|exit|close)\\b",
    "Press Enter",
    "^\\s*→ ",
    "^\\s*(?:│\\s*)?[❯>]\\s*\\d+[.)]\\s",
    "\\((?:y/n|Y/n|y/N)\\)|\\[(?:y/n|Y/n|y/N)\\]",
    "Yes, I trust this folder",
  ].join("|"),
  "im",
);
const NUMBERED_RE = /^\s*(?:[❯>]\s*)?\d+[.)]\s/;
const RULE_RE = /^─{8,}$/; // a full-width rule: pi-tui's editor borders, Claude Code's input box (round, no sides)
const PI_SCROLL_RULE_RE = /^─+ [↑↓] \d+ more ─*$/; // pi-tui editor border with hidden lines (centred, or "─── ↓ N more ──" when narrow)
/** Any escape sequence a styled capture (`capture-pane -e`) can hold: CSI (SGR and others), OSC, other ESC X. */
const ANSI_RE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, "");

/**
 * The typed text of a styled (`capture-pane -e`) Claude Code input line, without the prompt: every character that
 * is not a space and lies outside a dim run (SGR 2, until SGR 0, an empty SGR or SGR 22). Claude Code draws its
 * idle placeholder dim; a draft is plain text. 256-colour / truecolour arguments (38;5;n, 38;2;r;g;b and the 48
 * forms) are skipped, so their numbers never read as SGR 2. An unstyled capture has no dim run: any text is a draft.
 */
export function undimmedText(line) {
  let dim = false;
  let out = "";
  const s = String(line);
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[([0-9;:]*)m/.exec(s.slice(i));
      if (m) {
        const ps = m[1] === "" ? ["0"] : m[1].split(/[;:]/);
        for (let k = 0; k < ps.length; k++) {
          const v = ps[k] === "" ? 0 : Number(ps[k]);
          if (v === 0 || v === 22) dim = false;
          else if (v === 2) dim = true;
          else if (v === 38 || v === 48 || v === 58) k += ps[k + 1] === "5" ? 2 : ps[k + 1] === "2" ? 4 : 0;
        }
        i += m[0].length;
        continue;
      }
      const o = new RegExp(ANSI_RE.source, "y");
      o.lastIndex = i;
      const e = o.exec(s);
      i += e ? e[0].length : 1;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    if (!dim && ch.trim()) out += ch;
    i += ch.length;
  }
  return out;
}
/** pi's footer stats line: the context indicator "12.3%/128k" or "?/128k" (footer.js contextPercentDisplay). */
const PI_STATS_RE = /(?:^|\s)(?:\d+(?:\.\d+)?%|\?)\/\d+(?:\.\d+)?[kM]?(?:\s|\(|$)/;
const CLAUDE_TOP_RE = /^(?:─{8,}|╭─{6,}╮)$/;
const CLAUDE_BOTTOM_RE = /^(?:─{8,}|╰─{6,}╯)$/;
/** Claude Code's input line: the prompt character "❯" (or ">" in older builds), never "!" (bash mode). */
const CLAUDE_INPUT_RE = /^(?:│\s*)?[❯>](?:\s|$)/;

/**
 * ALLOWLIST (Task 6b I6): may a line be typed into this pane now? Only when the bottom of the captured screen is
 * the program's own idle input box:
 *   - pi (pi-tui, interactive-mode.js): the editor between two full-width rules (the bottom one may read
 *     "─── ↓ N more"), with the footer below it (the cwd line and the stats line with the context indicator
 *     "12.3%/128k"). When pi shows a selector, confirm, input or submenu, that component takes the editor's
 *     place (editorContainer), so the region between the rules then holds spacer lines, "→ Yes", hints, etc.
 *   - Claude Code: its input box (borderStyle round without sides: a full-width rule, the "❯ " line and any
 *     continuation lines, a rule), with at most 4 footer lines ("? for shortcuts", modes) below. A permission
 *     menu or the trust prompt replaces the box: there is no rule-"❯ "-rule at the bottom then.
 * Inside the region found, a menu hint (MENU_HINT_RE), two numbered lines in a row, or (pi) a blank line in a
 * multi-line region also block. Anything unrecognised blocks: `{ ready: false, why }`.
 * A DRAFT blocks too (I7: our text would be appended to the user's half-typed text and submitted with it), with
 * `why: "draft"`:
 *   - pi: any non-whitespace text in the editor region (pi has no placeholder; its cursor is an inverse-video
 *     cell, a space in a plain capture);
 *   - Claude Code: any non-space character after the "❯ " / "> " prompt outside a dim run (`undimmedText`: the
 *     dim placeholder alone is idle; needs a `capture-pane -e` screen, an unstyled one blocks any text), or any
 *     continuation line in the box.
 * @param {string|null} screen capture-pane output (`-p`; for Claude Code `-p -e`)
 * @param {"pi"|"claude"} program
 */
export function inputReady(screen, program) {
  if (screen == null) return { ready: false, why: "unreadable" };
  const raw = String(screen).split("\n");
  const lines = raw.map((l) => stripAnsi(l).replace(/\s+$/, ""));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const t = (i) => (lines[i] ?? "").trim();
  const menuIn = (region) => {
    if (MENU_HINT_RE.test(region.join("\n"))) return true;
    for (let i = 1; i < region.length; i++) if (NUMBERED_RE.test(region[i - 1]) && NUMBERED_RE.test(region[i])) return true;
    return false;
  };
  const n = lines.length;
  if (program === "pi") {
    let stats = -1;
    for (let i = n - 1; i >= Math.max(0, n - 4); i--) if (PI_STATS_RE.test(lines[i])) { stats = i; break; }
    if (stats < 0) return { ready: false, why: "no pi footer" };
    let b = -1;
    for (let i = stats - 1; i >= Math.max(0, stats - 4); i--) if (RULE_RE.test(t(i)) || PI_SCROLL_RULE_RE.test(t(i))) { b = i; break; }
    if (b < 0) return { ready: false, why: "no editor below" };
    let top = -1;
    for (let i = b - 1; i >= Math.max(0, b - 40); i--) if (RULE_RE.test(t(i)) || PI_SCROLL_RULE_RE.test(t(i))) { top = i; break; }
    if (top < 0) return { ready: false, why: "no editor above" };
    const content = lines.slice(top + 1, b);
    if (!content.length) return { ready: false, why: "empty region" };
    if (content.length > 1 && content.some((l) => !l.trim())) return { ready: false, why: "a menu or dialog" };
    if (menuIn(lines.slice(top))) return { ready: false, why: "a menu or dialog" };
    if (content.some((l) => l.trim())) return { ready: false, why: "draft" };
    return { ready: true };
  }
  if (program === "claude") {
    let b = -1;
    for (let i = n - 1; i >= Math.max(0, n - 6); i--) if (CLAUDE_BOTTOM_RE.test(t(i))) { b = i; break; }
    if (b < 0) return { ready: false, why: "no input box" };
    let top = -1;
    for (let i = b - 1; i >= Math.max(0, b - 40); i--) if (CLAUDE_TOP_RE.test(t(i))) { top = i; break; }
    if (top < 0 || top + 1 >= b) return { ready: false, why: "no input box" };
    if (!CLAUDE_INPUT_RE.test(t(top + 1))) return { ready: false, why: "not the input line" };
    if (menuIn(lines.slice(top))) return { ready: false, why: "a menu or dialog" };
    if (b - top > 2) return { ready: false, why: "draft" }; // a continuation line is always typed text
    // The input line, styles kept: drop the old box's side borders, then the prompt character and its space.
    const input = raw[top + 1].replace(/^((?:\x1b\[[0-9;:]*m)*)\s*│/, "$1").replace(/│((?:\x1b\[[0-9;:]*m|\s)*)$/, "$1");
    const after = input.replace(/^((?:\x1b\[[0-9;:]*m|\s)*)[❯>]/, "$1");
    if (undimmedText(after)) return { ready: false, why: "draft" };
    return { ready: true };
  }
  return { ready: false, why: "unknown program" };
}

/** An inputReady verdict as a terminal screen word: "input" (typing allowed), "draft" (unsent text), "menu" (anything else). */
export const screenWord = (r) => (r?.ready ? "input" : r?.why === "draft" ? "draft" : "menu");
/** The extra field of a blocked deliverToTerminal: `{ draft: true }` for unsent text, `{ waiting: true }` otherwise. */
export const notReady = (r) => (r?.why === "draft" ? { draft: true } : { waiting: true });

/**
 * Deliver `text` to a tmux pane's foreground program (the pi TUI) as if typed,
 * then press Enter. A single line is typed LITERALLY (`send-keys -l -- text`, so
 * "C-d", "Escape" or a leading "-" are characters, never key names or options;
 * a trailing ";" — tmux's command separator — is sent as "\;"), then Enter as a
 * separate key. Multi-line text (the phone only) goes through load-buffer +
 * paste-buffer WITHOUT bracketed paste: tmux turns each LF into CR, so every line
 * is submitted on its own, then a final Enter. (The overseer never takes this path.)
 * `singleLine: true` (the overseer's messages): any newline or control character
 * is refused (never pasted).
 *
 * @returns {Promise<void>} rejects when tmux is unavailable.
 */
export async function tmuxDeliver(paneId, text, { tmuxBin = "tmux", singleLine: only = false } = {}) {
  const singleLine = !text.includes("\n");
  if (only && CONTROL_CHARS_RE.test(text)) {
    throw Object.assign(new Error("a typed message must be one line without control characters"), { statusCode: 400 });
  }
  if (singleLine) {
    // A trailing ";" is tmux's command separator and would be eaten: "\;" is a literal ";".
    const arg = text.endsWith(";") ? text.slice(0, -1) + "\\;" : text;
    await runTmux(tmuxBin, ["send-keys", "-t", paneId, "-l", "--", arg]);
    await runTmux(tmuxBin, ["send-keys", "-t", paneId, "Enter"]);
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
 * the terminal TUI is actually showing). `styled`: keep the SGR attributes
 * (`capture-pane -e`), so inputReady can tell Claude Code's dim placeholder from a draft.
 * @returns {Promise<string|null>}
 */
export async function capturePane(paneId, { tmuxBin = "tmux", styled = false } = {}) {
  const { stdout } = await new Promise((resolve, reject) =>
    execFile(tmuxBin, ["capture-pane", "-p", ...(styled ? ["-e"] : []), "-t", paneId], { timeout: 5000 }, (err, stdout) =>
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

/** The pane (in `cwd`) whose foreground command is one of `commands` and whose pane_pid is `pid` or its ancestor. */
async function findPaneFor(cwd, pid, commands, { tmuxBin = "tmux", procRoot = "/proc" } = {}) {
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
    return null;
  }
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const panePid = Number(parts[3]);
    const command = parts[4];
    if (parts.slice(5).join(" ") !== cwd) continue;
    if (!commands.some((c) => command === c || command.endsWith("/" + c))) continue;
    if (panePid && (await isBridgeDescendant(pid, procRoot, panePid))) return parts[2];
  }
  return null;
}

/**
 * Right before typing (after any wait): does `paneId` still run one of `commands` in the foreground, with
 * pane_pid an ancestor of (or equal to) `pid`? A program that exited leaves a shell there, which would EXECUTE
 * the typed text; a pane that now hosts another process is someone else's.
 * @returns {Promise<boolean>}
 */
export async function paneRunsPid(paneId, pid, { commands = ["pi"], tmuxBin = "tmux", procRoot = "/proc" } = {}) {
  let out;
  try {
    const { stdout } = await new Promise((resolve, reject) =>
      execFile(tmuxBin, ["display-message", "-p", "-t", paneId, "#{pane_current_command} #{pane_pid}"], { timeout: 5000 }, (err, stdout) =>
        err ? reject(err) : resolve({ stdout: String(stdout ?? "") })
      )
    );
    out = stdout.trim();
  } catch {
    return false;
  }
  const [command = "", panePidS = ""] = out.split(/\s+/);
  const panePid = Number(panePidS);
  if (!commands.some((c) => command === c || command.endsWith("/" + c))) return false;
  if (!panePid || pid == null) return false;
  return isBridgeDescendant(pid, procRoot, panePid);
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
