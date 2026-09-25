#!/usr/bin/env node
// Idempotent dist patch for @evenrealities/even-terminal: make the
// glasses-spawned CC permission mode configurable (EVEN_BRIDGE_CC_PERMISSION_MODE,
// default "auto"). The official dist hardcodes permissionMode: "default", which
// prompts the wearer for every non-auto tool call; a late or missed answer
// (60s waitForUser timeout, or an aborted SSE stream) resolves to DENY and wedges
// the session ("Stream closed"). Run after any `npm update` — server.mjs
// no-ops cleanly if the patch is already present.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "node_modules/@evenrealities/even-terminal/dist/claude/session.js");

const anchor = "const CLAUDE_CODE_EXECUTABLE = process.env.EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE;";
const marker = "EVEN_BRIDGE_CC_PERMISSION_MODE";

let s = readFileSync(target, "utf8");
if (s.includes(marker)) {
  console.log("[patch-dist] already patched — nothing to do");
  process.exit(0);
}
if (!s.includes(anchor)) {
  console.error("[patch-dist] anchor not found — the dist changed shape; patch by hand.");
  process.exit(1);
}
const add =
  "\n// even-bridge dist-patch: permission mode for glasses-spawned CC sessions.\n" +
  "// Official default \"default\" prompts the wearer for every non-auto tool call,\n" +
  "// and a missed/late answer (60s timeout or aborted SSE) resolves to DENY,\n" +
  "// which surfaces as \"Stream closed\" and wedges the session. \"auto\" lets the\n" +
  "// CLI approve safe work locally and only surfaces higher-risk calls. Override\n" +
  "// with EVEN_BRIDGE_CC_PERMISSION_MODE (default|acceptEdits|bypassPermissions|plan|auto|dontAsk).\n" +
  `const EVEN_BRIDGE_CC_PERMISSION_MODE = (process.env.EVEN_BRIDGE_CC_PERMISSION_MODE || "auto").trim() || "auto";`;
s = s.replace(anchor, anchor + add, 1);
const oldLine = '                permissionMode: "default",';
if (!s.includes(oldLine)) {
  console.error("[patch-dist] permissionMode line not found — patch by hand.");
  process.exit(1);
}
s = s.replace(oldLine, "                permissionMode: EVEN_BRIDGE_CC_PERMISSION_MODE,", 1);
writeFileSync(target, s, "utf8");
console.log("[patch-dist] applied permission-mode env patch to", target);
