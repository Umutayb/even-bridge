# Durable agents for Even AI — design (combined spec)

This spec is the pi-durable design (rev 2) followed by the user's handover notes, unchanged, plus the rulings
recorded in the implementation plan (docs/superpowers/plans/2026-11-03-durable-even-ai.md, section Global Constraints):
prompt + interrupt from day one; guard extension + systemd-run caps in the MVP (bwrap optional); 2 agents / 2 h TTL /
60 turns; spoken two-turn confirmation, HUD confirm behind a flag; no zram change.

---

# Pi Durable agents on borealis, dispatched from Even AI — feasibility + design (rev 2)

Research/design only (2026-11-02). Nothing installed, nothing modified. Hosts inspected read-only: borealis
(`~/github/even-cloud-shim` branch `kb`, `~/github/even-bridge` branch `cc-resume-rc`, `~/github/claude-remote-terminal`,
`~/github/lets-code`, `~/.pi/agent`, decompiled app `~/even-app/work/2.4.0-246/blutter/asm`).
Rev 2 reconciles with the user's handover notes `borealis:~/tasks/pi-durable-even-bridge.md` (2026-11-02) and the
user's decision on models (vLLM default; Claude stays in the bridge). Decisions taken from the notes are marked **[notes]**;
conflicts with what I observed are marked **[conflict]**.

## 1. What "pi durable agents" is — and which flavour this design uses

| | What | Source |
|---|---|---|
| (a) **pi** CLI | Earendil coding agent (ex `badlogic/pi-mono`, now `earendil-works/pi`, npm `@earendil-works/pi-coding-agent`, MIT; latest 1.5.0, **borealis has 1.0.3** at `~/.local/bin/pi`, node v24.21.0 via nvm). Configured by `lets-code` (`main-8c3fb10`) against the user's vLLM: `~/.pi/agent/models.json` provider `lets-code` → `https://inference.i-bora.com/v1`, `api: openai-completions`, model `qwen3.8-27b`, context 262144, thinking budgets. Headless: `pi --mode rpc` (JSONL over stdio). Sessions = JSONL trees in `~/.pi/agent/sessions/`, **single writer**; a crash mid-turn loses the turn. | https://pi.dev/docs/latest/rpc , https://pi.dev/docs/latest/sessions |
| (b) **Pi Durable** — **chosen [notes]** | `@earendil-works/pi-durable` (+ `pi-ai`, `chord`), MIT, **experimental, "API changes without notice"**. npm says **1.5.0 published 2026-11-02 10:58Z** (the notes say 1.4.0, written the same day; a secondary blog says 1.3.0) — 18+ releases in a month; **1.4.0's SQLite migration cannot be rolled back; pin the exact version**. A TypeScript *library*, no CLI: `Harness.open(storage, {models, registry, env}, ctx)`, `harness.root()`, `conversation.submit({type:"input", content, requestId, whenBusy:"steer"|"follow-up"|"reject"})`, `.watch()`/`viewState()`, `.abort()`, `harness.resume()` after a crash; every model request / tool call / compaction is a checkpointed task; `replay:"safe"` tools rerun after a crash, others report "interrupted"; owned child conversations = subagents (README examples 22 foreground / 23 persistent); multiplayer views. Storage: Node SQLite (`openNodeSqliteStorage`), JSONL, Memory, IndexedDB, Cloudflare DO; **one process owns a store, no cross-process locking**. Tools `CodingTools` (read/write/edit/bash) run through `NodeExecutionEnv` — **no sandbox built in**. The pi CLI does not use Durable; Durable has its own extension model (`defineExtension`), so **pi CLI extensions (lets-code's modules, sandbox, mandate) do not load in it** [notes, confirmed by README]. | https://earendil.com/posts/pi-durable/ , https://github.com/earendil-works/pi `packages/durable` (README ≈900 lines, `docs/spec.md`), https://www.npmjs.com/package/@earendil-works/pi-durable |
| (c) **pi-agents** — not chosen | mavam's pi extension (`pi install npm:pi-agents`, MIT): durable named agents inside one pi CLI process on pi-durable (`/agents`, store `~/.pi/agent/pi-agents/`). Superseded by (b) running in the bridge; kept here only as the fallback if the in-bridge provider stalls. | https://pi.dev/packages/pi-agents , https://github.com/mavam/pi-agents |

**Decision [notes §1 Task B, §3]:** Durable lives **inside even-bridge** as a new, separate provider `src/providers/durable/` next to the existing `src/providers/pi/`; lets-code itself does *not* integrate Durable. This removes the single-writer dance (`detect.mjs` 307 lines, `watcher.mjs`, `even-pi-tmux.service` — currently `inactive`, no tmux server running) for glasses-started conversations, and lets runs survive bridge restarts (`harness.resume()` at startup). The existing pi provider stays for sessions shared with a terminal pi.

**Fit for borealis.** Pi 5, 8 GB, 4 cores; at inspection 3.6 GB available, **swap 2 GB fully used**; Open WebUI ≈720 MB RSS, even-bridge ≈114 MB, shim ≈170 MB. Because Durable runs **in-process**, an agent costs a conversation in SQLite plus tool children — no 150–250 MB Node child per agent as with `pi --mode rpc`. Memory risk is therefore moderate (bridge heap growth + concurrent `bash` tools), not blocking. Cap concurrency anyway (section 2). LLM compute is on inference-server (do not run heavy tests there — it serves the model [notes]).

**Alternatives if it does not fit.** *A.* execute on another host: Durable's `env` is pluggable (README example 29) — a remote `ExecutionEnv` over SSH to the Mac keeps borealis as broker. *B.* Claude Agent SDK queue on the Mac (Max sub) with a bridge provider — more code, sends code to Anthropic; only if Durable proves too unstable.

## 2. Architecture

```
glasses ──Even AI WS──▶ even-cloud-shim shim/ai.py (new tools) ──HTTP (loopback, bridge token)──▶ even-bridge :3456
                                 │                                        ├─ POST /api/prompt {provider:"durable", cwd, name, model?}
                                 │                                        ├─ GET /api/sessions · /api/status · /api/interrupt · /history
                                 └─ shim SQLite: pending_dispatch, agents (label, conv_id, ttl, confirm_frame_id)   └─ Durable Harness, ~/.even-terminal/durable.sqlite
glasses/phone "Terminal" feature ─▶ cterm.i-bora.com (nginx, LAN+WG only) ─▶ even-bridge merged /api/sessions, /events (SSE), /prompt, /interrupt
RC sessions (claude --remote-control via claude-remote-bridge :8790/:8791) ─▶ unchanged, still listed and driven as today
```

**The Even Terminal fork** = `~/github/even-bridge` (systemd `even-bridge.service`, user `ay`, port 3456, drop-ins `pi-lets-code.conf` → `EVEN_BRIDGE_PI_BIN=~/.local/bin/lets-code`, `remote-control.conf` → `EVEN_BRIDGE_NEW_SESSION_PROVIDER=pi`, `EVEN_BRIDGE_CC_RESUME_RC=1`), fronted by nginx `cterm.i-bora.com` (allow 192.168.0.0/24 + WireGuard 10.6.0.0/24). It wraps the closed-source `@evenrealities/even-terminal@0.10.4` and mounts `src/ext-router.mjs` in front: `GET /api/sessions` (merged local-Claude + RC + pi, all tagged `provider:"claude"` because the app filters providers), `POST /api/prompt`, `/api/interrupt`, `/api/permission-response`, `/api/question-response`, `GET /api/status`, `/api/messages`, `/api/sessions/:id/history`, `GET /api/events` (SSE hub, `Last-Event-ID` replay). **The live working tree has uncommitted work** (`provider.mjs` `startCwdFor`, `session.mjs`, untracked `test/pi-start-cwd.test.mjs`) — Phase 0 below; never overwrite it [notes Task A].

**New provider `durable` in the bridge [notes Task B.1]:** `Harness.open(openNodeSqliteStorage("~/.even-terminal/durable.sqlite"), {models, registry, env})`; models via `@earendil-works/pi-ai` OpenAI-compatible provider **built from the `lets-code` entry in `~/.pi/agent/models.json`** (baseUrl, model id, context window, thinking budgets, `LETS_CODE_TOKEN` from the unit env) — one source of truth with the CLI; `CodingTools` in `NodeExecutionEnv({cwd})`; one Durable conversation per glasses session, listed in `/api/sessions` with `provider:"claude"` cosmetic tag and ownership claimed in `ownership.mjs`. Wiring: prompt → `submit({type:"input", content, requestId: <phone request id>, whenBusy:"steer"})` (idempotent on retries); `/events` ← `conversation.watch()` into `hub.mjs`; `/interrupt` → `abort()`; a question to the user → a tool that waits for the next submission (surfaced as the app's existing question/permission frames). `harness.resume()` on bridge start. Open [notes]: start **read-only** (start + watch from the glasses) or with full prompt/interrupt — unanswered.

**Models [user decision]:** anything Even AI dispatches **without an explicit choice runs on the private vLLM** (`lets-code/qwen3.8-27b`). The bridge **retains every Claude capability it has today**: RC sessions keep being listed and driven unchanged, Claude Haiku/Sonnet stay selectable with `/model`, and `dispatch_agent` takes an optional `model` (`qwen` default | `haiku` | `sonnet` via the bridge's existing model switch / `claude-sub-proxy`) that the user must name explicitly. Rev-1's "RC sessions off for agents" item is **withdrawn**.

**New Even AI tools** (`TOOLS` + dispatch in `_run_turn`, `shim/ai.py`, beside `control_app`):

| tool | args | effect |
|---|---|---|
| `dispatch_agent` | `task`, `label` (≤24), `cwd` (allow-list enum), `model?` | Stores a **pending intent** (token, TTL 90 s) and triggers the confirmation below. Never spawns by itself. |
| `confirm_dispatch` | `token` | Internal, runs only on a received confirm frame: registry row → `POST /api/prompt {provider:"durable", text, cwd, name:label, model}` → `{conv_id}`; then `control_app terminal on` so the glasses open the session list. |
| `list_agents` | – | registry ⨝ `/api/sessions` + `/api/status`: label, busy/idle/stopped, age, last line (≤120 chars). |
| `agent_status` | `label` | `/history?limit=3` → ≤2 spoken sentences (LLM-condensed in the shim). |
| `message_agent` | `label`, `text` | `POST /api/prompt {sessionId}` → Durable `whenBusy:"steer"`. |
| `stop_agent` | `label` \| `all` | `POST /api/interrupt` → `abort()`; `all` = kill switch. |

`SYSTEM` prompt additions: never claim an agent was dispatched unless the tool result says so; summarise, never read transcripts aloud ("say 'open terminal' to read it").

**Confirmation flow on the glasses.** The Even AI v2 protocol in app 2.4.0-246 (`even/common/services/even_ai_v2/model/*`) has: `cmd.content.confirm` (bool; the shim sends `false` today) with dialog state `EvenAiV2DialogState{app, action, params, confirm_text}`; `ask.kind ∈ {fetch, options}` with `content.options`; reply intents `EvenAiV2ReplyIntent ∈ {confirmed, selected, dismissed}`; the glasses projection renders `title/question/prompt/options[{id,label}]/confirm_text`. **Caveat: no captured frame with `confirm:true` or `kind:"options"` exists in `~/even-app/records` or `ai_frames.log` — shapes are inferred** (spike item 1). `ask_options`/`interaction_capabilities` literals belong only to the phone KB-chat screen (`kb_qa_client.dart`), not the HUD.

Preferred (one turn, HUD dialog; a *yes* also opens the Terminal feature where the agent appears):
```
down {"type":"cmd","id":"cmd_x","msg_id":..,"content":{"app":"terminal","action":"on","params":{},"confirm":true,"confirm_text":"Dispatch agent 'fix-ci' in ~/github/lets-code on qwen?"},"cmd_ids":["cmd_x"],"question_msg_id":..}
up   {"type":"reply","id":"cmd_x","content":{"result":"confirmed"}}   | {"result":"dismissed"}
```
Alternative: `{"type":"ask","id":..,"kind":"options","content":{"question":"Dispatch agent?","options":[{"id":"yes","label":"Dispatch"},{"id":"no","label":"Cancel"}]}}` → `reply.content.selected`. Fallback (always works, two turns): speak "Shall I dispatch an agent for X? Say yes to confirm."; the next `request` matching `yes|do it|go ahead|confirm` within 90 s calls `confirm_dispatch`; anything else voids the token. Reuses the `pending` futures; `CMD_REPLY_TIMEOUT` ≈20 s for confirm dialogs.

**Registration and limits.** Shim table `agents(id, label, conv_id, cwd, model, created_ts, ttl_s, confirm_frame_id, state, last_seen)`. `MAX_AGENTS=2` running (reject: "two agents are already running"); unique labels ≤24 chars (= Durable conversation name shown in Terminal); TTL default 2 h (idle → abort + archive; busy → warn at TTL, hard abort at 2×TTL); `cwd` ∈ `AGENT_CWDS` (`~/github/*`, `~/sandbox/agents/<label>`), never `~`. Durable's `maxTurns` per conversation as a second brake.

**Results back to the glasses.** Pull: `agent_status`/`list_agents` summarise the latest assistant entry from `/history`; optional push later through the app's notes/quicklist `ask` channel. Full transcripts stay in Terminal (`/events` + `/history`).

**Attaching.** From glasses/phone: the Durable conversation is a normal row in the merged `/api/sessions`; open → `/events` stream; type/speak → `submit(... steer)`. From a shell: Durable's store is bridge-owned, so **`pi --session` / tmux attach do not apply** — provide `even-bridge attach <label>` (tiny CLI over `/api/events` + `/api/prompt`) in Phase 3; until then use the phone panel or `curl /api/sessions/:id/history`.

**Delegation inside agents [notes Task B.2–3].** A lets-code **agent-file loader** (`~/.pi/agent/agents/*.md`: scout, general, worker, reviewer, tester, researcher, software-factory, …; parser = `parseAgentFile` in lets-code's subagents module) plus a Durable `subagent` tool that opens an **owned child conversation** (README ex. 22/23); mapping per the notes' table (prompt → `instructions`/section, `tools`/`disallowed` → `tools`, `thinking` → `thinkingLevel`, `timeout` → abort budget, `role/permission` → `beforeTool` hook). Then experts through the same loader (`bin/` helpers, refs, `setup`, `requires`/`platform` checks). Later: the software factory as a Durable task with child tasks. Even AI only ever addresses the *root* agent; children are visible via `list_agents` as `label/child-n`.

## 3. Safety

- **No-stray guarantee**: an agent exists only if a registry row with a received `confirm_frame_id` exists **and** a Durable conversation with that `conv_id` exists. A reaper (systemd user timer, 1 min) reconciles: rows without a live conversation → `stopped`; live Even-AI-created conversations without a row → `abort()` + log "stray"; TTL enforcement; owned children die with their parent (Durable ownership tree). The reaper and `dispatch_agent` refuse while `~/.even-terminal/agents.disabled` exists. Bridge restarts: `harness.resume()` continues checkpointed work — the reaper re-applies TTLs, so nothing resumes past its budget.
- **Kill switch**: `stop_agent all` (voice) → `abort()` on every Even-AI-owned conversation; `touch ~/.even-terminal/agents.disabled`; `systemctl --user stop even-cloud-shim`; `sudo systemctl stop even-bridge` (needs the user: `! ssh -t borealis.local '<cmd>'` [notes §4]). Max 2 agents, hard.
- **Permission scope — [conflict/gap]**: the notes defer "lets-code's guards as Durable `beforeTool` hooks" to *later*, but `NodeExecutionEnv` runs `bash` directly as `ay` and **lets-code's mandate and bubblewrap sandbox are pi-CLI extensions that cannot load in Durable** — so a glasses-dispatched agent would initially run with the user's full shell rights. For the Even AI path this must be in the MVP: a custom `env` that wraps commands in `bwrap` (writes confined to cwd + /tmp, `~/.ssh ~/.aws ~/.config` unreadable, network allow-list = inference host) or `systemd-run --user -p MemoryMax=600M --scope`, and a `beforeTool` hook ported from lets-code's `judgeBash` (plain functions) for `.git/.env/keys` protection. Stronger later: dedicated `agent` Unix user.
- **Privacy**: default model = the user's vLLM, no third-party traffic (`PI_TELEMETRY=0`, pi-ai `identity:{attribution:null}`); Claude only when the user names it per agent; the bridge's existing Claude/RC sessions are untouched.
- **Audit log**: append-only JSONL `~/even-app/shim-data/agents.log` `{ts, session, tool, args, confirm_frame_id, reply_intent, conv_id, model, outcome}`; reaper actions; Durable's `harness.usage()` token/cost totals per conversation; bridge log already records prompts/interrupts.
- **Abuse surface**: Even AI WS only via `evapi.i-bora.com` (LAN+WG); bridge token stays in `/etc/even-terminal.env`; the LLM cannot fabricate a confirmation — `confirm_dispatch` requires a stored token *and* a matching reply frame id.

## 4. Verdict, risks, plan, questions

**Verdict: feasible; the user's chosen flavour (Durable inside even-bridge) is the right one for "no strays" because the bridge becomes the single owner of every glasses-started agent.** The Even AI side is ~400 lines of Python in the shim plus a reaper; the bridge side is a new provider (~800–1200 lines) plus the agent-file loader. Rev-1's "MVP without Durable" (bridge-spawned `pi --mode rpc`) remains a valid stop-gap if the provider slips.

**Risks.** (1) HUD confirm/options frames unverified → two-turn spoken fallback. (2) pi-durable churn (1.3→1.5 within weeks, irreversible migrations, no upstream tests) → pin, back up `durable.sqlite` before upgrades, keep the old pi provider. (3) **Unsandboxed bash in Durable** (above) → bwrap `env` + `beforeTool` in MVP. (4) qwen tool-calling misfires in the shim loop → harmless thanks to confirmation; tool result drives the spoken answer. (5) Memory on the Pi (swap full) → monitor bridge RSS; zram; alternative A. (6) Durable conversations are invisible to a terminal `pi` (by design) → `even-bridge attach` CLI.

**Phased plan.**
- *Phase 0 (½ day) [notes Task A]*: commit the live uncommitted even-bridge work on a branch (`fix/pi-start-cwd`), `node --test test/pi-start-cwd.test.mjs`, PR, then move the checkout to `main` and restart (user runs sudo). Resolve the `node:fs` import conflict as the notes describe.
- *Spike (1 day)*: send `cmd confirm:true` and `ask kind:"options"` from the shim behind an env flag and record the glasses + reply frames; `npm pack @earendil-works/pi-durable@<pinned>` and run README ex. 26/29 against vLLM in a scratch dir (`/tmp`, isolated `HOME`, removed afterwards [notes §4]); measure bridge RSS with 2 concurrent conversations.
- *MVP (3–5 days)*: bridge `durable` provider (read-only first if the user says so; then prompt/interrupt), bwrap `env` + `judgeBash` hook; shim tools + registry + two-turn fallback + reaper + audit log; `terminal on` after dispatch; real-life test on borealis (real pi/vLLM, scratch dirs) before calling it done.
- *Full (1–2 weeks)*: native HUD confirm/options once verified; agent-file loader + `subagent` tool (owned children), experts; `even-bridge attach` CLI; result push to glasses; per-agent `systemd-run` caps or dedicated user; software factory as a Durable task.

**Closed by the notes / user:** flavour (Durable in even-bridge, SQLite store, pi-ai from lets-code's `models.json`); default model (vLLM; Claude kept in the bridge, explicit per agent); lets-code stays Durable-free; conventions (commit identity `Umutayb <66674442+Umutayb@users.noreply.github.com>`, ask before push/PR/merge, real tests, sudo via the user).

**Still open (only the user can answer).**
1. Phase-1 scope of the `durable` provider: read-only (start + watch) first, or prompt + interrupt from day one? [asked in the notes, unanswered]
2. Isolation for Even-AI-dispatched agents: bwrap `env` + `beforeTool` hook in the MVP (my recommendation given the gap above), or accept unsandboxed `ay` until the "later" guards phase? Which directories may agents touch (`~/github/*` only?)?
3. Limits: 2 concurrent agents, 2 h TTL, `maxTurns` ≈ 60 — acceptable? Auto-archive finished agents or keep them listed until dismissed?
4. Confirmation UX: one-tap HUD "Dispatch?" dialog enough, or always read task/cwd/model aloud first?
5. Memory headroom: OK to add zram/swap on borealis, or move execution to the Mac via a remote `ExecutionEnv` if two agents strain the Pi?


---

# Handover: Pi Durable in even-bridge (borealis), and loose ends

Written 2026-11-02 for a fresh agent. Read all of it before acting. Everything
below was checked on the date above. Re-check anything you depend on, since
the machines and repos keep moving.

## 1. Your next tasks, in order

### Task A: commit the live, uncommitted even-bridge work on borealis (do this first)

- **What and where.** The even-bridge checkout on borealis, `~/github/even-bridge`, is on branch `cc-resume-rc`. It has uncommitted work from 2026-10-30:
  - `src/providers/pi/provider.mjs`: a new `startCwdFor(phoneCwd, cwd, defaultCwd, home)`, so a new pi session falls back to an existing folder instead of failing with a misleading ENOENT;
  - `src/providers/pi/session.mjs`: a one-line change;
  - `test/pi-start-cwd.test.mjs`: untracked.
- **It is live.** The running bridge (`even-bridge.service`) executes this working tree. Do not stash, reset or pull over it.
- **Steps:**
  1. Read the diff.
  2. Run `npm test` there, or at least the new test with `node --test test/pi-start-cwd.test.mjs`.
  3. Commit it on its own branch (e.g. `fix/pi-start-cwd`), with the commit identity from section 4.
  4. Push and open a PR on `Umutayb/even-bridge`.
- **After it merges:** move the checkout to `main` (`git checkout main && git pull`), then `systemctl restart even-bridge`. This restart needs sudo with a password, so ask the user to run it (section 4). `main` already contains PR #1. That PR's `provider.mjs` edit touches the same `import { readFileSync } from "node:fs";` line as the uncommitted work, so expect a trivial conflict, resolved as `import { accessSync, constants, readFileSync, statSync } from "node:fs";`.

### Task B: the Pi Durable prototype in even-bridge (agreed with the user, not started)

**Goal.** Glasses-started conversations run on Pi Durable inside the bridge process. That removes the single-writer problem and makes runs survive bridge restarts.

**Build order** (the user agreed to the direction; confirm the order before starting):

1. **A new, separate pi provider in even-bridge:** "durable", next to the existing `src/providers/pi/`.
   - It runs inside the bridge process.
   - Storage: SQLite, `openNodeSqliteStorage("~/.even-terminal/durable.sqlite")`.
   - Model: your vLLM through `@earendil-works/pi-ai`, an OpenAI-compatible provider with `baseUrl: https://inference.i-bora.com/v1` and model `qwen3.8-27b`. Better: read the lets-code provider out of `~/.pi/agent/models.json`, which lets-code writes with the discovered context window and thinking budgets.
   - Tools: `CodingTools` (read, write, edit, bash) in a `NodeExecutionEnv` at the conversation's cwd.
   - Wiring to the glasses:
     - a prompt → `conversation.submit({type:"input", content, requestId, whenBusy:"steer"|"followUp"})`;
     - the session stream → `conversation.watch()` / `viewState()`;
     - an interrupt → `abort()`;
     - a selectable question → a tool that waits for the next submission.
   - Keep the existing pi provider for sessions shared with a terminal pi.
   - Ask the user whether to start read-only (start and watch from the glasses) or with full prompt and interrupt support. The question was asked and not yet answered.
2. **A lets-code agent-file loader plus a `subagent` tool,** so Durable conversations can delegate to lets-code's agents (`~/.pi/agent/agents/*.md`: `scout`, `general`, `worker`, `reviewer`).
   - Use Durable's owned-conversation pattern from its README examples 22 (foreground) and 23 (persistent, restart-safe).
   - The agent files stay the single source of truth, shared with the pi CLI.
3. **Experts through the same loader:** their `bin/` helpers, refs, `setup`, and the `requires` / `platform` checks.

Later: lets-code's guards as Durable `beforeTool` hooks (the git guard's `judgeBash` is plain functions), and the software factory as a Durable task with child tasks (a rewrite).

**How a lets-code agent file maps to Durable** (`configure()`, the per-conversation `pi.agent` document):

| Agent file | Durable |
|---|---|
| prompt body, `append_prompt` | `instructions` or an extension `section` |
| `tools`, `disallowed` | `tools` / `modelTools` |
| `thinking`, `effort` | `thinkingLevel` |
| model (inherited) | `model` |
| cwd | `cwd` |
| subagent run (child `pi --mode rpc` today) | owned child conversation |
| `bin/` helpers, refs, `agent_dir` | unchanged: files used through bash and read |
| `setup`, `requires`, `requires_env`, `platform` | host-side check or one-time run |
| `timeout` | abort the child after its budget |
| `role`, `permission` (mandate) | a `beforeTool` hook selected for that conversation |
| `use_for`, `keywords`, `job`, `route`, `dispatch_rule`, `team` | the subagent/expert tool's description and routing |
| `skills` | a section listing them, plus `read` |

The parser in lets-code is `parseAgentFile` in the subagents module, in the `lets-code` script around `pi_write_subagent_extension`.

**Pi Durable facts:**
- Package: `@earendil-works/pi-durable` 1.4.0, MIT, explicitly "Experimental. The API changes without notice". It went 0.0.1 → 1.4.0 in a month (17 releases). 1.4.0's SQLite migration cannot be rolled back. Pin the exact version.
- One process owns a store, with no cross-process locking. That fits: the bridge is the only owner.
- The pi CLI (1.4.0) does not use Durable at all. Durable has its own extension model (`defineExtension` with tools, sections, hooks, wraps, tasks), so pi CLI extensions such as lets-code's modules do not load in it.
- Docs: the package README (about 900 lines, very complete; `npm pack @earendil-works/pi-durable@1.4.0` and read `package/README.md`), and `docs/spec.md` in github.com/earendil-works/pi under `packages/durable`.
- Useful README examples:
  - 20: inbox (steer, follow-up, while busy);
  - 21: late join;
  - 22 / 23: subagents;
  - 26: coding agent;
  - 29: environment per conversation.

**Why even-bridge needs it.** The current pi provider (about 2,800 lines) works around pi session files allowing only one writer:
- `detect.mjs` (307 lines) scans `/proc` and tmux, because a second writer "wedges and silently drops prompts";
- `watcher.mjs` (182) tails JSONL so a terminal pi's output reaches the glasses;
- `session-files.mjs` and `rpc-client.mjs` run `pi --mode rpc`;
- `even-pi-tmux.service` exists only for tmux prompt injection.

## 2. State of things (2026-11-02)

### lets-code: github.com/civitas-cerebrum/lets-code, local checkout `~/Github/lets-code`, `main` at `8c3fb10`

Merged recently:
- **#102: Windows support.** It runs in Git Bash. Shared JS helpers come from `lc_ts_platform` (lcw*), there is a `bin/lets-code-windows.js` launcher, and the windows-latest CI job is green. Also in #102: the git guard is off by default, `/git-guard on|off|status` turns it on for a session and remembers the choice, and setup does not ask about it.
- **#101: memory guard off by default, plus a RAM watcher.** At 85% use the user is asked; a headless session declines. On Windows it works from a PowerShell process list.
- **#103: `--mode rpc`.** lets-code's own lines go to stderr, so stdout is pi's protocol only.
- **#104: core memory keeps significant entries only.**
  - Kept: decisions, facts, preferences, wrapped-up work.
  - The harness records only a factory run that ends `done`.
  - A subagent's `remember kind: work` is refused.
  - Old step entries move to the archive.
- **#106: fixes #105.** The memory guard's abandoned-process marker is now `LETS_CODE_PI_MARK`. `LETS_CODE_PI` is only the "how to start pi" override. Before the fix, every subagent, expert and factory spawn failed on Linux and Windows.

Real-life verified on borealis with `main-8c3fb10`:
- a subagent;
- `expert-reviewer`;
- a full software factory run (plan → build → reviews → test → judge → regression PASS → commit).

Tests: `bash tests/run.sh [file...]` runs everything, or only the named files. CI runs ubuntu, macos and windows. Ubuntu needs about 2 min, macOS about 8, Windows about 14.

### even-bridge: github.com/Umutayb/even-bridge, local checkout `~/Github/even-bridge`, `main` at `c2c9e8b`

- PR #1 merged: pi sessions start through `lets-code` when it is on PATH (`EVEN_BRIDGE_PI_BIN=pi` keeps a bare pi). `ensure-pi-tmux.sh` and `install-services.sh` do the same.
- `npm test`: one failure that also happens on `main`, on macOS only (`claude-wrap.test.mjs` expects `/tmp`, macOS gives `/private/tmp`).

### borealis (`ssh borealis.local`, Linux aarch64, Raspberry Pi; user `ay`)

- **lets-code:** `~/.local/bin/lets-code` = `main-8c3fb10`, updated with `lets-code update --snapshot`. Backups `lets-code.bak-*` are next to it.
- **The bridge:** `even-bridge.service`, port 3456, behind nginx at cterm.i-bora.com. It runs from `~/github/even-bridge` (see Task A).
  - Drop-ins live in `/etc/systemd/system/even-bridge.service.d/`.
  - `pi-lets-code.conf` sets `EVEN_BRIDGE_PI_BIN=/home/ay/.local/bin/lets-code`, `EVEN_BRIDGE_PI_MODEL=` (empty) and `LETS_CODE_TOKEN=lets-code-local`.
  - `remote-control.conf` sets `EVEN_BRIDGE_NEW_SESSION_PROVIDER=pi` and `EVEN_BRIDGE_CC_RESUME_RC=1`.
  - Glasses sessions therefore default to `inference.i-bora.com`, which is what the user wanted; Claude Haiku stays in `/model`. The old `~/.local/bin/pi-claude` wrapper (`lets-code --claude`) was removed, and `pi-claude.bak-20261101` keeps it.
- **lets-code's config:** `~/.config/lets-code/config` has `ENDPOINTS="https://inference.i-bora.com https://vllm.i-bora.com http://192.168.0.114/vllm"`.
- **Other services:** `claude-remote-bridge.service` is active; `even-pi-tmux.service` is inactive.
- **No node on borealis's non-login PATH:** use `bash -lc` or `$HOME/.nvm/versions/node/v24.21.0/bin`.

### Other machines

- **inference-server** (Windows 11, reached only through borealis: `ssh borealis.local "ssh inference-server ..."`; its shell is PowerShell). It hosts the vLLM server inside WSL Ubuntu: qwen3.8-27b, about 25 GB.
  - Git, Node 26 and Python 3.13 were installed there for Windows testing, along with a global lets-code and pi. The test folder is `C:\Users\windows-pc\lc-test`, and a portable Node is in WSL at `~/lc-test-node`.
  - Do not run heavy test suites there without asking: it serves the model.

## 3. Pi Durable: what was already decided

- **lets-code itself:** do not integrate Durable now. It would mean leaving pi's plugin API, which every lets-code module is built on, and Durable is not stable yet. Revisit if pi itself moves onto Durable, or if lets-code gets a headless always-on mode.
- **even-bridge:** yes, as the prototype in Task B.

## 4. Rules and conventions (from the user and their memory)

- **Commit identity.** Under `/Users/Ay` and on borealis, commits must be authored as `Umutayb <66674442+Umutayb@users.noreply.github.com>`. This machine's git config is still `Umut Ay Bora <umutaybora@gmail.com>`, and two lets-code commits of 2026-11-02 (`fe9ae0e`, `30cc4d1`) went out under it and are merged. Do not rewrite merged history; set the right identity (per repo, or `--author`) before committing.
- **Commit messages and PRs:** plain sentence-style messages like the repo history, with no AI attribution trailers (lets-code's `.githooks/commit-msg` strips them).
- **Pushing and merging:** ask before pushing, opening PRs or merging, unless the user said so in this task. Delete PR branches after merge.
- **Live machines:**
  - Never overwrite live working trees on borealis.
  - When simulating `lets-code setup` or launches, isolate `HOME`, `XDG_CONFIG_HOME` and `PI_CODING_AGENT_DIR`. Setup step 7 copies the script over `~/.local/bin/lets-code`; this happened once and was repaired with `lets-code update --snapshot`.
- **sudo on borealis** needs a password. Ask the user to run such commands themselves with `! ssh -t borealis.local '<cmd>'`.
- **Testing:** test for real (real pi, vLLM, scratch dirs under `/tmp`, removed afterwards) before calling something done. The user asks for this. Unit tests with a fake pi are not enough.
- **Subagents:** every subagent the user sees dispatched runs on Opus 5.5.
