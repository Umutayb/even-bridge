// The even guard of lets-code sessions, without pi or Durable: even-guard.ts
// (a pi extension loaded into every lets-code child with `-e`) calls
// guardDecision on each `tool_call` and blocks what it returns.
//
// It is the floor under lets-code's own mandate, not a workspace jail:
// - the denied dirs and secret system files (~/.ssh ~/.aws ~/.config
//   ~/.even-terminal ~/.pi ~/.gnupg, /etc/shadow, /etc/systemd, /run/user, ...)
//   for read/write/edit and in any bash command text, and guard.mjs's RULES
//   (force pushes, hard resets, scripts piped into a shell, sudo, ...);
// - everything else, writes outside the project included, is left to the
//   mandate (mode `ask` asks before leaving the project), so a glasses user is
//   asked instead of being refused.
// One exception inside ~/.pi (plan ruling 19): the worktree of a factory run,
// `<factoryRoot>/<id>/work`, counts as the project when that run's ledger repo
// is the session cwd or below it.
//
// Loaded inside the child: imports only node builtins and guard.mjs (which has
// no Durable import).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { confinePath, judgeHard } from "../guard.mjs";

export const GUARD_PREFIX = "even-guard: ";
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const HARD_WHY = /off limits|too many symlinks|cannot tell where/;

const within = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const expand = (p, home) => (p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p.replace(/^\$\{?HOME\}?(?=\/|$)/, home));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function defaultReadLedger(factoryRoot, id) {
  try {
    const L = JSON.parse(readFileSync(join(factoryRoot, id, "ledger.json"), "utf8"));
    return L && L.v === 1 ? L : null;
  } catch {
    return null;
  }
}

/** realpath of the deepest existing ancestor of `abs`, with the missing tail appended. */
function realish(abs) {
  let base = abs;
  const tail = [];
  while (!existsSync(base)) {
    const up = dirname(base);
    if (up === base) break;
    tail.unshift(basename(base));
    base = up;
  }
  try {
    return join(realpathSync(base), ...tail);
  } catch {
    return abs;
  }
}

/** Is `abs` inside the worktree of a factory run of `cwd` (also after resolving symlinks)? */
function inOwnWorktree(abs, { cwd, factoryRoot, readLedger }) {
  if (!within(abs, factoryRoot)) return false;
  const [id, work] = relative(factoryRoot, abs).split(sep);
  if (!id || work !== "work") return false;
  const L = readLedger(factoryRoot, id);
  if (!(L && typeof L.repo === "string" && cwd && within(resolve(L.repo), resolve(cwd)))) return false;
  const worktree = join(factoryRoot, id, "work");
  return within(realish(abs), realish(worktree)); // a symlink out of the worktree is judged normally
}

/**
 * The guard's decision for one pi tool call.
 * @param {string} toolName pi tool name (bash, read, write, edit, ...)
 * @param {object} input the call's arguments (`command` for bash, `path` for the file tools)
 * @param {{ cwd?: string, home?: string, factoryRoot?: string, readLedger?: (root: string, id: string) => object|null }} o
 * @returns {{ block: true, reason: string } | undefined}
 */
export function guardDecision(toolName, input, { cwd = process.cwd(), home = homedir(), factoryRoot, readLedger = defaultReadLedger } = {}) {
  const root = resolve(factoryRoot ?? join(home, ".pi", "agent", "lets-code-factory"));
  const ctx = { cwd, factoryRoot: root, readLedger };
  const args = input ?? {};
  let why;
  if (toolName === "bash") {
    let cmd = String(args.command ?? "");
    // An own factory worktree, named absolutely or under ~ / $HOME, is judged as the project itself.
    const tail = within(root, home) ? root.slice(home.length) : null;
    const prefixes = [root, ...(tail !== null ? ["~" + tail, "$HOME" + tail, "${HOME}" + tail] : [])];
    const re = new RegExp(`(?:${prefixes.map(escapeRe).join("|")})/([^/\\s'"\`;|&()<>]+)/work(?=/|$|[\\s'"\`;|&()<>])`, "g");
    cmd = cmd.replace(re, (m, id) => (inOwnWorktree(join(root, id, "work"), ctx) ? cwd : m));
    why = judgeHard(cmd, home).block;
  } else if (PATH_TOOLS.has(toolName) && args.path != null && args.path !== "") {
    const p = String(args.path);
    const abs = resolve(cwd, expand(p, home));
    if (inOwnWorktree(abs, ctx)) return undefined;
    const res = confinePath(p, cwd, home, { mode: toolName === "write" || toolName === "edit" ? "write" : "read" });
    if (!res.ok && HARD_WHY.test(res.why ?? "")) why = res.why;
  }
  return why ? { block: true, reason: GUARD_PREFIX + why } : undefined;
}
