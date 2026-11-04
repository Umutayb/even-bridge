// even-guard: the even-bridge floor under lets-code's mandate, loaded into a
// durable lets-code session's child with `-e` (see guard-core.mjs for what it
// blocks). The session's project is EVEN_GUARD_CWD (set by the bridge).
//
// Subagents: lets-code starts them as plain `pi` processes in the same cwd,
// without this `-e`. They get the guard from the project-local copy the bridge
// writes to `<cwd>/.pi/extensions/even-guard.ts`, which pi loads only for a
// trusted project. As a command-line extension this one may answer pi's
// `project_trust` event: it trusts exactly its session's project and lets pi
// remember that (~/.pi/agent/trust.json), so the subagents started there later
// load the guard too.
import { guardDecision, trustsProject } from "./guard-core.mjs";
import { sealAfterTool } from "./seal-core.mjs";

export default function (pi: any) {
  pi.on("project_trust", async (event: any) =>
    trustsProject(String(event?.cwd ?? ""), process.env.EVEN_GUARD_CWD) ? { trusted: "yes", remember: true } : { trusted: "undecided" },
  );
  pi.on("tool_call", async (event: any) => {
    const decision = guardDecision(String(event?.toolName ?? ""), event?.input ?? {}, {
      cwd: process.env.EVEN_GUARD_CWD || process.cwd(),
    });
    if (decision) return decision;
    return undefined;
  });
  // After every tool (a subagent's bash may plant into .pi without naming it): undo it before this pi
  // returns, so the next pi of the chain never loads it (seal-core.mjs).
  pi.on("tool_result", async (event: any) => sealAfterTool(event));
}
