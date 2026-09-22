// Vendored & adapted from even-terminal-pi (MIT, c) lallenlowe — src/even/summarize.ts
// See NOTICE.md. Adapted to the official even-terminal summary style (ASCII
// truncation suffix, leading-caps tool name) so pi tool lines render identically
// to local Claude lines on the glasses.

// Compact one-line summaries of pi tool calls for the G2's tiny canvas.

function base(p) {
  if (typeof p !== "string") return "";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Official even-terminal truncation: one-line, ASCII "..." suffix (the HUD
// font has no ellipsis glyph).
function trunc(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "..." : t;
}

function caps(name) {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function summarizePiToolCall(name, input) {
  switch (name) {
    case "read":
      return `Read ${base(input.path) || "file"}`;
    case "write":
      return `Write ${base(input.path) || "file"}`;
    case "edit":
      return `Edit ${base(input.path) || "file"}`;
    case "bash":
      return `Bash ${trunc(input.description ?? input.command ?? "command", 50)}`;
    case "grep":
      return `Grep "${trunc(input.pattern, 25)}"`;
    case "glob":
      return `Glob ${trunc(input.pattern ?? input.glob, 40)}`;
    case "ls":
      return `ls ${base(input.path) || "."}`;
    case "ask_user":
      return `Ask ${trunc(input.question, 50)}`;
    case "subagent":
      return `Agent ${trunc(input.agent, 40)}`;
    default: {
      // Generic: leading-caps tool name + first informative arg.
      const key = ["path", "command", "pattern", "query", "url", "text"].find((k) => input[k]);
      const detail = key ? trunc(input[key], 40) : "";
      return detail ? `${caps(name)} ${detail}` : caps(name);
    }
  }
}
