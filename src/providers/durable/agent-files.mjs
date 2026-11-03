// lets-code agent files (`~/.pi/agent/agents/*.md`): Markdown with a `---`
// frontmatter block of `key: value` lines, the body being the agent's
// instructions. The parse rules are ported from lets-code's `parseAgentFile`
// (`~/github/lets-code/lets-code`, the subagent extension):
//   - frontmatter = the block between a leading `---` line and the next `---`;
//   - one `key: value` per line, key `[A-Za-z_][\w-]*`, value trimmed and one
//     pair of surrounding quotes stripped; indented / list lines are ignored
//     (lets-code's own multi-line keys such as `brief:` end up as "");
//   - `name` defaults to the file name without `.md` and must match
//     `[A-Za-z0-9][\w.-]*`, otherwise the file is skipped;
//   - `tools` (and `disallowed`) are comma lists, optionally in `[...]`.
// Differences:
//   - a file WITHOUT frontmatter is ignored (lets-code would load it under its
//     file name); every real agent file has one;
//   - `append_prompt: <path>` (lets-code's generated agents keep their prompt
//     there, with an empty body) is read relative to the agent home (the
//     parent of the agents dir, `~/.pi/agent`), realpath'd and refused when it
//     leaves that dir; its text follows the body in `prompt`;
//   - an agent with neither a body nor a readable `append_prompt` is left out
//     with a warning (it would otherwise run with the parent's instructions);
//   - `timeout` is seconds, optionally with an `s`/`m`/`h` suffix; anything
//     else is ignored with a warning.
// The first file (in name order) wins a duplicate agent name; unreadable files
// are skipped. Files are read ONCE, when the provider starts: edits to agent
// files take effect at the next bridge start.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { expandHome } from "./models.mjs";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY_VALUE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
const NAME = /^[A-Za-z0-9][\w.-]*$/;
const KNOWN = new Set(["name", "description", "tools", "disallowed", "disallowedTools", "disallowed_tools", "thinking", "timeout", "role"]);
const UNIT = { s: 1, m: 60, h: 3600 };

const list = (v) =>
  v
    ? v
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

/** Seconds from `900`, `45s`, `30m` or `2h`; `NaN` for anything else, `undefined` when unset. */
export function parseTimeout(v) {
  if (v == null || v === "") return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(String(v).trim());
  if (!m) return NaN;
  const n = Number(m[1]) * UNIT[(m[2] || "s").toLowerCase()];
  return n > 0 ? n : NaN;
}

/**
 * Parse one agent file. `null` when it has no frontmatter or an invalid name.
 * `prompt` is the body here; loadAgentFiles appends `append_prompt`'s text.
 * @param {string} text
 * @param {string} file path (its base name is the default agent name)
 * @param {{ log?: { warn?: Function } }} [o]
 * @returns {{name: string, description: string, tools?: string[], disallowed?: string[], thinking?: string, timeout?: number, role?: string, body: string, prompt: string, extra: Record<string,string>, file: string} | null}
 */
export function parseAgentFile(text, file, { log } = {}) {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = KEY_VALUE.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  const name = (fm.name || file.replace(/^.*\//, "").replace(/\.md$/, "")).trim();
  if (!NAME.test(name)) return null;
  const extra = {};
  for (const [k, v] of Object.entries(fm)) if (!KNOWN.has(k)) extra[k] = v;
  const body = m[2].trim();
  const def = { name, description: fm.description ?? "", body, prompt: body, extra, file };
  const tools = list(fm.tools);
  if (tools) def.tools = tools;
  const disallowed = list(fm.disallowed ?? fm.disallowedTools ?? fm.disallowed_tools);
  if (disallowed) def.disallowed = disallowed;
  if (fm.thinking) def.thinking = fm.thinking;
  const timeout = parseTimeout(fm.timeout);
  if (Number.isNaN(timeout)) log?.warn?.(`[durable] agent ${name}: timeout ${JSON.stringify(fm.timeout)} is not seconds (N, Ns, Nm, Nh); using the default`);
  else if (timeout !== undefined) def.timeout = timeout;
  if (fm.role) def.role = fm.role;
  return def;
}

/** The text of `rel` below `home`, or undefined (missing, unreadable, or outside `home` after realpath). */
function readInside(home, rel, log, name) {
  try {
    const realHome = realpathSync(home);
    const real = realpathSync(resolve(realHome, rel));
    if (!real.startsWith(realHome + sep)) {
      log?.warn?.(`[durable] agent ${name}: append_prompt ${rel} leaves ${realHome}; ignored`);
      return undefined;
    }
    return readFileSync(real, "utf8").trim();
  } catch (err) {
    log?.warn?.(`[durable] agent ${name}: append_prompt ${rel} unreadable (${err.code ?? err.message}); ignored`);
    return undefined;
  }
}

/**
 * Every usable agent file of `dir` (`~` expanded). A missing directory gives an empty map.
 * @param {string} [dir]
 * @param {{ log?: object, home?: string }} [o] `home`: where `append_prompt` paths resolve (default: the parent of `dir`)
 * @returns {Map<string, ReturnType<typeof parseAgentFile>>}
 */
export function loadAgentFiles(dir = "~/.pi/agent/agents", { log, home } = {}) {
  const out = new Map();
  const root = expandHome(dir);
  const promptHome = home ? expandHome(home) : dirname(resolve(root));
  if (!existsSync(root)) return out;
  let files;
  try {
    files = readdirSync(root).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    log?.warn?.(`[durable] agent files in ${root}: ${err.message}`);
    return out;
  }
  for (const f of files) {
    let def;
    try {
      def = parseAgentFile(readFileSync(join(root, f), "utf8"), join(root, f), { log });
    } catch {
      continue; // unreadable file: skipped, as lets-code does
    }
    if (!def || out.has(def.name)) continue;
    const rel = def.extra.append_prompt;
    if (rel) {
      const appended = readInside(promptHome, rel, log, def.name);
      if (appended) def.prompt = [def.body, appended].filter(Boolean).join("\n\n");
    }
    if (!def.prompt) {
      log?.warn?.(`[durable] agent ${def.name}: no instructions (empty body, no readable append_prompt); not offered`);
      continue;
    }
    out.set(def.name, def);
  }
  return out;
}
