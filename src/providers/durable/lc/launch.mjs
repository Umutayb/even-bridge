// How a lets-code session child is launched, and the host chores around it.
//
// One child per busy lets-code session: `lets-code --mode rpc` (PiRpcClient adds
// `--mode rpc`, `--session`, `--name`) with the glasses flags from the Task 1
// spike (`--mandate ask --subagents --sandbox --session-dir <dir> -e even-guard.ts`),
// inside a transient scope `even-lc-<sid>` (systemd-run --user --scope; both it
// and lets-code exec, so the spawned pid ends up being pi itself).
//
// The child env is an allowlist (guard.mjs `shellEnv`: PATH, HOME, LANG, ...,
// never a *_TOKEN/*_KEY): lets-code reads its endpoint and token from
// ~/.config/lets-code/config and exports LETS_CODE_TOKEN to pi itself, so the
// bridge's LETS_CODE_TOKEN is not needed. LETS_CODE_MEM_WATCH/MEM_GUARD=false
// keep pi inside our scope: without them lets-code re-execs pi into its own
// `lets-code-<pid>.scope` (spike Finding 2), and the scope stop, the cgroup
// check of findExternalPi and the memory cap would all miss it.

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { runSync, shellEnv } from "../guard.mjs";
import { launcherModel } from "../../pi/provider.mjs";

export const LC_SCOPE_PREFIX = "even-lc-";
export const LC_DEFAULT_BIN = "lets-code";
export const FACTORY_ROOT = "~/.pi/agent/lets-code-factory";
export const LC_REGISTRY_ROOT = "~/.pi/agent/lets-code-sessions";
export const LC_RUNS_ROOT = "~/.pi/agent/lets-code-runs";
export const LC_CGROUP_CONTROLLERS = "/sys/fs/cgroup/cgroup.controllers";

export const expandHome = (p, home = homedir()) => (p === "~" ? home : String(p).startsWith("~/") ? home + String(p).slice(1) : p);

/** The scope unit name of a session's child (without `.scope`). */
export function lcScopeUnit(sid) {
  return `${LC_SCOPE_PREFIX}${String(sid ?? "unknown").replace(/[^A-Za-z0-9:_.-]/g, "_")}`;
}

/**
 * The child env: the allowlisted variables of `baseEnv` plus what lets-code needs to
 * stay in our scope; no tokens or keys, no LETS_CODE_EXPERTS_ON (lets-code ignores it).
 * `extra`: more own variables (tests: FAKE_PI_*); secret-looking names are dropped too.
 */
export function lcEnv(baseEnv = process.env, { cwd, extra = {} } = {}) {
  const env = shellEnv(
    {
      PI_TELEMETRY: "0",
      LETS_CODE_MEM_WATCH: "false",
      LETS_CODE_MEM_GUARD: "false",
      LETS_CODE_SUBAGENT_CONCURRENCY: "1",
      ...(cwd ? { EVEN_GUARD_CWD: cwd } : {}),
      ...extra,
    },
    baseEnv,
  );
  delete env.LETS_CODE_EXPERTS_ON;
  return env;
}

/**
 * The launch of one glasses agent session.
 * @returns {{ bin: string, wrap: string[], extraArgs: string[], env: object }}
 *   `wrap` goes before the bin (PiRpcClient `opts.wrap`); `--session`/`--name` are
 *   PiRpcClient's own `resume`/`name` options, not part of `extraArgs`.
 */
export function lcLaunch({ sid, cwd, sessionDir, model, bin = LC_DEFAULT_BIN, guardExt, caps = { memoryMax: null, cpuQuota: "200%" }, wrapper = "none", sandbox = true, baseEnv = process.env, extraEnv } = {}) {
  const wrap = [];
  if (wrapper === "systemd-run") {
    wrap.push("systemd-run", "--user", "--scope", "-q", `--unit=${lcScopeUnit(sid)}`);
    if (caps?.memoryMax) wrap.push("-p", `MemoryMax=${caps.memoryMax}`);
    if (caps?.cpuQuota) wrap.push("-p", `CPUQuota=${caps.cpuQuota}`);
    wrap.push("--");
  }
  const extraArgs = ["--mandate", "ask", "--subagents", sandbox ? "--sandbox" : "--no-sandbox", "--session-dir", sessionDir];
  if (guardExt) extraArgs.push("-e", guardExt);
  if (model) extraArgs.push("--model", launcherModel(bin, model));
  return { bin, wrap, extraArgs, env: lcEnv(baseEnv, { cwd, extra: extraEnv }) };
}

/** Does this kernel give scopes a memory controller (`MemoryMax` is enforced)? Read once at start. */
export function lcMemoryControllerAvailable({ readFile = (p) => readFileSync(p, "utf8"), path = LC_CGROUP_CONTROLLERS } = {}) {
  try {
    return String(readFile(path)).split(/\s+/).includes("memory");
  } catch {
    return false;
  }
}

/** Stop the scopes of exactly these sessions (never a glob: a throwaway instance must not kill the live bridge's children). */
export function stopLcScopes(sids, { env = process.env, run = runSync } = {}) {
  const units = [...new Set((sids ?? []).filter(Boolean))].map((sid) => `${lcScopeUnit(sid)}.scope`);
  if (!units.length) return true;
  const { status } = run(["systemctl", "--user", "stop", ...units], { env });
  return status === 0;
}

function onPath(bin, env) {
  for (const dir of String(env.PATH ?? "").split(":").filter(Boolean)) if (existsSync(join(dir, bin))) return true;
  return false;
}

/** lets-code's `--sandbox` needs bubblewrap and socat on PATH. */
export function lcSandboxAvailable({ env = process.env, which = (b) => onPath(b, env) } = {}) {
  return Boolean(which("bwrap") && which("socat"));
}

const within = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** A factory run's ledger (`<root>/<id>/ledger.json`, v 1), or null. */
export function readLedger(id, root = FACTORY_ROOT) {
  try {
    const L = JSON.parse(readFileSync(join(expandHome(root), id, "ledger.json"), "utf8"));
    return L && L.v === 1 ? L : null;
  } catch {
    return null;
  }
}

/** The newest factory run (by `updated`) whose repo is `cwd` or below it and whose status is running|waiting; else null. */
export function findFactoryRun(cwd, root = FACTORY_ROOT) {
  if (!cwd) return null;
  const dir = expandHome(root);
  let ids;
  try {
    ids = readdirSync(dir);
  } catch {
    return null;
  }
  const want = resolve(cwd);
  let best = null;
  for (const id of ids) {
    const L = readLedger(id, dir);
    if (!L || typeof L.repo !== "string") continue;
    if (L.status !== "running" && L.status !== "waiting") continue;
    if (!within(resolve(L.repo), want)) continue;
    if (!best || (L.updated ?? 0) > (best.updated ?? 0)) best = { id: L.id ?? id, updated: L.updated };
  }
  return best?.id ?? null;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

/** Delete lets-code's sessions registry file of `pid` when that pid is gone (left by a SIGKILL). @returns whether it was removed */
export function removeStaleRegistry(pid, { root = LC_REGISTRY_ROOT, alive = pidAlive } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (alive(pid)) return false;
  const f = join(expandHome(root), `${pid}.json`);
  try {
    unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}
