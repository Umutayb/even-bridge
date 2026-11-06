// Harness-injected and inter-agent text in Claude Code user turns.
//
// Claude Code records a lot of text as `type: "user"` that the human never
// typed: skill bodies and slash-command expansions (isMeta), teammate /
// peer hand-backs (isMeta, origin.kind "peer"; an <agent-message> envelope
// behind a one-line preface), coordinator relays (sidechain), background
// task results (<task-notification>, origin.kind "task-notification"),
// <system-reminder> blocks, local-command caveats and stdout, `!` shell
// echoes, hook output, "[Request interrupted by user]" and
// "[SYSTEM NOTIFICATION - NOT USER INPUT]" notices. Shown as a user_prompt
// (or replayed by /history) they read on the glasses as if the wearer had
// said them.
//
// Two layers, used by every transcript -> wire path:
//   * isInjectedUserEntry(entry): the flags on a local transcript entry (the
//     official SDK drops isMeta / isSidechain / teamName entries the same way;
//     non-human origin kinds are harness turns).
//   * cleanUserText(text): text-only, for paths where the flags are gone (the
//     RC fork's /events frames and /history rows). Strips WHOLE harness tag
//     blocks at the start (and known harness blocks at the end) of the turn;
//     returns null when nothing the human wrote remains. A real prompt that
//     merely mentions a tag in its prose is left alone.

/** Harness tag names (whole blocks of these are never the human's words). */
const HARNESS_TAGS = new Set([
  "system-reminder",
  "task-notification",
  "cross-session-message",
  "agent-message",
  "teammate-message",
  "relay",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "command-contents",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "user-prompt-submit-hook",
  "hook-output",
]);

/** Tag blocks the human produced (a paste) — never stripped. */
const USER_TAGS = new Set(["pasted_content"]);

/** Inter-agent envelopes: the whole turn is another agent's message. */
const ENVELOPE_TAGS = ["agent-message", "cross-session-message", "teammate-message", "relay"];

// Leading notices Claude Code writes in square brackets.
const NOTICE_RE = /^\s*\[(?:SYSTEM NOTIFICATION\b[^\]]*|Request interrupted by user[^\]]*)\]/;
// A skill body Claude Code injects when a skill loads (isMeta locally; the RC
// fork's /history rows have lost that flag, the fixed preface remains).
const SKILL_BODY_RE = /^\s*Base directory for this skill: /;

// Generic harness-looking tag name: lowercase, hyphen/underscore-joined
// (system-reminder, local-command-stdout, ...). Plain HTML-ish tags (<b>,
// <div>) in a prompt are not treated as harness blocks.
const GENERIC_TAG_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/;

function isHarnessTag(name) {
  if (USER_TAGS.has(name)) return false;
  return HARNESS_TAGS.has(name) || GENERIC_TAG_RE.test(name);
}

/** A whole `<name ...>...</name>` block at the start of `s`, or null. */
function leadingBlock(s) {
  const m = /^\s*<([A-Za-z][\w-]*)(?:\s[^>]*)?>/.exec(s);
  if (!m) return null;
  const name = m[1];
  const close = `</${name}>`;
  const end = s.indexOf(close, m[0].length);
  if (end < 0) return { name, inner: null, rest: null }; // unterminated
  return { name, inner: s.slice(m[0].length, end), rest: s.slice(end + close.length) };
}

/** A whole known harness block at the end of `s` (prompt + appended reminder). */
function stripTrailingHarness(s) {
  for (;;) {
    const m = /<\/([A-Za-z][\w-]*)>\s*$/.exec(s);
    if (!m || !HARNESS_TAGS.has(m[1])) return s;
    const open = s.lastIndexOf(`<${m[1]}`, m.index);
    if (open < 0) return s;
    const ch = s[open + m[1].length + 1];
    if (ch !== ">" && !/\s/.test(ch ?? "")) return s;
    // Only an APPENDED block: it opens on its own line (prose that quotes a tag keeps it).
    if (open > 0 && !/\n[ \t]*$/.test(s.slice(0, open))) return s;
    s = s.slice(0, open);
  }
}

/**
 * Text of one Claude Code user turn as the glasses should show it, or null
 * when it is harness-injected / inter-agent content.
 *  - `<command-name>/x</command-name>…<command-args>a</command-args>` -> "/x a"
 *  - `<bash-input>cmd</bash-input>` -> "!cmd" (the wearer's own `!` command)
 *  - other leading harness blocks are stripped; nothing left -> null
 */
export function cleanUserText(text) {
  if (typeof text !== "string") return null;
  if (!text.trim()) return null;
  if (NOTICE_RE.test(text) || SKILL_BODY_RE.test(text)) return null;
  // Inter-agent envelope: the turn opens with it, or with a one-line preface
  // ending in ":" ("Message from X: <agent-message from=…>…</agent-message>").
  const env = /^\s*(?:[^\n<]{1,120}:\s*)?<([a-z][\w-]*)\s[^>]*\bfrom=/.exec(text);
  if (env && ENVELOPE_TAGS.includes(env[1]) && text.includes(`</${env[1]}>`)) return null;

  let s = text;
  let command = null;
  let commandArgs = "";
  let bash = null;
  for (;;) {
    const b = leadingBlock(s);
    if (!b || !isHarnessTag(b.name)) break;
    if (b.inner === null) return null; // an unterminated harness block: nothing typed follows
    if (b.name === "command-name") command = b.inner.trim();
    else if (b.name === "command-args") commandArgs = b.inner.trim();
    else if (b.name === "bash-input") bash = b.inner.trim();
    s = b.rest;
  }
  s = stripTrailingHarness(s).trim();
  if (s) return s === text.trim() ? text : s;
  if (command) return commandArgs ? `${command.startsWith("/") ? "" : "/"}${command} ${commandArgs}` : `${command.startsWith("/") ? "" : "/"}${command}`;
  if (bash) return `!${bash}`;
  return null;
}

/**
 * True when a local transcript `user` entry's TEXT is not the human's (its
 * tool_result blocks still count — those are tool output, not prompts).
 */
export function isInjectedUserEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (e.isMeta === true || e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true) return true;
  if (e.isSynthetic === true) return true;
  const kind = e.origin && typeof e.origin === "object" ? e.origin.kind : undefined;
  if (kind !== undefined && kind !== null && kind !== "human") return true;
  if (e.promptSource === "system") return true;
  return false;
}

/** True when a whole transcript entry belongs to another agent's thread. */
export function isSidechainEntry(e) {
  return !!e && (e.isSidechain === true || (typeof e.teamName === "string" && e.teamName !== ""));
}
