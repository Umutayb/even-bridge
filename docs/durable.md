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
| `EVEN_BRIDGE_DURABLE_CWDS` | `~/sandbox/agents` | colon-separated roots; a new agent's cwd must lie strictly below one. Keep it at `~/sandbox/agents`: a root inside or covering the bridge checkout, `~/.local`, `~/.nvm`, `~/.even-terminal`, `~/.pi` or a `PATH` dir is dropped with a warning |
| `EVEN_BRIDGE_DURABLE_DEFAULT_CWD` | `<first root>/glasses` | cwd of a prompt that names none (created on demand); never `PROJECT_DIR` |
| `EVEN_BRIDGE_DURABLE_AGENTS` | `scout,general,worker,reviewer,researcher,tester` | comma-separated lets-code agents (`~/.pi/agent/agents/*.md`) the `subagent` tool offers. Agent files and this list are read **once at bridge start**; edits apply after a restart |
| `BWRAP` | off | `1` runs agent bash under `bwrap` when installed (it is not on borealis) |
| `LETS_CODE_TOKEN` | — | vLLM key (`$LETS_CODE_TOKEN` in models.json); the live unit sets it in `even-bridge.service.d/pi-lets-code.conf` (keep that drop-in mode 0600, root-owned) |
| `EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE` | off | `1` adds the lets-code engine (needs `EVEN_BRIDGE_DURABLE_ENABLE=1`): a prompt with `engine: "lets-code"` runs in an owned `lets-code --mode rpc` child (`--mandate ask --subagents --sandbox`, `-e even-guard.ts`) inside the scope `even-lc-<sid>`; banner `lc=on(sandbox,mem|nomem)` / `lc=off` |
| `EVEN_BRIDGE_LC_BIN` | `EVEN_BRIDGE_PI_BIN`, else `lets-code` | the lets-code launcher (`pi-inference` works too) |
| `EVEN_BRIDGE_LC_MAX_LIVE` | `1` | live lets-code children at once (an idle-kept child makes room; otherwise 429) |
| `EVEN_BRIDGE_LC_MEMORY_MAX` | `500M` | `MemoryMax` of `even-lc-<sid>.scope`, applied only when `/sys/fs/cgroup/cgroup.controllers` lists `memory` (not on borealis today: one startup warning, banner `nomem`) |
| `EVEN_BRIDGE_LC_SANDBOX` | on | `0` drops lets-code's `--sandbox` (tests only); on and without `bwrap`+`socat`, every lets-code start answers 503 |

All of them are read at startup only.

## Limits

- `maxTurns` 1–60 per run (default 60); `name` ≤ 24 chars; `model` ≤ 32 chars.
- The cwd must be strictly below a configured root; `~` and `/` are always
  refused; symlinks are resolved (on the deepest existing ancestor) and checked
  before anything is created; a missing dir below a root is created. A cwd
  inside or containing the bridge checkout, `~/.local`, `~/.nvm`,
  `~/.even-terminal`, `~/.pi` or a `PATH` dir is refused.
- Every bash command runs under `systemd-run --user --scope -q
  --unit=even-durable-<sid>-<startMs>-<n> -p MemoryMax=600M -p CPUQuota=200%` (or `bwrap`
  with `BWRAP=1`). Under the system unit there is no login session, so the
  provider defaults `XDG_RUNTIME_DIR=/run/user/<uid>` (and the user bus) when
  that dir exists and probes `systemd-run --user --scope -q true` once at
  start; if the probe fails, bash runs **without caps** (`wrapper=none` in the
  startup line, plus a warning). Scopes outlive the bridge unit, so every
  `even-durable-*.scope` is stopped before resume and at shutdown.
- The shell's environment is an allowlist (PATH, HOME, LANG, …): the bridge's
  `LETS_CODE_TOKEN`/`BRIDGE_TOKEN` are not in it. That is **not** the same as
  "agents cannot read tokens" — see *Residual exposure* below.
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
- **Secrets.** `/etc/systemd` (unit drop-ins hold `Environment=` tokens),
  `/etc/even-terminal.env` and `/run/user` are refused for reading and
  writing, and `/proc/self/environ`/`cmdline` are no longer readable. Every
  absolute (or `~`/`$HOME`) path anywhere in the command text, also inside
  quoted interpreter code and with globs (`/etc/sys*/…`, `/etc/systemd/**`,
  `/etc/[s]ystemd`), is matched against the denied dirs; a recursive read of
  an ancestor of one (`grep -r … /etc`, `find /etc …`, `rg`, `tar`, …) is
  refused, and so is a `cd` into such an ancestor (`cd /etc`), so relative
  paths after it cannot reach them. `systemctl cat/show/list-unit-files/edit`
  and `journalctl` are refused.
- **Host control.** `systemctl` start/stop/…, `systemctl --user`,
  `systemd-run`, `loginctl`, `crontab`, `pkill`/`killall`, `tmux`, `screen`,
  `busctl`, `dbus-send`, `gdbus`, and `ps` with process environments (`ps e`,
  `ps eww`, `ps auxe`, `ps -E`) are refused.
- A refused call never runs. The model gets `Tool call blocked: guard: <why>`
  and the bridge logs `[durable:guard] blocked <tool> (<command>): <why>`.

**Residual exposure (same uid).** Agent bash runs as the bridge's user, so
anything that user can read, a determined agent can read. The routes that stay
open are:

- the bridge's own `/proc/<pid>/environ` (it holds `LETS_CODE_TOKEN`): the
  text scan only sees literal paths, so a path built at run time inside an
  interpreter (`python3 -c` with string concatenation, `os.listdir("/proc")`)
  or a script the agent wrote first and runs later still reaches it;
- any program that reads files for the agent on its own: a build script, a
  test runner, an npm lifecycle script, a git hook, a tool with a config file
  — the guard judges the command line, not what the program then opens;
- every file the bridge user can read that the denied list does not name.

Only `bwrap --unshare-pid` (not installed) or running agents as a separate
uid closes this. Because of it, the token drop-in **must** be made
unreadable to the bridge user at deployment: `sudo chmod 0600
/etc/systemd/system/even-bridge.service.d/pi-lets-code.conf` (root-owned;
deployment checklist item 1) — systemd still reads it, and agents no longer
can even by a route the guard misses. The token then exists only in the
bridge process's environment (first bullet). Read-only agents still get through with
`curl -o`, `tar x`, `chmod`, `npm i` and other programs that write on their
own. `NoNewPrivileges=yes` in the unit breaks a setuid `bwrap`, so enabling
`BWRAP=1` later needs a non-setuid (user-namespace) `bwrap`.

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

## Subagents

Every durable conversation has a `subagent` tool that runs one of the allowed
lets-code agents (`EVEN_BRIDGE_DURABLE_AGENTS`) as an owned child conversation
in the same cwd, behind the same guard (`role: readonly` agents may not
write). The child gets lets-code's header (`You are the "<name>" agent.
<description>`) plus the file's body and its `append_prompt` file (resolved
inside `~/.pi/agent`) as instructions; an agent with neither is not offered.
The wait is bounded by the file's `timeout` (`N`, `Ns`, `Nm`, `Nh`; default
900 s); the parent gets the last 4000 characters of the child's answer.
Agent files are read **once at bridge start**: restart the bridge to pick
up edits.

## The lets-code engine

`POST /api/prompt` with `provider: "durable"` and **`engine: "lets-code"`** (`native`
is the default; anything else is a 400 `'engine' must be one of native, lets-code`)
starts the session as an owned lets-code child instead of in-process tools. Off
(`EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE` unset) such a prompt is a 400 `the lets-code
engine is off`. The child is `lets-code --mode rpc [--session <file>] --name <label>
--mandate ask --subagents --sandbox --session-dir <store dir>/lc-sessions/<sid>
-e src/providers/durable/lc/even-guard.ts`, inside `systemd-run --user --scope -q
--collect --unit=even-lc-<sid> [-p MemoryMax=… -p MemorySwapMax=0] -p CPUQuota=200%`
(with a memory controller the child is OOM-killed at its cap instead of swapping into
zram; `--collect` plus a
`systemctl --user reset-failed even-lc-<sid>.scope` before each spawn: a scope that an
OOM kill left failed never blocks the next spawn's unit name).

- **Child token.** The bridge passes no token or key (allowlisted env). lets-code reads
  `~/.config/lets-code/config` itself and exports `LETS_CODE_TOKEN` to its pi, so that
  variable is in pi's environment anyway; the bridge's own `LETS_CODE_TOKEN` is not needed
  for lets-code sessions (only native durable sessions read it through models.json).
- **The even guard** (`lc/guard-core.mjs`) is a floor under lets-code's mandate: the denied
  dirs (~/.ssh ~/.aws ~/.config ~/.even-terminal ~/.pi ~/.gnupg, secret /etc files,
  /run/user) and guard.mjs's RULES. Writes outside the project are the mandate's (mode
  `ask` asks the glasses). The project's own `.pi/` dir is refused too (see next point).
- **Subagents.** lets-code starts subagents as plain `pi` processes in the same cwd,
  **without** the parent's `-e`. So at every spawn the bridge writes the guard to
  `<cwd>/.pi/extensions/even-guard.ts`; pi loads project extensions only for a trusted
  project, and the parent's `-e even-guard.ts` answers pi's `project_trust` event "yes,
  remember" for exactly its session cwd (pi records it in `~/.pi/agent/trust.json`).
  Live probe 2026-11-03: before this a subagent's `wc -c ~/.ssh/id_ed25519.pub` ran;
  after it, the subagent got `even-guard: ~/.ssh is off limits`. The guard file is added
  to the repo's `.git/info/exclude` (`/.pi/extensions/even-guard.ts`), so `git add -A`
  never commits it. write/edit of any path with a `.pi` segment ANYWHERE are refused (this
  project, a nested `sub/.pi`, a sibling session's project, an absolute path; inside an own
  factory worktree the segments are counted below the worktree, and `~/.pi` keeps its "off
  limits" reason), and bash commands naming `.pi`.
  **Known limit:** the bash block is text-based (`tar xf`, `git checkout`, `d=.p; …${d}i/…`
  pass it). So the `.pi` dirs are sealed (`lc/seal-core.mjs`, node builtins only): the guard
  file is rewritten when changed, and every other entry of `.pi` or `.pi/extensions` is moved
  to `<store dir>/lc-quarantine/<sid>/` (env `EVEN_GUARD_QUARANTINE` in the child). The seal runs
  **inside every pi of the project** (the `-e even-guard.ts` and the project-local guard both
  seal after each `tool_result`, for the project and, in a factory stage, its worktree), so a
  plant made by one subagent is undone before that subagent returns, i.e. before the next pi of
  a chain loads `.pi/extensions`; the model sees an `even-guard: removed …` note in that tool
  result. The bridge also seals at every spawn (a project it cannot seal gets no child: error
  frame `even-guard: could not seal …; lets-code was not started`), after every parent tool
  call, every second while a child lives, and on every factory watch tick (error frames
  `even-guard: removed …` / `…restored`).
  **Accepted window:** between the seal at spawn and pi loading its extensions a few hundred
  ms pass; a writer then exists only if another session shares the cwd or a factory stage of
  the same session still runs in a worktree. Nested `sub/.pi` dirs planted without naming
  `.pi` are not scanned (pi loads them only for a pi started in that subdir).
- **Repos that track `.pi`.** A new lets-code agent in a repo whose git tracks a `.pi` dir
  (top or nested) and a factory ticket there are refused 409 `{reason: "repo_tracks_pi",
  error: "this repo tracks a .pi dir; lets-code agents can't run here"}`: sealing would
  quarantine tracked files, which an agent or the factory then commits as deletions.
- **Forget.** `forgetSession` removes the session cwd's entry from `~/.pi/agent/trust.json`
  (unless another live lets-code session has the same cwd) and the entries of the factory
  worktrees it trusted (`record.trusted`).
- **Factory worktree.** A factory run works in
  `~/.pi/agent/lets-code-factory/<id>/work`; the guard treats that dir as the project
  when the run's `ledger.json` `repo` is the session cwd or below it (ruling 19), and keeps
  the rest of `~/.pi` off limits. `stopSession` leaves the factory dir to lets-code.
  The run's stage subagents are plain pi processes in that worktree: while a factory run
  may create one (after `/factory start`, at a checkpoint, on `/factory resume`), the
  engine gives each new worktree of this session's running/waiting runs the project guard,
  the git exclude and a pi trust entry (written under pi's own lock `trust.json.lock`, waited
  for asynchronously). A ledger whose `work` is not its own `<root>/<id>/work` is ignored.
  When the run leaves running/waiting (or its worktree is gone) the trust entry is dropped.
- **Experts are the operator's.** lets-code's "Enable the factory's experts?" confirm is
  answered No by the bridge with the error frame `factory experts must be enabled by the
  operator` (a glasses Yes must never change host-wide lets-code state), and
  `POST /api/agents/:sid/factory` with `on: true` (with or without a ticket; orchestration
  without the stage experts only raises expert dialogs that are answered No), and a new
  agent with `factory: true`, answer 409 `{error, reason: "experts_disabled"}` while
  `~/.pi/agent/lets-code-state.json` lacks any of developer, expert-reviewer,
  design-reviewer, tester, acceptance-judge (it is only read). The single-expert confirm
  "Enable the <name> expert?" is answered No the same way.
- **The factory toggle.** `POST /api/agents/:sid/factory {on, ticket?, howToRun?}` (only
  with the lets-code engine; without it the route falls through as on main) records the
  wish, waits for a child that is starting, then sends `/mode orchestration|ask` to a live
  child and answers `{ok, sessionId, factory, mode}` with `mode` = what lets-code
  acknowledged in this call (`null`: no live child, applied at the next spawn). Without the
  ack: 504 and the flag stays as it was. A ticket goes to `<cwd>/.factory/ticket-<ms>.md`
  and starts `/factory start <file>[ <howToRun>]` (how-to-run unquoted: one line, no
  quotes). The 200 comes before lets-code accepts the run: a refusal (only lets-code's own
  replies: "No ticket file …", "factory: …", the experts messages; other warnings such as
  the memory guard's are not) becomes an error frame
  `lets-code refused the factory start: …` and `lastError {text, at}` on the agent's
  `GET /api/agents` row (cleared by the next toggle). `factory` on a prompt to an existing
  agent is a 400 (use the toggle). The factory smoke (`scripts/durable-smoke.mjs --engine
  lets-code --factory`) needs the operator to have enabled the five experts first.
- **Restarts.** A prompt counts as delivered once lets-code accepted it (its response or
  any event after it, recorded as `sentTaskId`). After a restart a delivered run gets one
  cut-off prompt (or `/factory resume <id>`); an undelivered prompt is sent again as it was.
  A child that crashes while the bridge runs gets a crash prompt after an error frame
  `lets-code exited mid-turn; starting it again (attempt n of 6)`.

## Every session of both harnesses: listing and messaging (overseer, `EVEN_BRIDGE_OVERSEER_ENABLE=1`)

With the overseer on, one inventory covers every active session the bridge can see:
durable agents (native and lets-code), pi sessions (`~/.pi/agent/sessions`, terminal or
bridge children), local Claude Code sessions (`~/.claude/projects`) and Remote Control
sessions. It is one function, `sessionsList` in `src/overseer/host.mjs`, read by:

- the overseer's `sessions_list` tool (fenced as untrusted data, titles and last lines included);
- `GET /api/overseer/sessions[?all=1]` (Even AI's `list_sessions`): host-built fields only;
- the gated actions (`describe`): the label and kind a summary names.

The phone's `GET /api/sessions` keeps its own wire rows; it shares the RC-twin rule
(`src/session-twins.mjs`: a live RC session's local transcript is listed once, as the RC row).

A row (`/api/overseer/sessions`):

| field | meaning |
|---|---|
| `id`, `kind` | `durable` \| `pi` \| `cc-local` \| `rc` (+ `engine` for durable) |
| `label` | a bridge agent's name (its sid when it has none); otherwise `<folder>-<last 6 of the id>` in `[a-z0-9-]` (the TAIL: pi ids are UUIDv7 and RC ids ULID-like, whose heads are timestamps shared for hours). Unique within the inventory: colliding labels get a longer tail, then `-2`, `-3`. A session's own title is never used: it is text the session wrote. |
| `state` | `idle` \| `busy` \| `waiting` (a permission or question prompt, `requires_action`); no state, or a finished / failed turn, is idle; other words count as busy |
| `driver` | `bridge`, `terminal-tmux`, `terminal`, `rc`, `none` |
| `lastActivity`, `ageS` | epoch ms of the last write / seen, and its age |
| `canMessage`, `via` / `why` | see below |

Active = every non-archived durable agent (seen in 7 days), plus any other session that is
driven by a terminal or a bridge child, not idle, or touched within 12 h (`ACTIVE_WINDOW_MS`); an RC
row counts by its state and age; `all=1` drops that filter.
Each provider lists at most 10 rows.

Who can receive a message (`messageRoute`), and through which transport:

| kind | driver | transport (`via`) |
|---|---|---|
| durable | bridge | durable prompt (`steer` or `followUp`) |
| rc | rc | the Remote Control engine (`/api/prompt` upstream) |
| pi | `none` / `bridge` | pi RPC: the bridge's `pi --mode rpc` child, resumed with `--session` if needed (`pi-rpc`) |
| pi, cc-local | `terminal-tmux` | typed into the terminal's tmux pane (`tmux`); the terminal stays the only writer |
| pi, cc-local | `unknown` (the driver probe failed) | no (`driver-unknown`): never an RPC child next to a terminal that may own it |
| pi, cc-local | `terminal` | no (`terminal-no-tmux`) |
| cc-local | `none` | no (`no-terminal`): nothing runs it, and the bridge does not spawn a claude for a message |
| cc-local | `bridge` | no (`phone-claude`): the phone's Claude bridge runs it |

This supersedes the plan's Q7/Q8 rulings (terminal pi and cc-local observe-only), as the Task 6b
brief asks: a terminal in tmux receives a confirmed message; a terminal outside tmux never does,
and no session is ever driven twice.

Typing into a terminal is code execution if done carelessly, so the tmux route is narrow:

- The text is ONE plain line: any control character (newline, CR, ESC, C-…, DEL, C1, U+2028/2029)
  is refused, and so is a `/` or `!` after any leading whitespace or zero-width/format characters
  (`\p{Cf}`). Both at propose and again at execute, for every origin and for standing orders. A pi /
  Claude Code / RC target takes at most 140 characters from every origin, so the summary the user
  confirms shows all of it.
- It is typed literally: `tmux send-keys -t <pane> -l -- <text>`, then `send-keys -t <pane> Enter`
  as a separate key ("C-d", "Escape" or a leading "-" are characters, never key names or options);
  never through a paste buffer.
- The pane is bound to the terminal's own process: pi's external pid (with two pi terminals in one
  folder, the pane whose screen shows this conversation, else none), Claude Code's owner pid. Right
  before typing (after the per-pane gap) the pane must still run `pi` / `claude` with `pane_pid` an
  ancestor of that pid; a shell in the foreground (the program exited) is never typed into.
- Claude Code goes only through `cc.deliverToTerminal`: never the official router and never the
  Remote Control resume (`EVEN_BRIDGE_CC_RESUME_RC`), with no watcher change. pi RPC goes through
  `pi.prompt(…, {noTerminal: true})`. A terminal that went away, or took the session over, is
  `{blocked: true}` → the action fails with 409 and no reply watch starts; only a delivery is "sent".
- A message to an existing pi session over RPC runs the user's pi (its normal tools, no sandbox) in
  that session's own folder, which can be anywhere, as on the phone: the "agents work only below
  ~/sandbox/agents" constraint covers new agents, not messages to existing pi sessions.

`session_message` goes through the same gate as every action: the overseer proposes it (or
Even AI stages `message_session` and proposes it through `POST /api/overseer/actions` at the
user's yes), nothing runs before a confirm (`confirmFrameId`, 90 s expiry, one pending
overseer action, the `agents.disabled` kill switch, the audit log), text starting with `/` or
`!` is refused at propose and again at execute, the overseer's text is at most 140 characters.
The summary names the target's kind and label: `Send pi session 'notes-0a1b2c': "run the tests"?`
(`agent`, `pi session`, `Claude session`, `Claude RC session`). The route is probed again right
before the send. A Claude Code pane that did not take the text (the terminal went away) is a
failed action (409), never "sent". A standing order may cover messages to any of these kinds.

Replies reach the glasses through the outbox. After a confirmed message the target is polled
every 5 s for up to 30 min (in the bridge process; a restart ends the watch; three failed reads in
a row end it too) and its next status change becomes ONE outbox item of kind `reply`, tagged with
the action id:

- `<Kind> '<label>' replied.` with the answer in a separate `quote` field (the session's own words:
  defused, one line, at most 200 characters) when it is idle, its history tail changed since the
  send (compared by items, so an identical "Done." still counts), the newest item is an answer, and
  nothing changed for 15 s (a terminal pi reports idle throughout; its first "Let me look…" is not
  the reply);
- `<Kind> '<label>' is waiting for an answer.` when it stops at a permission or question prompt;
- `<Kind> '<label>' finished its turn without a new answer.` after a busy phase without one.

Even AI's "what's new" says the host text, then the quote as the session's words ("It says: …"),
filtered like overseer notes. The quote reaches only the outbox (never the overseer's context,
never an action).

## Restart and resume

A bridge shutdown does **not** abort running agents. On SIGTERM/SIGINT the
bridge closes the store (waiting up to 3 s); unfinished runs stay pending.
On the next start, before `resume()`, the provider stops leftover
`even-durable-*` scopes, loads the subagent child edges, and lists the live
tasks (`harness.inspect`): a run of a session seen in the last 7 days resumes
(watcher re-attached, state `busy`); any other live task (older session,
unknown conversation) is abort-marked before `resume()`, so it never runs
again, and its tools find no cwd until the abort lands. Rows older than 7 days
are not read at all and report `idle`. Until that re-attachment is done, `/api/status` reports a session
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
the bridge. pi-durable is then never imported, `/api/agents` falls through to
the official router (its 404) exactly as before, and every other route behaves
as before. The store is left on disk untouched; set
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
`~/.even-terminal/config.json`, `LETS_CODE_TOKEN` from the environment
(`export LETS_CODE_TOKEN=…` first); only if it is unset does the script try
the live unit's drop-in, which should **not** be readable (make it 0600,
root-owned) — then the script stops and asks for the variable. Neither token
is printed.

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

### lets-code engine (plan Task 2), measured on borealis, 2026-11-03

```sh
cd ~/github/even-bridge
bash -lc 'TMPDIR=~/tmp/ovs-tmp node scripts/durable-smoke.mjs --engine lets-code'
bash -lc 'TMPDIR=~/tmp/ovs-tmp node scripts/durable-smoke.mjs --engine lets-code --kill-mid-turn --kill-signal SIGKILL'
```

Instance: store `~/tmp/ovs-smoke-store`, cwd `~/sandbox/agents/ovs-smoke`,
`EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE=1`, `EVEN_BRIDGE_DURABLE_CWDS=~/sandbox/agents`,
`EVEN_BRIDGE_LC_BIN=~/.local/bin/lets-code`, and **no** `LETS_CODE_TOKEN` in the
bridge env (lets-code reads `~/.config/lets-code/config` and exports the token to
pi itself; the child's `/proc/<pid>/environ` has no other token or key). The
script removes the store, the cwd and `~/tmp/ovs-outside.txt` at the end.

| check | result |
| --- | --- |
| (d) banner | `durable=on wrapper=systemd-run lc=on(sandbox,nomem)` and the one `no memory cgroup controller` warning |
| (a) `Create hello.txt containing hi` | `hello.txt` = `hi`, no dialog, answer in `/api/history`; idle after 7.6 s (cold spawn included) |
| (c) scope | `systemd-cgls --user-unit even-lc-<sid>.scope` lists `pi` and its sandbox `socat`; `/proc/<pi>/cgroup` ends in `even-lc-<sid>.scope`; no `lets-code-<pi pid>.scope`; after `POST /api/agents/<sid>/stop` the scope is gone; the live bridge's `/api/sessions` (read-only GET on 3456) does not list the session |
| (a2) `Write hi to ~/tmp/ovs-outside.txt` | exactly one `permission_request` on the SSE stream after 1.0 s (`toolName` `mandate`, `write outside the project: /home/ay/tmp/ovs-outside.txt`, Yes/No), status `awaiting`; `deny` → file absent, the model says the write was not approved |
| (b) SIGKILL 2 s into `sleep 20 && echo done > done.txt` | the old pi was still alive (its scope outlives the bridge) and is stopped by the next start's scope cleanup; restart → resumed run idle after 28.8 s; exactly one cut-off prompt in the child's session file (same file, `--session`); `done.txt` = `done`; no `~/.pi/agent/lets-code-sessions/<old pid>.json` |
| (b') the same with SIGTERM | the old pi stopped at shutdown; resumed run idle after 25.8 s; one cut-off prompt; `done.txt` = `done` |
| bridge RSS | 127.2 MiB → 132.9 MiB across (a)+(a2) (the child is its own process: idle lets-code pi ≈ 150 MB, see `docs/overseer-spike.md`) |

`even-guard.ts` loads inside the real child (`-e`, a `.ts` importing
`guard-core.mjs`): a `wc -c ~/.pi/agent/models.json` bash call came back as
`even-guard: ~/.pi is off limits`.
