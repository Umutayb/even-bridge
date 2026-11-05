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
| `EVEN_BRIDGE_LC_MEMORY_MAX` | `500M` | `MemoryMax` (plus `MemorySwapMax=0`) of `even-lc-<sid>.scope`, applied only when `/sys/fs/cgroup/cgroup.controllers` lists `memory` (borealis has it since 2026-11-03: banner `mem`; without it one startup warning and banner `nomem`) |
| `EVEN_BRIDGE_LC_MAX_TURNS` | `40` | turns per lets-code run (one prompt and its steers, a crash retry included); at most `200` (a larger value is clamped, a non-positive-integer one keeps 40, each with a startup warning). An agent's own lower `maxTurns` wins for that agent. At the cap the turn is aborted (the child is not killed) and the run fails with `lets-code run stopped after N turns (cap)`; see *Per-run caps* below |
| `EVEN_BRIDGE_LC_SANDBOX` | on | `0` drops lets-code's `--sandbox` (tests only); on and without `bwrap`+`socat`, every lets-code start answers 503 |
| `EVEN_BRIDGE_OVERSEER_ENABLE` | off | `1` adds the overseer (needs `EVEN_BRIDGE_DURABLE_ENABLE=1`; it does not need the lets-code engine): the root conversation `dur-overseer`, `/api/overseer/*`, `overseer: true` on `GET /api/agents`; banner `, overseer=on` / `, overseer=failed: …` (the part is absent while the flag is unset). See *The overseer* below |
| `EVEN_BRIDGE_OVERSEER_AUDIT` | `~/.even-terminal/overseer-actions.log` | the action audit file (JSONL, 0600); throwaway instances point it at their own dir |
| `EVEN_BRIDGE_ASSISTANT_ENABLE` | off | `1` adds the Even AI assistant (needs `EVEN_BRIDGE_DURABLE_ENABLE=1`, **not** the lets-code engine flag): the always-warm lets-code session `dur-assistant` and `/api/assistant/*`; banner ` assistant=on` / ` assistant=failed: …` (absent while unset). Off: the routes fall through to the official 404, no child, no `lc/` module loaded. See *The Even AI assistant* below |
| `EVEN_BRIDGE_ASSISTANT_TOOLS_URL` | `http://127.0.0.1:8814` | the shim's tool server (the child's `EVEN_ASSISTANT_TOOLS_URL`) |
| `EVEN_BRIDGE_ASSISTANT_TOKEN_FILE` | `~/even-app/shim-data/assistant_tools.token` | the tool server's token **file** (0600); the child gets the path, never the token |
| `EVEN_BRIDGE_ASSISTANT_EXT` | `src/providers/durable/lc/even-assistant.ts` (Task A2) | the assistant extension; smoke runs point it at a probe |
| `EVEN_BRIDGE_ASSISTANT_CWD` | `~/sandbox/assistant` | the assistant's cwd (keys its core-memory store); smoke runs use their own |
| `EVEN_BRIDGE_ASSISTANT_API_TOKEN_FILE` | `~/.even-terminal/assistant-api.token` | the only token `/api/assistant/*` accepts (created 0600 when missing; the shim reads it); the bridge token gets 403 there |
| `EVEN_BRIDGE_ASSISTANT_DEADLINE_S` | `20` | per-run deadline (A0 `ASSISTANT_RUN_DEADLINE_S`); smoke runs lower it |
| `EVEN_BRIDGE_OVERSEER_HANDOFF` | off | `1` accepts overnight hand-offs (`POST /api/overseer/ask {mode:"tell", handoff}`); off: `400 hand-offs are off`. Leave off until a producer (Ideate) exists |

All of them are read at startup only. With every flag of this table unset the behavior and the wire output
are those of `main` (tests assert that no `src/providers/durable/lc/` or `src/overseer/` module is loaded).

## Limits

- `maxTurns` 1–60 per run (default 60); `name` ≤ 24 chars; `model` ≤ 32 chars. A lets-code agent's
  cap is `EVEN_BRIDGE_LC_MAX_TURNS` (default 40), or its own `maxTurns` when lower (see *Per-run caps*).
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

## Web tools

With `EVEN_BRIDGE_WEB_SEARCH_URL` set (env or `~/.even-terminal/bridge.env`,
read **once at bridge start**; trailing slash stripped) every durable
conversation also has the `even-web` extension (`src/providers/durable/web.mjs`)
with two tools backed by the private even-search service (SearXNG +
trafilatura on the LAN, the same service the glasses' own web search uses):

- `web_search({ query })`: `GET <base>/search?q=<query>&n=5`, up to 5
  results `{title, url, snippet}` (snippet at most 300 characters), then
  `GET <base>/fetch?url=<url>` for the top 2 in parallel, `text` at most
  1200 characters each (a failed or timed-out page keeps `text: ""`).
  Timeouts: search 8 s, each fetch 6 s. A failed search returns
  `{results: [], error: "search unavailable"}`.
- `web_fetch({ url })`: http(s) URLs only (anything else returns
  `{error: "only http(s) URLs"}` without a request), via `/fetch`, `text` at
  most 6000 characters; `{url, text}` or `{url, text: "", error}`.

Neither tool throws into the model. They are not bash and never touch the
filesystem, so the guard does not vet them; every page is fetched by
even-search, never by the bridge host. The tools are not a network boundary:
`web_fetch` passes any http(s) URL, LAN and loopback hosts included, and
even-search fetches it from the LAN (bash may already reach any host with
curl/wget). Only the normalised URL (no tabs or newlines) is requested, logged
and returned, and the log drops any `user:password@`; search results that are
not http(s) are dropped. Subagent children keep the
extension, subject to their agent file's `tools` / `disallowed` lists (an
agent whose `tools` list does not name `web_search` does not get it). The
tool descriptions tell the model when to search (current information, news,
prices, facts it does not know) and to name the source site; the agent
instructions do not list tools.

Logging: `[durable:web] search "<query>" -> <n> results` and
`[durable:web] fetch <url> -> <chars> chars` (failures say `failed`); page
text and snippets are never logged.

Unset: the extension is not installed, no conversation is offered the tools,
and the bridge logs `[durable] web tools off (EVEN_BRIDGE_WEB_SEARCH_URL unset)`
once at start. A conversation's extensions are stored when it is created:
conversations created before the URL was set do not get the tools, and
unsetting the URL later just drops them (a missing extension is skipped).

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

**The factory stays DISABLED on the live bridge** until a separate confinement task ("3b") lands:
host-level confinement of the lets-code child (bwrap or a `systemd-run --user` service that hides
`~/.ssh`, `~/.even-terminal` and `~/.pi`, with writes only under `~/sandbox/agents` and the factory
root; even-guard as a global pi extension that stays inert without `EVEN_GUARD_CWD`). Until then the
five factory experts stay off in `~/.pi/agent/lets-code-state.json`, so every factory request (voice
`agent_factory`, `factory: true` on a new agent, `POST /api/agents/:sid/factory {on:true}`) answers 409
`experts_disabled`, and the overseer can never propose one. Do not run `/experts enable` on borealis.

- **Run model (ruling 1).** One background task `even.lc-run` per busy period drives the child;
  the record is the conversation doc `even.lc-session` plus `lc.user` / `lc.answer` / `lc.tool`
  entries (at most 20 `lc.tool` per run). Idle sessions hold no process and no task; the child is
  kept `LC_IDLE_KEEP_MS` = 120 s after a run and then stopped; the next prompt re-spawns it with
  `--session <file>`. At most `EVEN_BRIDGE_LC_MAX_LIVE` children live at once (an idle-kept one is
  stopped to make room, otherwise 429).
- **Per-run caps.** A run (one `even.lc-run` task) stops at the first of:
  - `EVEN_BRIDGE_LC_MAX_TURNS` turns (default 40, at most 200; the agent's own `maxTurns` when lower;
    a turn is one `turn_end` of the child) → `lets-code run stopped after N turns (cap)`;
  - the same tool with the same args `LC_REPEAT_MAX` = 8 times in a row → `lets-code run stopped:
    repeated tool call (<tool>, 8 times in a row)`.

  Both take the same path: one `error` frame with that text, `record.lastError = {text, at, reason:
  "cap"}` (the agent row's `lastError`, and a `last error:` line in the overseer's `session_read`),
  an `lc_cap` line in the overseer audit log (`{event, sid, label, reason, turns, cap, tool,
  repeats, summary, by: "bridge"}`, no tool args; only with the overseer on, otherwise the bridge log
  has the warning), then the turn is aborted (open dialogs cancelled, RPC `abort`). The child stays
  (idle-kept); the task ends `failed`; a prompt while the turn is still ending gets a 409. A child
  that does not end the turn within 10 s is stopped; inputs still queued for that run are dropped and
  one error frame says how many (`N queued inputs were dropped when the capped run was stopped; send
  them again`). The next prompt starts a new run with fresh
  counters and clears the cap's `lastError` (a refused factory start's `lastError` is left alone).
  The counters are in memory: a bridge restart mid-run starts them again.
- **Dialog policy.** What lets-code asks reaches the phone and glasses as frames on the agent's
  session; nothing is auto-approved:
  - a mandate `ask` (e.g. a write outside the project) → one `permission_request` Yes/No (Yes =
    `Allow once`, No = `Deny`; an "allow always" also becomes `Allow once`);
  - a factory checkpoint → a `user_question` without `Edit` or `Cancel`, **held** (never answered
    by a timeout);
  - an `editor` dialog → answered `cancelled`, nothing shown (glasses cannot edit text);
  - a `confirm` / mandate `select` with no client attached is denied after 10 min
    (`LC_CONFIRM_DENY_MS`); while a client watches it waits;
  - lets-code's "Enable the factory's experts?" and "Enable the <name> expert?" confirms are
    answered No by the bridge (error frame `factory experts must be enabled by the operator`).
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

## The Even AI assistant (`EVEN_BRIDGE_ASSISTANT_ENABLE=1`)

Code: `src/providers/durable/lc/assistant.mjs` (profile, routes' backend, nightly task), `launch.mjs`
`assistantLaunch`, the profile hooks in `engine.mjs`, the no-resume branch in `task.mjs`. Design:
`docs/superpowers/specs/2026-11-03-evenai-agent-design.md` §2; constants from `docs/assistant-spike.md` (A0).

- **One session, its own profile.** `dur-assistant` is a virtual row (like `dur-overseer`) backed by a
  record conversation of its own (id in the session map's `meta` table). It runs on the lets-code engine
  as profile `assistant`: `<bin> --mode rpc -ne -e ~/.pi/agent/extensions/lets-code -e even-assistant.ts
  --tools <17 Even tools>,memory --thinking medium --session-dir <store>/lc-sessions/dur-assistant
  --no-mandate --approve --no-skills --no-prompt-templates --no-context-files --model <qwen> [--session <file>]`,
  cwd `~/sandbox/assistant`, env `ASSISTANT_MODULE_ENV`
  (`LETS_CODE_<X>=false|true`: only core memory, agent guard and grounding on; the `_ON` names do nothing)
  + `EVEN_ASSISTANT_TOOLS_URL`, `EVEN_ASSISTANT_TOOLS_TOKEN_FILE`, `EVEN_ASSISTANT_SCHEMA_CACHE`; no
  `*_TOKEN`/`*_KEY`, no `EVEN_GUARD_CWD`. No mandate, sandbox, subagents or guard: it has no shell or file
  tools. Scope `even-lc-dur-assistant-<sha1(store dir)[0:8]>` (a throwaway bridge never touches the live
  one's). `--approve` makes pi read `<cwd>/.pi/settings.json`, which the bridge writes with
  `compaction.keepRecentTokens: 200` (without both, `compact` answers "Nothing to compact" on a short day).
  `--approve` trusts that project, so everything else pi takes from a project is off (`-ne`, `--no-skills`,
  `--no-prompt-templates`, `--no-context-files`), and the cwd and its `.pi` are created `0700`. **Only the
  bridge writes `~/sandbox/assistant/.pi`** (just `settings.json`; anything else there is logged as a
  warning at start). The assistant has no file tools; no agent, shim or operator script may put files
  there.
- **Own slot, always warm.** Never admitted against `EVEN_BRIDGE_LC_MAX_LIVE`, not in `/api/agents`
  (so the shim's reaper and TTL never see it), no idle stop. Spawned at bridge start; after an exit
  respawned with `--session` (backoff 2 s → 60 s, reset after 60 s up), at once when the engine stopped it
  itself. qwen at `medium` at every (re)spawn: `--model` is always passed (on `--session` pi would restore
  the session's own model, e.g. Claude after a switch), and before the first prompt the bridge reads
  `get_state`, sends `set_model` back to qwen if the child runs anything else, then `set_thinking_level
  medium`. `state().model` is what the child really runs; `status` is `starting` until that is done and
  the tools line is in.
- **The agent engine flag stays the agents' gate.** Without `EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE` the engine
  exists for `dur-assistant` only: lets-code agent rows left from an earlier `lc=on` start are not routed
  to it (they behave as on `main` with the flag off), and the engine refuses agent prompts and resumed agent
  runs (`agentsOff`); its sandbox setting stays on.
- **Per-run caps (A0).** Deadline `ASSISTANT_RUN_DEADLINE_S = 20` (`EVEN_BRIDGE_ASSISTANT_DEADLINE_S`)
  and `ASSISTANT_MAX_TOOL_CALLS = 8` (the 9th `tool_execution_start` trips it; A2's extension blocks
  the 9th call itself): RPC `abort`, an error frame `code: "assistant_deadline" | "assistant_tool_cap"`,
  the run task fails; a child still busy `ASSISTANT_ABORT_GRACE_MS = 2000` later is stopped and respawned
  with `--session`, so the next prompt never meets "Agent is already processing". The agents' turn cap
  (40) and repeat cap (8 identical calls) apply too. No overseer audit line (it is no agent). The deadline
  runs from the run's first prompt: a steer or follow-up joins that run and shares its 20 s.
- **No resume.** A run cut by a bridge restart or a crash (task attempt > 1) is not continued: the note
  `(bridge restarted; your last answer was lost. Do not answer or continue that interrupted request unless
  the user asks for it again.)` is queued (the cut user message stays in the session; A2's context hook
  also stubs it), the frame
  `{type:"error", code:"assistant_restarted", message:"I lost that one, please ask again."}` goes out,
  the task ends `aborted`. That frame goes out while the bridge starts (before any client can listen), so
  `GET /api/assistant/state` also carries `lost: {requestId, at}` (the cut run's own requestId). A retry with
  that requestId is deduplicated (nothing runs): the shim checks `lost` first.
- **Notes** (`POST /api/assistant/note`, restart, hand-off) are files
  `<store>/lc-sessions/dur-assistant-notes/<ms>.txt` (0600, dir 0700) sent as `/even-note <file>` (the
  extension reads, deletes and `sendMessage`s it with `triggerTurn:false`: no run). Queued while a run
  is busy or the child is down, sent after `agent_end` / the next spawn (files a previous process left in
  that dir are sent again at start, oldest first), and only once the child printed
  `[even-assistant] tools: N (<source>)` (so `/even-note` is never sent to a child without the extension).
- **Tools line.** `N = 0` (or no line within 3 s) → `POST /api/assistant/prompt` answers 503
  `assistant tools not loaded`; `GET /api/assistant/state` shows `toolsLoaded`, `toolsSource`.
- **Dialogs** never reach the phone: `{type:"assistant_dialog", id, method, title, options}` frames,
  answered with `POST /api/assistant/dialog {id, value|confirmed|cancelled}`; `editor` is cancelled.
- **Model and thinking** (`POST /api/assistant/model`, idle only, else 409 `assistant is busy`):
  `set_thinking_level` follows **every** `set_model` (pi resets the level to `settings.json`
  `modelThinkingLevels` on a switch; A0). A switch to `Anthropic/claude-*` from a non-Claude model hands
  off first (ruling 32) and is refused with 409 while anything listens on `127.0.0.1:8795`: the child
  would host the lets-code Claude proxy there itself, and a second proxy cannot bind it.
- **Hand-off / daily reset** (04:00 local, task `even.assistant-nightly` of the assistant's conversation,
  busy → again in 10 min; also `POST /api/assistant/reset`): RPC `compact {customInstructions:
  ASSISTANT_HANDOFF}` ("Keep open questions, pending tasks and the user's stated plans. Do not copy
  calendar events, notes, quick-list items or any other phone data … write "(phone data left out; fetch it
  again)" instead …") → `new_session` → the note `Summary of the earlier
  conversation:\n<summary>`; the record follows the new session file. A failed compact still resets
  (`new_session` + the note `(the earlier conversation was reset; no summary of it was kept)`).
  `POST /api/assistant/compact` compacts the current session only.
- **Core memory** (`~/.pi/agent/core-memory/projects/assistant-<sha1(cwd)[0:8]>/memory.jsonl`, A0) is
  read by the child only at `session_start` (a `new_session` or a respawn), and the child's next
  `remember`/`forget` saves its cached entries over the file. Nothing in the bridge writes the store;
  the reset path is the only point where a change made outside the child is picked up. The one-time
  import (Task A5) runs while the assistant is off (ruling 36).
- **Phone Terminal:** listed right after `dur-overseer` as "Even AI" with `readOnly: true`; history,
  status and watch work; prompt, stop, forget, interrupt and question answers are 403
  `Even AI is read-only here`.

Where A1 differs from the plan text (A0 findings and the A1 real run, `docs/assistant-spike.md` § A1):
`--no-mandate --approve` in the argv and `<cwd>/.pi/settings.json` written by the bridge; the run deadline,
the tool-call cap and the grace stop/respawn; `set_thinking_level` after every `set_model`; the port-8795
check before a Claude switch; the compact fallback (`new_session` with the no-summary note);
`ASSISTANT_HANDOFF` says to leave phone data out (explicitly, with a placeholder); `ASSISTANT_RESTART_NOTE`
says not to continue the cut request; `--model` always plus the post-spawn model/thinking sync; the
assistant API token; the scope name carries
the store; interrupt and question answers from the phone are 403 too; `state().lost`; and the optional
`EVEN_BRIDGE_ASSISTANT_EXT`, `_CWD`, `_DEADLINE_S` (smoke runs).

**Auth.** `/api/assistant/*` takes only the assistant API token: `Authorization: Bearer <contents of
EVEN_BRIDGE_ASSISTANT_API_TOKEN_FILE>` (default `~/.even-terminal/assistant-api.token`, created 0600 with a
random value at the first start with the flag on; the shim reads it). The bridge token, which the phone
holds, gets 403 there, and the assistant token opens nothing else (401). A token file that is missing and
cannot be created, empty, shorter than 16 characters or unreadable means no token: every `/api/assistant/*`
request gets 503 `the assistant API token is not set up` (a startup warning says so); an empty token is
never compared. Events stay on
`GET /api/events?sessionId=dur-assistant` with the bridge token (read-only).

**Deploy note.** The first start with the flag on adds a `meta` table to the session map
(`<store>.sessions.sqlite`): back up `~/.even-terminal/durable.sqlite*` first (global constraint).

Routes (all fall through to the official 404 unless the flag is on): `POST /api/assistant/prompt
{text 1–4000, requestId 1–128, whenBusy?: steer|followUp}` (a text starting with `/` after leading
whitespace is 400 `slash_command_refused`: no pi/lets-code command such as `/even-note` is reachable from
the prompt route; notes go through `/api/assistant/note`) → 202 `{ok, requestId, deduped}` | 503
`assistant not ready` | 503 `assistant tools not loaded` | 409 (hand-off running, capped run ending);
`POST /api/assistant/{interrupt,reset,compact}` → `{ok:true}`; `POST /api/assistant/model {model?,
thinking?}` → `{model, thinking}`; `POST /api/assistant/note {text}` → `{ok, queued}`; `POST
/api/assistant/dialog`; `GET /api/assistant/state` → `{status: busy|idle|starting|down, model, thinking,
toolsLoaded, toolsSource, sessionFile, lastResetAt, lost}`. Events: `GET /api/events?sessionId=dur-assistant`.

Read routes for the shim's tool server (Task A3, ruling 26; same flag and same assistant API token):
`GET /api/assistant/sessions` → `{sessions}` (the overseer host's inventory rows as `/api/overseer/sessions`
sends them, `dur-assistant` left out); `GET /api/assistant/sessions/:id?n=1..20` (default 5) → `{text}`,
the host's `sessionRead` (fenced as untrusted, capped at 4 KB; `dur-assistant` itself is 404);
`GET /api/assistant/outbox?since=<seq>` → `{seq, items}` from the overseer, `{seq:0, items:[]}` when the
overseer is off. With the assistant on and the overseer off, `src/server.mjs` builds the host alone
(`src/overseer/host.mjs` only; `overseer.mjs` and the action/check-in modules are not loaded).

## The overseer (`EVEN_BRIDGE_OVERSEER_ENABLE=1`)

Code: `src/overseer/` (`overseer.mjs` root and ask, `extension.mjs` tools, `host.mjs` inventory and
execute, `actions.mjs` gate, `checkins.mjs` check-ins and the nightly task, `docs.mjs` docs and limits).
Smoke: `scripts/overseer-smoke.mjs [--actions]`.

- **The root.** The overseer is Durable's root conversation, listed first as the virtual session
  `dur-overseer` ("Overseer"; chat with it from the phone Terminal). It runs qwen, `maxTurns` 12,
  with exactly one extension, `even-overseer`, and **no CodingTools**: it cannot run commands or touch
  files. `stopSession`/`forgetSession` on it answer 403; it never appears in `GET /api/agents` (the
  shim reaper never sees it). A failed root setup leaves the banner `overseer=failed: …` and the
  overseer routes fall through.
- **Tools.** Read-only: `sessions_list {}` (the inventory below, fenced), `session_read {id, n≤20}`
  (`<<untrusted session output: id>>` … `<<end of untrusted output>>`, ≤ 4096 bytes, cut from the
  oldest end, `<<`/`>>` inside defused), `notes_get` / `notes_put` (≤ 16 KB, fenced on read), `notify
  {text≤500, tag?}` (≤ 3 per run). Gated (they only write a proposal): `session_start`,
  `session_message`, `session_interrupt`, `session_stop`, `standing_order`. Reminders:
  `checkin_schedule`, `checkin_cancel`.
- **Ask and outbox.** `POST /api/overseer/ask {question 1–2000, requestId 1–128, waitMs 0–15000,
  mode: "ask"|"tell"}` submits one input (`whenBusy: followUp`) and waits; in time →
  `{status:"done", answer, actions?, refused?, sent?}`, else `{status:"pending"}` and the answer lands in
  the outbox exactly once (also across a restart: `even.overseer.asks` is reconciled on every outbox
  read and at start). `GET /api/overseer/outbox?since=<seq>`, `POST /api/overseer/outbox/read {upTo}`.
  The outbox keeps the newest 50 items (`answer`, `notify`, `action`, `checkin`, `system`, `reply`;
  hand-off items younger than 24 h are pinned on top). Even AI's "what's new" reads it without an LLM.
- **The action gate.** Nothing the overseer (or Even AI's one gate) wants to change runs before a
  confirmation outside the model:
  - `propose` validates the arguments, applies the limits and the single-writer rules, writes the
    item (`even.overseer.actions`) and an `action` outbox item, and — for overseer proposals — puts a
    `permission_request` (`toolName: "overseer"`, Yes/No) on `dur-overseer`. Summaries are built by
    host code from the arguments, never by the model: `Start lets-code agent 'fix-ci' in
    ~/sandbox/agents/fix-ci on qwen to: "<task ≤ 140>"?`, `Send pi session 'notes-0a1b2c': "…"?`,
    `Stop agent 'fix-ci'?`, `Let the overseer tell agent 'x' "…" up to 2 times until 18:30?`.
  - `POST /api/overseer/actions/:id/confirm {confirmFrameId, by?}` (the shim's spoken or HUD yes) or
    the phone's permission answer on `dur-overseer` executes it. The phone's answer carries no action
    id: it counts for the pending overseer proposal only when that proposal's prompt is the last one
    sent to the phone and the answer arrives at least 500 ms after it; otherwise it is ignored (an
    `ignore` audit line, and 400 to the phone), so a Yes left from an expired proposal that lands as a
    newer one is proposed does not confirm the newer one. Confirm is idempotent by action id
    (both racers get the same result); expired → 410 `action expired`; denied → 409; the kill switch
    `~/.even-terminal/agents.disabled` → 423 `agents are switched off`. `…/deny` denies.
  - Pending actions expire after 90 s (sweep every 10 s) and at every restart (outbox `system` item
    "N pending action(s) were dropped by a restart." and a note to the overseer). Only one overseer
    proposal may wait at a time (409 `another action is waiting for your answer`).
  - Limits, at propose and again at confirm: 2 non-archived agents of origin `evenai|overseer`
    (`2 agents exist; stop one first`); a Claude model needs 2 free slots on the Claude bridge
    (`GET :8795/status`, unreachable = refused) and at most one overseer-started Claude agent; `ttlS`
    300–43200 (default 7200); the overseer's task/message text ≤ 140 characters, Even AI's ≤ 2000
    (≤ 140 for any non-durable target); a text starting with `/` or `!` (after whitespace or
    invisible characters), control or invisible characters, or no words is refused at propose and
    at execute; overseer starts never carry `factory`.
  - Stop and interrupt work only on bridge (durable) agents; messages follow the route table below.
- **Audit log.** `~/.even-terminal/overseer-actions.log` (`EVEN_BRIDGE_OVERSEER_AUDIT`), JSONL, mode
  0600, created by the bridge: one line per `propose`, `confirm`, `deny`, `expire`, `execute`, `fail`,
  `standing`: `{ts, event, id, kind, origin, summary, by}`. It never throws; it is not rotated.
- **Check-ins and the nightly reset.** `checkin_schedule {inMinutes 15–720 | at, about≤200}` creates a
  background task `even.overseer-checkin` that later submits `check-in: <about>` to the root (≤ 6
  pending, ≥ 15 min apart, ≤ 24 a day; a check-in run may schedule one more; skipped with the kill
  switch on). `even.overseer-nightly` resets the root at 04:00 when it is idle (else retries every 10
  min), handing off the fenced notes and the pending check-ins, and writes the day's token/cost usage
  to the outbox (the first report after a deploy says "so far").
- **Standing orders.** A confirmed `standing_order {id, text, maxTimes 1–3, until ≤ 12 h}` lets a later
  overseer `session_message` with exactly that target and text (not a steer) run without a new
  confirm while it has uses left (audit `standing`; a refused execution refunds the use).
- **Hand-offs** (`EVEN_BRIDGE_OVERSEER_HANDOFF=1`, default off): a told ask with `handoff {tag,
  label, ttlS}` holds the start the overseer proposes in that run to that label, folder, qwen and the
  deadline. The Ideate producer is not built yet.

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
- Invisible characters are refused anywhere in the text (format characters: bidi overrides and
  isolates, zero-width space/non-joiner, BOM, …, the emoji zero-width joiner excepted; blank fillers
  such as U+3164 and U+2800), and so is a text of only punctuation and spaces, so the summary the user
  confirms reads exactly as what is typed.
- It is typed literally: `tmux send-keys -t <pane> -l -- <text>`, then `send-keys -t <pane> Enter`
  as a separate key ("C-d", "Escape" or a leading "-" are characters, never key names or options; a
  trailing ";", tmux's command separator, is sent as "\\;"); never through a paste buffer.
- A terminal is typed into only when the bottom of its pane shows the program's own idle input
  box (an ALLOWLIST, `inputReady` in src/providers/pi/detect.mjs, shapes taken from the installed
  pi 1.0.3 and Claude Code 2.1.316): for pi, the editor between two full-width rules with the
  footer below (the cwd line and the stats line with the context indicator "12.3%/128k"); for
  Claude Code, the "❯ " input line between two rules with at most 4 footer lines below. pi puts
  its selectors, confirms ("→ Yes / No", "↑↓ navigate  enter select  escape cancel"), inputs and
  submenus in the editor's place, and Claude Code's permission menu and trust prompt replace its
  input box, so any of those (and anything unrecognised, an unreadable pane, Claude Code's "!" bash
  mode) blocks: 409 "<kind> '<label>' is showing a prompt or menu in its terminal; answer it there".
  Inside the input region a menu hint, two numbered lines in a row, or a blank line in a multi-line
  pi region also block. The transcript above the input box is never searched (an answer that says
  "Do you want to …" does not block). The check runs right before typing; the same screen check
  is the state of a tmux row (`terminalScreen`: anything but the input box is `waiting`, and the
  row says `canMessage: false, why: "waiting-in-terminal"`), so propose refuses it too. A terminal
  pi always reports idle and cc-local only busy/idle, so for tmux rows the screen IS the gate.
- A half-typed draft in the input box blocks too (our text would be appended to it and submitted
  with it): for pi any non-whitespace text in the editor region (pi has no placeholder; its cursor
  is an inverse-video cell); for Claude Code, captured styled (`capture-pane -p -e`), any non-space
  character after "❯ " / "> " outside a dim run (SGR 2: the placeholder), or any continuation line
  in the box. The refusal is its own: 409 "<kind> '<label>' has unsent text in its terminal; send
  or clear it there", and the row says `canMessage: false, why: "draft-in-terminal"` (its state
  stays as it is: a draft is not a prompt). A tmux row with no bound pane (`terminalScreen` null)
  says `canMessage: false, why: "no-pane"`, and propose refuses it.
- Capture real screens at deploy (Task 7). The shapes above are rebuilt from the installed sources,
  not captured: no pi or claude ran in tmux on borealis. At the deploy, capture each screen below
  with both `tmux capture-pane -p -t <pane>` and `tmux capture-pane -p -e -t <pane>`, and add them as
  fixtures in test/overseer-delivery.test.mjs (replacing the rebuilt ones):
  - pi: idle (empty editor), a draft in the editor, a menu (a selector or submenu, e.g. the
    thinking level), a confirm (`ui.confirm`, "→ Yes / No");
  - Claude Code: idle (with its dim placeholder, and with an empty box after a turn), a draft, a
    permission menu ("Do you want to proceed?"), the trust prompt ("Yes, I trust this folder"),
    bash mode ("! …").
  Check in particular that Claude Code's placeholder really is SGR 2 (if it is a grey colour or has
  an inverse-video first character, an idle box reads as a draft and every message is refused) and
  that pi draws no visible cursor glyph.
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

With the lets-code engine and the overseer on, a start runs in this order:

1. The session map migrates to schema v2 (`engine`, `ttl_s`, origin `overseer`; on every start, flag
   or not; main's code can still open a v2 map).
2. `even-durable-*` scopes and the `even-lc-<sid>.scope` of **this store's** lets-code rows are stopped
   (by own sids, never by glob: a throwaway instance never kills the live bridge's children).
3. With the overseer: the root is configured (`even-overseer` only) before anything resumes.
4. Live tasks are inspected and resumed. An `even.lc-run` task re-spawns its child with `--session
   <file>`: a run lets-code had accepted gets one cut-off prompt ("you were cut off …", or `/factory
   resume <id>`), an undelivered prompt is sent again as it was; after 5 restarts in a row the run
   stops (`lets-code run stopped: restarted 5 times in a row`). Sleeping check-ins and the nightly
   task do not make `dur-overseer` look busy.
5. The overseer's actions: every `pending` item from before this start becomes `expired` (outbox
   `system` item and a note for the overseer); a `confirmed` start without a result is looked up by
   its requestId `ovs-act:<id>` (found → its result is stored; else `failed`); other cut-off confirmed
   actions are marked `failed`. Unanswered asks are reconciled into the outbox.

What a restart loses (accepted limits, see below): reply watches, the refusal reasons kept for late
asks, and whether a `session_message` cut off mid-execute reached its target.

## Accepted limits (v1)

- Messages over pi RPC to an **existing** pi session run the user's pi (normal tools, no sandbox) in
  that session's folder, which can be anywhere: they are not confined to `~/sandbox/agents` (that
  constraint covers new agents only).
- Reply watches are in-process: a restart ends them and no reply is reported after it.
- A `session_message` cut off by a restart mid-execute is marked failed without checking whether it
  landed (only starts are reconciled).
- Refusal reasons for a told ask live in memory (newest 50 submissions): after a restart a late tell
  gets no `refused` list.
- The `.pi` bash rule is text-based; it is backed by sealing (see the lets-code engine). Nested
  `sub/.pi` dirs planted by bash without naming `.pi` are not scanned.
- The first factory stage has a ~1 s trust window (the factory watch tick) before its worktree is
  guarded and sealed. Irrelevant while the factory stays disabled.
- The window between the seal at spawn and pi loading its extensions (a few hundred ms).
- The phone's permission answer on `dur-overseer` carries no action id; it answers the only pending
  overseer proposal (one may wait at a time), and only when it arrives at least 500 ms after that
  proposal's own prompt (an earlier one is ignored and audited). A stale Yes that arrives later than
  that still confirms the newer proposal the phone was sent.
- The tmux allowlist (`inputReady`) is rebuilt from sources, not captured; it fails closed. Claude
  Code's placeholder is ASSUMED dim (SGR 2): if it is not, every message to a Claude Code terminal is
  refused ("has unsent text") until the fixtures are corrected from real captures.
- A lets-code loop is stopped by the per-run caps, not prevented: the Task 7 QA loop ("write hi to
  hi.txt", 68 identical writes in ~35 s) now ends at the 8th identical call; a loop with varying
  calls runs up to `EVEN_BRIDGE_LC_MAX_TURNS` turns (40) first. The caps do not see inside a
  subagent or a factory stage (separate pi processes), and a bridge restart mid-run resets the counts.
- The overseer's root store grows forever (no pruning yet; see *Store growth*).

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

Per flag (each: remove the line from the drop-in, `sudo systemctl daemon-reload`, `sudo systemctl
restart even-bridge`, check the banner):

- `EVEN_BRIDGE_OVERSEER_ENABLE`: the overseer modules are not loaded, `/api/overseer/*` falls through,
  `GET /api/agents` loses `overseer: true`, so the shim stops offering `overseer_ask`, `overseer_tell`,
  `list_sessions` and `message_session` within its 60 s engines cache, and its one gate falls back to
  `POST /api/prompt`. The root conversation, notes, outbox and actions stay in the store; pending
  actions expire at the next start with the flag on. The audit log stays.
- `EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE`: new `engine: "lets-code"` prompts answer 400, `GET
  /api/agents` loses `engines`, so the shim dispatches native agents again. Existing lets-code rows
  stay in the map; their session files stay in `<store dir>/lc-sessions/<sid>/` and their
  quarantine in `<store dir>/lc-quarantine/<sid>/`. Stop live lets-code agents first (`POST
  /api/agents/:sid/stop`), so no `even-lc-*` scope outlives the switch; with the engine off the
  startup scope cleanup of lets-code rows does not run (check `systemctl --user list-units
  'even-lc-*'`).
- The session map stays at schema v2 after a rollback of the code; main's SessionMap opens it. To
  return to the exact pre-deploy files, stop the bridge and restore the backup pair.

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
