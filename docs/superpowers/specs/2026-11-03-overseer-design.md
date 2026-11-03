# Durable × lets-code, and one Durable overseer: design

2026-11-03. Design only; every host read-only. Sources: even-bridge `main` a6200b6, lets-code `d20144e` + `~/.pi/agent/extensions/lets-code/*.ts`, pi-durable 1.5.0 README/`.d.ts`, shim `main` a57b79c, the handover and Ideate notes, the live unit and processes. **Proposal** marks a decision for you. **(verify)** marks something I inferred and have not run.

## 0. Facts that shape the design

1. **lets-code's "full stack" is not what bridge pi sessions get today.** `lets-code` defaults are `MANDATE=false SUBAGENTS=false SANDBOX=false` (script l.2917–2920), and `~/.config/lets-code/config` sets only `ENDPOINTS` and `TOKEN`. Experts and the factory need `SUBAGENTS_ON` (and `EXPERTS_ON`). So a glasses pi session gets agent-guard, grounding, core memory and the memory and git guards, but no mandate, subagents, experts or factory, unless the unreadable 0600 `pi-lets-code.conf` sets them (verify from a launch line). **The sandbox cannot run on borealis at all**: it needs `bwrap` and `socat`, and neither is installed.
2. **pi has not adopted Durable.** pi-coding-agent 1.5.0 (latest, 2026-11-02) depends on pi-ai, pi-agent-core, pi-mcp, pi-tui and pi-codemode, but not pi-durable. borealis runs pi 1.0.3. Option C has no date.
3. **pi RPC is enough to drive lets-code headless.** `prompt` runs extension commands (`/factory start|resume`, `/git-guard on`) even while a run is streaming (`agent-session.js` l.1488). `steer`, `follow_up`, `abort` and `get_state` exist. `ctx.ui.select/confirm/input` become `extension_ui_request` dialogs, so `hasUI` is true and mandate approvals and factory checkpoints arrive as dialogs. `PiSession` already maps those dialogs to glasses `permission_request`/`user_question`.
4. **The ownership map is not a driver map.** `ownership.mjs` only routes a session id to a provider, in memory. Who actually *drives* a session comes from `detect.mjs` (`findExternalPi`, `externalOwnsSession`, tmux panes) and from cc-local's external detection. The overseer must ask those, not just `getOwner()`.
5. **Memory is tight.** Free memory is 2.5 GB, and 2 GB of swap is 100% used. The bridge uses 139 MB RSS. Three `claude -p` processes (≈185 MB each) run under lets-code's Claude proxy on :8795, which allows `MAX_SESSIONS=8` and 4 per token. Every lets-code session is a full pi node process, and its subagents and factory stages are more pi processes (`LETS_CODE_SUBAGENT_CONCURRENCY` default 2).
6. **Durable is ready for an overseer.** `harness.root()` is reserved and unused. Background tasks survive conversation aborts, `sleepUntil` survives restarts, owned work cascades aborts. README example 22 (background subagents whose reporter tasks post answers back as follow-ups) is the overseer↔worker pattern.

## 1. Durable sessions on lets-code

### (A) Port lets-code modules to Durable extensions

| lets-code module (lines) | pi API used | Durable equivalent | Verdict |
|---|---|---|---|
| git-guard (1110) | `tool_call` block, `tool_result`, checkpoint refs | `beforeTool`/`afterTool` hooks; `judgeBash` is plain functions | Easy (≈2 d) |
| mandate (978) | `tool_call`, `context`, `before_agent_start`, `turn_end`, 28 `ctx.ui` dialogs, commands, `pi.events` | `beforeTool` + `section`; dialogs need a new "ask the user" tool that ends the run | Medium (≈4 d); its ask flow does not fit |
| agent-guard (886) | `before_provider_request`, `context`, `turn_end`, `agent_before_settle` | `beforeProviderRequest`, `beforeRequest`, `onYield`, `afterTools` | Medium (≈3 d) |
| grounding, backend, session-tag | `before_agent_start`, headers | `section`, `beforeProviderRequest` | Easy |
| core-memory (802) | tool, `tool_result`, pointers into pi session files | tool + doc; pointers change meaning | Medium; splits the memory in two |
| subagents (2131), experts (529) | spawns `pi --mode json` children, `input`, `model_select`, session hooks | owned conversations (half done in `subagent.mjs`) | Large (≈1.5 wk) |
| factory (1032) | `/factory`, dialogs, git worktrees, child runs | a Durable task with child tasks; checkpoints = sleeping/waiting phases | Rewrite (≈1.5 wk) |
| sandbox | sandbox-runtime (bwrap) | a custom `ExecutionEnv` | Blocked: no bwrap |
| sessions, footer, subagent-view, memory-guard | TUI, pi session files, /proc | none | Drop |

Total: 4–6 weeks, plus a second implementation of every module that drifts with each lets-code PR (#101–#106 landed in one week), against the handover's §3 decision. **Not recommended**, except a later "A-lite": the git guard's `judgeBash` inside `even-guard`.

### (B) Hybrid: Durable records and controls, lets-code does the work (recommended)

A Durable session gets an **engine**: `native` (today's in-process `CodingTools`) or `lets-code`. A lets-code session is:

- **The runner.** A host module, `LcRunner`, reuses `PiRpcClient` and `PiSession` unchanged, so wire frames, questions, steer and `/model` behave exactly like the pi provider. It spawns `pi-inference --mode rpc [--session <file>] --name <label> --mandate --subagents` in the session's cwd (below `~/sandbox/agents`; repos: Q2), in a `systemd-run --user --scope` unit `even-lc-<sid>` with memory/CPU caps and an allowlisted env (no `BRIDGE_TOKEN`).
- **The Durable record.** A background task `even.lc-session` is owned by the session's Durable conversation (by the overseer's root once phase 3 lands). Its checkpoint holds `{piSessionFile, label, cwd, model, engineFlags, restarts, factoryRunId?}`. User prompts, final answers and one-line tool summaries are written to the conversation as `write` entries (`kind:"lc.user"`, `"lc.answer"`, `"lc.tool"`). Writes start no model run. **Proposal:** do not stream every JSONL event into the store: Durable never prunes, and the full transcript is in the pi session file the record points at.
- **Ownership and strays.**
  - Claim both the `dur-` id and the child's *pi* session id for durable; the pi provider's `probe()`/`listSessions()` skip runner-owned files (otherwise it sees our child as an "external pi" and blocks).
  - The shim registry row and reaper apply unchanged (origin `evenai`, TTL, 2 running).
  - Before any spawn, `findExternalPi` + `externalOwnsSession`: if a terminal drives the file, the runner only watches.
  - Startup stops leftover `even-lc-*` scopes, the same as `even-durable-*`.
- **Restarts.** stdio RPC cannot be re-attached, so a bridge restart ends the child, and the scope is stopped. On `resume()` the task's phase reruns from the top:
  1. re-spawn with `--session <file>`;
  2. if a run was in progress, send one "cut off by a restart; check the state and continue" prompt (deduplicated by a checkpoint mark), or `/factory resume <id>` for a factory run.
  `restartLimit` (5) ends crash loops; a cut-off bash command can run twice.
- **The second layer.** The text guard from `guard.mjs` (`judgeCommand`, `confinePath`) is loaded into the child as a small pi extension (`even-guard.ts`, `-e` flag; verify the flag on pi 1.0.3). It blocks on `tool_call`, the same way lets-code's git guard does. lets-code's mandate stays the first policy, and the even guard is the floor: cwd confinement, secret paths, host control.
- **Control mapping.**

| glasses / overseer | lets-code child |
|---|---|
| prompt while idle | `prompt` |
| prompt while busy | `prompt` + `streamingBehavior:"steer"` (follow-up only when it is asked for) |
| interrupt | cancel open dialogs, then `abort` (what `PiSession.interrupt` already does) |
| stop | abort, `stop()`, archive the record, `forget()` |
| question/permission while a client is attached | glasses `user_question`/`permission_request` (as today) |
| question with nobody attached | **Proposal:** to the overseer's outbox; an unanswered `confirm` is denied after 10 min; a factory checkpoint waits (no model time) |
| status | the task state + `get_state` |

**Cost:** a lets-code session takes 1–3 node processes against 0 extra for native. **Proposal:** at most 1 lets-code session running at once and at most 2 agents in total, until the phase-0 measurement.

### (C) Wait for pi to adopt Durable

No sign of it (fact 2); watch it. If it lands, only B's runner is replaced.

### Recommendation and migration

**Proposal: B.** Migrate in this order:

1. Phase 1 adds `engine` to `POST /api/prompt` and the session map (default `native`: nothing changes).
2. After the phase-0 spike, shim dispatches default to `lets-code`; `native` stays for cheap jobs and as fallback.
3. The pi provider stays for terminal-shared sessions.

## 2. The overseer

### Shape

- **One overseer.** It is the Durable root conversation (`harness.root()`), listed in `/api/sessions` as `dur-overseer` ("Overseer") so the phone Terminal can open it.
- **Its agent.** qwen, `maxTurns` 12, compaction plus a nightly `reset(handoff)` from its notes. **Proposal: no `CodingTools`** (no shell, no files): an injection can only reach gated tool calls.
- **Extension `even-overseer`.** These tools run in the bridge process and call the providers directly, not over HTTP:

| tool | does | scope |
|---|---|---|
| `sessions_list` | durable (both engines), pi files + live + **driver** (bridge child / terminal+tmux / terminal without tmux), cc-local (+ external driver), RC; state, age, last line | free |
| `session_read(id, n)` | status + last n history items, wrapped as untrusted data, capped at 4 KB | free |
| `notes_get/notes_put` | its own `overseer.notes` doc (≤16 KB) | free |
| `checkin_schedule(at, about)` / `checkin_cancel` | a background sleeping task that submits a follow-up "check-in: …" to the root when due | free, capped |
| `notify(text)` | appends to an outbox doc that Even AI reads | free, capped |
| `session_start(engine, task, label, cwd, model)` | proposes | **confirm** |
| `session_message(id, text, steer\|followUp)` | proposes | **confirm** |
| `session_interrupt(id)` / `session_stop(id)` | proposes | **confirm** |

### The confirmation gate (outside the model)

- **Proposing.** A gated tool never acts. It writes a `pending_action` `{id, kind, args, summary, expires}` to an `overseer.actions` doc and returns "proposed, waiting for the user". The **summary is built by host code from the arguments**, never by the model ("Start lets-code agent 'fix-ci' in ~/sandbox/agents/fix-ci on qwen?").
- **Executing.** Only `POST /api/overseer/actions/:id/confirm` with a `{confirmFrameId}` executes, and it runs host code, idempotent by action id. Two channels may call it:
  - the shim's existing two-turn spoken confirmation, or the HUD confirmation behind its flag;
  - on the phone, the pending action is emitted as a `permission_request` frame on the `dur-overseer` session, and `/api/permission-response` answers it. That UI already exists and the model cannot forge it.
- **Expiry.** 90 s, and at any restart.
- **Kill switch.** `agents.disabled` blocks confirms and check-ins. `stop_agent all` stays a deterministic shim tool, and so do `list_agents` and `agent_status`.

### Single-writer safety

- **Before every message or interrupt**, the action re-runs the driver probe. A terminal-driven pi or cc-local session is **observe-only**: no tmux injection by the overseer. **Proposal:** not even with a confirmation in v1.
- **RC sessions** may be messaged with a confirmation, because the RC protocol is a proper second writer. They may not be stopped.
- **cc-local.** Sessions not driven by a terminal are read-only in v1, because starting them spends your Claude Max quota.
- **Stopping** works only on sessions the bridge owns (durable).

### Permission scopes (Proposal)

- **Unprompted:** list, read, notes, check-ins (at most 6 pending, at least 15 min apart, at most 24 a day), outbox.
- **Each needs your confirmation:** start, message, interrupt, stop, switching itself to Claude.
- **Never:** shell, files, prefs, raising limits, terminal injection, stopping non-bridge sessions, deleting anything.
- **Phase 4, optional:** a *standing order* you approve once, bounded and listed in the confirmation ("if its tests fail, tell it to fix them, at most 2 times, until 07:00"). The host checks it against the rule, not the model.

### Even AI ↔ overseer (shim)

- **`overseer_ask(question)`** submits to the root with a `requestId` and waits ≤15 s. A done answer is condensed to ≤2 sentences. Otherwise Even AI says "Working on it, I'll have it next time you ask" and the answer goes to the outbox. It goes in `UNTRUSTED_TOOLS`, so gated agent tools are refused later in the same turn (existing rule).
- **`overseer_tell(instruction)`** submits an input. Any `pending_action` it produces is handed to the existing confirmation flow, and the shim speaks the host-built summary.
- **Honesty.** `_honest_agent_answer` is extended: "started/stopped/sent" may only be claimed after a confirmed action result.
- **Reads.** "What's new?" reads the outbox without an LLM.
- **Migration.** Keep the five agent tools in phases 2–3; later `dispatch_agent`/`message_agent` may wrap overseer proposals (one gate, one audit trail; Q9).

### Model and cost

- **Default:** qwen (private, zero cost).
- **Claude only by name.** "Ask the overseer with Sonnet" switches it with `configure()`, which reverts after the run (queued inputs wait behind it). It holds one of the 8 slots on :8795 while it runs.
- **Claude sessions.** **Proposal:** refuse a Claude `session_start` while :8795 has fewer than 2 free slots; at most 1 overseer-started Claude agent.

### Restarts and the reaper

- **After a restart:** the root and its sleeping check-ins resume. Pending actions are dropped, and the overseer is told so on its next run.
- **Overseer-started sessions** get origin `overseer`. The bridge's `AGENT_ORIGINS` gains it. The shim writes the registry row at confirm time, so the reaper's TTL and stray rules cover them, with a per-action TTL of up to 12 h (`agents_ttl_s` max 43200).
- **The root itself** is exempt from the reaper. Its runaway brakes are `maxTurns`, the check-in caps and Durable's `restartLimit`.

### Ideate overnight hand-off (ruling 8: may write, must ask first)

1. "Work on this overnight" at wrap-up: the shim copies the doc into `~/sandbox/agents/<label>/brief.md` (the Ideate dir stays private) and calls `overseer_tell`.
2. The overseer proposes scope, folder, engine (factory only for a code ticket), model, turns and deadline; you confirm on glasses or phone.
3. Check-ins until 07:00; at the end a summary and paths go to the outbox, and the **shim** links them into the Ideate ledger.
4. Morning: "what happened overnight" reads the outbox.

### Risks

- **Runaway loops.** Covered by the caps above, plus a hop rule: a run started by a check-in may schedule at most one new check-in, and session completions never start overseer runs (pull-only).
- **Prompt injection through session output.** No shell or file tools, host-built summaries, confirmation outside the model, and session output treated as untrusted data in both the overseer and the shim.
- **The Claude 8-process cap** (fact 5, above).
- **Pi memory.** Running lets-code children and a busy overseer could push the Pi into OOM: the overseer's own runs are cheap, but the children are not.
- **Durable churn.** Pin 1.5.0; back up the store before upgrades.
- **Latency.** Two LLMs per voice turn: hence the 15 s budget and the outbox.
- **Store growth.** The root lives forever; pruning is still missing.

## 3. Phased plan

| phase | content | effort | phone/glasses needed |
|---|---|---|---|
| 0 spike | measure `lets-code --mode rpc --mandate --subagents` RSS on borealis (scratch HOME, 1 subagent run); read the real launch line of a bridge pi session; check pi's `-e` extension flag; run a factory checkpoint over RPC and cancel it; record HUD `confirm:true` frames | 1–2 d | glasses for HUD frames |
| 1 lets-code engine | `LcRunner` + `even.lc-session` task, `engine` field, pi-provider ownership skip, `even-guard.ts`, `even-lc-*` scopes, restart resume, dialog policy, shim `engine` pass-through; real smoke test (kill mid-turn) | 4–6 d | glasses smoke test |
| 2 overseer, read-only | root + `even-overseer` free tools, `dur-overseer` listing, `/api/overseer/ask`, shim `overseer_ask`, outbox read | 3–4 d | glasses Q&A |
| 3 gated actions | pending actions, confirm endpoint, phone `permission_request`, shim confirmation, `overseer_tell`, origin `overseer`, audit, reaper | 3–4 d | phone + glasses confirm |
| 4 check-ins + Ideate overnight | sleeping tasks, caps, nightly reset/usage, Ideate hand-off, standing orders (optional) | 3–5 d | one overnight run |
| later | A-lite (`judgeBash` in the native guard), outbox push to the glasses (notes/quicklist `ask`), pruning | — | — |

Total ≈ 3–4 weeks. Each phase ships behind a flag and rolls back by unsetting it. Bridge restarts need your sudo.

## 4. Open questions for you

1. Approve **B** (lets-code engine via owned RPC children), with native kept as fallback and A dropped except for A-lite?
2. Which lets-code features: `--mandate` (mode `auto` or `ask`?), `--subagents`, experts, factory? May lets-code sessions work outside `~/sandbox/agents` (a `pi/*` worktree of `~/github/<repo>`, git guard on)?
3. Install `bubblewrap` + `socat` (sudo) so lets-code's sandbox actually runs, and with it `BWRAP=1` for native sessions?
4. Concurrency: 1 lets-code + 2 total until phase 0 measures memory, or add zram?
5. A dialog with nobody watching: deny `confirm` after 10 min and hold factory checkpoints, as proposed?
6. Overseer scopes: is the unprompted list right? Do you want standing orders (phase 4) at all?
7. Terminal-driven sessions: strictly observe-only for the overseer, even when you confirm a message (tmux injection stays a phone-only action)?
8. cc-local and RC: read-only in v1, with RC messageable after a confirmation?
9. Should the overseer replace `dispatch_agent`/`message_agent` eventually (one gate), or stay a parallel path?
10. Ideate overnight: 07:00 deadline, ≤12 h TTL, qwen only?
