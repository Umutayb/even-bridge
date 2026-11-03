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
// One deliberate difference: a file WITHOUT frontmatter is ignored here
// (lets-code would load it under its file name); every real agent file has one.
// The first file (in name order) wins a duplicate agent name; unreadable files
// are skipped.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./models.mjs";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY_VALUE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
const NAME = /^[A-Za-z0-9][\w.-]*$/;
const KNOWN = new Set(["name", "description", "tools", "disallowed", "disallowedTools", "disallowed_tools", "thinking", "timeout", "role"]);

const list = (v) =>
  v
    ? v
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

const seconds = (v) => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Parse one agent file. `null` when it has no frontmatter or an invalid name.
 * @param {string} text
 * @param {string} file path (its base name is the default agent name)
 * @returns {{name: string, description: string, tools?: string[], disallowed?: string[], thinking?: string, timeout?: number, role?: string, body: string, extra: Record<string,string>, file: string} | null}
 */
export function parseAgentFile(text, file) {
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
  const def = { name, description: fm.description ?? "", body: m[2].trim(), extra, file };
  const tools = list(fm.tools);
  if (tools) def.tools = tools;
  const disallowed = list(fm.disallowed ?? fm.disallowedTools ?? fm.disallowed_tools);
  if (disallowed) def.disallowed = disallowed;
  if (fm.thinking) def.thinking = fm.thinking;
  const timeout = seconds(fm.timeout);
  if (timeout !== undefined) def.timeout = timeout;
  if (fm.role) def.role = fm.role;
  return def;
}

/**
 * Every agent file of `dir` (`~` expanded). A missing directory gives an empty map.
 * @returns {Map<string, ReturnType<typeof parseAgentFile>>}
 */
export function loadAgentFiles(dir = "~/.pi/agent/agents", { log } = {}) {
  const out = new Map();
  const root = expandHome(dir);
  if (!existsSync(root)) return out;
  let files;
  try {
    files = readdirSync(root).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    log?.warn?.(`[durable] agent files in ${root}: ${err.message}`);
    return out;
  }
  for (const f of files) {
    try {
      const def = parseAgentFile(readFileSync(join(root, f), "utf8"), join(root, f));
      if (def && !out.has(def.name)) out.set(def.name, def);
    } catch {
      // unreadable file: skipped, as lets-code does
    }
  }
  return out;
}
