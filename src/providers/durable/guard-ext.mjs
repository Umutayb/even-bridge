// The Durable side of the guard (see guard.mjs): the `even-guard` extension of
// native durable conversations. Split from guard.mjs so the pure rules there can
// be loaded without pi-durable (lets-code children load them via lc/guard-core.mjs).
import { homedir } from "node:os";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { DEFAULT_CAPS, TMP, detectWrapper, guardBeforeTool, guardPrepare } from "./guard.mjs";

/**
 * The Durable extension. Install after CodingTools so its `bash` (with `prepare`) wins.
 * @param {object} o
 * @param {(conversationId: unknown) => string|undefined} o.cwdOf the workspace of a
 *   conversation. The caller owns this mapping: a child conversation (a subagent, Task 7)
 *   must map to its parent's cwd, and an unknown conversation must return undefined (blocks).
 * @param {(conversationId: unknown) => boolean} [o.readonlyOf] true for a read-only agent
 *   (agent file `role: readonly`): write/edit and writing, removing or git-mutating bash are blocked.
 * @param {(conversationId: unknown) => string|undefined} [o.unitOf] systemd scope name of the next bash call.
 * @param {object} [o.baseEnv] where the shell's allowlisted variables come from (default process.env).
 */
export function createGuardExtension({ cwdOf, readonlyOf = () => false, unitOf, baseEnv = process.env, caps = DEFAULT_CAPS, wrapper = detectWrapper(), home = homedir(), tmp = TMP, log } = {}) {
  return defineExtension({
    name: "even-guard",
    hooks: [hook(ToolTask, { beforeTool: (call, api) => guardBeforeTool(call, { cwd: cwdOf(api.conversationId), readonly: Boolean(readonlyOf(api.conversationId)), home, tmp, log }) })],
    tools: [createBashTool({ prepare: (execution, api) => { guardPrepare(execution, { wrapper, caps, baseEnv, unit: unitOf?.(api?.conversationId) }); } })],
  });
}
