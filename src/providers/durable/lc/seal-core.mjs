// The `.pi` seal of a lets-code project, without pi, Durable or the bridge: the engine calls it
// (spawn, a timer while a child lives, after the parent's tool calls, the factory watch) and so does
// every pi of the project itself — even-guard.ts (`-e`) and the project-local guard both seal on each
// `tool_result`, so a plant made by one subagent (tar, git checkout, a computed path the bash text rule
// cannot see) is undone before that subagent returns, i.e. before the next pi of the chain starts and
// loads `.pi/extensions`. Imports only node builtins.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The project-local copy of the guard (pi loads `<cwd>/.pi/extensions/*` in every pi it starts there, subagents included). */
export const LC_PROJECT_GUARD = join(".pi", "extensions", "even-guard.ts");
const GUARD_CORE = fileURLToPath(new URL("./guard-core.mjs", import.meta.url));
const SEAL_CORE = fileURLToPath(import.meta.url);
/** A factory run's worktree (`…/lets-code-factory/<id>/work`), the other dir a project's pi may run in. */
const FACTORY_WORK_RE = /[\\/]lets-code-factory[\\/][^\\/]+[\\/]work$/;

/**
 * The guard source for `<cwd>/.pi/extensions/even-guard.ts`: lets-code starts its subagents as
 * plain `pi --mode rpc` processes in the same cwd, without the parent's `-e` flags, so only a
 * project-local extension reaches them (live probe 2026-11-03: a subagent's bash read under
 * ~/.ssh ran unguarded before this). It imports guard-core.mjs and this module from this checkout
 * by absolute URL; it checks each tool call and seals `.pi` after each tool result.
 */
export function projectGuardSource(guardCore = GUARD_CORE, sealCore = SEAL_CORE) {
  return [
    "// Written by even-bridge (durable lets-code engine); edits are overwritten.",
    "// The even guard for this project's pi processes, subagents included (see guard-core.mjs).",
    `import { guardDecision } from ${JSON.stringify(pathToFileURL(guardCore).href)};`,
    `import { sealAfterTool } from ${JSON.stringify(pathToFileURL(sealCore).href)};`,
    "",
    "export default function (pi: any) {",
    '  pi.on("tool_call", async (event: any) => {',
    '    const decision = guardDecision(String(event?.toolName ?? ""), event?.input ?? {}, { cwd: process.env.EVEN_GUARD_CWD || process.cwd() });',
    "    return decision ?? undefined;",
    "  });",
    '  pi.on("tool_result", async (event: any) => sealAfterTool(event));',
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
 * plain dir, is moved to `quarantine` (removed when that fails). Never follows symlinks. Throws when the
 * dir cannot be sealed (a plant that can be neither moved nor removed, an unwritable guard).
 * @returns {{ restored: boolean, removed: string[] }} restored: an existing guard file was replaced
 */
export function sealProjectPi(dir, { quarantine, source = projectGuardSource(), now = Date.now } = {}) {
  const removed = [];
  let n = 0;
  const away = (p, name) => {
    try {
      if (!quarantine) throw new Error("no quarantine dir");
      mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      renameSync(p, join(quarantine, `${now()}-${process.pid}-${++n}-${name.replace(/[/\\]/g, "_")}`));
    } catch {
      rmSync(p, { recursive: true, force: true });
    }
    if (lstatOrNull(p)) throw new Error(`${name} could not be removed`);
    removed.push(name);
  };
  const pi = join(dir, ".pi");
  let st = lstatOrNull(pi);
  if (st && !st.isDirectory()) away(pi, ".pi");
  if (lstatOrNull(pi)?.isDirectory()) for (const e of readdirSync(pi)) if (e !== "extensions") away(join(pi, e), `.pi/${e}`);
  const ext = join(pi, "extensions");
  st = lstatOrNull(ext);
  if (st && !st.isDirectory()) away(ext, ".pi/extensions");
  if (lstatOrNull(ext)?.isDirectory()) {
    for (const e of readdirSync(ext)) if (e !== "even-guard.ts") away(join(ext, e), `.pi/extensions/${e}`);
  }
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

/**
 * The dirs a pi of this project seals after a tool: the session's project (EVEN_GUARD_CWD) and its own
 * cwd when that is the project or a factory run's worktree (never an unrelated dir).
 */
export function sealDirs({ env = process.env, cwd = process.cwd() } = {}) {
  const project = env.EVEN_GUARD_CWD ? resolve(env.EVEN_GUARD_CWD) : null;
  const here = resolve(cwd);
  const out = [];
  if (project) out.push(project);
  if (here !== project && FACTORY_WORK_RE.test(here)) out.push(here);
  return out;
}

/**
 * pi `tool_result` handler of both guards: seal the project's `.pi` dirs; when something was undone, say
 * so in the tool result (the model sees it). Never throws.
 */
export function sealAfterTool(event, { env = process.env, cwd = process.cwd(), now } = {}) {
  const notes = [];
  for (const d of sealDirs({ env, cwd })) {
    try {
      const r = sealProjectPi(d, { quarantine: env.EVEN_GUARD_QUARANTINE || undefined, ...(now ? { now } : {}) });
      if (r.restored) notes.push(`restored the guard in ${d}/.pi`);
      for (const name of r.removed) notes.push(`removed ${name} from ${d}`);
    } catch (err) {
      notes.push(`could not seal ${d}/.pi (${err?.message ?? err})`);
    }
  }
  if (!notes.length) return undefined;
  const text = `even-guard: ${notes.join("; ")}. Only the bridge's guard may be in a .pi dir.`;
  return { content: [...(Array.isArray(event?.content) ? event.content : []), { type: "text", text }] };
}
