// The guard every Even-AI Durable conversation runs behind.
//
// - `confinePath`: a write may only reach the conversation's cwd or /tmp (a
//   read also the system dirs), after resolving `..`, `~`, `$HOME` and
//   symlinks; ~/.ssh ~/.aws ~/.config ~/.even-terminal ~/.pi ~/.gnupg and the
//   secret parts of /etc are refused even when a symlink under an allowed root
//   leads there.
// - `judgeCommand`: vets a bash command. `RULES` are the deny patterns ported
//   from lets-code's `judgeBash` (destructive git, sudo, scripts piped into a
//   shell, ...); on top of that a small lexer follows `cd`, removals, write
//   targets and every path-like token, so `cd .. && rm -rf x`, absolute paths,
//   `$HOME/...` and symlinks out of the workspace are refused.
// - `createGuardExtension`: the Durable extension. Its `beforeTool` hook vets
//   read/write/edit/bash; it re-declares `bash` so `prepare` can run each
//   command under resource caps (systemd-run scope, or bwrap when BWRAP=1).
//   Install it AFTER CodingTools: the later `bash` replaces the earlier one.
//
// `judgeCommand`, `confinePath`, `guardBeforeTool` and `guardPrepare` need no
// Durable and are unit-tested directly.
//
// Reads vs writes: reads may also reach the system dirs (/usr /bin /sbin /lib*
// /opt /snap /etc /proc/self); writes and removals only cwd and /tmp. Secret
// system files (/etc/shadow*, /etc/sudoers*, /etc/ssh, ...) are refused for both.
//
// Known limits. This is a lexer/regex guard over shell text, not a sandbox: it
// catches the obvious and the common evasions, and a determined model can
// still get past it. The real isolation is bwrap (BWRAP=1), which borealis does
// not have installed; systemd-run only caps memory and CPU. Still uncaught:
// - Code run by an interpreter: `python3 -c`, `node -e`, `perl -e`, `ruby -e`,
//   `python3 <<EOF`, `| python3`, or `npm test`/`make` running a script the
//   model edited. Only the denied home dirs are caught there, by name.
// - A script written first and run later (`echo ... > x.sh; bash x.sh`,
//   `bash < x.sh`), and anything the program does on its own (git hooks
//   already in the repo, npm lifecycle scripts, a Makefile).
// - Paths built at run time beyond what the lexer sees (`cd "$(cat f)"` makes
//   the cwd unknown and blocks what follows, but `$X/..`-style values that are
//   computed are only checked by their literal prefix), and symlinks or files
//   made by a program other than `ln` earlier in the same command.
// - Network use: curl/wget are allowed (only piping them into a shell or an
//   interpreter is refused).
// - RULES also run on the raw text, so `echo "git reset --hard" x` is
//   blocked too. That over-blocking is intended.
// - Child conversations (subagents) must map to their parent's cwd; `cwdOf`
//   is the caller's responsibility.

import { lstatSync, readlinkSync, accessSync, existsSync, constants as FS } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";

const TMP = "/tmp";
const DENIED_IN_HOME = [".ssh", ".aws", ".config", ".even-terminal", ".pi", ".gnupg"];
// Read AND write: unit drop-ins hold tokens (`Environment=LETS_CODE_TOKEN=...`), the user bus is host control.
const DENIED_ABS = ["/etc/ssh", "/etc/ssl/private", "/etc/netplan", "/etc/wpa_supplicant", "/etc/NetworkManager", "/etc/systemd", "/etc/even-terminal.env", "/run/user"];
const DENIED_PREFIX = ["/etc/shadow", "/etc/gshadow", "/etc/sudoers"];
const READ_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/snap", "/etc"];
// /proc: only named, harmless entries; never root, cwd, fd, exe, map_files (they lead anywhere),
// nor environ/cmdline (a shell's own environ is filtered, but the names invite reading other pids').
const PROC_SELF_OK = new Set(["status", "stat", "statm", "maps", "smaps", "smaps_rollup", "comm", "limits", "mountinfo", "mounts", "cgroup", "io", "sched", "oom_score", "loginuid", "sessionid", "uid_map", "gid_map", "wchan"]);
const PROC_GLOBAL_OK = new Set(["cpuinfo", "meminfo", "loadavg", "uptime", "version", "stat"]);
// The shell sees only these variables from the bridge's environment (never tokens or keys).
const ENV_ALLOW = /^(?:PATH|HOME|LANG|LC_\w+|TERM|USER|LOGNAME|SHELL|TMPDIR|NVM_DIR|NODE_\w+|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/;
const ENV_SECRET = /(?:TOKEN|_KEY|SECRET|PASSWORD|PASSWD)$|APIKEY|API_KEY|CREDENTIAL|PRIVATE|^(?:LETS_CODE_TOKEN|BRIDGE_TOKEN)$/i;
// Environment assignments that make git run a program or look elsewhere.
const GIT_ENV_EXEC = /^GIT_(?:CONFIG\w*|SSH\w*|PAGER|EDITOR|SEQUENCE_EDITOR|EXTERNAL_DIFF|ASKPASS|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR)$/;
const GIT_ENV_PATH = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/;
// Config keys whose value is a program, or that pull in other config.
const GIT_EXEC_KEYS = String.raw`(?:core\.(?:hookspath|sshcommand|pager|editor|fsmonitor|alternaterefscommand|gitproxy|askpass)|gpg\.(?:\w+\.)?program|sequence\.editor|credential\.|include\.path|includeif\.|alias\.|filter\.|protocol\.|uploadpack\.|diff\.\S*\.(?:textconv|command)|merge\.\S*\.driver|pager\.|[\w.-]*command(?=[\s=]|$))`;
const DEVICES = /^\/dev\/(?:null|zero|u?random|stdin|stdout|stderr|tty|fd\/\d+)$/;
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|.*\.(?:pem|key|p12|pfx|jks|keystore))$/;
const SHELLS = /^(?:sh|bash|zsh|dash|ksh|fish)$/;
const MAX_DEPTH = 5;

// ================================================================ rules
// Patterns over the whole command text (heredoc bodies removed). `G` is `git`
// with its global options (`-C dir`, `-c k=v`, `--git-dir=...`), `A` the rest
// of one simple command, `E` the end of a flag.
const G = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;
const A = String.raw`[^;&|\n]*`;
const E = String.raw`(?=\s|$|[;&|)])`;
const r = (s) => new RegExp(s);

/** Deny rules ported from lets-code `judgeBash` (destructiveGit, stdin scripts) plus a few host-safety ones. */
export const RULES = [
  { re: r(`${G}push\\b${A}\\s(?:-[A-Za-z]*f[A-Za-z]*|--force(?:-with-lease|-if-includes)?(?:=\\S*)?|--mirror|--delete|-d|--prune)${E}`), why: "git push --force/--delete/--mirror/--prune rewrites or deletes remote history" },
  { re: r(`${G}push\\b${A}\\s[+:][^\\s;&|]+`), why: "git push +refspec / :refspec force-pushes or deletes a remote branch" },
  { re: r(`${G}reset\\b${A}\\s(?:--hard|--merge)${E}`), why: "git reset --hard discards work irreversibly" },
  { re: r(`${G}checkout\\b${A}\\s(?:--|-f|--force|-B|-p|--patch)${E}`), why: "git checkout -- <path>/-f/-B discards work irreversibly" },
  { re: r(`${G}checkout\\s+\\.(?:\\/\\S*)?${E}`), why: "git checkout . discards work irreversibly" },
  { re: r(`${G}switch\\b${A}\\s(?:-f|--force|--discard-changes|-C|--force-create)${E}`), why: "git switch -f/-C discards work" },
  { re: r(`${G}restore\\b(?!(?=${A}\\s(?:--staged|-S)${E})(?!${A}\\s(?:--worktree|-W)${E}))`), why: "git restore <path> discards work irreversibly (only --staged is allowed)" },
  { re: r(`${G}clean\\b(?!${A}\\s(?:-n|--dry-run|-[A-Za-z]*n[A-Za-z]*)${E})${A}\\s(?:-[A-Za-z]*[fdxX][A-Za-z]*|--force)${E}`), why: "git clean -f deletes untracked files irreversibly" },
  { re: r(`${G}branch\\b${A}\\s(?:-D|-f|--force|-M)${E}`), why: "git branch -D/-f/-M can lose commits" },
  { re: r(`${G}stash\\s+(?:drop|clear)${E}`), why: "git stash drop/clear loses stashed work" },
  { re: r(`${G}rm\\b(?!${A}\\s--cached${E})${A}\\s(?:-[A-Za-z]*f[A-Za-z]*|--force)${E}`), why: "git rm -f deletes work" },
  { re: r(`${G}tag\\b${A}\\s(?:-d|--delete)${E}`), why: "git tag -d deletes a tag" },
  { re: r(`${G}(?:update-ref|filter-branch|filter-repo|replace|fast-import|prune)${E}`), why: "low-level git history rewriting is refused" },
  { re: r(`${G}reflog\\s+(?:expire|delete)${E}`), why: "git reflog expire/delete loses recovery points" },
  { re: r(`${G}gc\\b${A}\\s--prune\\b`), why: "git gc --prune loses recovery points" },
  { re: r(`${G}worktree\\s+remove\\b${A}\\s(?:-f|--force)${E}`), why: "git worktree remove -f discards work" },
  { re: r(`${G}config\\b${A}\\s(?:--unset-all|--remove-section)${E}`), why: "git config --unset-all/--remove-section is refused" },
  { re: r(`${G}submodule\\s+deinit\\b${A}\\s(?:-f|--force)${E}`), why: "git submodule deinit -f discards work" },
  { re: /(?<![\w.-])(?:sudo|doas|pkexec)(?![\w./-])/, why: "sudo/doas/pkexec is refused" },
  { re: /(?<![\w.-])(?:docker|podman|nerdctl|ctr|lxd|machinectl|lxc(?:-[\w-]+)?)(?![\w./-])(?!\s+(?:ps|images|logs|inspect|version|info)(?=\s|$|[;&|)]))/, why: "container tools are refused (docker group membership is root-equivalent)" },
  { re: /(?<![\w.-])(?:nsenter|unshare|chroot)(?![\w./-])/, why: "namespace and chroot tools are refused" },
  { re: /(?<![\w.-])(?:pkill|killall5?|loginctl|crontab|systemd-run|busctl|dbus-send|gdbus|tmux|screen)(?![\w./-])/, why: "process, session, bus, terminal-multiplexer and scheduler control is refused" },
  // ps with environment output: BSD `e` in a dashless cluster (`ps eww`, `ps auxe`) or `-E`.
  { re: r(`(?<![\\w.-])ps(?:\\s+[a-zA-Z]+)*?\\s+[a-zA-Z]*e[a-zA-Z]*${E}`), why: "ps with process environments (ps e/eww) is refused" },
  { re: r(`(?<![\\w.-])ps\\b${A}\\s-[A-Za-z]*E[A-Za-z]*${E}`), why: "ps with process environments (ps -E) is refused" },
  { re: r(`(?<![\\w.-])kill\\b${A}\\s(?:--\\s+)?-1${E}`), why: "kill -1 signals every process" },
  { re: r(`(?<![\\w.-])kill\\b${A}(?:\\$|\`)`), why: "kill with a computed target ($PPID, $$, $(..)) cannot be checked" },
  { re: r(`(?<![\\w.-])(?:ba|z|da|k|fi)?sh(?![\\w./-])${A}<<<`), why: "a here-string fed to a shell cannot be checked; use bash -c '...'" },
  { re: r(`${G}config\\b${A}\\s--(?:global|system)${E}`), why: "git config --global/--system is refused" },
  { re: new RegExp(String.raw`\bgit\b[^;&|\n]*\s(?:-c\s*|--config-env[= ])["']?${GIT_EXEC_KEYS}`, "i"), why: "git -c with a key that runs a program (core.sshCommand, pager, hooksPath, credential.helper, alias, ...) is refused" },
  { re: new RegExp(String.raw`${G}config\b(?![^;&|\n]*\s(?:--get\S*|-l|--list|--show-\S+)(?=\s|$))[^;&|\n]*\s["']?${GIT_EXEC_KEYS}`, "i"), why: "git config writes of keys that run a program (core.hooksPath, core.sshCommand, include.path, alias.*, ...) are refused" },
  { re: /(?<![\w.-])GIT_(?:CONFIG\w*|SSH\w*|PAGER|EDITOR|SEQUENCE_EDITOR|EXTERNAL_DIFF|ASKPASS|PROXY_COMMAND|EXEC_PATH|TEMPLATE_DIR)=/, why: "git environment that runs a program (GIT_SSH_COMMAND, GIT_PAGER, GIT_CONFIG_*, ...) is refused" },
  { re: /(?:^|[;&|(\n]|\$\()\s*su(?=\s|$)/, why: "su is refused" },
  { re: r(`\\|\\s*(?:env\\s+)?(?:\\S*\\/)?(?:ba|z|da|k|fi)?sh${E}(?!${A}\\s-c\\b)`), why: "a script piped into a shell cannot be checked; use bash -c '...' or a heredoc" },
  { re: /\b(?:curl|wget)\b[^;&\n]*\|\s*(?:\S*\/)?(?:python[\d.]*|perl|ruby|node|php)\b/, why: "a downloaded script piped into an interpreter is refused" },
  { re: /(?:^|[;&|(\s])(?:\S*\/)?(?:(?:ba|z|da|k)?sh|source|\.)\s+<\(/, why: "running a process substitution as a script is refused" },
  { re: /\b(?:eval|(?:ba|z|da|k)?sh\s+-c)\s+["']?\$\(\s*(?:curl|wget)\b/, why: "running a downloaded script is refused" },
  { re: r(`\\brm\\b${A}--no-preserve-root`), why: "rm --no-preserve-root is refused" },
  { re: r(`\\brm\\s+(?:-\\S+\\s+)*-[A-Za-z]*[rR][A-Za-z]*\\s+(?:-\\S+\\s+)*(?:\\/|~\\/?|\\$HOME\\/?|\\$\\{HOME\\}\\/?)\\*?${E}`), why: "rm -rf of / or ~ is refused" },
  { re: /\bmkfs(?:\.\w+)?\b/, why: "mkfs is refused" },
  { re: r(`\\bdd\\b${A}\\bof=\\/dev\\/(?!null${E})`), why: "dd onto a device is refused" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:/, why: "fork bomb" },
  { re: /(?:^|[;&|(\n]|\$\()\s*(?:shutdown|reboot|poweroff|halt)(?=\s|$)/, why: "powering the host off is refused" },
  { re: r(`\\bsystemctl\\b${A}\\s(?:start|stop|restart|reload|kill|disable|enable|mask|isolate|poweroff|reboot)${E}`), why: "service control is refused" },
  { re: r(`\\bsystemctl\\b${A}\\s--user${E}`), why: "systemctl --user is refused" },
  // Unit files, drop-ins and the journal hold `Environment=` tokens and logs: no reading them either.
  { re: r(`\\bsystemctl\\b${A}\\s(?:cat|show|list-unit-files|edit)${E}`), why: "reading unit files and properties (systemctl cat/show/list-unit-files) is refused" },
  { re: /(?<![\w.-])journalctl(?![\w./-])/, why: "journalctl is refused (logs and unit environments)" },
];

// ================================================================ paths
const within = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const inside = (p, root) => p !== root && within(p, root);

/** Kernel-like resolution: `..` after symlinks, dangling links followed; missing tails stay lexical. */
function resolveReal(abs) {
  let todo = abs.split("/").filter(Boolean);
  let cur = "/";
  let hops = 0;
  while (todo.length) {
    const seg = todo.shift();
    if (seg === ".") continue;
    if (seg === "..") { cur = dirname(cur); continue; }
    const next = cur === "/" ? "/" + seg : cur + "/" + seg;
    let st;
    try { st = lstatSync(next); } catch { cur = next; continue; }
    if (st.isSymbolicLink()) {
      if (++hops > 40) return null;
      const target = readlinkSync(next);
      todo = [...target.split("/").filter(Boolean), ...todo];
      if (target.startsWith("/")) cur = "/";
      continue;
    }
    cur = next;
  }
  return cur;
}

/** `~`, `~/x`, `$HOME`, `${HOME}` → home; `null` when another `$`/backtick/`~user` is left. */
function expandHome(p, home) {
  let s = p;
  if (s === "~" || s.startsWith("~/")) s = home + s.slice(1);
  s = s.replace(/^\$\{HOME\}|^\$HOME(?![\w])/, home);
  if (/[`$]/.test(s) || s.startsWith("~")) return null;
  return s;
}

/** `/proc/self`, `/proc/self/<named entry>` or `/proc/<global entry>`, judged on the unnormalized path. */
function procOk(abs) {
  const segs = abs.split("/").filter((x) => x !== "" && x !== ".");
  if (segs[0] !== "proc") return false;
  if (segs.length === 2) return PROC_GLOBAL_OK.has(segs[1]) || segs[1] === "self";
  return segs.length === 3 && segs[1] === "self" && PROC_SELF_OK.has(segs[2]);
}

const tilde = (p, home) => (within(p, home) ? "~" + p.slice(home.length) : p);

/**
 * May `p` (relative to `cwd`) be touched? `mode` "write" (default): cwd and /tmp only;
 * "read": also /usr /bin /sbin /lib* /opt /snap /etc and (lexically) /proc/self. The denied
 * dirs are refused even under an allowed root, also when reached through a symlink.
 * `base` (default `cwd`) is where a relative `p` starts, e.g. after a `cd` in a command.
 * @returns {{ ok: boolean, why?: string, real?: string }}
 */
export function confinePath(p, cwd, home = homedir(), { tmp = TMP, base = cwd, mode = "write" } = {}) {
  if (typeof p !== "string" || p === "") return { ok: false, why: "no path" };
  const expanded = expandHome(p, home);
  if (expanded === null) return { ok: false, why: `cannot tell where '${p}' points` };
  const realCwd = resolveReal(resolve(cwd));
  const realBase = base === cwd ? realCwd : resolveReal(resolve(base));
  const real = resolveReal(isAbsolute(expanded) ? expanded : join(realBase ?? base, expanded));
  if (real === null || realCwd === null) return { ok: false, why: `too many symlinks in '${p}'` };
  const lexical = resolve(base, expanded);
  const denied = [...DENIED_IN_HOME.map((d) => join(home, d)), ...DENIED_ABS];
  for (const d of denied) {
    const dr = resolveReal(d) ?? d;
    if (within(real, dr) || within(real, d) || within(lexical, d)) return { ok: false, why: `${tilde(d, home)} is off limits`, real };
  }
  for (const d of DENIED_PREFIX) if (real.startsWith(d) || lexical.startsWith(d)) return { ok: false, why: `${d}* is off limits`, real };
  const roots = [realCwd, resolveReal(tmp) ?? tmp];
  if (roots.some((root) => within(real, root))) return { ok: true, real };
  if (mode === "read" && (READ_SYSTEM.some((root) => within(real, resolveReal(root) ?? root)) || procOk(isAbsolute(expanded) ? expanded : `${base}/${expanded}`))) return { ok: true, real };
  const where = mode === "read" ? "the workspace, /tmp and the system dirs" : `the workspace (${tilde(realCwd, home)} and ${tmp})`;
  return { ok: false, why: `'${p}' is outside ${where}${mode === "write" ? " for writing" : ""}`, real };
}

// ================================================================ text scan
// Every absolute (or ~/$HOME) path-like token anywhere in the command text, also
// inside quoted interpreter code, with shell globs (`*`, `**`, `?`, `[..]`,
// `{a,b}`) taken as patterns. A token that names (or may name) something inside
// or equal to a denied dir is refused; a token that is an ANCESTOR of one is
// refused when the command reads recursively (grep -r, find, rg, tar, ...).
const PATH_TOKEN = /(?<![\w.~$}\/-])(?:~|\$\{HOME\}|\$HOME)?\/[^\s'"`;|&()<>,]*/g;
const RECURSIVE = /(?:^|[\s;&|(`'"])(?:find|rg|ag|ack|tar|zip|rsync|tree|du|locate|fd|fdfind)(?=[\s;&|)`'"]|$)|(?:^|\s)-[A-Za-z]*[rR][A-Za-z]*(?=\s|$)|--recursive\b|--dereference-recursive\b|\bos\.walk\b|\brglob\b|\breaddirSync\b|\bglob\.glob\b/;

/** One path component as a shell-glob regex (anchored). `**` matches any run of components (handled by the caller). */
function componentRe(c) {
  let out = "";
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "[") {
      const j = c.indexOf("]", i + 2);
      if (j < 0) { out += "\\["; continue; }
      let body = c.slice(i + 1, j);
      if (body.startsWith("!") || body.startsWith("^")) body = "^" + body.slice(1);
      out += `[${body.replace(/\\/g, "\\\\")}]`;
      i = j;
    } else if (ch === "{") {
      const j = c.indexOf("}", i);
      if (j < 0) { out += "\\{"; continue; }
      out += `(?:${c.slice(i + 1, j).split(",").map((a) => a.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("|")})`;
      i = j;
    } else out += ch.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** How pattern components `pc` relate to path components `dc`: "inside" (pc reaches dc or below), "ancestor", or null. */
function relate(pc, dc) {
  for (let i = 0; i < pc.length; i++) {
    if (pc[i] === "**") return "inside"; // matches dc itself and anything below
    if (i >= dc.length) return "inside";
    if (!componentRe(pc[i]).test(dc[i])) return null;
  }
  return pc.length >= dc.length ? "inside" : "ancestor";
}

/** The denied dir strictly below `dir` (a real path), if any. */
function deniedBelow(dir, home) {
  const pc = dir.split("/").filter(Boolean);
  for (const d of [...DENIED_ABS, ...DENIED_PREFIX, ...DENIED_IN_HOME.map((x) => join(home, x))]) {
    if (relate(pc, d.split("/").filter(Boolean)) === "ancestor") return d;
  }
  return undefined;
}

function scanDenied(text, home) {
  const denied = [...DENIED_ABS, ...DENIED_PREFIX, ...DENIED_IN_HOME.map((d) => join(home, d))];
  const recursive = RECURSIVE.test(text);
  for (const m of text.matchAll(PATH_TOKEN)) {
    let t = m[0].replace(/^(?:~|\$\{HOME\}|\$HOME)(?=\/)/, home);
    // `..` and `.` components: normalize lexically (globs stay as they are).
    const pc = [];
    for (const c of t.split("/").filter(Boolean)) {
      if (c === ".") continue;
      if (c === "..") pc.pop();
      else pc.push(c);
    }
    for (const d of denied) {
      const dc = d.split("/").filter(Boolean);
      const rel = relate(pc, dc);
      if (rel === "inside") return `${tilde(d, home)} is off limits (via '${m[0]}')`;
      if (rel === "ancestor" && recursive) return `a recursive read of '${m[0]}' would reach ${tilde(d, home)}, which is off limits`;
    }
  }
  return undefined;
}

// ================================================================ lexing
/** Drop heredoc bodies (they are data, not commands) and join line continuations. */
function stripHeredocs(src) {
  const lines = src.replace(/\\\n/g, " ").split("\n");
  const out = [];
  const shellBodies = [];  // bodies fed to a shell (`bash <<EOF`): those are scripts
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const toShell = /(?<![\w.-])(?:ba|z|da|k|fi)?sh(?![\w./-])[^|;&<]*<<(?!<)/.test(line.replace(/[\\'"]/g, ""));
    const docs = [...line.matchAll(/<<(?!<)(-?)\s*(['"]?)([\w.-]+)\2/g)];
    for (const [, dash, , delim] of docs) {
      const body = [];
      while (++i < lines.length && (dash ? lines[i].replace(/^\t+/, "") : lines[i]) !== delim) body.push(lines[i]);
      if (toShell) shellBodies.push(body.join("\n"));
    }
  }
  return { text: out.join("\n"), shellBodies };
}

/** Index of the `)` matching the `(` at `i`, skipping quoted text. */
function matchParen(src, i) {
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") { k++; continue; }
    if (c === "'") { const j = src.indexOf("'", k + 1); k = j < 0 ? src.length : j; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return k;
  }
  return src.length;
}

/**
 * Split into simple commands: `{ argv, writes, reads }`. Subshells and command or
 * process substitutions become `{ open: true }`, their own commands, `{ close: true }`;
 * the word they stand in becomes unresolved (`$()`), so it is never trusted as a path.
 */
function lex(src) {
  const out = [];
  let seg = { argv: [], dyn: [], writes: [], reads: [] };
  let tok = null;
  let dyn = false;  // the word has a `$`/backtick outside single quotes: the shell expands it
  let redir = null;
  const endTok = () => {
    if (tok === null) return;
    if (redir === "write") seg.writes.push(tok);
    else if (redir === "read") seg.reads.push(tok);
    else if (redir !== "skip") { seg.argv.push(tok); seg.dyn.push(dyn); }
    tok = null;
    dyn = false;
    redir = null;
  };
  const endSeg = () => {
    endTok();
    if (seg.argv.length || seg.writes.length || seg.reads.length) out.push(seg);
    seg = { argv: [], dyn: [], writes: [], reads: [] };
  };
  // Note: `seg.piped` (stdin from a `|`) and `seg.herestring` (`<<<`) ride on the segment.
  const nested = (inner) => { out.push({ open: true }, ...lex(inner), { close: true }); };
  // `$(..)` / `<(..)` / `>(..)` at `i` (pointing at the `(`): lex the inside, return the end.
  const substitution = (i) => { const j = matchParen(src, i); nested(src.slice(i + 1, j)); return j; };
  const backtick = (i) => { let j = i + 1; while (j < src.length && src[j] !== "`") { if (src[j] === "\\") j++; j++; } nested(src.slice(i + 1, j)); return j; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) { tok = (tok ?? "") + src[++i]; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); const k = j < 0 ? src.length : j; tok = (tok ?? "") + src.slice(i + 1, k); i = k; continue; }
    if (c === '"') {
      let k = i + 1, s = "";
      while (k < src.length && src[k] !== '"') {
        if (src[k] === "\\" && k + 1 < src.length) { s += src[k + 1]; k += 2; continue; }
        if (src[k] === "$" || src[k] === "`") dyn = true;
        if (src[k] === "$" && src[k + 1] === "(") { k = substitution(k + 1) + 1; s += "$()"; continue; }
        if (src[k] === "`") { k = backtick(k) + 1; s += "$()"; continue; }
        s += src[k++];
      }
      tok = (tok ?? "") + s; i = k; continue;
    }
    if (c === " " || c === "\t") { endTok(); continue; }
    if (c === "$" && src[i + 1] === "(") { i = substitution(i + 1); tok = (tok ?? "") + "$()"; dyn = true; continue; }
    if (c === "`") { i = backtick(i); tok = (tok ?? "") + "$()"; dyn = true; continue; }
    if ((c === "<" || c === ">") && src[i + 1] === "(") { endTok(); i = substitution(i + 1); tok = "$()"; dyn = true; continue; }
    if (c === "(") { endSeg(); out.push({ open: true }); continue; }
    if (c === ")") { endSeg(); out.push({ close: true }); continue; }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if (c === "&" && src[i + 1] === ">") { endTok(); redir = "write"; i++; if (src[i + 1] === ">") i++; continue; }
      endSeg();
      if ((c === "|" || c === "&") && src[i + 1] === c) i++;
      else if (c === "|") { if (src[i + 1] === "&") i++; seg.piped = true; }
      continue;
    }
    if (c === ">" || c === "<") {
      if (tok !== null && /^\d+$/.test(tok)) tok = null;  // fd number: 2>
      endTok();
      if (c === "<" && src[i + 1] === "<") {
        if (src[i + 2] === "<") { i += 2; redir = "skip"; seg.herestring = true; continue; }  // here-string
        i++; if (src[i + 1] === "-") i++; redir = "skip"; continue;   // heredoc delimiter
      }
      if (c === ">" && (src[i + 1] === ">" || src[i + 1] === "|")) i++;
      if (src[i + 1] === "&") { i++; redir = "skip"; continue; }        // >&2, <&0
      redir = c === ">" ? "write" : "read";
      continue;
    }
    if (c === "$") dyn = true;
    tok = (tok ?? "") + c;
  }
  endSeg();
  return out;
}

const pathLike = (t) => t.startsWith("/") || t.startsWith("~") || t.startsWith(".") || t.includes("/") || /^\$\{?HOME\b/.test(t);
const unresolved = (t) => /[`$]|\{\}/.test(t);
const hasGlob = (t) => /[*?[]/.test(t);
const globRe = (pat) => new RegExp("^" + pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/** Strip `command`, `env K=V`, `xargs -n1`, `timeout 5`, `nohup`, ... in front of the real command. */
const WRAPPER_VALUE_FLAGS = { nice: /^-n$/, exec: /^-a$/, ionice: /^-[cnp]$/, stdbuf: /^-[ioe]$/ };

function unwrapArgv(argv, assigns = []) {
  let a = argv;
  for (let guard = 0; guard < 10 && a.length; guard++) {
    const n = basename(a[0]);
    if (/^(?:then|do|else|elif|if|while|until|!|\{|\}|time|nohup|command|builtin|exec|stdbuf|nice|ionice)$/.test(n)) {
      a = a.slice(1);
      // Flags that take a value: `nice -n 5`, `exec -a NAME`, `ionice -c 3`, `stdbuf -o L`.
      const valued = WRAPPER_VALUE_FLAGS[n];
      while (a.length && /^-/.test(a[0])) a = a.slice(valued?.test(a[0]) ? 2 : 1);
      continue;
    }
    if (n === "env") {
      a = a.slice(1);
      while (a.length && (/^-/.test(a[0]) || /^\w+=/.test(a[0]))) {
        const t = a[0];
        // `env -S 'cmd args'` splits its value into words: lex it and go on with those.
        const split = t === "-S" || t === "--split-string" ? a[1] ?? "" : t.startsWith("--split-string=") ? t.slice(15) : /^-S./.test(t) ? t.slice(2) : null;
        if (split !== null) { a = [...lexWords(split), ...a.slice(t === "-S" || t === "--split-string" ? 2 : 1)]; break; }
        if (/^\w+=/.test(t)) assigns.push(t);
        if (/^-C|^--chdir/.test(t)) assigns.chdir = true;
        a = a.slice(/^-[uC]$|^--(?:unset|chdir)$/.test(t) ? 2 : 1);
      }
      continue;
    }
    if (n === "timeout") { a = a.slice(1); while (a.length && /^-/.test(a[0])) a = a.slice(/^-[sk]$|^--(?:signal|kill-after)$/.test(a[0]) ? 2 : 1); a = a.slice(1); continue; }
    if (n === "xargs") {
      a = a.slice(1);
      while (a.length && /^-/.test(a[0])) a = a.slice(/^-[IndPLsE]$/.test(a[0]) ? 2 : 1);
      continue;
    }
    break;
  }
  return a;
}

/** All words of a string, ignoring operators (for `env -S`). */
function lexWords(src) {
  return lex(src).flatMap((seg) => seg.argv ?? []);
}

function flagsOf(args) {
  const flags = [], pos = [];
  let dashdash = false;
  for (const x of args) {
    if (!dashdash && x === "--") { dashdash = true; continue; }
    if (!dashdash && x.startsWith("-") && x !== "-") flags.push(x); else pos.push(x);
  }
  return { flags, pos };
}

// ================================================================ judging
/**
 * Vet a bash command run in `cwd`.
 * @returns {{ block?: string }}
 */
export function judgeCommand(cmd, cwd, home = homedir(), { tmp = TMP, readonly = false } = {}) {
  if (typeof cmd !== "string") return { block: "no command" };
  const why = judge(cmd, cwd, home, tmp, 0, readonly);
  return why ? { block: why } : {};
}

// Read-only agents (agent file `role: readonly`): git verbs that only read, and
// how a listing-only use of branch/tag/remote/config/stash looks.
const GIT_READ_VERBS = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "describe", "shortlog", "cat-file", "rev-list", "for-each-ref", "name-rev", "show-ref", "whatchanged", "reflog", "help", "version"]);
const GIT_LIST_VERBS = new Set(["branch", "tag", "remote"]);
const LIST_FLAG = /^(?:-[arvl]+|-vv|--list|--all|--remotes|--verbose|--contains|--merged|--no-merged|--show-current)$/;
const INLINE_CODE = /^(?:python\d*(?:\.\d+)?|node|nodejs|deno|bun|perl|ruby|php|lua|Rscript|osascript)$/;
const RO = "read-only agent: ";

/** Why a git invocation would change the repository, for a read-only agent. */
function gitMutates(ga) {
  let gi = 0;
  while (gi < ga.length && ga[gi].startsWith("-")) gi += /^-[Cc]$|^--(?:git-dir|work-tree|namespace|config-env)$/.test(ga[gi]) ? 2 : 1;
  const verb = ga[gi];
  if (verb === undefined) return undefined;
  const rest = ga.slice(gi + 1);
  if (GIT_READ_VERBS.has(verb)) return verb === "reflog" && rest[0] && rest[0] !== "show" ? `git reflog ${rest[0]} changes the repository` : undefined;
  if (GIT_LIST_VERBS.has(verb) && rest.every((a) => LIST_FLAG.test(a) || (verb !== "remote" && a.startsWith("-") === false && rest.some((f) => f === "--list" || f === "-l")))) return undefined;
  if (verb === "remote" && (rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url")) return undefined;
  if (verb === "config" && rest.some((a) => /^(?:--get\S*|-l|--list)$/.test(a))) return undefined;
  if (verb === "stash" && (rest[0] === "list" || rest[0] === "show")) return undefined;
  return `git ${verb} may change the repository`;
}

function judge(cmd, cwd0, home, tmp, depth, readonly = false) {
  if (depth > MAX_DEPTH) return "commands nested too deeply to check";
  const { text, shellBodies } = stripHeredocs(cmd);
  for (const rule of RULES) if (rule.re.test(text)) return rule.why;
  for (const body of shellBodies) { const v = judge(body, cwd0, home, tmp, depth + 1, readonly); if (v) return v; }
  // A denied dir named anywhere, also inside quoted interpreter code (`python -c "open('~/.ssh/..')"`).
  for (const d of DENIED_IN_HOME) {
    const tail = d.replace(/\./g, "\\.") + "(?![\\w.-])";
    const homes = [home, "~", "$HOME", "${HOME}"].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (new RegExp(`(?:${homes.join("|")})/+${tail}`).test(text)) return `~/${d} is off limits`;
  }
  { const v = scanDenied(text, home); if (v) return v; }

  const confine = (p, base, mode = "write") => confinePath(p, cwd0, home, { tmp, base, mode });
  const realCwd0 = resolveReal(resolve(cwd0));
  const realTmp = resolveReal(tmp) ?? tmp;
  // Recursive removal: strictly inside the workspace, or at least two levels below /tmp.
  const removableRecursively = (real) => inside(real, realCwd0) || (inside(real, realTmp) && real.slice(realTmp.length + 1).split(sep).filter(Boolean).length >= 2);
  const UNKNOWN = null;
  let cwd = cwd0;
  const stack = [];
  const vars = {};
  const expand = (t) => t.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => {
    const k = a ?? b;
    if (k === "HOME") return home;
    if (k === "PWD" && cwd !== UNKNOWN) return cwd;
    return Object.hasOwn(vars, k) ? vars[k] : m;
  });

  // Links made earlier in this command (`ln -s X up && rm -rf up/y`): they do not exist yet when
  // judged, so anything under them is unknown.
  const links = [];
  const viaLink = (t) => {
    if (!links.length || cwd === UNKNOWN) return undefined;
    const lx = resolve(cwd, expandHome(t, home) ?? t);
    const l = links.find((x) => within(lx, x));
    return l ? `'${t}' goes through a link made earlier in this command; run the ln on its own first` : undefined;
  };
  // An unresolved path (`~/$(printf .ssh)/x`, `/$X`): judge the literal part before the first `$`/backtick.
  const unresolvedPrefix = (raw, t) => {
    const i = t.search(/[`]|\$[{(\w$]|\{\}/);
    const prefix = t.slice(0, i);
    const cut = prefix.lastIndexOf("/");
    const dir = cut > 0 ? prefix.slice(0, cut) : cut === 0 ? "/" : prefix.startsWith("~") ? "~" : "";
    if (dir === "") return undefined;
    const res = confine(dir, cwd ?? cwd0, "read");
    if (!res.ok) return `cannot tell what '${raw}' refers to, and ${dir} is outside what may be touched`;
    if (dir === "~" || /^~\/?$/.test(prefix)) return `cannot tell what '${raw}' refers to under ~`;
    return undefined;
  };
  const checkToken = (raw) => {
    const t = expand(raw);
    if (DEVICES.test(t) || !pathLike(t)) return undefined;
    if (unresolved(t)) return /[`]|\$[{(\w$]|\{\}/.test(t) ? unresolvedPrefix(raw, t) : undefined;  // a lone `$` (sed '/^$/d') is literal
    if (cwd === UNKNOWN && !isAbsolute(t) && !t.startsWith("~")) return `cannot tell what '${raw}' refers to after an unresolved cd`;
    const res = confine(t, cwd ?? cwd0, "read");
    return res.ok ? viaLink(t) : res.why;
  };
  const checkWrite = (raw) => {
    const t = expand(raw);
    if (DEVICES.test(t)) return undefined;
    if (readonly) return `${RO}writing '${raw}' is refused`;
    if (unresolved(t)) return `cannot tell what '${raw}' refers to ($VAR or $(..)); use a literal path`;
    if (cwd === UNKNOWN) return `cannot tell where '${raw}' is after an unresolved cd`;
    if (SECRET_NAME.test(basename(t))) return `writing '${basename(t)}' (env files and keys) is refused`;
    const res = confine(t, cwd);
    if (!res.ok) return res.why;
    if (/(?:^|\/)\.git(?:\/|$)/.test(res.real)) return "writing inside .git is refused; use git commands instead";
    return viaLink(t);
  };
  const checkRemoval = (name, raw, recursive) => {
    if (readonly) return `${RO}${name} ${raw} is refused`;
    const t = expand(raw);
    if (unresolved(t)) return recursive ? `cannot tell what '${raw}' refers to ($VAR, $(..) or {}); use a literal path` : undefined;
    if (cwd === UNKNOWN) return `cannot tell where '${raw}' is after an unresolved cd`;
    const glob = hasGlob(basename(t));
    const res = confine(glob ? dirname(t) || "." : t, cwd);
    if (!res.ok) return `${name} ${raw}: ${res.why}`;
    { const v = viaLink(t); if (v) return `${name} ${raw}: ${v}`; }
    if (basename(t) === ".git" || /(?:^|\/)\.git(?:\/|$)/.test(res.real)) return `${name} ${raw}: removing .git is refused`;
    if (glob) {
      if (recursive && within(cwd, res.real) && globRe(basename(t)).test(".git")) return `${name} ${raw}: the pattern would take .git`;
      if (recursive && res.real === realTmp) return `${name} ${raw}: emptying /tmp is refused`;
      return undefined;
    }
    if (recursive && !removableRecursively(res.real)) return `${name} -r ${raw}: only paths inside the workspace or two levels below /tmp may be removed recursively`;
    return undefined;
  };

  const segs = lex(text);
  let prevWords = "";
  for (const seg of segs) {
    if (seg.open) { stack.push(cwd); prevWords = ""; continue; }
    if (seg.close) { if (stack.length) cwd = stack.pop(); prevWords = ""; continue; }
    for (const w of seg.writes) { const v = checkWrite(w); if (v) return v; }
    for (const rd of seg.reads) { const v = checkToken(rd); if (v) return v; }

    const assigns = [];
    let argv = unwrapArgv(seg.argv, assigns);
    if (/^(?:export|declare|local|typeset|readonly)$/.test(argv[0] ?? "")) argv = argv.slice(1).filter((a) => !a.startsWith("-"));
    // Assignments: remember `D=x` on its own, check the value either way.
    const checkAssign = (name, value) => {
      if (GIT_ENV_EXEC.test(name)) return `${name} makes git run a program; refused`;
      if (GIT_ENV_PATH.test(name)) { const t = expand(value); const res = unresolved(t) ? { ok: false, why: "unresolved" } : confine(t, cwd ?? cwd0); if (!res.ok) return `${name} must point inside the workspace`; }
      return checkToken(value);
    };
    let k = 0;
    for (; k < argv.length; k++) {
      const m = /^(\w+)=(.*)$/s.exec(argv[k]);
      if (!m) break;
      const v = checkAssign(m[1], m[2]); if (v) return v;
      if (argv.length === 1 || argv.every((a) => /^\w+=/.test(a))) vars[m[1]] = expand(m[2]);
    }
    argv = unwrapArgv(argv.slice(k), assigns);
    if (assigns.chdir) return "env -C/--chdir cannot be followed; cd first";
    for (const a of assigns) { const m = /^(\w+)=(.*)$/s.exec(a); const v = checkAssign(m[1], m[2]); if (v) return v; }
    if (!argv.length) { prevWords = ""; continue; }
    // The program word must be literal: `$G push`, `$(..) push`, `"" push` cannot be checked.
    const prog = expand(argv[0]);
    if (prog === "" || unresolved(prog)) return `cannot tell which program '${argv[0]}' runs; use a literal name`;
    // RULES again on the dequoted, expanded words: `"git" push "--force"`, `g\\it`, `--hard""`.
    const words = argv.map(expand).join(" ");
    const joined = seg.piped && prevWords ? `${prevWords} | ${words}` : words;
    prevWords = words;
    for (const rule of RULES) if (rule.re.test(joined)) return rule.why;
    const name = basename(prog);
    if (seg.herestring && SHELLS.test(name)) return "a here-string fed to a shell cannot be checked; use bash -c '...'";
    if (name === "git") {
      const ga = argv.slice(1);
      let gi = 0;
      while (gi < ga.length && ga[gi].startsWith("-")) gi += /^-[Cc]$|^--(?:git-dir|work-tree|namespace|config-env)$/.test(ga[gi]) ? 2 : 1;
      if (gi < ga.length && unresolved(expand(ga[gi]))) return `cannot tell which git command '${ga[gi]}' is; use a literal verb`;
      if (readonly) { const v = gitMutates(ga.map(expand)); if (v) return RO + v; }
    }
    if (readonly && INLINE_CODE.test(name) && argv.slice(1).some((a) => /^-[a-zA-Z]*[ceE]$|^--eval$|^--command$/.test(a))) return `${RO}inline ${name} code cannot be checked for writes`;

    for (const t of argv) {
      const v = checkToken(t) ?? (/^-{0,2}[\w-]+=(.+)$/.test(t) ? checkToken(t.slice(t.indexOf("=") + 1)) : undefined);
      if (v) return v;
    }

    if (name === "cd" || name === "pushd") {
      const args = argv.slice(1).filter((a) => !/^-[LPe@]+$/.test(a) && a !== "--");
      if (!args.length) return "cd to ~ leaves the workspace";
      const d = expand(args[0]);
      // A cd target must be literal and must not be an ancestor of a denied dir: relative
      // paths after `cd /etc` (`grep -r TOKEN systemd`) would escape the text scan.
      if (args[0] === "-" || unresolved(d) || hasGlob(d)) return `cd ${args[0]}: a computed, glob or previous dir cannot be checked; use a literal path inside the workspace`;
      if (cwd === UNKNOWN && !isAbsolute(d) && !d.startsWith("~")) continue;
      const res = confine(d, cwd ?? cwd0, "read");
      if (!res.ok) return `cd ${args[0]}: ${res.why}`;
      { const d0 = deniedBelow(res.real, home); if (d0) return `cd ${args[0]}: ${tilde(d0, home)} lies below it, so relative paths there cannot be judged; cd elsewhere or use absolute paths`; }
      if (within(res.real, "/proc")) return `cd ${args[0]}: cd into /proc is refused`;
      cwd = res.real;
      continue;
    }
    if (name === "popd") { cwd = UNKNOWN; continue; }

    if (SHELLS.test(name) || name === "eval" || name === "source" || name === ".") {
      // `bash -c S`, `bash -lc S`, `bash -ec S`: S is the script (a short-flag cluster with a `c`).
      const ci = argv.findIndex((x, j) => j > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
      const script = name === "eval" ? argv.slice(1).join(" ") : SHELLS.test(name) && ci > 0 ? argv[ci + 1] : undefined;
      const fromStdin = argv.slice(1).some((x) => /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(expand(x)) || /^-[a-zA-Z]*s[a-zA-Z]*$/.test(x));
      // A script the shell expands before handing it over (`bash -c "echo $X"`, `eval "$s"`) is
      // whatever the variable holds: only single-quoted (or expansion-free) scripts are judged.
      const off = seg.argv.length - argv.length;
      const dynAt = (j) => seg.argv[off + j] === argv[j] ? seg.dyn?.[off + j] === true : /[`$]/.test(argv[j]);
      const scriptDyn = name === "eval" ? argv.slice(1).some((_, j) => dynAt(j + 1)) : ci > 0 && dynAt(ci + 1);
      if (script !== undefined) {
        if (scriptDyn) return `${name}: a script with $-expansions outside single quotes cannot be checked; single-quote it`;
        if (cwd === UNKNOWN) return "cannot tell where a nested script runs after an unresolved cd";
        const v = judge(script, cwd, home, tmp, depth + 1, readonly); if (v) return v;
      } else if (seg.piped || fromStdin) {
        return `${name} reading its script from stdin cannot be checked; use ${SHELLS.test(name) ? name : "bash"} -c '...'`;
      }
      continue;
    }

    if (/^(?:rm|rmdir|shred|unlink)$/.test(name)) {
      const { flags, pos } = flagsOf(argv.slice(1));
      const recursive = flags.some((f) => f === "--recursive" || /^-[A-Za-z]*[rR]/.test(f));
      if (!pos.length && recursive) return `${name} -r with targets from stdin cannot be checked`;
      for (const p of pos) { const v = checkRemoval(name, p, recursive); if (v) return v; }
      continue;
    }

    if (name === "find") {
      const args = argv.slice(1);
      const i = args.findIndex((x) => x.startsWith("-") || x === "!" || x === "(");
      const paths = (i < 0 ? args : args.slice(0, i)).filter((x) => x !== "--");
      const expr = i < 0 ? [] : args.slice(i);
      const ex = expr.findIndex((x) => /^-exec(?:dir)?$/.test(x) || /^-ok(?:dir)?$/.test(x));
      if (ex >= 0 && SHELLS.test(basename(expr[ex + 1] ?? ""))) {
        const end = expr.findIndex((x, j) => j > ex && (x === ";" || x === "+"));
        const sub = expr.slice(ex + 1, end < 0 ? undefined : end);
        const ci = sub.indexOf("-c");
        if (ci > 0 && sub[ci + 1] !== undefined) { const v = judge(sub[ci + 1], cwd ?? cwd0, home, tmp, depth + 1, readonly); if (v) return v; }
      }
      const action = expr.findIndex((x, j) => x === "-delete" || (/^-(?:exec|ok)(?:dir)?$/.test(x) && /^(?:rm|shred|unlink)$/.test(basename(expr[j + 1] ?? ""))));
      if (action >= 0) {
        const before = expr.slice(0, action);
        const prunesGit = before.some((x, j) => /^-i?(?:name|path|wholename)$/.test(x) && /^(?:\.\/)?\.git$/.test(before[j + 1] ?? "") && before[j + 2] === "-prune");
        const filters = before.filter((_, j) => /^-i?(?:name|path|regex|wholename)$/.test(before[j - 1] ?? "") && before[j - 2] !== "!" && before[j - 2] !== "-not" && before[j + 1] !== "-prune");
        const risky = !prunesGit && (!filters.length || filters.some((f) => { const re = globRe(f); return re.test(".git") || re.test("./.git"); }));
        for (const p of paths.length ? paths : ["."]) {
          const v = risky ? checkRemoval("find -delete", p, true) : checkRemoval("find -delete", p, false);
          if (v) return v;
        }
      }
      continue;
    }

    const { flags, pos } = flagsOf(argv.slice(1));
    if (name === "ln") {
      const srcs = pos.length > 1 ? pos.slice(0, -1) : pos;
      if (srcs.some((x) => unresolved(expand(x)))) return "ln with a computed source cannot be checked; use a literal path";
    }
    let targets = [];
    if (/^(?:cp|mv|ln|install|rsync)$/.test(name)) targets = pos.slice(-1);
    else if (/^(?:tee|touch|truncate|mkdir)$/.test(name)) targets = pos;
    else if (name === "dd") targets = pos.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
    else if ((name === "sed" || name === "perl") && flags.some((f) => /^-[A-Za-z]*i/.test(f) || f.startsWith("--in-place"))) targets = pos.slice(name === "sed" ? 1 : 0);
    for (const t of targets) { const v = checkWrite(t); if (v) return v; }
    if (name === "mv") for (const s of pos.slice(0, -1)) { const v = checkRemoval("mv", s, false); if (v) return v; }
    if (name === "rsync" && flags.some((f) => f.startsWith("--delete")) && pos.length) { const v = checkRemoval("rsync --delete", pos[pos.length - 1], true); if (v) return v; }
    if (name === "ln" && cwd !== UNKNOWN && pos.length) {  // remembered only after its own checks passed
      const srcs = pos.length > 1 ? pos.slice(0, -1) : pos;
      const dest = pos.length > 1 ? expand(pos[pos.length - 1]) : basename(expand(pos[0]));
      const destAbs = resolve(cwd, expandHome(dest, home) ?? dest);
      let isDir = false;
      try { isDir = lstatSync(destAbs).isDirectory(); } catch { /* a new name */ }
      if (isDir) for (const x of srcs) links.push(join(destAbs, basename(expand(x))));
      else links.push(destAbs);
    }
  }
  return undefined;
}

// ================================================================ the extension
const SHQ = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const shellQuote = SHQ;

function onPath(bin, env = process.env) {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    try { accessSync(join(dir, bin), FS.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** `"bwrap"` only when BWRAP=1 and the binary exists, else `"systemd-run"` when present, else `"none"`. */
export function detectWrapper({ env = process.env, which = (bin) => onPath(bin, env) } = {}) {
  if (env.BWRAP === "1" && which("bwrap")) return "bwrap";
  if (which("systemd-run")) return "systemd-run";
  return "none";
}

/**
 * `env` plus what `systemd-run --user` needs to reach the user manager when the
 * bridge runs as a system unit (no login session): XDG_RUNTIME_DIR defaults to
 * `/run/user/<uid>` and DBUS_SESSION_BUS_ADDRESS to its `bus` socket, each only
 * when unset and the path exists.
 */
export function wrapperEnv(env = process.env, { uid = process.getuid?.(), exists = existsSync } = {}) {
  const out = { ...env };
  if (!out.XDG_RUNTIME_DIR && uid !== undefined && exists(`/run/user/${uid}`)) out.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (!out.DBUS_SESSION_BUS_ADDRESS && out.XDG_RUNTIME_DIR && exists(`${out.XDG_RUNTIME_DIR}/bus`)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${out.XDG_RUNTIME_DIR}/bus`;
  return out;
}

/** Run argv synchronously: `{ status }` (null when it could not start). Injected in tests. */
export function runSync(argv, { env, timeoutMs = 5000 } = {}) {
  try {
    const r = spawnSync(argv[0], argv.slice(1), { env, timeout: timeoutMs, stdio: "ignore" });
    return { status: r.error ? null : r.status };
  } catch {
    return { status: null };
  }
}

/**
 * Probe a detected wrapper once with the tools' env: `systemd-run --user --scope -q true`
 * must exit 0, else the caps cannot apply and we fall back to "none" with a loud warning.
 * @returns {"systemd-run"|"bwrap"|"none"}
 */
export function probeWrapper(wrapper, { env = process.env, run = runSync, warn = (l) => console.warn(l) } = {}) {
  if (wrapper !== "systemd-run") return wrapper;
  const { status } = run(["systemd-run", "--user", "--scope", "-q", "true"], { env });
  if (status === 0) return wrapper;
  warn(
    `[durable:guard] WARNING: 'systemd-run --user --scope' does not work here (exit ${status ?? "spawn failed"}; ` +
      `XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR ?? "unset"}); agent bash runs WITHOUT memory/CPU caps (wrapper=none)`,
  );
  return "none";
}

export const SCOPE_PREFIX = "even-durable-";

/** The transient scope unit of one bash call: `even-durable-<sid>-<n>.scope`, `n` = `<startMs>-<seq>` (systemd-safe characters only). */
export function scopeUnit(sid, n) {
  return `${SCOPE_PREFIX}${String(sid ?? "unknown").replace(/[^A-Za-z0-9:_.-]/g, "_")}-${n}`;
}

/**
 * Stop every `even-durable-*.scope` left by an earlier process (on resume) or this one (shutdown):
 * a scope outlives the bridge unit it was started from. Absence of units, of systemctl or of a user
 * manager is not an error. @returns {boolean} whether systemctl exited 0
 */
export function stopScopes({ env = process.env, run = runSync } = {}) {
  const { status } = run(["systemctl", "--user", "stop", `${SCOPE_PREFIX}*.scope`], { env });
  return status === 0;
}

const DEFAULT_CAPS = { memoryMax: "600M", cpuQuota: "200%" };

/**
 * The shell's environment: the allowlisted variables of `baseEnv` (PATH, HOME, LANG, LC_*,
 * NODE_*, ...; XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS so `systemd-run --user` works)
 * plus what the caller set, minus anything that looks like a token, key or secret.
 */
export function shellEnv(own = {}, baseEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) if (ENV_ALLOW.test(k) && !ENV_SECRET.test(k) && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(own ?? {})) if (!ENV_SECRET.test(k)) env[k] = v;
  return env;
}

/** Rewrite a bash execution (`{command, cwd, env, inheritEnv}`) to run under the wrapper. */
export function guardPrepare(execution, { wrapper = "none", caps = DEFAULT_CAPS, baseEnv = process.env, unit } = {}) {
  const cmd = execution.command;
  execution.env = shellEnv(execution.env, baseEnv);
  execution.inheritEnv = false;
  if (wrapper === "systemd-run") {
    const { memoryMax, cpuQuota } = { ...DEFAULT_CAPS, ...caps };
    const named = unit ? ` --unit=${unit}` : "";
    execution.command = `systemd-run --user --scope -q${named} -p MemoryMax=${memoryMax} -p CPUQuota=${cpuQuota} -- bash -lc ${SHQ(cmd)}`;
  } else if (wrapper === "bwrap") {
    const cwd = execution.cwd;
    execution.command = `bwrap --ro-bind / / --bind ${SHQ(cwd)} ${SHQ(cwd)} --bind /tmp /tmp --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- bash -lc ${SHQ(cmd)}`;
  }
  return execution;
}

const PATH_TOOLS = new Set(["read", "write", "edit"]);

/**
 * The `beforeTool` decision for one call, without Durable: `{ block }` or undefined.
 * @param {{ name: string, arguments: object }} call
 * @param {{ cwd: string|undefined, home?: string, tmp?: string, log?: (line: string) => void }} o
 */
export function guardBeforeTool(call, { cwd, home = homedir(), tmp = TMP, log = (l) => console.warn(l), readonly = false } = {}) {
  const name = call?.name;
  if (name !== "bash" && !PATH_TOOLS.has(name)) return undefined;
  const args = call.arguments ?? {};
  let why;
  if (!cwd) why = "no workspace is known for this conversation";
  else if (readonly && (name === "write" || name === "edit")) why = `${RO}${name} is refused`;
  else if (name === "bash") why = judgeCommand(args.command, cwd, home, { tmp, readonly }).block;
  else {
    const res = confinePath(args.path, cwd, home, { tmp, mode: name === "read" ? "read" : "write" });
    if (!res.ok) why = res.why;
    else if (name !== "read" && SECRET_NAME.test(basename(res.real))) why = `writing '${basename(res.real)}' (env files and keys) is refused`;
    else if (name !== "read" && /(?:^|\/)\.git(?:\/|$)/.test(res.real)) why = "writing inside .git is refused; use git commands instead";
  }
  if (!why) return undefined;
  const what = name === "bash" ? String(args.command ?? "").slice(0, 120) : String(args.path ?? "");
  log(`[durable:guard] blocked ${name} (${what}): ${why}`);
  return { block: `guard: ${why}` };
}

/**
 * The Durable extension. Install after CodingTools so its `bash` (with `prepare`) wins.
 * @param {object} o
 * @param {(conversationId: unknown) => string|undefined} o.cwdOf the workspace of a
 *   conversation. The caller owns this mapping: a child conversation (a subagent, Task 7)
 *   must map to its parent's cwd, and an unknown conversation must return undefined (blocks).
 * @param {(conversationId: unknown) => boolean} [o.readonlyOf] true for a read-only agent
 *   (agent file `role: readonly`): write/edit and writing, removing or git-mutating bash are blocked.
 * @param {(conversationId: unknown) => string|undefined} [o.unitOf] systemd scope name of the next bash call.
 * @param {object} [o.baseEnv] where the shell's allowlisted variables come from (default process.env).
 */
export function createGuardExtension({ cwdOf, readonlyOf = () => false, unitOf, baseEnv = process.env, caps = DEFAULT_CAPS, wrapper = detectWrapper(), home = homedir(), tmp = TMP, log } = {}) {
  return defineExtension({
    name: "even-guard",
    hooks: [hook(ToolTask, { beforeTool: (call, api) => guardBeforeTool(call, { cwd: cwdOf(api.conversationId), readonly: Boolean(readonlyOf(api.conversationId)), home, tmp, log }) })],
    tools: [createBashTool({ prepare: (execution, api) => { guardPrepare(execution, { wrapper, caps, baseEnv, unit: unitOf?.(api?.conversationId) }); } })],
  });
}
