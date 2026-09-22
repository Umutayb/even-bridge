// RC transcript detection.
//
// The claude-remote fork runs the real `claude --remote-control` CLI, which
// writes its transcript to ~/.claude/projects/<cwd>/<local-uuid>.jsonl just
// like any local session. The claude CLI embeds a `bridge-session` entry in
// those transcripts (within the first few lines):
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
import { openSync, readSync, closeSync } from "node:fs";

const HEAD_BYTES = 64 * 1024; // the marker is written at session start
const DEFAULT_BASE = join(homedir(), ".claude", "projects");

/** Path of a local Claude session transcript file. */
export function claudeSessionFile(cwd, sessionId, baseDir = DEFAULT_BASE) {
  const encoded = String(cwd || "").replace(/\//g, "-");
  return join(baseDir, encoded, `${sessionId}.jsonl`);
}

/**
 * Read the head of a local session file and return the RC `bridgeSessionId`
 * (cse_…) it belongs to, or null if the file is a plain local session /
 * missing.
 */
export function findBridgeSessionId(cwd, sessionId, baseDir = DEFAULT_BASE) {
  let fd;
  try {
    fd = openSync(claudeSessionFile(cwd, sessionId, baseDir), "r");
  } catch {
    return null; // no transcript file
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString("utf8");
    for (const line of head.split("\n")) {
      if (!line.includes("bridge-session")) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === "bridge-session" && typeof j.bridgeSessionId === "string") {
          return j.bridgeSessionId;
        }
      } catch {
        /* truncated line at the head boundary — ignore */
      }
    }
    return null;
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
