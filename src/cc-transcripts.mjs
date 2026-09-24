// Local (non-remote-control) Claude Code transcripts.
//
// Claude Code appends each session's conversation to
//   ~/.claude/projects/<cwd with / replaced by ->/<sessionId>.jsonl
// while it runs. The official even-terminal's SDK-based session list SKIPS
// in-progress sessions, and the official dist has no watcher for external
// transcripts — so live local CC sessions are invisible to the phone and
// never stream. This module treats the on-disk files as ground truth:
// list them, convert entries to even-terminal wire messages, and support
// byte-offset tailing (src/cc-watch.mjs) so an open session streams into
// the shared ring/SSE exactly like a bridge-launched one.

import { readdirSync, statSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { summarizeCcToolCall } from "./providers/pi/summarize.mjs";

export function ccProjectsBase(override) {
  return override || process.env.EVEN_BRIDGE_CC_DIR || join(homedir(), ".claude", "projects");
}

/** sessionId -> absolute path of its transcript file (or null). */
export function findCcSessionFile(sessionId, base = ccProjectsBase()) {
  if (!sessionId) return null;
  let dirs;
  try {
    dirs = readdirSync(base);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = join(base, d, `${sessionId}.jsonl`);
    try {
      statSync(file);
      return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Read up to `bytes` from byte offset `from` (raw Buffer). */
export function readRange(file, from, bytes) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, Math.max(0, size - from));
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, from);
    return buf;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export const readHead = (file, bytes = 64 * 1024) => readRange(file, 0, bytes).toString("utf8");
export const readTail = (file, bytes = 64 * 1024) => {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return "";
  }
  return readRange(file, Math.max(0, size - bytes), bytes).toString("utf8");
};

/** Parse a raw JSONL chunk; unparseable lines (partial tail line etc.) are skipped. */
export function parseCcLines(raw) {
  const out = [];
  for (const line of String(raw).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip partial/corrupt line */
    }
  }
  return out;
}

// ── meta (title / cwd) ──────────────────────────────────────────────────────
const metaCache = new Map(); // file -> {mtime, meta}

/** {title, cwd} for a transcript: title from the newest ai-title/agent-name
 *  (file tail); cwd from the first entry carrying one (file head). */
export function ccMeta(file, dirCwd = "") {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { title: "", cwd: dirCwd };
  }
  const hit = metaCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;

  const tail = parseCcLines(readTail(file));
  let title = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (e?.type === "ai-title" && e.aiTitle) {
      title = e.aiTitle;
      break;
    }
    if (e?.type === "agent-name" && e.agentName) {
      title = e.agentName;
      break;
    }
  }
  const head = parseCcLines(readHead(file));
  if (!title) {
    for (const e of head) {
      if (
        e?.type === "user" &&
        !e.isCompactSummary &&
        typeof e.message?.content === "string" &&
        e.message.content.trim()
      ) {
        title = e.message.content.replace(/\s+/g, " ").trim().slice(0, 60);
        break;
      }
    }
  }
  let cwd = null;
  for (const e of head) {
    if (typeof e?.cwd === "string" && e.cwd) {
      cwd = e.cwd;
      break;
    }
  }
  const meta = { title: title ?? "", cwd: cwd ?? dirCwd };
  metaCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}

/**
 * Newest-first list of local CC sessions — ALL of them, including live
 * ones the official SDK list skips. Meta (file reads) is resolved only for
 * the newest `limit + 8` (RC-twin matching headroom); older rows would be
 * cut by the phone's list window anyway.
 */
export function listCcSessions({ limit = 50, cwd, base = ccProjectsBase() } = {}) {
  let dirs;
  try {
    dirs = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = readdirSync(join(base, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(base, d.name, f);
      try {
        const st = statSync(file);
        rows.push({
          id: f.slice(0, -6),
          file,
          mtime: st.mtimeMs,
          dirCwd: d.name.replace(/-/g, "/"),
        });
      } catch {
        /* ignore */
      }
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const r of rows.slice(0, limit + 8)) {
    const meta = ccMeta(r.file, r.dirCwd);
    if (cwd && meta.cwd !== cwd) continue;
    out.push({
      id: r.id,
      title: meta.title,
      cwd: meta.cwd,
      timestamp: new Date(r.mtime).toISOString(),
      status: null,
      provider: "claude",
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Last `n` user prompts (whitespace-stripped, tail 40 chars each) — for
 * pane-screen matching; mirrors recentPromptFragments() for pi.
 */
export function recentCcPromptFragments(file, n = 3) {
  const entries = parseCcLines(readTail(file, 262144));
  const fr = [];
  for (let i = entries.length - 1; i >= 0 && fr.length < n; i--) {
    const e = entries[i];
    if (e?.type === "user" && !e.isCompactSummary && typeof e.message?.content === "string") {
      const t = e.message.content.replace(/\s+/g, "").trim();
      if (t) fr.push(t.slice(-40));
    }
  }
  return fr;
}

// ── entries -> wire ─────────────────────────────────────────────────────────
/**
 * Convert CC transcript entries to even-terminal wire messages (same shapes
 * the pi wire emits: user_prompt / text_delta / tool_start / tool_end), so
 * the phone renders local CC live activity exactly like pi.
 *
 * @param {object[]} entries parsed transcript entries (any types)
 * @param {{ pending?: Map }} [state] persistent tool_use_id -> {name, input}
 *   bookkeeping — tool_results land in a later batch than the tool_use.
 */
export function ccEntriesToWire(entries, state = {}) {
  const out = [];
  const pending = state.pending ?? new Map();
  state.pending = pending;
  for (const e of entries) {
    if (e?.type === "user") {
      const content = e.message?.content;
      if (typeof content === "string") {
        // Human prompt (compact summaries are metadata, not user input).
        if (!e.isCompactSummary && content.trim()) out.push({ type: "user_prompt", text: content });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_result") {
            const id = b.tool_use_id ?? null;
            const info = id ? pending.get(id) : null;
            if (id && info) pending.delete(id);
            out.push({
              type: "tool_end",
              name: info?.name ?? "tool",
              toolId: id,
              summary: info ? summarizeCcToolCall(info.name, info.input) : "Tool",
              detail: { input: info?.input ?? {}, output: toolResultText(b) },
            });
          } else if (typeof b?.text === "string" && b.text.trim()) {
            out.push({ type: "user_prompt", text: b.text });
          }
        }
      }
    } else if (e?.type === "assistant") {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "text" && b.text) out.push({ type: "text_delta", text: b.text });
        else if (b?.type === "tool_use" && b.id) {
          pending.set(b.id, { name: b.name, input: b.input ?? {} });
          out.push({ type: "tool_start", name: b.name, toolId: b.id });
        }
        // thinking blocks: no wire equivalent; skipped (pi parity).
      }
    }
    // Everything else (ai-title, agent-name, mode, attachment, system,
    // last-prompt, cost-state, queue-operation, ...) is metadata — skipped.
  }
  return out;
}

function toolResultText(b) {
  const c = b.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n");
  return "";
}
