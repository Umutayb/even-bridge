# even-bridge

A single phone pairing that serves **three kinds of agent sessions** over the
Even phone protocol:

1. **Local Claude Code sessions** — the stock `@evenrealities/even-terminal`
   behavior, untouched (SDK-backed, plus Codex if you enable it).
2. **Claude Code Remote Control (RC) sessions** — the live `claude
   --remote-control` sessions from your existing
   [`claude-remote-terminal`](https://github.com/Umutayb/claude-remote-terminal)
   bridge, proxied through.
3. **Pi agent sessions** — `pi` (pi-coding-agent) sessions, served in-process
   via a vendored pi provider.

The phone knows one bridge. The bridge knows all three.

## Why this exists

The official Even bridge (`@evenrealities/even-terminal`, closed source — only
its compiled npm package is published) serves local Claude Code and Codex
sessions. The Even phone app only talks to one bridge per pairing, filters its
session list to providers it recognizes (`claude` / `codex`), and omits the
`provider` parameter on follow-up calls. So extensions must:

- present **every** session as `provider: "claude"` on the wire (cosmetic —
  the agent underneath may be pi or an RC session), and
- route per-session calls by **session-ID ownership**, not by provider
  parameter (the phone won't send one).

This project is a **superserver**: it depends on the official package and
mirrors its `dist/index.js` wiring, then mounts an *extension router* **before**
the official routers. Anything the extension router doesn't own falls through
to the official code paths unchanged — no `node_modules` patching.

## Requirements

- Node.js >= 18 (tested on v26)
- `@evenrealities/even-terminal@0.10.4` (installed as a dependency)
- For RC sessions: the `claude-remote-terminal` bridge running, with its
  terminal host reachable (default `http://127.0.0.1:8791`)
- For pi sessions: the `pi` executable on `PATH` (or `--pi-bin`)

## Install & setup

```sh
git clone <this repo> even-bridge
cd even-bridge
npm install                 # also rebuilds node-pty for the official package

even-bridge init            # create ~/.even-terminal/config.json (defaults)
#   — or run the official wizard:  npx even-terminal config
#     (same config file; fully compatible both ways)

even-bridge                 # start (default port 3456)
```

Pair the Even phone with the token printed at startup (or the QR code on
re-start). One pairing covers all three session types.

## Provisioning (system services)

`scripts/install-services.sh` installs and starts the systemd units for this
stack — idempotent, safe to re-run:

- creates `/etc/even-terminal.env` with a fresh `BRIDGE_TOKEN` (shown once) if
  it doesn't exist — existing tokens are kept, so re-runs never break a phone
  pairing;
- writes `even-bridge.service` (and `claude-remote-bridge.service` when the RC
  fork binary is present) — existing unit files are left untouched;
- disables the old official `even-terminal.service` if it is active (port 3456
  conflict); set `KEEP_OFFICIAL=1` to opt out;
- `systemctl enable --now` both and prints a status summary.

```sh
sudo scripts/install-services.sh
# overrides: HOST_USER, EVEN_BRIDGE_DIR, NODE_BIN, TOKEN_ENV_FILE,
#            RC_BRIDGE_BIN, RC_BRIDGE_PORT, KEEP_OFFICIAL
```

## Usage

```sh
even-bridge [flags]         # start the bridge (default command)
even-bridge init            # non-interactive default config
```

Stock even-terminal flags work unchanged: `--port`, `--token`, `--name`,
`--cwd`, `--provider`, `--config`, `--lan`, `--tailscale`, `--interface`,
`--allow-cors`, `--expose`, `--log-file`, `--verbose`,
`--use-original-claude`, `--claude-allowed-tools`.

Bridge flags:

| flag | env | default | meaning |
| --- | --- | --- | --- |
| `--rc-url <url>` | `EVEN_BRIDGE_RC_URL` | `http://127.0.0.1:8791` | RC terminal host |
| `--rc-token <t>` | `EVEN_BRIDGE_RC_TOKEN` | `~/.config/claude-remote-terminal/bridge-token` | RC auth token |
| `--no-rc` | `EVEN_BRIDGE_RC_ENABLE=0` | on | disable RC sessions |
| `--no-pi` | `EVEN_BRIDGE_PI_ENABLE=0` | on | disable pi sessions |
| `--pi-bin <bin>` | `EVEN_BRIDGE_PI_BIN` | `pi` | pi executable |
| `--pi-model <m>` | `EVEN_BRIDGE_PI_MODEL` | pi's default | default pi model |
| `--no-pi-all-cwds` | `EVEN_BRIDGE_PI_ALL_CWDS=0` | all cwds | scope pi list to project dir |
| `--pi-agent-dir <d>` | `EVEN_BRIDGE_PI_AGENT_DIR` | `~/.pi/agent` | pi agent dir |

## How it routes

The extension router (`src/ext-router.mjs`) intercepts `/api/*` before the
official routers and claims a request when:

1. an **explicit** `provider` param is an extended name
   (`claude-remote`, `pi`) — CLI/test path, the phone never does this, or
2. the `sessionId` is **claimed** or **probed** to an extended provider:
   - the ownership registry (`src/ownership.mjs`) maps session IDs to
     providers, claimed as sessions are listed/created;
   - pi probes from disk (`~/.pi/agent/sessions/**/<id>` file lookup);
   - RC probes the upstream (`/api/status`) and caches the answer.

Everything else calls `next()` and is handled by the official routers —
local Claude Code and Codex behave exactly as stock.

### Merged `/api/sessions`

For `provider` absent or `"claude"`, the list merges the official default
provider + RC + pi, all tagged `provider: "claude"`, newest first.

**RC transcript dedupe:** the RC fork runs the real `claude --remote-control`
CLI, which writes its transcript to `~/.claude/projects/` — so a live RC
conversation would otherwise appear twice (once as the `cse_…` RC session,
once as a local claude session). The claude CLI embeds a `bridge-session`
marker in those transcripts:

```json
{"type":"bridge-session","sessionId":"<local-uuid>","bridgeSessionId":"cse_…",...}
```

The bridge scans each local session's transcript head
(`src/rc-transcripts.mjs`) for the marker, hides the local duplicate, and
borrows its title + cwd for the RC entry (the upstream lists RC entries with
`cwd: ""` and a terminal-name title). When the RC session dies, the upstream
(active-only list) drops it and the transcript automatically becomes a plain
local session again.

### Live streaming (SSE)

- **Local/Codex:** the official ring buffer + `/api/events` (untouched).
- **Extended sessions:** a shared hub (`src/hub.mjs`) with the same semantics
  the phone expects — `Last-Event-ID` resume, watermark gap replay for a
  returning sole client, full replay on `needReplay=true`, 8s heartbeat, and
  idle re-assertion (a `status: idle` frame is replayed to a reconnecting
  client when the session is idle, never while busy).
- **RC** additionally runs a per-session **relay pump**
  (`src/upstream-pump.mjs`): it holds the upstream `/api/events?sessionId=…`
  stream open, dedups by monotonic upstream id (re-baselining after an
  upstream generation reset), and feeds frames into the local ring + hub.
  The pump stops when the session goes idle with no local clients.

## Architecture map

```
bin/even-bridge.mjs          CLI: official config machinery + bridge flags
src/server.mjs               superserver entry (mirrors official dist/index.js)
src/ext-router.mjs           ownership-intercepting router + merged /sessions
src/ownership.mjs            session-ID → provider registry (claim/probe/forget)
src/hub.mjs                  phone-facing SSE for extended sessions
src/upstream-pump.mjs        RC relay pump (upstream SSE → local ring + hub)
src/rc-transcripts.mjs       bridge-session marker scan (RC twin dedupe)
src/providers/claude-remote.mjs  RC proxy provider (HTTP → fork terminal host)
src/providers/pi/            vendored pi provider (MIT — see NOTICE.md)
  framing.mjs                JSONL RPC framing
  rpc-client.mjs             pi --mode rpc client (spawn, request/response)
  session.mjs                one pi session: prompt → streaming messages
  session-files.mjs          ~/.pi/agent/sessions disk listing/lookup
  summarize.mjs              tool-call summaries (ASCII, official style)
  provider.mjs               pi provider (owns sessions, probes from disk)
test/                        node:test suites (hermetic, no real provider state)
scripts/check-upstream.mjs   asserts the official dist exports we rely on
scripts/smoke-import.mjs     imports every module (catches bad import paths)
```

## API surface

The wire protocol is the official even-terminal one (`/api/sessions`,
`/api/prompt`, `/api/status`, `/api/messages`, `/api/events`,
`/api/sessions/:id/history`, `/api/permission-response`,
`/api/question-response`, `/api/interrupt`, `/api/info`, …). Extended sessions
flow through the same endpoints; the phone needs no changes.

## Development

```sh
npm test                    # node --test, hermetic (no ~/.claude / ~/.pi access)
npm run check               # upstream export audit + module-graph smoke import
npm run dev                 # node --watch
```

## Notes & limitations

- The official package is compiled-only; `scripts/check-upstream.mjs` locks in
  the exact export surface this bridge depends on so a future package update
  breaks loudly instead of silently.
- RC session ownership is probed via the upstream's `/api/status`; if the
  fork is down, RC entries drop out of the merged list with a log warning
  (local + pi are unaffected).
- Pi sessions are spawned with `pi --mode rpc` in the project cwd; session
  files live under `~/.pi/agent/sessions/`.
- On the wire, extended sessions are all `provider: "claude"` — the phone
  filters its list to known providers, so a `"pi"` tag would make pi sessions
  invisible.

## Attribution

See [NOTICE.md](./NOTICE.md). The pi provider is vendored from
[even-terminal-pi](https://github.com/lallenlowe/even-terminal-pi) (MIT,
© lallenlowe); RC reliability semantics are mirrored from the author's own
`claude-remote-terminal` fork.
