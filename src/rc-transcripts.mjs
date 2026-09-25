// RC transcript detection.
//
// The claude-remote fork runs the real `claude --remote-control` CLI, which
// writes its transcript to ~/.claude/projects/<cwd>/<local-uuid>.jsonl just
// like any local session. The claude CLI embeds a `bridge-session` entry in
// those transcripts (at session start, and again on every RC reconnect —
// possibly with a new cse_ id; the latest marker is authoritative):
//
//   {"type":"bridge-session","sessionId":"<local-uuid>",
//    "bridgeSessionId":"cse_...","lastSequenceNum":0, ...}
//
// That gives us the local-UUID → cse_ mapping we need to dedupe the merged
// /api/sessions list: without it, one RC conversation shows up twice (once
// as an RC session under its cse_ id, once as a local claude session under
// its transcript uuid). When the RC session dies, the upstream list (active
// only) drops it and the transcript automatically falls back to being a
// plain local session.

import { homedir } from "node:os";
import { join } from "node:path";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

const HEAD_BYTES = 64 * 1024; // first marker is written at session start
const TAIL_BYTES = 256 * 1024; // re-written markers (RC reconnects) land here
const DEFAULT_BASE = join(homedir(), ".claude", "projects");

/** Path of a local Claude session transcript file. */
export function claudeSessionFile(cwd, sessionId, baseDir = DEFAULT_BASE) {
  const encoded = String(cwd || "").replace(/\//g, "-");
  return join(baseDir, encoded, `${sessionId}.jsonl`);
}

/** Last `bridge-session` marker's bridgeSessionId in `text`, or null. */
function lastMarker(text) {
  let found = null;
  for (const line of text.split("\n")) {
    if (!line.includes("bridge-session")) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === "bridge-session" && typeof j.bridgeSessionId === "string") {
        found = j.bridgeSessionId;
      }
    } catch {
      /* truncated line at a window boundary — ignore */
    }
  }
  return found;
}

/**
 * Return the RC `bridgeSessionId` (cse_…) a local session file belongs to,
 * or null if the file is a plain local session / missing.
 *
 * The CLI re-writes the marker whenever its RC connection is (re)established,
 * with a NEW cse_ id after a reconnect — so the id near the head can be stale
 * (observed: 1513 markers for an old cse_ id, then 28 for the live one). The
 * tail window is checked first (latest marker wins); the head is the fallback
 * for sessions that wrote their only marker at start.
 */
export function findBridgeSessionId(cwd, sessionId, baseDir = DEFAULT_BASE) {
  let fd;
  try {
    fd = openSync(claudeSessionFile(cwd, sessionId, baseDir), "r");
  } catch {
    return null; // no transcript file
  }
  try {
    const size = fstatSync(fd).size;
    const read = (pos, len) => {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      return buf.subarray(0, n).toString("utf8");
    };
    const tailLen = Math.min(TAIL_BYTES, size);
    const fromTail = lastMarker(read(size - tailLen, tailLen));
    if (fromTail || size <= tailLen) return fromTail;
    return lastMarker(read(0, Math.min(HEAD_BYTES, size)));
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}
