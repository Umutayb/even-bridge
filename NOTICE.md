# Third-Party Notices

## even-terminal-pi (pi provider)

Parts of `src/providers/pi/` are vendored and adapted from
**even-terminal-pi** by lallenlowe (https://github.com/lallenlowe/even-terminal-pi),
published under the MIT License.

Files derived from it (TypeScript ported to plain ESM JavaScript):

| this repo                          | upstream                 |
| ---------------------------------- | ------------------------ |
| `src/providers/pi/framing.mjs`     | `src/rpc/framing.ts`     |
| `src/providers/pi/rpc-client.mjs`  | `src/rpc/client.ts`      |
| `src/providers/pi/summarize.mjs`   | `src/even/summarize.ts`  |
| `src/providers/pi/session-files.mjs` | `src/even/session-files.ts` |
| `src/providers/pi/session.mjs`     | `src/even/session.ts`    |
| `src/providers/pi/provider.mjs`    | `src/even/provider.ts`   |

Adaptations made for this bridge:

- the wire provider name is `"claude"` (the Even app filters its session list
  to providers it knows; `"pi"` would render every session invisible) —
  cosmetic only, the agent underneath is pi;
- session IDs are registered in an ownership registry so per-session API
  calls route here even when the phone omits the provider parameter;
- `probe(sessionId)` resolves ownership from disk (pi session file lookup);
- messages emitted before a session ID is known are buffered and flushed
  instead of dropped;
- tool-call summaries use the official even-terminal summary style (ASCII
  truncation) for consistent HUD rendering.

## @evenrealities/even-terminal (official bridge)

`src/server.mjs` and `src/ext-router.mjs` import and mirror wiring from the
compiled `dist/` of `@evenrealities/even-terminal@0.10.4` (the published npm
package; the upstream source is not publicly available). No code from that
package is modified or republished — it is a dependency, used through its
public module exports.

## claude-remote-terminal (RC provider)

`src/providers/claude-remote.mjs` and `src/upstream-pump.mjs` proxy to and
relay from the author's own `claude-remote-terminal` bridge (no third-party
code; the reliability semantics — pump loop, watermark gap replay, heartbeat
idle re-assertion, socket tuning — are mirrored from that bridge's
`terminal_host.py`).
