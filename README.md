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
  fork binary is present, and `even-pi-tmux.service` when `tmux` is on PATH) —
  existing unit files are left untouched;
- disables the old official `even-terminal.service` if it is active (port 3456
  conflict); set `KEEP_OFFICIAL=1` to opt out;
- `systemctl enable --now` them and prints a status summary.

```sh
sudo scripts/install-services.sh
# overrides: HOST_USER, EVEN_BRIDGE_DIR, NODE_BIN, TOKEN_ENV_FILE,
#            RC_BRIDGE_BIN, RC_BRIDGE_PORT, KEEP_OFFICIAL,
#            EVEN_PI_CWD, EVEN_PI_TMUX_SESSION
```

### Reboot persistence (all three units are `enabled`)

- **`even-bridge`** and **`claude-remote-bridge`** come back at boot on their
  own (`Restart=always` if they crash mid-run).
- **`even-pi-tmux`** (oneshot, `RemainAfterExit=yes`) re-creates the tmux
  session that hosts the terminal pi. The glasses can only **inject** prompts
  into a pi running under tmux — a raw terminal pty isn't injectable from
  another server-side process — so without this, a reboot leaves the pi
  conversation terminal-less, and any ad-hoc `pi` opened in a plain terminal
  makes the single-writer guard block glasses prompts ("driven from a terminal
  that is not in tmux"). `scripts/ensure-pi-tmux.sh` resumes the **newest**
  conversation in `EVEN_PI_CWD` (default `~/github`) via `pi --session <file>`,
  and **refuses to start a second driver** while a live (non-stopped) pi
  already runs in that cwd outside tmux — so `enable --now` is always safe.
  The unit also loads `/etc/even-terminal.env` (`EnvironmentFile=`) so the
  tmux pi gets `LETS_CODE_TOKEN` (the lets-code provider in pi's
  `models.json` needs a non-empty value or pi hangs before its first model
  call); the script passes it into the pane explicitly (`tmux -e`), which
  also covers a pre-existing tmux server started without it.

After a reboot: the bridge is up; the tmux pi is up and has resumed your last
conversation; `tmux attach -t even` to see it. If the pi in the pane ever dies,
`systemctl restart even-pi-tmux` recreates it.

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
   - RC probes the upstream (`/api/status`) and caches the answer;
   - cc-local probes from disk (`~/.claude/projects/*/<id>.jsonl` file
     lookup) — local Claude Code sessions the official SDK list would skip
     while they are live.
3. the prompt creates a **new session** (no `sessionId`): it routes to pi
   by default. The phone sends `provider: "claude"` as an app-level default
   (from the pairing URL's `defaultProvider`), not a user choice, so it is
   deliberately not honored for new sessions. Override with
   `EVEN_BRIDGE_NEW_SESSION_PROVIDER` (`pi` default; `claude-remote` for an
   RC session; `official`/`claude` for stock Claude Code).

Everything else calls `next()` and is handled by the official routers —
codex sessions and Claude Code sessions the official dist launched itself
behave exactly as stock.

### Merged `/api/sessions`

For `provider` absent or `"claude"`, the list merges the local slot + RC +
pi, all tagged `provider: "claude"`, newest first. The **local slot is a
plain disk scan of `~/.claude/projects/`** (`src/cc-transcripts.mjs`):
the official SDK list skips in-progress Claude Code sessions and carries
no live status, so the disk is the ground truth — every local CC session
shows up (title from the newest `ai-title`/`agent-name`, else the first
prompt; cwd from the entries), with `busy` while a terminal `claude`
is driving that conversation (per Claude Code's own
`~/.claude/sessions/<pid>.json` record — other claudes in the same cwd
don't count; the record's busy/idle wins) or the transcript is being
written. The SDK list is kept
only as a fallback if the scan finds nothing.

**RC transcript dedupe:** the RC fork runs the real `claude --remote-control`
CLI, which writes its transcript to `~/.claude/projects/` — so a live RC
conversation would otherwise appear twice (once as the `cse_…` RC session,
once as a local claude session). The claude CLI embeds a `bridge-session`
marker in those transcripts:

```json
{"type":"bridge-session","sessionId":"<local-uuid>","bridgeSessionId":"cse_…",...}
```

The CLI re-writes the marker on every RC reconnect, possibly with a
**new** `cse_…` id, so the latest one wins: the bridge scans each local
session's transcript tail, then head (`src/rc-transcripts.mjs`), for the
marker, hides the local duplicate, and
borrows its title + cwd for the RC entry (the upstream lists RC entries with
`cwd: ""` and a terminal-name title). When the RC session dies, the upstream
(active-only list) drops it and the transcript automatically becomes a plain
local session again.

### Live streaming (SSE)

- **Local/Codex:** the official ring buffer + `/api/events` (untouched).
- **Local CC (terminal-driven):** same treatment as pi — ring seeded from
  the on-disk transcript on first open, then a 1s-poll transcript watcher
  (`src/cc-watch.mjs`) tails `~/.claude/projects/<cwd>/<id>.jsonl` and
  feeds new entries into the ring as `user_prompt` / `text_delta` /
  `tool_start` / `tool_end` (converted by `ccEntriesToWire`, with
  persistent tool-call bookkeeping across batches). The watcher only runs
  for sessions the bridge seeded — officially-launched sessions stream
  through the official pipeline, and double-watching would duplicate
  frames.
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
- **Pi** additionally seeds its ring from the on-disk transcript on first
  open (`seedTranscript` in `src/providers/pi/provider.mjs`): the bridge's
  ring is in-memory, so after a restart an unloaded pi session would
  otherwise appear empty in the phone until the next prompt. The seeder
  parses `~/.pi/agent/sessions/**/<id>.jsonl` and feeds the ring the same
  wire shapes the live provider emits (`user_prompt` / `text_delta` /
  `tool_start` / `tool_end`), once per session, no-op when the session is
  already live or the ring is populated. The ring's 500-message cap applies,
  so very long sessions surface their most recent context. Merged
  `/api/sessions` rows for the extended lists also carry a **live status**
  (filled from each provider's `getSessionStatus`, mirroring the official
  local list), so the phone shows a running pi session as `busy` instead of
  a stale `null`/`idle`.

### Pi cross-surface sync (single-writer routing)

A pi session file is a shared append-only log, but only **one** driver can
process prompts for it at a time: if a terminal pi TUI and a bridge-spawned
`pi --mode rpc` both attach to the same session, the second one wedges and
silently drops prompts. The bridge therefore enforces a single-writer rule
(`src/providers/pi/provider.mjs` + `detect.mjs`):

- **Terminal pi driving the session** (detected by probing `/proc` for a
  `pi` process in the session's cwd **and** identifying which conversation
  that terminal is running — a cwd can host many pi sessions, so the pane's
  on-screen content is matched against each candidate transcript's recent
  prompt text; with no tmux pane, the freshest transcript in the cwd is
  used): the terminal owns the conversation. A **stopped** pi (Ctrl+Z /
  SIGSTOP, `T` state in `/proc/<pid>/stat`) is suspended — it reads no
  input and drives nothing — so it never counts as the external driver
  (a leftover zombie like that would otherwise block every glasses prompt
  for the session until it is killed).
  - If that terminal is in **tmux**, glasses/phone prompts are delivered
    into the pane with `tmux send-keys`/`paste-buffer` (single writer —
    the terminal pi handles them exactly as if typed). The terminal's
    responses then flow back to the phone through the transcript watcher
    below.
  - If it is **not** in tmux, the phone gets a clear error ("driven from a
    terminal that is not in tmux — run it under tmux to send") instead of
    a silent drop. **To send to a terminal pi from the glasses, run the
    terminal session under tmux:** `tmux new; cd <project>; pi --resume`.
  - A bridge child that got superseded this way is killed on the next
    prompt (it is wedged and would eat prompts).
- **Same cwd, but a *different* conversation:** an external terminal pi in
  the cwd that is *not* actively writing this session's transcript (i.e. the
  freshest transcript is another one) does **not** block us. The bridge
  spawns/resumes its own `pi --mode rpc --session <file>` for this session —
  distinct transcripts, so a second writer is safe and the prompt is not
  mis-injected into the terminal's conversation (the failure that used to
  eat glasses prompts).
- **No terminal pi for that cwd:** the bridge spawns/resumes its own
  `pi --mode rpc --session <file>` and drives it directly (the phone is the
  sole driver).
- **Transcript watcher** (`src/providers/pi/watcher.mjs`): while a session
  has an open SSE stream (or a live bridge session), the bridge tails the
  transcript file (1s poll) and feeds NEW entries written by an external
  driver into the ring — so terminal activity appears on the glasses in
  near-real time even though the bridge's ring normally only sees its own
  `emit()`. A session whose bridge child is mid-turn is skipped (its file
  growth is the RPC turn already streaming into the ring); external-driver
  attribution is the same pane-content/freshest-transcript test used for
  routing. History is never re-fed by the watcher (seeding owns that);
  entries are deduped by transcript id.

  Tuning: `EVEN_BRIDGE_PI_WATCH_MS` (poll interval), `EVEN_BRIDGE_PI_TMUX=0`
  (disable tmux delivery), `EVEN_BRIDGE_PI_BIN` (pi binary).

- **Live-stream gap recovery** (`src/hub.mjs`): the phone reaps its idle SSE
  sockets (~4 min) and reconnects stream-only with **no** Last-Event-ID. A
  plain delivery-watermark replay is unsafe — `res.write()` succeeds into the
  kernel buffer of a black-holed (half-open) connection (phone screen asleep,
  radio down, OS still ACKing), so the watermark advances past bytes the
  phone never saw and a reply looks "cut off mid-sentence" until the session
  is re-opened. A stream-only reconnect therefore replays the **whole
  most-recent turn** from the shared ring (cap 1500), starting at the last
  `user_prompt` frame (every turn — live or seeded from the transcript after
  a restart — begins with exactly one; seeded turns carry no status frames,
  which is why the anchor must not be status-based; the last-`status:idle`
  logic remains only as a fallback for rings without a prompt marker).
  (An earlier version anchored on the *last non-idle* status, which lands on
  `text_end` near the tail and silently dropped the prompt + reply body.)
  The app merges by message id, so re-sent frames don't duplicate. An 8s
  `:heartbeat` (plus idle re-assertion and aggressive socket keepalive) keeps
  the stream from going idle in the first place.

### Local Claude Code sessions (single-writer routing)

The official dist can only stream Claude Code sessions **it** launched (its
SDK list skips live sessions, it has no external-transcript watcher, and
`prompt()` would spawn a parallel `claude` child while a terminal one is
running). The bridge adds the missing pieces for terminal-driven local CC
sessions, mirroring the pi architecture (`src/cc-local.mjs` provider +
`cc-transcripts.mjs` + `cc-watch.mjs` + `findExternalClaude` /
`findClaudeTmuxPane` in `detect.mjs`):

- **Listed:** the `/api/sessions` local slot is a disk scan (above), so a
  live terminal CC session appears with a `busy` status.
- **Streamed:** opening the session seeds the ring from the transcript and
  starts the transcript watcher — terminal activity (text + tool calls,
  `Bash …` / `Edit …` summaries via `summarizeCcToolCall`) flows to the
  phone exactly like pi.
- **Prompt guard:** a phone prompt for a session a terminal `claude` is
  driving is **never** answered by spawning a parallel child. Ownership is
  per conversation: a terminal `claude` whose `~/.claude/sessions/<pid>.json`
  names another session is ignored; one with no record is conservatively
  treated as driving any session in its cwd.
  - owning `claude` in a tmux pane → delivered into **its** pane; unknown
    owner + a `claude` pane in the cwd (the pane's screen
    shows this conversation's recent prompts, or it's the newest CC
    session in the cwd) → the prompt is delivered into the pane with
    `tmux send-keys`; the terminal CC processes it and the watcher streams
    the reply back;
  - terminal `claude` alive but unreachable → a clear **409** ("running in
    a terminal the bridge can't reach — reply there or put it in tmux");
  - nothing external → pass-through to the official router, which owns
    spawn/resume for dead or officially-launched sessions (and the bridge
    stops its watcher at that point so frames can't double).

  The `/proc` scan excludes the CC background daemon family
  (`claude daemon run`, `bg-pty-host`, `bg-spare` — they host, not drive),
  `--remote-control` processes (owned by the RC fork), STOPPED
  processes, and bridge children (ancestor chain reaching the bridge pid).
  Disable the whole extension with `EVEN_BRIDGE_CC_DISABLED=1`.
- **History:** `/api/sessions/:id/history` is served from the disk
  transcript in the official wire shape (`{role, text}` only — tool cards
  are a live-feed feature, matching official sessions).

## Architecture map

```
bin/even-bridge.mjs          CLI: official config machinery + bridge flags
src/server.mjs               superserver entry (mirrors official dist/index.js)
src/ext-router.mjs           ownership-intercepting router + merged /sessions
src/ownership.mjs            session-ID → provider registry (claim/probe/forget)
src/hub.mjs                  phone-facing SSE for extended sessions
src/upstream-pump.mjs        RC relay pump (upstream SSE → local ring + hub)
src/rc-transcripts.mjs       bridge-session marker scan (RC twin dedupe)
src/cc-transcripts.mjs       local CC transcript scan/convert (list, meta, wire)
src/cc-watch.mjs             local CC transcript tailer (external -> ring)
src/cc-local.mjs             cc-local provider (seed/watch/single-writer guard)
src/providers/claude-remote.mjs  RC proxy provider (HTTP → fork terminal host)
src/providers/pi/            vendored pi provider (MIT — see NOTICE.md)
  framing.mjs                JSONL RPC framing
  rpc-client.mjs             pi --mode rpc client (spawn, request/response)
  session.mjs                one pi session: prompt → streaming messages
  session-files.mjs          ~/.pi/agent/sessions disk listing/lookup
  summarize.mjs              tool-call summaries (ASCII, official style)
  provider.mjs               pi provider (owns sessions, probes from disk)
  detect.mjs                 /proc + tmux detection (pi & local CC)
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
  files live under `~/.pi/agent/sessions/`. When a terminal pi is driving a
  session, the bridge routes to it via tmux instead of spawning a second
  instance — see "Pi cross-surface sync" above.
- **Model auth env:** a bridge-spawned pi inherits the **systemd** environment,
  not your interactive shell's. pi refuses to call a provider whose `$VAR`
  apiKey (see `~/.pi/agent/models.json`) resolves to nothing, so the session
  hangs silently before its first model call. `install-services.sh` handles
  this: it copies `LETS_CODE_TOKEN` from the host user's environment when it
  can, otherwise writes a placeholder (the vllm endpoint on this network does
  not validate keys — any non-empty value works). If you set up the unit by
  hand, add the variable to `/etc/even-terminal.env` (root:root 600) and
  restart; use the real key if your endpoint validates it.
- On the wire, extended sessions are all `provider: "claude"` — the phone
  filters its list to known providers, so a `"pi"` tag would make pi sessions
  invisible.
- **Fork-token compatibility:** the bridge also accepts the
  `claude-remote-terminal` fork's bridge token
  (`~/.config/claude-remote-terminal/bridge-token`, read at startup) in
  addition to its own `BRIDGE_TOKEN`. Phones already paired with the fork's
  terminal host (e.g. through an nginx vhost pointing at port 8791) keep
  working against the unified bridge without re-pairing; point that vhost's
  `proxy_pass` at the bridge (port 3456) to get the merged session list.

## Attribution

See [NOTICE.md](./NOTICE.md). The pi provider is vendored from
[even-terminal-pi](https://github.com/lallenlowe/even-terminal-pi) (MIT,
© lallenlowe); RC reliability semantics are mirrored from the author's own
`claude-remote-terminal` fork.
