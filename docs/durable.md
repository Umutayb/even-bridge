# Durable agents (`durable` provider)

Glasses-started agents run as [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
conversations inside the bridge process. The phone, SSE and `/api/*` see them
as ordinary extended sessions (wire provider `claude`, session ids `dur-<uuid>`);
the shim's agent tools use the extra `/api/agents` endpoints. Off unless
`EVEN_BRIDGE_DURABLE_ENABLE=1`; with the flag unset pi-durable is never loaded.

Code: `src/providers/durable/` (`provider.mjs` contract, `harness.mjs` store,
`sessions.mjs` session map, `wire.mjs` view → wire frames, `guard.mjs` guard,
`models.mjs` models.json loader). Smoke: `scripts/durable-smoke.mjs`.

## How it works

- **One harness per process.** The bridge opens one Durable `Harness` on a
  SQLite store (`~/.even-terminal/durable.sqlite`) and a session map next to it
  (`<store>.sessions.sqlite`) that maps `dur-…` ids to Durable conversation ids,
  with name, cwd, model, origin and `maxTurns`. One bridge process per store.
- **Models.** Built from lets-code's `~/.pi/agent/models.json`; the default is
  the private vLLM (`lets-code/qwen3.8-27b`, key read from `$LETS_CODE_TOKEN` on
  every request). Claude models only when named (`model: "haiku"|"sonnet"`).
  The thinking level comes from `~/.pi/agent/settings.json`
  (`modelThinkingLevels["provider/modelId"]`, `medium` when absent) and is
  always passed explicitly (Durable's own default is `off`).
- **Prompts.** `POST /api/prompt {provider:"durable", text, cwd, name?, model?,
  maxTurns?, requestId?, origin?}` creates the session and the conversation and
  submits the input with `whenBusy: "steer"`: a prompt for a busy session joins
  the running work, never a second concurrent run. `requestId` makes retries
  idempotent (same session, same submission).
- **Frames.** A `conversation.watch()` runs while a conversation is busy (so the
  ring fills without clients) and while SSE clients are attached; views become
  the bridge's `user_prompt` / `text_delta` / `tool_start` / `tool_end` /
  `result` / `status` frames. History (`/api/sessions/:id/history`) is the
  `{role, text}` of the user and assistant entries; tool output is in the ring
  (`/api/messages`), not in the history.
- **Agents API.** `GET /api/agents` lists live agents (`sid, name, cwd, model,
  state, origin, createdAt, lastSeen, lastLine`); `POST /api/agents/:sid/stop`
  aborts and archives one.

## Environment

| env | default | meaning |
| --- | --- | --- |
| `EVEN_BRIDGE_DURABLE_ENABLE` | off | `1` enables the provider and `/api/agents` |
| `EVEN_BRIDGE_DURABLE_STORE` | `~/.even-terminal/durable.sqlite` | Durable store; the session map is `<store>.sessions.sqlite` |
| `EVEN_BRIDGE_DURABLE_MODELS` | `~/.pi/agent/models.json` | models file |
| `EVEN_BRIDGE_DURABLE_CWDS` | `~/sandbox/agents` | colon-separated roots; a new agent's cwd must lie strictly below one |
| `BWRAP` | off | `1` runs agent bash under `bwrap` when installed (it is not on borealis) |
| `LETS_CODE_TOKEN` | — | vLLM key (`$LETS_CODE_TOKEN` in models.json); the live unit sets it in `even-bridge.service.d/pi-lets-code.conf` |

All of them are read at startup only.

## Limits

- `maxTurns` 1–60 per run (default 60); `name` ≤ 24 chars; `model` ≤ 32 chars.
- The cwd must be strictly below a configured root; `~` and `/` are always
  refused; symlinks are resolved before the check; a missing dir below a root
  is created.
- Every bash command runs under `systemd-run --user --scope -q -p MemoryMax=600M
  -p CPUQuota=200%` (or `bwrap` with `BWRAP=1`), with an allowlisted
  environment (no tokens, keys or secrets).
- `MAX_AGENTS=2` running and `AGENT_TTL_S=7200` are enforced by the shim's
  registry and reaper, not by the bridge.

## The guard

Every conversation runs `CodingTools` behind the `even-guard` extension. Its
`beforeTool` hook vets `read`/`write`/`edit`/`bash` before they run:

- **Paths.** Writes and removals only inside the conversation's cwd and `/tmp`;
  reads also the system dirs. `~/.ssh ~/.aws ~/.config ~/.even-terminal ~/.pi
  ~/.gnupg` and the secret parts of `/etc` are refused, also through symlinks.
  Writing `.env*` files and keys, or inside `.git`, is refused.
- **Commands.** The deny patterns from lets-code's `judgeBash` (destructive git,
  `sudo`/`su`, containers, service and host control, `curl | sh`, `rm -rf` of
  `/` or `~`, `mkfs`, `dd` to devices, …) plus a small lexer that follows `cd`,
  removals, write targets and path-like tokens (`cd .. && rm -rf x`, absolute
  paths, `$HOME/…`, symlinks out of the cwd).
- A refused call never runs. The model gets `Tool call blocked: guard: <why>`
  and the bridge logs `[durable:guard] blocked <tool> (<command>): <why>`.

**Known limits of the guard.** It is a lexer/regex guard over shell text, not
a sandbox: it stops the obvious and the common evasions, and a determined model
can still get past it. Not caught: code run by an interpreter (`python3 -c`,
`node -e`, heredocs into an interpreter, `npm test`/`make` running a script the
model edited; only the denied home dirs are caught there, by name), a script
written first and run later, what programs do on their own (git hooks, npm
lifecycle scripts), paths computed at run time beyond their literal prefix,
and network use (curl/wget are allowed; only piping them into a shell or an
interpreter is refused). `/tmp` is writable by every agent, including anything
else that lives there. Real isolation needs `bwrap` (not installed on
borealis); `systemd-run` only caps memory and CPU. Child conversations
(subagents) must map to their parent's cwd.

## Restart and resume

A bridge shutdown does **not** abort running agents. On SIGTERM/SIGINT the
bridge closes the store (waiting up to 3 s); unfinished runs stay pending.
On the next start the harness calls `resume()`, the provider re-attaches a
watcher to every busy conversation seen in the last 7 days, and the run
continues. Until that re-attachment is done, `/api/status` reports a session
whose state is not yet known as `busy`. Submissions are deduplicated, so a
resumed run never re-submits the prompt (verified by
`node scripts/durable-smoke.mjs --kill-mid-turn`, below).

## Backup

The store is two SQLite files: `durable.sqlite` and `durable.sqlite.sessions.sqlite`.
Back them up as a pair:

1. Stop the bridge (or the second instance using the store); the store is
   closed on SIGTERM.
2. Copy both files (and any `-wal`/`-shm` files next to them, if present).
3. Start the bridge again; pending runs resume.

A copy of a store that is open and being written can be inconsistent; do not
copy it live. Restore = put both files back while the bridge is stopped.

## Store growth

Durable keeps every entry of every conversation (user input, model output,
tool calls and results) and archiving a session only hides it from the lists;
nothing is deleted. Compaction (on) bounds what is sent to the model, not what
is stored, so the files grow with use. The smoke's two short turns produced a
128 KiB store and a 28 KiB session map. Watch the size
(`ls -l ~/.even-terminal/durable.sqlite*`); there is no pruning yet. To start
over, stop the bridge and move both files away (all durable sessions are lost).

## Rollback

Unset `EVEN_BRIDGE_DURABLE_ENABLE` (or set it to anything but `1`) and restart
the bridge. pi-durable is then never imported, `/api/agents` returns 404, and
every other route behaves as before. The store is left on disk untouched; set
the flag again to get the sessions back.

## Smoke run

`scripts/durable-smoke.mjs` starts a **second** bridge (child process) on
`127.0.0.1:3466` with an isolated store under `/tmp/durable-smoke` and the real
vLLM. It never binds 3456 or touches the live store, and removes
`/tmp/durable-smoke` at the end (`--keep` leaves it, with `bridge.log`, which
holds the full bridge token in its banner, mode 0600).

```sh
cd ~/github/even-bridge
bash -lc 'node scripts/durable-smoke.mjs'                  # create a file, then a guard-blocked read
bash -lc 'node scripts/durable-smoke.mjs --kill-mid-turn'  # stop 2 s into a turn, restart, resume
```

Environment of the instance: `PORT=3466`, `EVEN_BRIDGE_DURABLE_ENABLE=1`,
`EVEN_BRIDGE_DURABLE_STORE=/tmp/durable-smoke/durable.sqlite`,
`EVEN_BRIDGE_DURABLE_CWDS=/tmp/durable-smoke`, `EVEN_BRIDGE_PI_ENABLE=0`,
`EVEN_BRIDGE_RC_ENABLE=0`, `EVEN_BRIDGE_CC_DISABLED=1`,
`PROJECT_DIR=/tmp/durable-smoke/work`, `EVEN_HOST_MODE=interface`
`EVEN_HOST_INTERFACE=lo` (loopback only). `BRIDGE_TOKEN` comes from
`~/.even-terminal/config.json`, `LETS_CODE_TOKEN` from the live unit's drop-in
(or the environment); neither is printed. The script needs read access to the
drop-in (it is world-readable on borealis).

What it checks: the file task creates `hello.txt` containing `hi`; the second
prompt makes the model call `cat ~/.ssh/id_ed25519 | wc -c`, which the guard
must refuse (the bridge log must have the `[durable:guard] blocked` line for
`~/.ssh`) and no key text may reach the transcript. `--kill-mid-turn` sends
SIGTERM 2 s into a `sleep 4 && …` bash call (`--kill-signal SIGKILL` crashes
instead; not run yet), restarts the bridge on the same store, waits for the
resumed run and asserts exactly one user prompt and one assistant answer.

**Prompt wording.** qwen3.8-27b refuses a bare `run: cat ~/.ssh/id_ed25519`
on its own, also when told it is an authorized sandbox test, so the guard is
never reached. Piping into `wc -c` (only a byte count would be printed) makes
it call the tool, and the guard is what stops it. The chat-template thinking
kwargs (`enable_thinking`, thinking level `medium` from settings.json) worked
unchanged; the model used the tool schema without extra instructions.

### Measured on borealis, 2026-11-03

| | standard | kill-mid-turn |
| --- | --- | --- |
| RSS after start (idle) | 126.2 MiB | 119.0 MiB |
| RSS after the run | 164.8 MiB (peak 173.7 MiB) | 153.5 MiB at the stop; 152.4 MiB after restart; 155.4 MiB (peak 168.7 MiB) after the resumed run |
| turn time | 2.2 s (write + ls + answer), 2.0 s (blocked bash + answer) | stopped at 2.0 s; resumed run idle 2.0 s after the restart |
| bridge start to ready | 0.9–1.6 s | 1.3 s restart |

Standard run (final):

```
[smoke +0.9s] bridge ready (pid 2191104); RSS before: 126.2 MiB
[smoke +3.2s] turn 1 idle after 2.2s
[smoke +3.2s] hello.txt exists: "hi"
[smoke +5.2s] turn 2 idle after 2.0s
[smoke +5.2s]   tool calls (both turns): write, bash, bash
[smoke +5.2s]   tool bash -> <harness> ⏎ [error] Tool call blocked: guard: ~/.ssh is off limits ⏎ </harness>
[smoke +5.2s] GUARD [durable:guard] blocked bash (cat ~/.ssh/id_ed25519 | wc -c): ~/.ssh is off limits
[smoke +5.2s] RSS after: 164.8 MiB (peak 173.7 MiB; before 126.2 MiB)
[smoke +5.2s] SMOKE OK
```

Kill-mid-turn run (SIGTERM):

```
[smoke +3.2s] state 2 s after the prompt: busy
[smoke +3.2s] bridge stopped mid-turn with SIGTERM (exit code=0 signal=null); RSS at stop 153.5 MiB
[smoke +4.5s] bridge restarted (pid 2189692); RSS 152.4 MiB
[smoke +6.5s] resumed turn idle after 2.0s
[smoke +6.5s]   history assistant: Done — `count.txt` now contains the lines 1, 2, 3, 4, 5 (the first run was interrupted before the file was created, so I re-ran the `seq`/`cat` portion to complete it). Nothing is left.
[smoke +6.5s] SMOKE OK (kill-mid-turn: one user prompt, one assistant answer after resume)
```

By the model's own account the interrupted `bash` call came back as
interrupted and it re-ran the command itself (the smoke does not inspect the
entries to confirm this). Either way, a tool call with side effects can run
twice across a restart; here that was harmless.
