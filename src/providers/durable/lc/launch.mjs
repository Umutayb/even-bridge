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

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSync, shellEnv } from "../guard.mjs";
import { launcherModel } from "../../pi/provider.mjs";

export const LC_SCOPE_PREFIX = "even-lc-";
export const LC_DEFAULT_BIN = "lets-code";
export const FACTORY_ROOT = "~/.pi/agent/lets-code-factory";
export const LC_REGISTRY_ROOT = "~/.pi/agent/lets-code-sessions";
export const LC_RUNS_ROOT = "~/.pi/agent/lets-code-runs";
export const LC_CGROUP_CONTROLLERS = "/sys/fs/cgroup/cgroup.controllers";
/** lets-code's host-wide state (remembered experts among others). */
export const LC_STATE_FILE = "~/.pi/agent/lets-code-state.json";
/** The experts the factory needs (lets-code factory.ts `ensureExperts`). */
export const FACTORY_EXPERTS = Object.freeze(["developer", "expert-reviewer", "design-reviewer", "tester", "acceptance-judge"]);
/** pi's project trust store (`{ <canonical path>: true|false|null }`, lock dir `<file>.lock`; pi trust-manager.js). */
export const LC_TRUST_FILE = "~/.pi/agent/trust.json";
/** The project-local copy of the guard (pi loads `<cwd>/.pi/extensions/*` in every pi it starts there, subagents included). */
export const LC_PROJECT_GUARD = join(".pi", "extensions", "even-guard.ts");
const GUARD_CORE = fileURLToPath(new URL("./guard-core.mjs", import.meta.url));

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
    // --collect: a scope that failed (an OOM kill under MemoryMax) is unloaded at once, so the
    // next spawn of the same session can take the same unit name.
    wrap.push("systemd-run", "--user", "--scope", "-q", "--collect", `--unit=${lcScopeUnit(sid)}`);
    // With a memory cap the child is OOM-killed at the cap instead of being pushed into swap (zram).
    if (caps?.memoryMax) wrap.push("-p", `MemoryMax=${caps.memoryMax}`, "-p", "MemorySwapMax=0");
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

/** Forget a failed scope of `sid` (left by a kill before --collect existed, or by a crash of systemd-run itself). */
export function resetFailedScope(sid, { env = process.env, run = runSync } = {}) {
  const { status } = run(["systemctl", "--user", "reset-failed", `${lcScopeUnit(sid)}.scope`], { env });
  return status === 0;
}

/**
 * Are all of `names` enabled in lets-code's host-wide state? Experts are host-global
 * (plan ruling 4): only the operator enables them; the bridge only reads.
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function expertsEnabled({ stateFile = LC_STATE_FILE, names = FACTORY_EXPERTS, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  let experts = {};
  try {
    experts = JSON.parse(readFile(expandHome(stateFile)))?.experts ?? {};
  } catch {
    /* no state yet: nothing enabled */
  }
  const missing = names.filter((n) => experts[n] !== true);
  return { ok: missing.length === 0, missing };
}

/**
 * The guard source for `<cwd>/.pi/extensions/even-guard.ts`: lets-code starts its subagents as
 * plain `pi --mode rpc` processes in the same cwd, without the parent's `-e` flags, so only a
 * project-local extension reaches them (live probe 2026-11-03: a subagent's bash read under
 * ~/.ssh ran unguarded before this). It imports guard-core.mjs from this checkout by absolute URL.
 */
export function projectGuardSource(guardCore = GUARD_CORE) {
  return [
    "// Written by even-bridge (durable lets-code engine) at every spawn; edits are overwritten.",
    "// The even guard for this project's pi processes, subagents included (see guard-core.mjs).",
    `import { guardDecision } from ${JSON.stringify(pathToFileURL(guardCore).href)};`,
    "",
    "export default function (pi: any) {",
    '  pi.on("tool_call", async (event: any) => {',
    '    const decision = guardDecision(String(event?.toolName ?? ""), event?.input ?? {}, { cwd: process.env.EVEN_GUARD_CWD || process.cwd() });',
    "    return decision ?? undefined;",
    "  });",
    "}",
    "",
  ].join("\n");
}

/** (Re)write the project-local guard of `cwd` (atomically, 0644). @returns the file path */
export function installProjectGuard(cwd, { source = projectGuardSource() } = {}) {
  const file = join(cwd, LC_PROJECT_GUARD);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, source, { mode: 0o644 });
  renameSync(tmp, file);
  return file;
}

/**
 * Keep the project-local guard out of git: `/.pi/extensions/even-guard.ts` in the repo's shared
 * `info/exclude` (a worktree uses its main repo's), so `git add -A` (the factory's stages, an agent's
 * own commits) never picks it up. A folder that is no git repository is left alone. Never throws.
 * @returns {boolean} whether the line is (now) there
 */
export function excludeProjectGuard(dir, { git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }) } = {}) {
  try {
    const common = resolve(dir, String(git(["rev-parse", "--git-common-dir"], dir)).trim());
    const file = join(common, "info", "exclude");
    const line = "/" + LC_PROJECT_GUARD.split(sep).join("/");
    let have = "";
    try {
      have = readFileSync(file, "utf8");
    } catch {
      /* none yet */
    }
    if (have.split("\n").includes(line)) return true;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}# even-bridge: its project-local pi guard\n${line}\n`);
    return true;
  } catch {
    return false;
  }
}

const canonical = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * pi's lock on the trust store: the directory `<file>.lock` (proper-lockfile; stale after 10 s). Waits
 * asynchronously (never blocks the bridge's event loop), `tries` x `delayMs`.
 */
async function withTrustLock(file, fn, { tries = 100, delayMs = 20, staleMs = 10_000 } = {}) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        /* gone meanwhile */
      }
      if (i >= tries) throw new Error(`trust store ${file} is locked`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Set (`trusted: true`) or remove (`trusted: null`) pi project-trust entries for `paths`
 * (canonical paths, as pi stores them). The file keeps pi's format (sorted keys, 2-space JSON).
 * @returns {Promise<string[]>} the keys changed
 */
export async function updateTrust(paths, trusted, { file = LC_TRUST_FILE, tries, delayMs } = {}) {
  const f = expandHome(file);
  const keys = [...new Set(paths.filter(Boolean).map(canonical))];
  if (!keys.length) return [];
  return withTrustLock(f, () => {
    let data = {};
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`trust store ${f} unreadable: ${err.message}`);
    }
    const changed = [];
    for (const k of keys) {
      if (trusted === true && data[k] !== true) (data[k] = true), changed.push(k);
      if (trusted !== true && k in data) delete data[k], changed.push(k);
    }
    if (changed.length) {
      const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
      renameSync(tmp, f);
    }
    return changed;
  }, { ...(tries != null ? { tries } : {}), ...(delayMs != null ? { delayMs } : {}) });
}

const lstatOrNull = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * Keep `<dir>/.pi` to exactly the bridge's guard: `extensions/even-guard.ts` (a regular file with the
 * current source, rewritten when missing or changed) and nothing else. Every other entry of `.pi` and of
 * `.pi/extensions` (pi loads all of them in a trusted project), and a `.pi` or `extensions` that is not a
 * plain dir, is moved to `quarantine` (removed when that fails). Never follows symlinks.
 * @returns {{ restored: boolean, removed: string[] }} restored: an existing guard file was replaced
 */
export function sealProjectPi(dir, { quarantine, source = projectGuardSource(), now = Date.now } = {}) {
  const removed = [];
  let n = 0;
  const away = (p, name) => {
    try {
      if (!quarantine) throw new Error("no quarantine dir");
      mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      renameSync(p, join(quarantine, `${now()}-${++n}-${name.replace(/[/\\]/g, "_")}`));
    } catch {
      rmSync(p, { recursive: true, force: true });
    }
    removed.push(name);
  };
  const pi = join(dir, ".pi");
  let st = lstatOrNull(pi);
  if (st && !st.isDirectory()) away(pi, ".pi");
  if (lstatOrNull(pi)?.isDirectory()) for (const e of readdirSync(pi)) if (e !== "extensions") away(join(pi, e), `.pi/${e}`);
  const ext = join(pi, "extensions");
  st = lstatOrNull(ext);
  if (st && !st.isDirectory()) away(ext, ".pi/extensions");
  if (lstatOrNull(ext)?.isDirectory()) for (const e of readdirSync(ext)) if (e !== "even-guard.ts") away(join(ext, e), `.pi/extensions/${e}`);
  const g = join(ext, "even-guard.ts");
  st = lstatOrNull(g);
  let restored = false;
  if (st && !st.isFile()) away(g, ".pi/extensions/even-guard.ts");
  else if (st) {
    let cur = null;
    try {
      cur = readFileSync(g, "utf8");
    } catch {
      /* unreadable: rewrite */
    }
    if (cur === source) return { restored, removed };
    restored = true;
  }
  installProjectGuard(dir, { source });
  return { restored, removed };
}

/** Worktrees of this cwd's running/waiting factory runs (ledger `work`, existing): `[{ id, work }]`. */
export function factoryWorktrees(cwd, root = FACTORY_ROOT) {
  if (!cwd) return [];
  const dir = expandHome(root);
  let ids;
  try {
    ids = readdirSync(dir);
  } catch {
    return [];
  }
  const want = resolve(cwd);
  const out = [];
  for (const id of ids) {
    const L = readLedger(id, dir);
    if (!L || typeof L.repo !== "string" || (L.status !== "running" && L.status !== "waiting")) continue;
    if (!within(resolve(L.repo), want)) continue;
    // only the run's own `<root>/<id>/work` (the bridge writes a guard there and trusts it)
    const work = join(dir, id, "work");
    if (typeof L.work === "string" && L.work && resolve(L.work) !== work) continue;
    if (existsSync(work)) out.push({ id: L.id ?? id, work });
  }
  return out;
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
