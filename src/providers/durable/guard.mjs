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
// Known MVP limits (this is a lexer/regex guard, not a sandbox; real isolation
// is bwrap, which borealis does not have installed):
// - Code given to an interpreter is not inspected: `python3 -c`, `node -e`,
//   `perl -e`, `python3 <<EOF`, or writing a script and then running
//   `bash file.sh`. Only the denied home dirs are caught there, by name.
// - RULES also run on the raw text, so `echo "git reset --hard" x` is
//   blocked too. That over-blocking is intended.
// - Child conversations (subagents) must map to their parent's cwd; `cwdOf`
//   is the caller's responsibility.

import { lstatSync, readlinkSync, accessSync, constants as FS } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";

const TMP = "/tmp";
const DENIED_IN_HOME = [".ssh", ".aws", ".config", ".even-terminal", ".pi", ".gnupg"];
const DENIED_ABS = ["/etc/ssh", "/etc/ssl/private", "/etc/netplan", "/etc/wpa_supplicant", "/etc/NetworkManager"];
const DENIED_PREFIX = ["/etc/shadow", "/etc/gshadow", "/etc/sudoers"];
const READ_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/snap", "/etc"];
const PROC_SELF = "/proc/self";
// The shell sees only these variables from the bridge's environment (never tokens or keys).
const ENV_ALLOW = /^(?:PATH|HOME|LANG|LC_\w+|TERM|USER|LOGNAME|SHELL|TMPDIR|NVM_DIR|NODE_\w+|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/;
const ENV_SECRET = /(?:TOKEN|_KEY|SECRET|PASSWORD|PASSWD)$|^(?:LETS_CODE_TOKEN|BRIDGE_TOKEN)$/i;
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
  { re: /(?<![\w.-])(?:docker|podman|nerdctl)(?![\w./-])(?!\s+(?:ps|images|logs|inspect|version|info)(?=\s|$|[;&|)]))/, why: "container tools are refused (docker group membership is root-equivalent)" },
  { re: /(?<![\w.-])(?:nsenter|unshare|chroot)(?![\w./-])/, why: "namespace and chroot tools are refused" },
  { re: /(?<![\w.-])(?:pkill|killall|loginctl|crontab|systemd-run)(?![\w./-])/, why: "process, session and scheduler control is refused" },
  { re: r(`(?<![\\w.-])kill\\b${A}\\s(?:--\\s+)?-1${E}`), why: "kill -1 signals every process" },
  { re: r(`(?<![\\w.-])kill\\b${A}(?:\\$\\(|\`)`), why: "kill with a computed target cannot be checked" },
  { re: r(`(?<![\\w.-])(?:ba|z|da|k|fi)?sh(?![\\w./-])${A}<<<`), why: "a here-string fed to a shell cannot be checked; use bash -c '...'" },
  { re: r(`${G}config\\b${A}\\s--(?:global|system)${E}`), why: "git config --global/--system is refused" },
  { re: /\bgit\b[^;&|\n]*\s(?:-c\s*|--config-env[= ])["']?(?:core\.(?:sshcommand|pager|editor|hookspath|fsmonitor|gitproxy|askpass)|credential\.|alias\.|protocol\.|uploadpack\.|diff\.\S*\.textconv|filter\.)/i, why: "git -c that runs commands (core.sshCommand, pager, hooksPath, credential.helper, ...) is refused" },
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
  if (mode === "read" && (READ_SYSTEM.some((root) => within(real, resolveReal(root) ?? root)) || within(lexical, PROC_SELF))) return { ok: true, real };
  const where = mode === "read" ? "the workspace, /tmp and the system dirs" : `the workspace (${tilde(realCwd, home)} and ${tmp})`;
  return { ok: false, why: `'${p}' is outside ${where}${mode === "write" ? " for writing" : ""}`, real };
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
  let seg = { argv: [], writes: [], reads: [] };
  let tok = null;
  let redir = null;
  const endTok = () => {
    if (tok === null) return;
    if (redir === "write") seg.writes.push(tok);
    else if (redir === "read") seg.reads.push(tok);
    else if (redir !== "skip") seg.argv.push(tok);
    tok = null;
    redir = null;
  };
  const endSeg = () => {
    endTok();
    if (seg.argv.length || seg.writes.length || seg.reads.length) out.push(seg);
    seg = { argv: [], writes: [], reads: [] };
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
        if (src[k] === "$" && src[k + 1] === "(") { k = substitution(k + 1) + 1; s += "$()"; continue; }
        if (src[k] === "`") { k = backtick(k) + 1; s += "$()"; continue; }
        s += src[k++];
      }
      tok = (tok ?? "") + s; i = k; continue;
    }
    if (c === " " || c === "\t") { endTok(); continue; }
    if (c === "$" && src[i + 1] === "(") { i = substitution(i + 1); tok = (tok ?? "") + "$()"; continue; }
    if (c === "`") { i = backtick(i); tok = (tok ?? "") + "$()"; continue; }
    if ((c === "<" || c === ">") && src[i + 1] === "(") { endTok(); i = substitution(i + 1); tok = "$()"; continue; }
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
function unwrapArgv(argv) {
  let a = argv;
  for (let guard = 0; guard < 10 && a.length; guard++) {
    const n = basename(a[0]);
    if (/^(?:then|do|else|elif|if|while|until|!|\{|\}|time|nohup|command|builtin|exec|stdbuf|nice|ionice)$/.test(n)) {
      a = a.slice(1);
      while (a.length && /^-/.test(a[0]) && !/^-c$/.test(a[0])) a = a.slice(/^-n$/.test(a[0]) ? 2 : 1);
      continue;
    }
    if (n === "env") { a = a.slice(1); while (a.length && (/^-/.test(a[0]) || /^\w+=/.test(a[0]))) a = a.slice(1); continue; }
    if (n === "timeout") { a = a.slice(1); while (a.length && /^-/.test(a[0])) a = a.slice(1); a = a.slice(1); continue; }
    if (n === "xargs") {
      a = a.slice(1);
      while (a.length && /^-/.test(a[0])) a = a.slice(/^-[IndPLsE]$/.test(a[0]) ? 2 : 1);
      continue;
    }
    break;
  }
  return a;
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
export function judgeCommand(cmd, cwd, home = homedir(), { tmp = TMP } = {}) {
  if (typeof cmd !== "string") return { block: "no command" };
  const why = judge(cmd, cwd, home, tmp, 0);
  return why ? { block: why } : {};
}

function judge(cmd, cwd0, home, tmp, depth) {
  if (depth > MAX_DEPTH) return "commands nested too deeply to check";
  const { text, shellBodies } = stripHeredocs(cmd);
  for (const rule of RULES) if (rule.re.test(text)) return rule.why;
  for (const body of shellBodies) { const v = judge(body, cwd0, home, tmp, depth + 1); if (v) return v; }
  // A denied dir named anywhere, also inside quoted interpreter code (`python -c "open('~/.ssh/..')"`).
  for (const d of DENIED_IN_HOME) {
    const tail = d.replace(/\./g, "\\.") + "(?![\\w.-])";
    const homes = [home, "~", "$HOME", "${HOME}"].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (new RegExp(`(?:${homes.join("|")})/+${tail}`).test(text)) return `~/${d} is off limits`;
  }

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

  const checkToken = (raw) => {
    const t = expand(raw);
    if (DEVICES.test(t) || !pathLike(t) || unresolved(t)) return undefined;
    if (cwd === UNKNOWN && !isAbsolute(t) && !t.startsWith("~")) return `cannot tell what '${raw}' refers to after an unresolved cd`;
    const res = confine(t, cwd ?? cwd0, "read");
    return res.ok ? undefined : res.why;
  };
  const checkWrite = (raw) => {
    const t = expand(raw);
    if (DEVICES.test(t)) return undefined;
    if (unresolved(t)) return `cannot tell what '${raw}' refers to ($VAR or $(..)); use a literal path`;
    if (cwd === UNKNOWN) return `cannot tell where '${raw}' is after an unresolved cd`;
    if (SECRET_NAME.test(basename(t))) return `writing '${basename(t)}' (env files and keys) is refused`;
    const res = confine(t, cwd);
    if (!res.ok) return res.why;
    if (/(?:^|\/)\.git(?:\/|$)/.test(res.real)) return "writing inside .git is refused; use git commands instead";
    return undefined;
  };
  const checkRemoval = (name, raw, recursive) => {
    const t = expand(raw);
    if (unresolved(t)) return recursive ? `cannot tell what '${raw}' refers to ($VAR, $(..) or {}); use a literal path` : undefined;
    if (cwd === UNKNOWN) return `cannot tell where '${raw}' is after an unresolved cd`;
    const glob = hasGlob(basename(t));
    const res = confine(glob ? dirname(t) || "." : t, cwd);
    if (!res.ok) return `${name} ${raw}: ${res.why}`;
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

    let argv = unwrapArgv(seg.argv);
    if (/^(?:export|declare|local|typeset|readonly)$/.test(argv[0] ?? "")) argv = argv.slice(1).filter((a) => !a.startsWith("-"));
    // Assignments: remember `D=x` on its own, check the value either way.
    let k = 0;
    for (; k < argv.length; k++) {
      const m = /^(\w+)=(.*)$/s.exec(argv[k]);
      if (!m) break;
      const v = checkToken(m[2]); if (v) return v;
      if (argv.length === 1 || argv.every((a) => /^\w+=/.test(a))) vars[m[1]] = expand(m[2]);
    }
    argv = unwrapArgv(argv.slice(k));
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
    }

    for (const t of argv) {
      const v = checkToken(t) ?? (/^-{0,2}[\w-]+=(.+)$/.test(t) ? checkToken(t.slice(t.indexOf("=") + 1)) : undefined);
      if (v) return v;
    }

    if (name === "cd" || name === "pushd") {
      const args = argv.slice(1).filter((a) => !/^-[LPe@]+$/.test(a) && a !== "--");
      if (!args.length) return "cd to ~ leaves the workspace";
      const d = expand(args[0]);
      if (args[0] === "-" || unresolved(d) || hasGlob(d)) { cwd = UNKNOWN; continue; }
      if (cwd === UNKNOWN && !isAbsolute(d) && !d.startsWith("~")) continue;
      const res = confine(d, cwd ?? cwd0, "read");
      if (!res.ok) return `cd ${args[0]}: ${res.why}`;
      cwd = res.real;
      continue;
    }
    if (name === "popd") { cwd = UNKNOWN; continue; }

    if (SHELLS.test(name) || name === "eval") {
      const ci = argv.indexOf("-c");
      const script = name === "eval" ? argv.slice(1).join(" ") : ci > 0 ? argv[ci + 1] : undefined;
      if (script !== undefined) {
        if (cwd === UNKNOWN) return "cannot tell where a nested script runs after an unresolved cd";
        const v = judge(script, cwd, home, tmp, depth + 1); if (v) return v;
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
        if (ci > 0 && sub[ci + 1] !== undefined) { const v = judge(sub[ci + 1], cwd ?? cwd0, home, tmp, depth + 1); if (v) return v; }
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
    let targets = [];
    if (/^(?:cp|mv|ln|install|rsync)$/.test(name)) targets = pos.slice(-1);
    else if (/^(?:tee|touch|truncate|mkdir)$/.test(name)) targets = pos;
    else if (name === "dd") targets = pos.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
    else if ((name === "sed" || name === "perl") && flags.some((f) => /^-[A-Za-z]*i/.test(f) || f.startsWith("--in-place"))) targets = pos.slice(name === "sed" ? 1 : 0);
    for (const t of targets) { const v = checkWrite(t); if (v) return v; }
    if (name === "mv") for (const s of pos.slice(0, -1)) { const v = checkRemoval("mv", s, false); if (v) return v; }
    if (name === "rsync" && flags.some((f) => f.startsWith("--delete")) && pos.length) { const v = checkRemoval("rsync --delete", pos[pos.length - 1], true); if (v) return v; }
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
export function guardPrepare(execution, { wrapper = "none", caps = DEFAULT_CAPS, baseEnv = process.env } = {}) {
  const cmd = execution.command;
  execution.env = shellEnv(execution.env, baseEnv);
  execution.inheritEnv = false;
  if (wrapper === "systemd-run") {
    const { memoryMax, cpuQuota } = { ...DEFAULT_CAPS, ...caps };
    execution.command = `systemd-run --user --scope -q -p MemoryMax=${memoryMax} -p CPUQuota=${cpuQuota} -- bash -lc ${SHQ(cmd)}`;
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
export function guardBeforeTool(call, { cwd, home = homedir(), tmp = TMP, log = (l) => console.warn(l) } = {}) {
  const name = call?.name;
  if (name !== "bash" && !PATH_TOOLS.has(name)) return undefined;
  const args = call.arguments ?? {};
  let why;
  if (!cwd) why = "no workspace is known for this conversation";
  else if (name === "bash") why = judgeCommand(args.command, cwd, home, { tmp }).block;
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
 */
export function createGuardExtension({ cwdOf, caps = DEFAULT_CAPS, wrapper = detectWrapper(), home = homedir(), tmp = TMP, log } = {}) {
  return defineExtension({
    name: "even-guard",
    hooks: [hook(ToolTask, { beforeTool: (call, api) => guardBeforeTool(call, { cwd: cwdOf(api.conversationId), home, tmp, log }) })],
    tools: [createBashTool({ prepare: (execution) => { guardPrepare(execution, { wrapper, caps }); } })],
  });
}
