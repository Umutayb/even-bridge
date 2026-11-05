# Assistant spike (plan Task A0)

2026-11-03, borealis. Script: `scripts/assistant-spike.mjs`. Captured RPC replies: `test/fixtures/assistant/rpc-replies.json`. Raw logs and per-run JSON (no tokens): `~/tmp/ovs-a0-run/` (`runs/*.json`, `log.jsonl`, `probe.jsonl`, `sessions/`). Runtime code is unchanged.

Versions: pi 1.0.3; lets-code **main-8c3fb10** (`~/.local/bin/lets-code --version`; the plan says `d20144e`); vLLM `qwen3.8-27b` at `inference.i-bora.com` (shared; all prompts ran one at a time). `MemAvailable` 2.1 GB, zram swap 6 GB (1 GB used) at the start.

## Setup

- Child: `systemd-run --user --scope -q --unit=even-lc-a0 -p CPUQuota=200% -- ~/.local/bin/lets-code --mode rpc -ne -e ~/.pi/agent/extensions/lets-code -e <probe-assistant.ts> --tools fetch_calendar,fetch_notes,memory --thinking <level> --session-dir <dir> --append-system-prompt <text> --no-mandate`, cwd `~/tmp/ovs-a0/assistant` (no git above it).
- Env: `shellEnv()` (allowlisted base env; no `*_TOKEN`/`*_KEY`) plus `ASSISTANT_MODULE_ENV` (below), `LETS_CODE_MEM_WATCH=false LETS_CODE_MEM_GUARD=false PI_TELEMETRY=0 TMPDIR=~/tmp/ovs-tmp EVEN_ASSISTANT_TOOLS_URL=http://127.0.0.1:8815 EVEN_ASSISTANT_TOOLS_TOKEN_FILE=<0600 file>`.
- **How the child reaches vLLM without `LETS_CODE_TOKEN`:** the launcher reads `TOKEN=` from `~/.config/lets-code/config`, exports `LETS_CODE_TOKEN` itself, and pi resolves it through `$ENV` in `models.json`. Every model call worked with the token stripped. The stub tool server saw 0 auth failures.
- Stub tool server on `127.0.0.1:8815`: the plan's schema; 1 s delay; calendar answers `window: <from> 00:00 to <to> 24:00 (local)\n18:00 Lasagna`.
- `probe-assistant.ts` (a throwaway A2): fetches the schema, registers each tool as an HTTP call (Bearer token from the file, 12 s timeout), and logs the `LETS_CODE_*_ON` switches and the active tools. Its `context` hook replaces `fetch_*` results from earlier user turns with `[<label> result of an earlier turn removed: fetch again]`. It logs every provider payload (stub count, tools, thinking params) and has the command `/even-note <file>`. From v2 on it also blocks a tool call after 8 calls per run.
- Every prompt starts with the design's per-turn header, e.g. `[10:27 Tue 3 Nov 2026, Europe/Amsterdam · lang en · style brief]`.
- System prompt addition (v2): "You are Even AI … one or two short spoken sentences. Facts about the user's calendar and notes come only from tool results of this turn: call the tool again whenever they ask … For anything about the user's schedule, call fetch_calendar with explicit dates; for their notes, call fetch_notes. The memory tool holds only what the user asked you to remember: never use it for calendar or notes, and search it at most once per question."

## Latency matrix (Step 3)

20 prompts per cell, one warm child per cell, one session per cell (persistent, like `dur-assistant`). Times are ms from writing the `prompt` until the event, p50/p90 over the rows that called the expected number of tools and finished.

- *final text* = the first `text_delta` after the last `tool_execution_end`. This is the answer the HUD shows.
- *end* = `agent_end`.
- *reasoning* = `usage.reasoning` (vLLM reports it).
- Thinking params sent:
  - medium: `{enable_thinking:true, thinking_budget:8192, reasoning_effort:"medium"}`
  - low: `{… thinking_budget:2048, reasoning_effort:"low"}`
  - `max_tokens` 32768 in both.

| thinking | tools | n ok | first thinking | first tool | **final text** | **end** | reasoning tok | output tok | idle RSS/PSS, peak RSS MB | spawn→ready |
|---|---|---|---|---|---|---|---|---|---|---|
| medium | 0 | 20 | 272/322 | – | **361/429** | **431/511** | 35/39 | 66/70 | 113/75, 139 | 1620 |
| medium | 1 | 19 | 431/458 | 834/1147 | **2379/2760** | **2458/2831** | 84/104 | 167/187 | 115/82, 259* | 1614 |
| medium | 2 | 20 | 241/278 | 537/656 | **1980/2043** | **2051/2122** | 45/79 | 157/186 | 114/75, 139 | 1703 |
| low | 0 | 20 | 295/363 | – | **387/482** | **543/650** | 40/43 | 69/71 | 113/80, 140 | 1658 |
| low | 1 | 20 | 248/301 | 530/598 | **1899/1966** | **1943/2045** | 78/97 | 157/176 | 113/75, 138 | 1598 |
| low | 2 | 17 | 295/698 | 869/1785 | **2262/3238** | **2358/3291** | 71/102 | 173/216 | 113/80, 134 | 1800 |

\* The peak of 259 MB comes from the runaway run below; normal runs peak at 134–147 MB.

Prompts:
- 0 tools: "Say something nice about Tuesdays."
- 1 tool: "What's on my calendar Friday?"
- 2 tools: "What's on my calendar Friday, and what's in my notes?"

Tool time includes the stub's 1 s.

Medium and low cost about the same: qwen thinks for 35–105 tokens on these turns at either level. Low is not faster for 0 or 2 tools. It is 0.5 s faster for 1 tool. It had more degenerate runs (below).

### Abnormal runs (not in the table)

In 120 v2 prompts, 4 runs went wrong:

- **medium, 1 tool, #4**: a tool loop. There were 241 `fetch_calendar` calls in one run, 242 requests and 32 478 output tokens. The 8-call block did not stop it: each blocked call just came back as an error, and the model called again. The spike's 180 s deadline finally sent `abort`.
- **low, 2 tools, #2 and #16**: `stopReason: "length"` at 32 768 output tokens, in the assistant message that holds the two tool calls (180 s and 98 s). vLLM's tool parser hides the tokens: the stored message has only thinking plus two tool calls. **#5** is the same pattern at 11 445 tokens (31 s). In v1 the same tail leaked into the text as `</trans>\n</parameter>\n</function>`.

The first run (**v1**) had a two-sentence system prompt without the routing sentences:
- 18/20 of the 1-tool turns at each level answered from `memory search` ("I don't have access to your calendar") and never called `fetch_calendar`. After the first such answer, the session kept repeating it.
- At low with 2 tools, run #0 looped on `memory search` 519 times (484 × the query "search") until the deadline. Every following prompt was then refused with "Agent is already processing".

The v1 results are kept in `~/tmp/ovs-a0-run/runs/v1/`.

## Cold start, memory and modules (Steps 2, 3, 4e)

| | spawn→`get_state` ready p50 (min–max), n=3 | idle RSS / PSS |
|---|---|---|
| assistant env (`ASSISTANT_MODULE_ENV` + `--no-mandate`) | **1695 ms** (1608–1758) | **115 / 82 MB** (one process, `pi`) |
| same + `LETS_CODE_REASONING=true LETS_CODE_VISION=true` (skips the launcher's two probe requests to vLLM) | **1139 ms** (1115–1160) | 114 / 81 MB |
| default lets-code env (n=1) | 5534 ms | 336 / 302 MB |
| SIGKILL mid-turn → respawn with `--session` (4e) | 1960 ms (2.0 s after the kill) | 116 / 75 MB |

- **Step 2 (module switches).** The `LETS_CODE_*_ON` switches the probe saw at load:
  - assistant env: `CORE_MEMORY_ON=1 GROUNDING_ON=1 AGENT_GUARD_ON=1 METRICS_ON=0`;
  - default: also `SUBAGENTS_ON EXPERTS_ON SESSIONS_ON PLAN_ON ORCHESTRATOR_ON METRICS_ON=1`.

  The banner's count fell from 15 to 9 extensions (it counts files and ignores `-ne`). `memory` still answers (4c).
- **4e (respawn after SIGKILL).** The killed turn ends in an assistant message with no tool result (ruling 20 holds). The respawn keeps the same session file and comes back at thinking `medium`. No `lets-code-sessions/<pid>.json` was left behind (sessions module off).

## Checks (Step 4)

- **(a)** `-ne`, `-e <dir>` and `--tools` pass through `lets-code` unchanged.
  - Active tools: exactly `fetch_calendar, fetch_notes, memory`.
  - `getAllTools()` lists only those three, also in the default env: tools not named in `--tools` (`subagent`, `expert`, `message`) are not registered at all.
  - Schema fetch took 29–40 ms at load.
- **(b)** "What's on Friday?" called `fetch_calendar {2026-11-06..2026-11-06}`. Then "And Thursday?":
  - the `context` hook stubbed 1 result on both requests of turn 2;
  - the provider payload carries the stub (`stubs:1`), so **the rewrite reaches the model**;
  - the model called `fetch_calendar` again.

  It asked for **2026-11-12** (the Thursday after that Friday), not 5 Nov (this Thursday; today is Tue 3 Nov). This is the §0 date ambiguity, reproduced. The provider payload still carries "Lasagna" through the model's own earlier answers (3–4 times), as the design expects.
- **(c)** "Remember that I like tea." produced `memory remember` →
  - project store `~/.pi/agent/core-memory/projects/assistant-1c8e8707/memory.jsonl` (+ `memory.md`);
  - entry `{"id":"igr7p1","t":…,"u":…,"kind":"preference","gist":"The user likes tea.","refs":[],"by":"user","n":1}`;
  - the global store was not touched (no `global.jsonl` exists).

  A line appended by hand (`#a0cofe`, coffee black) was **not** seen in the same process ("No entry matches coffee"). After `new_session`, `memory search coffee` found it. → `MEMORY_REREAD = no`. The store is cached per process in `globalThis` and reloaded only at `session_start` (a new session or a respawn).
- **(d)** RPC shapes; the exact replies are in the fixture.
  - `set_thinking_level` → `{type:"response",command:"set_thinking_level",success:true}` (no data). `get_state.thinkingLevel` follows.
  - `set_model {provider:"Anthropic", modelId:"claude-haiku"}` → `success:true`, `data` = the full model object (`id,name,api,provider,baseUrl,reasoning,thinkingLevelMap,input,cost,contextWindow,maxTokens,compat`; qwen adds `samplingParamsByThinkingLevel`).
    - No auth env was needed.
    - **The thinking level is reset on every switch** to the model's `modelThinkingLevels` entry in `~/.pi/agent/settings.json`: `low` → haiku `medium` → qwen `medium`. Sonnet would get `low`.
    - The child's `claude` module then hosts the lets-code Claude proxy on `127.0.0.1:8795` in-process. It logged "lets-code Claude proxy on http://127.0.0.1:8795/v1" at each switch and went away with the child. No prompt went to Claude.
  - `compact {customInstructions}`:
    - With the defaults it fails as `{success:false, error:"Nothing to compact (session too small)"}`. pi keeps the last `compaction.keepRecentTokens` (default 20 000) verbatim and refuses when there is less history than that.
    - With `<cwd>/.pi/settings.json {"compaction":{"keepRecentTokens":200}}` **and** `--approve` on the child, it succeeded in 5.2 s. RPC mode cannot ask the project-trust question, so without `--approve` the project settings are skipped and it failed the same way.
    - Reply: `data:{summary, firstKeptEntryId, tokensBefore:4524, estimatedTokensAfter:2648, usage:{…, reasoning:221}, details}`. `summary` is markdown (`## Goal`, `## Constraints & Preferences`, `## Progress`, `## Key Decisions`, `## Next Steps`, `## Critical Context`, and for a split turn `**Turn Context (split turn):**`).
    - The session file stays the same. `get_messages` becomes `system, compactionSummary, <kept tail>`.
    - The summary repeated phone data ("Calendar (Fri 2026-11-06): 18:00 Lasagna", the notes).
  - `new_session` → `{success:true, data:{cancelled:false}}`. `get_state.sessionFile` changes at once. The file does not exist until the first prompt, and `get_messages` is empty.
  - `/even-note <file>` sent as `prompt`:
    - reply `{success:true, data:{disposition:"handled"}}` in 2 ms;
    - events only `message_start`, `message_end` (no `agent_start`);
    - `get_messages` shows `{role:"custom", customType:"even-note"}` and no assistant turn, and the file is deleted;
    - on the next prompt ("What happened at 07:30?") the model answered from the note. → `sendMessage(…, {triggerTurn:false})` from an extension command works (ruling 24).
- **(e)** See the respawn row above.

### Other observations

- "I might go to Anna's on Saturday, not sure yet." made qwen try `memory remember` 8+ times without a `gist`. Each call failed ("Give the gist…"), and the 8-call block ended it. Unrequested memory writes do happen, so ruling 30's gate is needed. Without the cap this would be another loop.
- Global state: the launcher rewrites `~/.pi/agent/models.json` and `settings.json` (compaction reserve) on every launch, as any lets-code launch does. RPC `set_model`/`set_thinking_level` do not persist (`persist` is never set over RPC). The one default-env launch (`--modules`) refreshed the expert files under `~/.pi/agent/` as every default launch does. No `trust.json` was written.

## Decisions

| constant | value | basis |
|---|---|---|
| `T1_S` | **2.5** | 0-tool medium final p50 = 0.43 s < 2.5 s (Step 5 rule); 5 s first-frame budget holds: 0-tool answers land < 0.6 s p90, tool turns get the progress line at the first `tool_start` (p50 0.53–0.87 s, p90 ≤ 1.8 s) |
| `T2_S` | **4.0** | unchanged; no measured turn produced neither text nor a tool within 4 s except the abnormal runs |
| `NO_TOOL_THINKING` | **`medium`** | 0-tool medium final p50 0.43 s, far below 8 s; ruling 27's `low` branch does not fire (every turn medium, no `POST /api/assistant/model {thinking}` per turn) |
| `ASSISTANT_MODULE_ENV` | `LETS_CODE_SUBAGENTS=false LETS_CODE_EXPERTS=false LETS_CODE_SESSIONS=false LETS_CODE_CLAUDE_CODE=false LETS_CODE_MANDATE=false LETS_CODE_SANDBOX=false LETS_CODE_GIT_GUARD=false LETS_CODE_SESSION_TAG=false LETS_CODE_METRICS=false LETS_CODE_CORE_MEMORY=true LETS_CODE_AGENT_GUARD=true LETS_CODE_GROUNDING=true LETS_CODE_MEM_WATCH=false LETS_CODE_MEM_GUARD=false` **plus the argv flag `--no-mandate`** | The launcher **unsets** every `LETS_CODE_<X>_ON` and derives it from `LETS_CODE_<X>`, config or flags, so `_ON=false` names do nothing. No env var removes the mandate module: `LETS_CODE_MANDATE=false` still loads it with plan mode dormant. Left loaded without a switch: `backend.ts` (facts on request only), the `claude` module (needed for a Claude switch), the footer (`METRICS_ON=0`, no UI in RPC). The memory guard is inert with both `MEM_*=false`. |
| `ASSISTANT_PROBE_PINS` (optional) | `LETS_CODE_REASONING=true LETS_CODE_VISION=true` | cold start 1.70 → 1.14 s and two fewer vLLM probe requests per spawn; **the values must equal what the launcher detects today** (`reasoning:true`, `input:[text,image]`), because the launcher writes them into the shared `~/.pi/agent/models.json` on every launch |
| `ASSISTANT_MEMORY_STORE` | `~/.pi/agent/core-memory/projects/assistant-a15eee30/memory.jsonl` for cwd `/home/ay/sandbox/assistant` (`<basename(cwd)>-<sha1(cwd)[0:8]>`, cwd = project root because no `.git` above it; `memory.md` and `archive.jsonl` beside it); entry `{id, t, u, kind: fact\|preference\|decision\|pointer\|work, gist ≤ 200, refs[], by: user\|model\|harness, n}`; `scope:"global"` writes `~/.pi/agent/core-memory/global.jsonl` | measured for `~/tmp/ovs-a0/assistant` → `assistant-1c8e8707`; the formula is lets-code's `projectDir()` |
| `MEMORY_REREAD` | **no**: reloaded only at `session_start` (`new_session` or a respawn with `--session`); a newer hand-edited `memory.md` is also read back only then | 4c |
| `-ne` / `-e <lets-code ext dir>` / `--tools` pass through | **yes / yes / yes**: active tools exactly the listed ones | 4a |
| `context` rewrite reaches the model | **yes**: provider payload carries the stub, the model re-fetches | 4b |
| `set_thinking_level` reply | `{success:true}`, no data | 4d |
| `set_model` reply | `{success:true, data:<model object>}`; **thinking resets to `settings.json` `modelThinkingLevels`** → send `set_thinking_level` after every `set_model` | 4d |
| `compact` reply | `{success:true, data:{summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage, details}}`; `{success:false, error:"Nothing to compact (session too small)"}` below `keepRecentTokens`; needs `<cwd>/.pi/settings.json {"compaction":{"keepRecentTokens":N}}` + `--approve` for a small N | 4d |
| `new_session` reply | `{success:true, data:{cancelled:false}}`; new `sessionFile` at once, written lazily | 4d |
| extension command `sendMessage(…, {triggerTurn:false})` | **works**: `prompt "/even-note <f>"` → `{disposition:"handled"}`, a `custom` message, no run | 4d |
| cold spawn / idle RSS | 1.7 s (1.1 s pinned), respawn after SIGKILL 2.0 s; idle 113–116 MB RSS, 75–82 MB PSS; turn peak 134–147 MB | Steps 3, 4e |
| `ASSISTANT_MAX_TOOL_CALLS` (new) | **8** per run, blocked in a `tool_call` hook, **and** the host aborts the run when it keeps calling | measured loops of 241 and 519 calls; a block alone does not stop qwen |
| `ASSISTANT_RUN_DEADLINE_S` (new, proposal) | **20** → RPC `abort`, the turn falls back to the loop | the longest normal run was 3.8 s (p90 ≤ 3.3 s); the degenerate ones ran 31–180 s |
| `ASSISTANT_MAX_TOKENS` (new, proposal, **not measured**) | **4096** per request, set by `even-assistant.ts` in `before_provider_request` (`max_tokens`/`max_completion_tokens`), not via `--output-cap`/`LETS_CODE_OUTPUT_CAP` (those rewrite the shared `models.json` for every lets-code session) | normal turns used ≤ 300 output tokens; degenerate ones hit 32 768; A2 must test that the hook's return replaces the payload |

## Step 6 [GLASSES]

App behaviour (progress text + pause + answer, a 30 s gap after `start`, a `request` during an open turn, `ask` after `end`, `cmd confirm:true` frames): **pending A7** (ruling 37).

## What changes for the later tasks

1. **A1 argv/env.** Use `ASSISTANT_MODULE_ENV` with `LETS_CODE_<X>`, not `_ON` names, plus `--no-mandate`.
   - The pi flag is `--thinking <level>`. The launcher's own flag is `--thinking-level`; `LETS_CODE_THINKING` also works.
   - Add `--approve` and write `<cwd>/.pi/settings.json` with a small `keepRecentTokens`. Without both, the 04:00 reset (ruling 28) fails with "Nothing to compact" on every day with < 20k tokens of history, and even when it works it keeps 20k tokens unsummarized.
   - If compact still fails, the reset must go ahead with `new_session` without a summary note.
2. **A1 model switch.** Send `set_thinking_level` after every `set_model`: pi applies `settings.json` `modelThinkingLevels` (qwen medium, sonnet low).
   - A switch to Claude starts the lets-code Claude proxy **inside the assistant child** on `127.0.0.1:8795`, and stopping or respawning the child takes the proxy down. If anything else on the host uses `:8795` (the plan's "8 `:8795` slots"), that needs a check before Q7's switch is built.
3. **A1/A2 runaway protection** is required, not optional: `ASSISTANT_MAX_TOOL_CALLS` + `ASSISTANT_RUN_DEADLINE_S` → `abort` + loop fallback, and `ASSISTANT_MAX_TOKENS`.
   - Without an abort a stuck run blocks every later prompt ("Agent is already processing").
   - The spec's 12 s per-tool timeout does not cover this: the tools return at once; the model is what loops.
4. **A2/A3 prompt and tool descriptions.** The schema descriptions plus the system prompt must route phone questions to the phone tools and keep `memory` for remembered facts only. With a neutral prompt qwen used `memory search` for the calendar 90% of the time. With the routing sentences above, every v2 tool turn used the phone tools and none used `memory`. Of those 60, 4 were the abnormal runs, and 2 more fetched twice.
5. **A5 / ruling 36.** `MEMORY_REREAD = no`. The memory import and the KB pointer writes must be followed by a respawn of the idle child (`--session`, ~1.1–2 s) or `new_session` before the model sees them. A plain write while the child runs is invisible to `memory search`. While the child runs, its next `remember`/`forget` saves its cached entries over the file, which drops anything written underneath it. So imports run only while the child is down or idle-and-respawned right after (ruling 36).
6. **Ruling 28 summary.** The compaction summary copies calendar and notes contents into the next session. The reset's `customInstructions` must say "no calendar, notes or list contents", and A6 should assert it.
7. **A6 scenario.** "And Thursday?" after a Friday question resolved to next week's Thursday (12 Nov), not this week's (5 Nov). Keep the `next/this Thursday` transcripts.
8. **Thinking cost** is small on these turns: medium 35–105 reasoning tokens. Medium thinking does not set the turn time; the tool round trip does (≈ 1.4 s of model time + the tool).

## A1 (real run, 2026-11-05)

The Task A1 profile on a throwaway bridge: `127.0.0.1:3466`, store `~/tmp/ovs-a1-store`, cwd
`~/tmp/ovs-a1/assistant` (`EVEN_BRIDGE_ASSISTANT_CWD`), real `~/.local/bin/lets-code` + vLLM qwen (one
prompt at a time), wrapper `systemd-run` (scope `even-lc-dur-assistant-b6d9903f`), a stub tool server on
`127.0.0.1:8815` and a throwaway probe extension (`EVEN_BRIDGE_ASSISTANT_EXT`; schema → HTTP tools, the
`[even-assistant] tools: N (live)` line, `/even-note`, a short system-prompt addition). Every prompt went
through `POST /api/assistant/prompt`, every frame came from `GET /api/events?sessionId=dur-assistant`.
Three runs: run 1 with the default deadline (20 s), run 2 with `EVEN_BRIDGE_ASSISTANT_DEADLINE_S=6`,
run 3 with 8 s and a serial slow tool. Raw output (no tokens): `~/tmp/assistant-a1-run/`; the store was removed.

Banner: `durable=on wrapper=systemd-run lc=off assistant=on`. `GET /api/agents` → `{agents: []}`;
`/api/sessions` lists `{id:"dur-assistant", title:"Even AI", readOnly:true}`.

| step | run 1 (20 s) | run 2 (6 s) | run 3 (8 s) |
|---|---|---|---|
| bridge start → assistant idle with tools | 3124 ms | 2496 ms | 2747 ms |
| calendar turn (1 tool): 202 / first `tool_start` / first text / `result` | 15 / 1087 / 2074 / 2152 ms | 20 / 2945 / 3785 / 3881 ms | 15 / 1147 / 1925 / 1992 ms |
| no-tool turn: first text / `result` | 226 / 449 ms | 497 / 656 ms | 239 / 378 ms |
| `POST /api/assistant/note` (idle) | 5 ms, `queued:false`, `/even-note` handled | 3 ms | 3 ms |
| forced fast loop (`kb_search`, 0.1 s, "read every page") | tool cap at 3580 ms (`assistant_tool_cap`) | tool cap at 4871 ms | tool cap at 6414 ms |
| next prompt after the cap | `result` 619 ms | 857 ms | 1228 ms |
| forced slow loop (`web_search`, 3 s per call) | the model stopped by itself after 3 calls, 15.0 s (no cap) | tool cap at 5947 ms (9 starts, 2 requests: parallel calls) | **deadline at 8007 ms** (`assistant_deadline`, 2 serial calls) |
| next prompt after it | `result` 477 ms | 748 ms | 591 ms |
| `POST /api/assistant/reset` (compact → new_session → summary note) | 6005 ms | 5697 ms | 6077 ms |
| summary: chars / phone data in it | 3560 / **"Lasagna at 18:00"** (old wording) | 3027 / none ("(phone data left out; fetch it again)") | 3328 / none |
| bridge SIGKILL mid-turn → restart → idle with tools | 2445 ms | 2250 ms | 2238 ms |
| restart note delivered / `state.lost` | yes / (not built yet) | yes / `{requestId:"kill-…"}` | yes / `{requestId:"kill-…"}` |

Findings:

1. **The deadline catches what the tool cap cannot.** Run 1's first turn after the restart answered in
   0.98 s and then kept generating `*\n**\n**…` (13 354 characters, no tool call): the 20 s deadline sent
   `abort`, the run ended `aborted` 19 ms later, and the next prompt worked. Run 3's serial slow loop
   was stopped by the deadline at 8.0 s. No run needed the grace stop (qwen always honoured `abort`).
2. **The tool cap counts `tool_execution_start`, so parallel calls count.** qwen issued up to 9 calls in
   one message on the "read every page" prompt; the cap fired after 1–13 requests had reached the
   server. A normal turn uses ≤ 2 calls, so 8 holds.
3. **The milder hand-off wording was ignored.** With "Leave out calendar, notes and quick-list contents",
   run 1's summary still listed "Lasagna at 18:00" (taken from the model's own answer). The explicit
   wording now in `ASSISTANT_HANDOFF` ("Do not copy calendar events, … not even from your own earlier
   answers: write "(phone data left out; fetch it again)" instead") kept it out in runs 2 and 3, and the
   placeholder appeared where the event had been. A6 should still assert it (n = 2 is no proof).
4. **`compact` works on a short session** with `--approve` + `keepRecentTokens: 200` (3 of 3; 5.7–6.1 s).
   The new session file is written at once (it holds `model_change`, `thinking_level_change` and the
   summary note), so a respawn right after a reset resumes it.
5. **After a restart the cut user message stays in the session.** In run 3 the model, after answering
   the next prompt, went back to the cut request ("search the web for aurora") on its own and ran into
   the deadline; run 1 offered to "pick that aurora search back up". The note says only that the last
   answer was lost.
6. **The `assistant_restarted` frame is emitted while the bridge starts**, before any client listens.
   It reached the SSE client late: replayed at the reconnect in run 3, and only with the next turn's
   frames in run 2 (so a client could take it for the new turn). Hence `GET /api/assistant/state`
   carries `lost: {requestId, at}`.
7. Nothing else bound `127.0.0.1:8795` during the runs (`ss -ltn`), and no Claude switch was run (it would
   start the lets-code Claude proxy in the throwaway child). After teardown: no `even-lc-dur-assistant-*`
   scope, ports 3466/8815 free, no core-memory project dir for the throwaway cwd (no memory write happened).

## Smoke (A2 real run, 2026-11-05)

`scripts/assistant-smoke.mjs`: a throwaway bridge on `127.0.0.1:3466` (store `~/tmp/ovs-a2-store`, cwd
`~/tmp/ovs-a2/assistant`, `EVEN_BRIDGE_DURABLE_ENABLE=1 EVEN_BRIDGE_ASSISTANT_ENABLE=1`), the real
`~/.local/bin/lets-code` + vLLM qwen at medium, this repo's `even-assistant.ts` (no probe), and
`test/helpers/fake-tool-server.mjs` on `127.0.0.1:8815` with the dated fixtures. Each prompt carries the
per-turn header (`[20:40 Thu 5 Nov 2026, Europe/Amsterdam · lang en · style brief]`). Two runs; run 1 found
two script bugs (it ended turn (d) on the late `assistant_restarted` frame, so the reset in (e) met a busy
run: 409), fixed for run 2. Output without tokens: `~/tmp/assistant-a2-run/` (`smoke*.out`,
`summary.json`, the extension log, the bridge log with hex runs masked). Everything under `~/tmp/ovs-a2*`
and the throwaway core-memory dir was removed; no `even-lc-dur-assistant-*` scope left, 3466/8815 free.

| check | run 2 | run 1 |
|---|---|---|
| bridge start → idle, `tools: 16 (live)` | 2928 ms | 2713 ms |
| (a) "What am I eating on Friday the 13th?" | 1 × `fetch_calendar 2026-11-13..13`, "lasagna … at 18:00", result 1589 ms | same, 3553 ms |
| (b) "And on Thursday?" | 1 × `fetch_calendar` **2026-11-12**, no Lasagna, result 4647 ms; the turn-1 result reached the model as a stub (`stale: 1`) | same date, 12 344 ms (degenerate tail `</invoke> … (Revised)` in the text) |
| (c) "Remember that I like tea." / "I like coffee." | 1 memory entry with tea; coffee: 1 `remember` blocked by the gate, 0 writes | tea 1 entry; coffee 2 blocked, 0 writes |
| (d) bridge SIGKILL during a slow `web_search` (8 s) → restart | warm 2250 ms; `assistant_restarted` frame (late, inside the next turn) and `state.lost`; restart note delivered; the cut user turn stubbed (`cut: 1`); next turn ("Fridays") answered, 0 resumed `web_search` | warm 2248 ms; same stub, 0 resumed |
| (e) `POST /api/assistant/reset`, then "Search your memory: what do I like to drink?" | 200 in 4578 ms, new session file; `memory` ×3, "I only have tea saved in memory …" | (409, script bug) |
| prompt section | `even_assistant` section in the session's system message | |
| `max_tokens` | 14/14 provider requests capped 32 768 → 4096; no vLLM error | 13/13 |

Findings:

1. **"And on Thursday?" on a Thursday resolves to next week** (12 Nov) in both runs, as in A0 (b). The plan
   expected 5 Nov; with today being Thursday the model chose the next one and, in run 2, offered to check
   today. The stub did its job (a fresh fetch, no Lasagna). The date choice is A4/A6's (header wording,
   the "this/next" scenarios).
2. **The memory gate is needed and works.** qwen tried `memory remember` for "I like coffee" in both runs
   (1 and 2 calls); every one was blocked with "memory writes need the user to ask for them", and the
   model then told the user to say "remember …".
3. **The cut-turn stub works.** Without it A1 run 3 resumed the cut request; here the next turn answered
   only the new question in both runs, and nothing called `web_search` again.
4. **qwen still leaks tool-parser tails into the text** now and then (`</invoke>`, `</parameter>`,
   `</function>`, "(Revised)"): 3 of 6 turns in run 1, 0 of 6 in run 2. The HUD path (A4: last message only,
   dedupe) has to strip or drop them.
5. Earlier phone data still rides in the model's own old answers (as A0 said); the instructions tell the
   model they are no source.

Run 3 (after rebasing onto A1 fix round 1, 57b06c9: assistant API token, `--no-skills --no-prompt-templates
--no-context-files`, the reworded restart note): the smoke now uses its own `EVEN_BRIDGE_ASSISTANT_API_TOKEN_FILE`
under `~/tmp/ovs-a2` for `/api/assistant/*`. All five checks passed again: warm 3413 ms; (a) 2026-11-13,
lasagna, 1711 ms; (b) 2026-11-12 again, no Lasagna, 2029 ms; (c) tea 1 entry, coffee 1 blocked, 0 writes;
(d) warm 2453 ms, the new note recognised by its marker, cut turn stubbed, nothing resumed; (e) reset 200 in
3595 ms, tea found; 13/13 requests capped at 4096; no tool-parser tails in the 6 turns.
