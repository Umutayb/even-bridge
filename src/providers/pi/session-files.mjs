// Vendored & adapted from even-terminal-pi (MIT, c) lallenlowe — src/even/session-files.ts
// See NOTICE.md.

// Read pi session files for resume/history without spawning pi.
//
// Layout (pi-coding-agent/docs/session-format.md):
//   ~/.pi/agent/sessions/--<cwd with / as ->--/<ISO-ts>_<uuid>.jsonl
// Header line:  {"type":"session","version":3,"id":...,"timestamp":...,"cwd":...}
// Entries:      {"type":"message","timestamp":...,"message":{role,content,usage,...}}
// Name:         {"type":"session_info","name":"..."}

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// The provider label sent on the wire to the Even app. The app only knows its
// own providers ("claude"/"codex") and FILTERS the session list to the provider
// it thinks it's connected to — so a "pi" tag would make every session
// invisible. We run pi underneath regardless; presenting as "claude" is purely
// cosmetic and makes sessions show up. (carried over from even-terminal-pi)
export const PROVIDER_NAME = "claude";

export function sessionsRoot(agentDir) {
  return join(agentDir ?? join(homedir(), ".pi", "agent"), "sessions");
}

/**
 * Encode a cwd to pi's session subdir form. pi resolves the real path (so on
 * macOS /tmp → /private/tmp), strips the leading slash, replaces remaining `/`
 * with `-`, and wraps in `--…--`.
 */
export function encodeCwdDir(cwd) {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // path may not exist (e.g. tests); fall back to the given cwd
  }
  const stripped = real.replace(/^\/+/, "").replace(/\/+$/, "");
  return `--${stripped.replace(/\//g, "-")}--`;
}

export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => !!b && typeof b === "object" && b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

/** One-line, ASCII-safe detail for a single tool-call block. */
function toolDetail(call) {
  const name = call.name ?? "";
  let input = call.arguments ?? call.input ?? call.args ?? {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = { _raw: input };
    }
  }
  let d;
  if (name === "bash") d = input.command ?? "";
  else if (name === "read" || name === "write" || name === "edit") d = input.path ?? "";
  else d = Object.values(input ?? {}).find((v) => typeof v === "string") ?? "";
  d = String(d).replace(/\s+/g, " ").trim();
  if (d.length > 70) d = d.slice(0, 70).trimEnd() + "...";
  return d;
}

/**
 * One-line summary of the tool-call blocks in an assistant content array.
 * pi records them as {type:"toolCall", id, name, arguments} (the Anthropic
 * tool_use shape is also accepted). "[tool] bash: <detail>" for a single
 * call, "[tools] name(n), ..." for several. "" when there are none. Used to
 * fold tool activity into /history text (the official history wire shape is
 * role/text only, so tool cards live in the live SSE feed; this keeps them
 * visible in the reopen view without extending the wire shape).
 */
function toolSummaryLine(content) {
  if (!Array.isArray(content)) return "";
  const calls = content.filter(
    (b) =>
      !!b &&
      typeof b === "object" &&
      (b.type === "toolCall" || b.type === "tool_use")
  );
  if (!calls.length) return "";
  if (calls.length === 1) {
    const name = calls[0].name ?? "tool";
    const d = toolDetail(calls[0]);
    return d ? `[tool] ${name}: ${d}` : `[tool] ${name}`;
  }
  const counts = new Map();
  for (const c of calls) {
    const n = c.name ?? "tool";
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return `[tools] ${[...counts.entries()]
    .map(([n, k]) => (k > 1 ? `${n}(${k})` : n))
    .join(", ")}`;
}

/** Read just enough of a session file to summarize it (header + name + first prompt). */
function readSummary(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  let id = "";
  let cwd = "";
  let name = "";
  let firstPrompt = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") {
      id = entry.id ?? "";
      cwd = entry.cwd ?? "";
    } else if (entry.type === "session_info") {
      const n = entry.name;
      if (n) name = n;
    } else if (entry.type === "message" && !firstPrompt) {
      const m = entry.message;
      if (m?.role === "user") {
        firstPrompt = textOf(m.content).slice(0, 80);
      }
    }
    if (id && name && firstPrompt) break; // got everything cheap
  }
  if (!id) return null;
  let mtime = new Date();
  try {
    mtime = statSync(file).mtime;
  } catch {
    /* keep now */
  }
  return {
    id,
    file,
    cwd,
    timestamp: mtime.toISOString(),
    name: name || firstPrompt || "",
    firstPrompt,
  };
}

/** List resumable sessions, newest first. If cwd is given, scan only that dir. */
export function listSessionFiles(limit, cwd, agentDir) {
  const root = sessionsRoot(agentDir);
  if (!existsSync(root)) return [];

  const dirs = [];
  if (cwd) {
    const d = join(root, encodeCwdDir(cwd));
    if (existsSync(d)) dirs.push(d);
  } else {
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      try {
        if (statSync(p).isDirectory()) dirs.push(p);
      } catch {
        /* skip */
      }
    }
  }

  const files = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = join(dir, n);
      try {
        files.push({ path: p, mtimeMs: statSync(p).mtimeMs });
      } catch {
        /* skip */
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const s = readSummary(f.path);
    if (!s) continue;
    out.push({
      id: s.id,
      title: s.name.slice(0, 64),
      timestamp: s.timestamp,
      cwd: s.cwd,
      provider: PROVIDER_NAME,
      status: null,
    });
  }
  return out;
}

/**
 * The most recently updated session file in a cwd's session directory.
 *
 * A cwd can host many pi sessions; an external terminal pi drives exactly
 * one of them. pi opens its transcript per write (no persistent fd) and does
 * not publish its session id in the process env, so the freshest file in the
 * driver's cwd is the best disk-level signal of which conversation that
 * driver is actually running.
 *
 * @returns {{ file: string, id: string, mtimeMs: number } | null}
 */
export function newestSessionForCwd(cwd, agentDir) {
  if (!cwd) return null;
  const dir = join(sessionsRoot(agentDir), encodeCwdDir(cwd));
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { file: p, id: n.slice(n.lastIndexOf("_") + 1, -6), mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/**
 * Normalized text fragments of the session's last `n` user messages.
 * Used to match a terminal pane's visible screen against a transcript:
 * the pi TUI shows the conversation it is driving, so its recent prompt
 * text on screen is ground truth for "which session does this terminal run".
 *
 * @returns {string[]} whitespace-stripped leading fragments (longest first)
 */
export function recentPromptFragments(sessionId, agentDir, n = 3, fragLen = 24) {
  const file = findSessionFile(sessionId, agentDir);
  if (!file) return [];
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e?.type !== "message") continue;
    const m = e.message;
    if (!m || m.role !== "user") continue;
    const t = textOf(m.content).trim();
    const frag = t.replace(/\s+/g, "").slice(0, fragLen);
    if (frag.length >= 8) out.push(frag);
  }
  return out;
}

/**
 * Session ids in a cwd's directory, most recently updated first (bounded).
 * Candidate set for the pane-matching disambiguation.
 */
export function recentSessionsInCwd(cwd, agentDir, n = 5) {
  try {
    return listSessionFiles(n, cwd, agentDir).map((s) => s.id);
  } catch {
    return [];
  }
}

/** Find a session file by id (scan all cwd dirs). */
export function findSessionFile(sessionId, agentDir) {
  const root = sessionsRoot(agentDir);
  if (!existsSync(root)) return null;
  for (const dirName of readdirSync(root)) {
    const dir = join(root, dirName);
    let names;
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.endsWith(`_${sessionId}.jsonl`) || n === `${sessionId}.jsonl`) {
        return join(dir, n);
      }
    }
  }
  return null;
}

/** The cwd a session was created in (from its header line), or null. */
export function readSessionCwd(sessionId, agentDir) {
  const file = findSessionFile(sessionId, agentDir);
  if (!file) return null;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session") return entry.cwd ?? null;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Read user/assistant text turns from a session file (latest `limit`). */
export function readHistory(sessionId, limit, agentDir) {
  const file = findSessionFile(sessionId, agentDir);
  if (!file) return [];
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const items = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    let text = textOf(m.content);
    const toolLine = m.role === "assistant" ? toolSummaryLine(m.content) : "";
    if (!text && !toolLine) continue;
    if (text && toolLine) text = `${text}\n\n${toolLine}`;
    else if (toolLine) text = toolLine;
    items.push({ role: m.role, text });
  }
  return items.slice(-limit);
}

/** Best-effort: the model id used most recently across sessions. */
export function readRecentModel(cwd, agentDir) {
  const sessions = listSessionFiles(3, cwd, agentDir);
  for (const s of sessions) {
    const file = findSessionFile(s.id, agentDir);
    if (!file) continue;
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Scan from the end for the last assistant message with a model.
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"role":"assistant"')) continue;
      try {
        const e = JSON.parse(line);
        const model = e.message?.model;
        if (model) return model;
      } catch {
        /* skip */
      }
    }
  }
  return "";
}
