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
// Every transcript -> wire path classifies a user entry first (userTextMode):
//   "drop"     the flags say it is injected (isMeta, compact summary,
//              isSynthetic, a known non-human origin.kind, promptSource
//              "system") — its text is never shown (tool_results still are);
//   "human"    the flags say a human typed it (origin.kind "human",
//              promptSource typed/queued, or promptSource "sdk" with no
//              origin: the bridge relaying the wearer) — never dropped, only RENDERED
//              (typed /command and !command blocks) and an appended reminder
//              block stripped;
//   "flagless" no verdict from the flags (RC fork frames and /history rows,
//              older transcripts, an unknown origin.kind) — the text-only
//              rules below drop whole known harness blocks and notices.
// A real prompt that merely mentions a tag in its prose is left alone, and
// unknown tags (custom elements, pasted XML) are the user's text.

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

/** Blocks that carry what the human typed (rendered, not dropped). */
const RENDER_TAGS = new Set(["command-name", "command-message", "command-args", "command-contents", "bash-input"]);

/** Inter-agent envelopes: the whole turn is another agent's message. */
const ENVELOPE_TAGS = ["agent-message", "cross-session-message", "teammate-message", "relay"];

/** origin.kind values Claude Code uses for turns no human typed. */
const INJECTED_KINDS = new Set(["task-notification", "peer", "coordinator"]);

// Leading notices Claude Code writes in square brackets.
const NOTICE_RE = /^\s*\[(?:SYSTEM NOTIFICATION\b[^\]]*|Request interrupted by user[^\]]*)\]/;
// A skill body Claude Code injects when a skill loads (isMeta locally; the RC
// fork's /history rows have lost that flag, the fixed preface remains).
const SKILL_BODY_RE = /^\s*Base directory for this skill: /;
// RC /history rows only (no flags at all there): a slash-command expansion
// header and a compact summary.
// Every real expansion header reads "# /<name> - <description>".
const HISTORY_ONLY_RES = [/^\s*# \/[\w:.-]+ - /, /^\s*This session is being continued from a previous conversation/];

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

/** A whole known harness block appended on its own line at the end of `s`. */
function stripTrailingHarness(s) {
  for (;;) {
    const m = /<\/([A-Za-z][\w-]*)>\s*$/.exec(s);
    if (!m || !HARNESS_TAGS.has(m[1])) return s;
    const open = s.lastIndexOf(`<${m[1]}`, m.index);
    if (open < 0) return s;
    const ch = s[open + m[1].length + 1];
    if (ch !== ">" && !/\s/.test(ch ?? "")) return s;
    // Only an APPENDED block: it opens on its own line (prose that quotes a tag keeps it).
    if (open === 0 || !/\n[ \t]*$/.test(s.slice(0, open))) return s;
    s = s.slice(0, open);
  }
}

/** A turn made only of typed /command or !command blocks -> its rendering, else null. */
function renderCommand(text) {
  let s = text;
  let command = null;
  let args = "";
  let bash = null;
  let any = false;
  for (;;) {
    const b = leadingBlock(s);
    if (!b || !RENDER_TAGS.has(b.name) || b.inner === null) break;
    any = true;
    if (b.name === "command-name") command = b.inner.trim();
    else if (b.name === "command-args") args = b.inner.trim();
    else if (b.name === "bash-input") bash = b.inner.trim();
    s = b.rest;
  }
  if (!any || s.trim()) return null;
  if (command) {
    const name = command.startsWith("/") ? command : `/${command}`;
    return args ? `${name} ${args}` : name;
  }
  if (bash) return `!${bash}`;
  return null;
}

/**
 * Text of one Claude Code user turn as the glasses should show it, or null
 * when it is harness-injected / inter-agent content.
 * @param {string} text
 * @param {{ human?: boolean, history?: boolean }} [o]
 *   human: the transcript marks it human-typed — render only, never drop;
 *   history: an RC /history row (no flags) — also drop the fixed
 *   slash-command-expansion and compact-summary prefaces.
 */
export function cleanUserText(text, { human = false, history = false } = {}) {
  if (typeof text !== "string") return null;
  if (!text.trim()) return null;
  const rendered = renderCommand(text);
  if (rendered) return rendered;
  if (human) {
    const s = stripTrailingHarness(text).trim();
    return s && s !== text.trim() ? s : text;
  }
  if (NOTICE_RE.test(text) || SKILL_BODY_RE.test(text)) return null;
  if (history && HISTORY_ONLY_RES.some((re) => re.test(text))) return null;
  // Inter-agent envelope: the turn opens with it, or with a one-line preface
  // ending in ":" ("Message from X: <agent-message from=…>…</agent-message>").
  const env = /^\s*(?:[^\n<]{1,120}:\s*)?<([a-z][\w-]*)\s[^>]*\bfrom=/.exec(text);
  if (env && ENVELOPE_TAGS.includes(env[1]) && text.includes(`</${env[1]}>`)) return null;

  let s = text;
  for (;;) {
    const b = leadingBlock(s);
    if (!b || !HARNESS_TAGS.has(b.name)) break;
    if (b.inner === null) return null; // an unterminated harness block: nothing typed follows
    s = b.rest;
  }
  s = stripTrailingHarness(s).trim();
  if (!s) return null;
  return s === text.trim() ? text : s;
}

/**
 * "drop" | "human" | "flagless" for a local transcript `user` entry (see the
 * header). An unknown origin.kind fails OPEN (flagless: only marker-bearing
 * text is dropped).
 */
export function userTextMode(e) {
  if (!e || typeof e !== "object") return "flagless";
  if (e.isMeta === true || e.isCompactSummary === true || e.isVisibleInTranscriptOnly === true) return "drop";
  if (e.isSynthetic === true) return "drop";
  const kind = e.origin && typeof e.origin === "object" ? e.origin.kind : undefined;
  if (INJECTED_KINDS.has(kind)) return "drop";
  if (e.promptSource === "system") return "drop";
  if (kind === "human" || e.promptSource === "typed" || e.promptSource === "queued") return "human";
  // A prompt the bridge itself sent through the SDK: the wearer's words, relayed.
  if (e.promptSource === "sdk" && kind === undefined) return "human";
  return "flagless";
}

/** True when a local transcript `user` entry's TEXT is not the human's. */
export function isInjectedUserEntry(e) {
  return userTextMode(e) === "drop";
}

/** The glasses text of a local transcript user entry's text, or null. */
export function entryUserText(e, text) {
  const mode = userTextMode(e);
  if (mode === "drop") return null;
  return cleanUserText(text, { human: mode === "human" });
}

/** True when a whole transcript entry belongs to another agent's thread. */
export function isSidechainEntry(e) {
  return !!e && (e.isSidechain === true || (typeof e.teamName === "string" && e.teamName !== ""));
}
