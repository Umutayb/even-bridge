// even-guard: the even-bridge floor under lets-code's mandate, loaded into a
// durable lets-code session's child with `-e` (see guard-core.mjs for what it
// blocks). The session's project is EVEN_GUARD_CWD (set by the bridge).
import { guardDecision } from "./guard-core.mjs";

export default function (pi: any) {
  pi.on("tool_call", async (event: any) => {
    const decision = guardDecision(String(event?.toolName ?? ""), event?.input ?? {}, {
      cwd: process.env.EVEN_GUARD_CWD || process.cwd(),
    });
    if (decision) return decision;
    return undefined;
  });
}
