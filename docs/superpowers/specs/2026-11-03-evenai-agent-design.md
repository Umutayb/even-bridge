# Even AI as an agent: design

2026-11-03. Design only; hosts read-only. Sources: shim `main` (`ai.py`, `llm.py`, `agents.py`, `kb.py`, PREFS/QA docs, `qa_runner.py`), `ai_frames.log`, bridge 7af008e (overseer spec + plan, `providers/pi`, `providers/durable`), lets-code `d20144e`, pi 1.0.3 docs. **Decision** = the user's binding choice. **Proposal** = mine. **(verify)** = inferred, not yet run.

## 0. What the logs and code say

1. **The failures come from one cause.** Each turn is a fresh tool loop, but the old answers stay in its context, so the model answers from them:
   - 07:28:32 "What am I eating this Thursday?" was answered with no fetch and was wrong (the lasagna is on Friday 13 Nov).
   - 09:18:21 "And, what about this Friday?" was answered with no fetch and the "birthday dinner at 19:30" was invented.
   - 07:22–07:23: an agent was offered in prose, then claimed as "running", with no tool behind either.
   Each fix added a regex (`calendar_followup`, `calendar_claim`, `proposes_agent`, `_honest_*` …). A persistent session makes this worse unless old data leaves the context (§5).
2. **Thinking is off today** (`enable_thinking: false`): a qwen call takes ~1 s, a phone `ask` 0.5–2 s (the app drops it after 3 s). lets-code sends `thinking_budget` via the chat template; pi-ai's medium is 8192 tokens elsewhere (verify). **Medium thinking, not the agent, sets turn time**; the 5 s first response is safe only with host-made progress lines (§4).
3. **The plan's lets-code engine defaults are wrong for an assistant**: sandbox required, `--mandate ask --subagents`, idle stop after 120 s (cold spawn after every pause), `LC_MAX_LIVE`, reaper/TTL, a cut-off resume prompt. It needs its own profile (§2).
4. **Global extensions would leak in**: `~/.pi/agent/extensions/` holds `grocerybot-confirm.ts` and `max-images.ts`, so the child needs `-ne` + explicit `-e`. `lcEnv` strips `*_TOKEN`: the tool-server token goes in as a file path.
5. **The memory merge is small**: kv `ai_memory` holds **0 facts**, the KB 56 chunks.
6. **Unknown app behaviour (needs the glasses)**: `text` + long pause + `text` before `end`; how long the app waits after `start`; an open turn when a new `request` arrives; `cmd confirm:true` frames; `ask` outside an open turn.

## 1. Architecture

```
glasses ─Even AI WS─▶ shim ai.py (thin relay)          ─HTTP loopback─▶ bridge :3456
                       │  pre-turn: gate yes/no,                         POST /api/assistant/prompt
                       │  farewell, stop                                 GET  /api/events?sessionId=dur-assistant (SSE)
                       │  SSE → progress line + HUD text                 └ LetsCodeEngine, profile "assistant"
                       │                                                    └ pi-inference --mode rpc (warm child)
                       └ tool server 127.0.0.1:8814 ◀─HTTP + token───────── even-assistant.ts (pi extension)
                          ask/cmd on the live WS, KB, web, prefs,
                          agents (one gate), overseer
```

- **The shim relays.** With `evenai_engine=agent`, a glasses `request` (not Conversate, Ideate — **Decision** 8 — or KB chat, **Proposal**, Q4) runs: `start` → pre-turn checks (§6) → `POST /api/assistant/prompt` → SSE until `result` → `text` frames → `end`.
- **One session.** It is `dur-assistant` (**Decision** 1): a lets-code engine record (`even.lc-session`) with the pi session file under `<store>/lc-sessions/dur-assistant/`.
- **Per-turn header** (**Proposal**) before the user's words: `[07:20 Tue 3 Nov 2026, Europe/Amsterdam · lang en · running: conversate · style brief]`. Phone lists stay out; the tool server uses the turn's `user_input` inside `control_app` (`_cmd_params`).

## 2. The bridge: assistant profile (**Proposal**)

| | agent sessions (plan Task 2) | `dur-assistant` |
|---|---|---|
| launch | `--mandate ask --subagents --sandbox` | `-ne -e ~/.pi/agent/extensions/lets-code -e even-assistant.ts --tools <Even tools>,memory --thinking medium` |
| lets-code modules | all on | only `CORE_MEMORY_ON`, `AGENT_GUARD_ON` and `GROUNDING_ON`; the provider comes from models.json (verify that `backend.ts` is not needed) |
| shell, files | yes, guarded | **none**: no bash/read/write/edit is registered, so no sandbox is needed |
| cwd | `~/sandbox/agents/<label>` | `~/sandbox/assistant`, empty; it only keys the core-memory store (verify the key for a dir that is not a git repo) |
| lifetime | stops 120 s after idle | **always warm**: spawned at bridge start and respawned with `--session` when it exits |
| limits | `LC_MAX_LIVE`, reaper, TTL | its own slot; not in `/api/agents`, so the reaper, TTL and max-agents never see it |
| restart mid-turn | "cut off" resume prompt | **no resume**: a `write` note "(bridge restarted; your last answer was lost)"; the shim says "I lost that one, please ask again" |
| dialogs | phone `permission_request` | never to the phone (§6) |

Routes (404 unless `EVEN_BRIDGE_ASSISTANT_ENABLE=1`): `POST /api/assistant/prompt {text, requestId, whenBusy}` (deduplicated), `POST /api/assistant/{interrupt,reset,compact}`, `POST /api/assistant/model {model, thinking}` (`set_model`/`set_thinking_level` over RPC when idle), `GET /api/assistant/state`. Events are the existing `PiSession` frames (`status think_*/text_*`, `text_delta` for text blocks only, `tool_start/tool_end`, `result`, `error`). Phone Terminal: listed read-only as "Even AI" (Q6).

## 3. The tool server and the extension

**`even-assistant.ts`** (pi extension, the `pi_write_subagent_extension` single-file `registerTool` pattern): fetches `GET /tools/schema` from the shim at load (one source of tool descriptions) and registers each tool as `POST /tools/<name> {args, toolCallId}` with a Bearer token read from `EVEN_ASSISTANT_TOOLS_TOKEN_FILE` (0600); 12 s timeout returned as a tool error; adds the §5 `context` and memory-taint hooks.

**Shim tool server** (`127.0.0.1:8814`, token-checked). The open Even AI turn registers `{ws, pending, ctx, question_msg_id}` as **the bound turn**; phone tools act only on it. Tools (**Decision** 4), handlers moved out of `EvenAI` unchanged:

| tool | handler | notes |
|---|---|---|
| `fetch_calendar {from, to, keywords?}` | `_fetch_calendar` ladder, `_compact_calendar`, `_localize_fetch` | **dates are required**; the result starts `window: Friday 6 Nov 00:00–24:00 (local)` |
| `fetch_notes`, `fetch_quicklist` | `_fetch_notes` (with the synced-copy fallback), `_ask_phone` | |
| `control_app {app, action, …}` | `_control_app` / `_send_cmd` | result `ok` / `failed: <reason>` / `sent, unconfirmed`; `running_module` comes back with it |
| `kb_search {query}` | `_search_knowledge` | marked untrusted |
| `web_search {query}` | `_web_search` | marked untrusted; only when the pref is on |
| `get_preferences` / `set_preference` | as today | `VOICE_LOCKED_GROUPS` kept |
| `agent_start/list/status/message/stop` | `BridgeClient` → `POST /api/overseer/actions` (plan Task 5, one gate) | start/message/stop return `proposed: <host summary>`; list/status are free |
| `overseer_ask {question}` | plan Task 4 | marked untrusted |
| `memory` | lets-code core memory, in the child | §7 |

- **WebSocket gone** (no bound turn): phone tools return at once `{"error": "glasses_offline"}`, never queued; other tools work. A final answer with no bound turn is spoken first on the next request if < 2 min old, else goes to the outbox.
- **Budgets**: `ask` keeps 3 s per attempt; `cmd` waits `cmd_reply_timeout_s` (2.5 s).

## 4. Progress lines, the 5 s budget, and HUD text

**Decision** 2: the "thinking" indicator shows after `start`, and the first response comes within 5 s. **Proposal**, all of it host-side:

1. **Fast answer.** If the run's final text is ready before **T1 = 3.0 s**, send it straight away with no progress line.
2. **First tool.** At the first `tool_start`, if no text has gone out yet, send one progress line chosen by the tool's name:

| tool | progress line |
|---|---|
| calendar | "Fetching your calendar…" |
| notes | "Looking at your notes…" |
| web | "Searching the web…" |
| agents / overseer | "Checking the agents…" |
| anything else | "Let me take a look…" |

3. **Nothing yet.** At **T2 = 4.0 s** with neither text nor a tool, send "Let me think…".
4. **At most one progress line per turn.** It ends with `\n`, so the answer starts on a new line (verify on the glasses that it is appended, not replaced).

**HUD text**: only the last assistant message (after the last `tool_end`), through `dedupe_answer` and `_chunks(…, 160)` when it ends. Text before a tool call is a preamble: logged, not shown, so no fact reaches the HUD before its tools ran. Buffered, not token-streamed (~0.5 s for two sentences, no retractions); `detailed` style sends per sentence. **Thinking** deltas are never forwarded, `think_start` only holds the thinking state, `<think>` is stripped as a last resort (verify vLLM's reasoning parser).

## 5. Honesty by construction

- **Facts come only from this turn's tool results.** The extension's `context` hook rewrites every phone-data result (`fetch_*`, `control_app`) from an earlier user turn into a stub: `[calendar 6 Nov fetched at 07:24, removed: fetch again]`.
  Old calendar items leave the context, so "and this Friday?" must fetch. Only the latest earlier turn changes, so the vLLM prefix cache holds. The model's own old answers still carry facts: the prompt says they are no source, and the backstop and suite check it.
- **Explicit windows.** The calendar tool takes dates, and the result echoes the window in words. Today's ±14/+42-day keyword searches are what produced the "next Thursday = Nov 12/Nov 5" confusion.
- **The app decides about commands.** Tool results carry the app's reply verbatim, and the prompt says "unconfirmed means say you sent it". `running_module` is only a hint: launch always calls `control_app` (re-launching is harmless).
- **The agent gate is outside the model**: start/message/stop only create an `overseer.actions` item; the shim catches the spoken yes (§6). A prose offer + "yes" with nothing pending is a normal prompt: the session remembers the offer and calls `agent_start`, giving a real proposal (asking is allowed, **Decision** 3).
- **Guards become tests**: `calendar_claim`, `unbacked_claim`, `_honest_*`, `proposes_agent`, `launch_question` move to `tools/qa_claims.py` as pure assertions. **Runtime backstop** (**Proposal**, MVP only): a calendar/launch/agent-state claim with no matching tool this run gets one `followUp` ("check with the tool and answer again") whose answer is shown instead; logged, deleted after 14 nightly runs with zero triggers.
- **Memory is tainted by untrusted results.** After an untrusted tool result in a run, `memory remember` is blocked unless the user's utterance in that run asked to remember (the current `_REMEMBER_RE` rule, enforced as a `tool_call` block, not by rewriting the answer).

## 6. Turns, questions, concurrency

**Pre-turn checks**, deterministic and kept in the shim. They gate the turn; they do not rewrite answers:

| check | what happens |
|---|---|
| a pending action (agents, overseer) for this user | `agents_mod.is_confirm` yes → `POST …/actions/:id/confirm {confirmFrameId}`; no → deny. Either way the agent gets a `write` note with the result, and the shim says the host-built result. Anything else voids the action and goes to the agent |
| `is_farewell` | the host answers, sends `cmd evenai off` (today's prefs), and gives the agent a `write` note with no run |
| "stop" / "never mind" while busy | `POST /api/assistant/interrupt`, then `end` with "Stopped." |
| a bare feature name (`bare_app_token`) | **Proposal:** a fast path with no LLM, `cmd` directly, and a note to the agent (Q10) |

**Questions**: the agent ends its run with a question; the shim sends it, then `end`; the next `request` is the answer (the session stays open across sockets). Dialogs (`extension_ui_request`; none expected, mandate is off) never reach the phone: `select`/`confirm` become HUD text, the next utterance is matched to an option or yes/no, else cancelled and passed on; `editor` is cancelled.

**Concurrency**: one run at a time. A `request` while busy is sent as `steer`; the old turn gets `end` at once (verify the app side), the new turn becomes the bound turn and gets the output. A closed socket interrupts nothing; only the stop intent does.

## 7. Memory (**Decision** 5)

- **Owner.** The lets-code core-memory store of the assistant cwd: `memory.jsonl`, entries `{kind: fact|preference|decision|pointer|work, gist ≤ 200, refs, by}`. Headlines go into the system prompt (≤ 150 tokens), and the `memory` tool does search/open/remember/forget.
- **One-time import** (`tools/assistant_memory_import.py`, idempotent):
  - kv `ai_memory` → `fact`, `by: user` (0 rows today);
  - the store profile (`_profile_summary`: birthday etc.) → `fact`;
  - after the import, kv `ai_memory` is read-only, and the shim loop reads it only while the loop flag is on.
- **KB.** The KB stays the searchable archive (e5 embeddings, Conversate transcripts, documents) through `kb_search`. After every completed KB build the shim writes harness `pointer` entries, one per top-level topic: `gist "KB topic: <title>"`, `refs ["kb:<source_key>…"]`. They are replaced, not appended, so `memory search` finds topics and `kb_search` gets the passages.
- **What the agent stores back** (prompt): preferences and facts the user states, decisions, and pointers (`kb:`, `agent:<label>`). Never calendar, notes or list content: it changes, and the phone is the truth.
- **Prefs stay in the shim** (`Prefs`, `/vitrum/settings`):
  - `assistant_name` and `answer_style` go into the per-turn header;
  - `calendar_*` set the tool's defaults;
  - `web_search_enabled` gates the tool;
  - `history_chars`, `max_tokens` and `HISTORY_N` apply only to the loop;
  - the new `evenai_engine` (loop | agent) is settings-page only.

## 8. Session lifecycle and cost

- **Persistent and recorded.** The session survives shim restarts. After a bridge restart the child is respawned with `--session` (§2).
- **Context growth.** Phone results are stubbed (§5), so a turn costs about 1–3k tokens; 150 turns a day is about 300k tokens. pi auto-compaction (qwen `reserveTokens` 49152 of 262k) compacts about once a day.
- **Daily reset** (**Proposal**). At 04:00 local time, when idle: `compact` with "keep open questions, pending tasks and the user's stated plans", then `new_session` with that summary as its first `write`. Core memory carries the facts. A busy session retries 10 min later.
- **Cost.** qwen has no marginal cost. Claude (§9) holds one of the 8 `:8795` slots while a run is in flight, and its token usage is logged from `turn_end`.

## 9. Model and thinking (**Decision** 6)

- **The default** is `lets-code/qwen3.8-27b` at thinking `medium`, at launch and on every respawn.
- **Switching per request.**
  1. The shim resolves `llm.resolve_backend(prefs, "even_ai")`, the analogue of today's per-turn contextvar.
  2. If the result differs from the session's model (cached from `/state`), it calls `POST /api/assistant/model` before the prompt; Claude maps to `Anthropic/claude-<model>`, qwen to `lets-code/qwen3.8-27b`.
  3. A switch that arrives while a run is going takes effect on the next turn.
- **Thinking per model.** `set_thinking_level` follows `modelThinkingLevels`, except that qwen is pinned to medium.
- **Privacy note:** switching to Claude sends the whole session context to Anthropic, not just the turn (Q7).

## 10. Latency plan, flag, scenario suite

**Measurement**: one JSONL line per turn in `~/even-app/shim-data/assistant_latency.jsonl` (request, prompt ack, think start, each tool start/end with ask round trip, first HUD, final HUD, end; tool count, thinking tokens, model).

| | target |
|---|---|
| first HUD frame | p95 ≤ 5.0 s |
| final answer, no tool | p50 ≤ 5 s |
| final answer, 1 tool | p50 ≤ 8 s |
| final answer, 2 tools | p50 ≤ 12 s |

The `/vitrum` page gets a p50/p90 table.

**The flag** (**Decision** 7). `evenai_engine` defaults to `loop`.
- **Per-turn fallback** to the loop (logged) when the bridge is unreachable, the prompt is refused, or the run errors before any HUD text.
- **Retirement** after Q8: the loop path, forced retries and answer guards are deleted; `_chunks`, the fetch ladder and cmd helpers stay in the tool server.

**Scenario suite.** `qa_runner.py --only assistant`:
- **Fake app**: throwaway shim + bridge (3466); `ask` answered from dated fixtures (Lasagna Fri 13 Nov 18:00 …); one connection per turn, one session.
- **Transcripts**: §0 replayed ("next Thursday" → "this Thursday" → "and what about this Friday?"; the 07:22 agent sequence); teleprompter with two documents (question, then document); launch while running; socket drop mid-fetch; steer; stop; farewell; model switch.
- **Assertions per turn:**
  - a calendar `ask` with the right window whenever the answer mentions the schedule;
  - every title, time and date in the answer appears in this turn's tool results (`qa_claims`);
  - no "started/running" claim without a confirmed action;
  - first frame ≤ 5 s;
  - no `<think>` in the text;
  - every chunk ≤ 160 characters.
- **Nightly live run.** A user timer at 03:00 against real qwen, N = 3. It passes at ≥ 95% per scenario and 100% on the no-unsupported-claim assertions. The report goes to `~/even-app/shim-data/assistant_qa/`.

## 11. Phases

| phase | content | effort | glasses |
|---|---|---|---|
| **0 spike** | (a) `scripts/assistant-spike.mjs`: a warm `pi-inference --mode rpc -ne --tools …` with a stub tool server (canned calendar, 1 s delay), 20 prompts × {0, 1, 2 tools} × thinking {medium, low}; record first-token time, end-to-end time, thinking tokens, child RSS and cold-spawn time; check that `-ne`/`--tools` pass through `pi-inference`, that the `context` hook rewrites, and where the non-git memory store lives. (b) On the glasses: progress `text` + 8 s pause + answer `text`; a 30 s gap after `start`; a new `request` while a turn is open; `ask` after `end`; `cmd confirm:true` | 1.5 d | yes, (b) |
| **1 MVP** | bridge assistant profile + routes; `even-assistant.ts`; shim tool server; relay turn + progress policy + HUD; pre-turn checks; latency log; flag + fallback; memory import; scenario suite (fake app) | 9–11 d | smoke test |
| **2 cutover** | settings page `evenai_engine=agent` for the user; nightly run; backstop counters; daily reset; KB pointer entries; Claude switch | 2 d + 2 weeks of use | daily use |
| **3 retire** | delete the loop path and the guards; keep the assertions | 1 d | — |

## 12. Tasks to merge into the overseer plan

- **A0** (with Task 1): the assistant spike above. Output: `docs/assistant-spike.md`, constants T1/T2 and the thinking-level result.
- **A1** (after Task 2): profile `assistant` in `LetsCodeEngine` (`lc/assistant.mjs`, `/api/assistant/*`, no sandbox requirement without shell tools, always warm, own slot, out of `/api/agents`, no-resume restart, dialog-to-HUD, `EVEN_BRIDGE_ASSISTANT_ENABLE`); tests for argv, dedupe, steer, restart, model/thinking switch.
- **A2** (after A1): `src/providers/durable/lc/even-assistant.ts`: schema fetch, HTTP tools, timeouts, the stale-data `context` hook, the memory taint hook. Tests run with a fake tool server and a fake pi.
- **A3** (shim, parallel to A1): `shim/assistant_tools.py` tool server: turn binding, socket-gone, handlers moved (loop unchanged), agent tools via the one gate (Task 5), `overseer_ask` (Task 4).
- **A4** (shim, after A2+A3): `shim/assistant_turn.py`: SSE relay, progress policy, `_chunks`, pre-turn checks, steer/stop, undelivered path, latency log, `evenai_engine` pref, fallback, model switch.
- **A5**: the memory import script, KB pointer entries after a build, kv `ai_memory` frozen, PREFS.md.
- **A6**: `tools/qa_claims.py` (guards → assertions), the `assistant` category with the fake app and the §0 transcripts, the nightly timer (operator installs it).
- **A7** (operator + glasses): deploy behind the flag, a one-day shadow on the settings page, cutover, retirement after Q8.

Task 7 (deploy) gains `EVEN_BRIDGE_ASSISTANT_ENABLE`, the tool-server token file and the rollback (`evenai_engine=loop`, no restart needed).

## 13. Open questions (only you)

1. **Medium thinking against the budget.** If the spike shows medium final answers at p50 > 8 s, do you accept that, with the progress line covering the first 5 s, or allow `low` for turns with no tool call?
2. **The overseer in the voice path.** Should `overseer_ask` (a second LLM, ≤ 15 s) stay, or should the assistant get the overseer's read tools (`sessions_list`, `session_read`) directly, with the overseer kept for check-ins and the outbox?
3. **The 04:00 daily reset** with a summary hand-off: right time, and should anything survive besides core memory and the summary?
4. **The phone's KB "Ask about this" screen**: stay on the shim loop (my proposal) or move to the agent?
5. **Memory writes**: only when you ask (today's rule), or may the agent store preferences and decisions it notices?
6. **Phone Terminal**: list "Even AI" there read-only, or hide it? (It holds the day's transcript.)
7. **Claude switch**: it ships the whole session context to Anthropic, not just the turn. Acceptable, or start Claude turns from a fresh, summary-only context?
8. **Cutover criteria**: e.g. 7 nightly runs green, plus 3 days of your own use with zero backstop triggers?
9. **Confirmations**: is the spoken yes enough for agents, or use the HUD `confirm:true` dialog once the spike has recorded it?
10. **Bare feature names** ("conversate"): keep the fast path with no LLM, or let the agent handle everything?
