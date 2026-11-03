# Durable agents for Even AI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Glasses-started agents run on Pi Durable inside even-bridge (one owner, restart-safe), and Even AI can dispatch, list, check, steer and stop them by voice — never without a confirmation.

**Architecture:** A new in-process provider `src/providers/durable/` in even-bridge opens a SQLite-backed `Harness` (`~/.even-terminal/durable.sqlite`), builds pi-ai providers from lets-code's `~/.pi/agent/models.json`, runs `CodingTools` behind a guard extension (path confinement + `judgeBash`-style command vetting + `systemd-run --user --scope` resource caps), and translates `conversation.watch()` views into the bridge's existing wire frames so the phone's Terminal feature, SSE and `/api/*` work unchanged. The shim (`even-cloud-shim`) gets an `agents` module: a registry table, a loopback HTTP client for the bridge, pending-dispatch tokens with a spoken two-turn confirmation, six Even AI tools, a reaper and an audit log.

**Tech Stack:** Node 24 ESM, `@earendil-works/pi-durable@1.5.0` + `pi-ai@1.5.0` + `chord@1.5.0` (exact pins), `node:sqlite`, node:test; Python 3 / FastAPI / SQLite / pytest in the shim.

**Spec:** `docs/superpowers/specs/2026-11-03-durable-even-ai-design.md` (= design rev 2 + the user's handover notes, with the rulings below).

## Global Constraints

- Commit identity on every commit: `Umutayb <66674442+Umutayb@users.noreply.github.com>` (env `GIT_COMMITTER_*` + `--author`; never change persistent git config). Trailer line: `Claude-Session: https://claude.ai/code/session_01F3yACWakjUemrX6a6mF1yH`. Plain sentence-style subject lines.
- even-bridge work on branch `feat/durable-provider` (based on `fix/pi-start-cwd`, which is PR #2 on top of `main`); shim work on branch `agents` of `~/github/even-cloud-shim`. Both repos live on `borealis.local` (user `ay`). Node: `bash -lc` or `/home/ay/.nvm/versions/node/v24.21.0/bin/node`.
- **Never restart `even-bridge.service` (sudo) and never overwrite its live working tree** (`~/github/even-bridge` is what the running service executes; new files and a new branch are fine because the running process has already loaded its modules — but do not `git checkout` away files the service might lazily import; `src/server.mjs`/`ext-router.mjs` edits are read only at restart). Real-life tests run a **second bridge instance** on another port with an isolated store (Task 6). The shim may be restarted (`systemctl --user restart even-cloud-shim`) only when its tree is clean and tests pass; after a shim restart relaunch the phone app (`~/tmp/ph.sh restart`).
- Default model = the private vLLM (`lets-code/qwen3.8-27b`); Claude models only when named explicitly (`haiku`|`sonnet` → provider `Anthropic` in models.json → 127.0.0.1:8795). `thinkingLevel` must be set explicitly (Durable default is `off`).
- Pin versions exactly in `package.json` (`"@earendil-works/pi-durable": "1.5.0"`, no caret). Node engine ≥ 22.19 is satisfied (24.21.0).
- Limits (ruling): `MAX_AGENTS=2` running, `AGENT_TTL_S=7200`, `maxTurns=60`, label ≤ 24 chars, `cwd` ∈ `AGENT_CWDS` (default `~/github/*` and `~/sandbox/agents/<label>`), never `~` itself.
- Isolation (ruling, MVP): guard extension in every Even-AI conversation — `beforeTool` for `read/write/edit/bash` with path confinement to the conversation cwd + `/tmp`, denial of `~/.ssh ~/.aws ~/.config ~/.even-terminal ~/.pi` and of the patterns ported from lets-code `judgeBash` (`~/github/lets-code/lets-code:1306`): destructive git (`push --force`, `reset --hard`, `checkout -- .`, `clean -f`), `rm -rf` outside cwd, `sudo`, `curl|sh`, writes to `.env*`/keys; plus a bash `prepare` prefix `systemd-run --user --scope -q -p MemoryMax=600M -p CPUQuota=200% --` (verified available on borealis). `bwrap` is **not installed**; when `BWRAP=1` and `bwrap` exists, use it instead of systemd-run (same interface) — optional.
- Confirmation (ruling): spoken two-turn confirmation is the MVP path (verified protocol); HUD `cmd confirm:true` only behind `SHIM_AGENT_HUD_CONFIRM=1` (Task 10, spike).
- Privacy: `PI_TELEMETRY=0`, pi-ai identity attribution null; nothing leaves the LAN except by the user's explicit Claude choice.
- Real tests before "done": Durable against the real vLLM in a scratch store under `/tmp`, removed afterwards; shim tools through `tools/ai_sandbox.py` against the running shim.

## Review Focus

1. A prompt for a Durable session arriving while the conversation is busy must become a steer (not a lost message, not a second run) — Task 4 test `prompt while busy steers`.
2. A bridge crash mid-turn must not duplicate the submission on resume — Task 4 test `requestId is stable across prompt retries`.
3. A bash command escaping the cwd (`cd .. && rm -rf`, absolute paths, `$HOME`, symlinks) must be blocked — Task 3 tests on `judgeCommand` and `confinePath`.
4. The shim must never say "dispatched" unless `confirm_dispatch` returned ok, and a stale/unknown confirmation token must be refused — Task 8 tests `answer cannot claim a dispatch that did not happen`, `expired token is refused`.
5. Reaper and limits: a third concurrent agent is refused; an agent past TTL is aborted exactly once; `agents.disabled` stops dispatches and the reaper — Task 9 tests.

---

## Part A — even-bridge (`~/github/even-bridge`, branch `feat/durable-provider`)

### Task 1: Dependencies and the models.json loader

**Files:**
- Modify: `package.json` (deps), `package-lock.json` via `npm install`
- Create: `src/providers/durable/models.mjs`
- Test: `test/durable-models.test.mjs`

**Interfaces:**
- Produces: `loadPiModels(path = "~/.pi/agent/models.json", env = process.env) → { models: Models, refs: Map<alias, {provider, modelId}>, default: {provider, modelId} }` where `Models` is pi-ai's `createModels()` instance with one `createProvider(...)` per entry of `providers` in the file; `refs` maps `"qwen"`, `"default"`, each `models[].id`, and the aliases `haiku|sonnet|opus|fable` (when provider `Anthropic` exists) to `{provider, modelId}`. `apiKey` values of the form `"$VAR"` resolve from `env` at request time (`auth.apiKey.resolve`), never at load time.
- Produces: `thinkingLevelFor(ref, settingsPath = "~/.pi/agent/settings.json") → "off"|"minimal"|"low"|"medium"|"high"|"xhigh"` (lets-code's per-model setting; default `"medium"`).

- [ ] **Step 1: Install exact pins**

Run: `cd ~/github/even-bridge && git checkout -b feat/durable-provider fix/pi-start-cwd && bash -lc 'npm install --save-exact @earendil-works/pi-durable@1.5.0 @earendil-works/pi-ai@1.5.0 @earendil-works/chord@1.5.0'`
Expected: `package.json` lists the three at `"1.5.0"`; `npm test` still passes (`ℹ fail 0`).

- [ ] **Step 2: Write the failing tests** (`test/durable-models.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPiModels, thinkingLevelFor } from "../src/providers/durable/models.mjs";

const FIXTURE = { providers: { "lets-code": { baseUrl: "https://inference.i-bora.com/v1", api: "openai-completions", apiKey: "$LETS_CODE_TOKEN",
  compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } },
  models: [{ id: "qwen3.8-27b", contextWindow: 262144, maxTokens: 32768, reasoning: true, input: ["text"],
             samplingParamsByThinkingLevel: { xhigh: { max_tokens: 49152 } } }] },
  "Anthropic": { baseUrl: "http://127.0.0.1:8795/v1", api: "openai-completions", apiKey: "x",
  models: [{ id: "claude-haiku", contextWindow: 1000000, maxTokens: 32000 }, { id: "claude-sonnet", contextWindow: 1000000, maxTokens: 32000 }] } } };

function fixture() { const d = mkdtempSync(join(tmpdir(), "models-")); const p = join(d, "models.json"); writeFileSync(p, JSON.stringify(FIXTURE)); return p; }

test("default ref is the lets-code qwen model", () => {
  const { refs, default: def } = loadPiModels(fixture(), {});
  assert.deepEqual(def, { provider: "lets-code", modelId: "qwen3.8-27b" });
  assert.deepEqual(refs.get("qwen"), def);
  assert.deepEqual(refs.get("haiku"), { provider: "Anthropic", modelId: "claude-haiku" });
});

test("model carries compat, context and sampling params", () => {
  const { models } = loadPiModels(fixture(), {});
  const m = models.getModel("lets-code", "qwen3.8-27b");
  assert.equal(m.contextWindow, 262144);
  assert.equal(m.compat.thinkingFormat, "chat-template");
  assert.equal(m.samplingParamsByThinkingLevel.xhigh.max_tokens, 49152);
  assert.equal(m.reasoning, true);
});

test("$VAR api keys resolve from env at request time", async () => {
  const { models } = loadPiModels(fixture(), { LETS_CODE_TOKEN: "tok-1" });
  const p = models.getProvider("lets-code");
  const r = await p.auth.apiKey.resolve({});
  assert.equal(r.auth.apiKey, "tok-1");
});

test("thinking level falls back to medium", () => {
  assert.equal(thinkingLevelFor({ provider: "lets-code", modelId: "qwen3.8-27b" }, "/nonexistent.json"), "medium");
});
```

(Adapt `getModel`/`getProvider` accessor names to pi-ai's actual `Models` API — check `node_modules/@earendil-works/pi-ai/dist/index.d.ts`; if the registry exposes no getter, test through `loadPiModels(...).raw` returning the built `Model[]`.)

- [ ] **Step 3: Run tests, verify they fail** — `bash -lc 'node --test test/durable-models.test.mjs'` → `fail 4` (module missing).

- [ ] **Step 4: Implement `src/providers/durable/models.mjs`** with `loadPiModels` and `thinkingLevelFor` per the Interfaces block. Mapping per the pi-ai brief: copy provider `baseUrl/api/compat` onto each model, set `provider`, add `name` (= id), `input` (default `["text"]`), `cost` zeros; wrap with `createProvider({ id, baseUrl, auth: { apiKey: { name: id, resolve: async () => ({ auth: { apiKey: resolveKey() } }) } }, models, api: openAICompletionsApi() })` where `resolveKey` reads `env[VAR]` for `"$VAR"` keys. `thinkingLevelFor` reads `settings.json` → the per-model thinking map lets-code writes (inspect the live file's keys first; use `"medium"` when absent).

- [ ] **Step 5: Run tests, verify they pass** — `fail 0`. Also `bash -lc 'npm test'` → `fail 0`.

- [ ] **Step 6: Commit** — `git add package.json package-lock.json src/providers/durable/models.mjs test/durable-models.test.mjs` ; subject `Add pi-durable and a loader for lets-code's models.json`.

### Task 2: Harness bootstrap, session map and the wire translator

**Files:**
- Create: `src/providers/durable/harness.mjs`, `src/providers/durable/sessions.mjs`, `src/providers/durable/wire.mjs`
- Test: `test/durable-sessions.test.mjs`, `test/durable-wire.test.mjs`

**Interfaces:**
- Produces (`harness.mjs`): `openDurable({ storePath, models, registry, envFor, telemetryOff = true }) → { harness, ctx, close() }` — `ctx = BACKGROUND_CONTEXT`; `Harness.open(await openNodeSqliteStorage(storePath), { models, registry, env: envFor, settings: { compaction: { enabled: true } } }, ctx)` then `harness.resume()`.
- Produces (`sessions.mjs`): `class SessionMap` backed by its own `node:sqlite` table in a **separate** file `storePath + ".sessions.sqlite"` (never inside Durable's store): rows `{ sid TEXT PK, conversation_id INTEGER, name TEXT, cwd TEXT, model_provider TEXT, model_id TEXT, created_at INTEGER, last_seen INTEGER, origin TEXT ('evenai'|'phone'), archived INTEGER }`; methods `create({name, cwd, modelRef, origin}) → sid` (sid = `"dur-" + randomUUID()`), `get(sid)`, `byConversation(id)`, `list({limit, cwd})`, `touch(sid)`, `archive(sid)`.
- Produces (`wire.mjs`): `class ViewTranslator { constructor(sid, emit) ; apply(view, ops) ; finish() }` turning successive `ConversationView` values into the bridge wire frames (shapes from `src/providers/pi/session.mjs` and the survey): on a new `pi.user` entry → `{type:"user_prompt", text}` + `{type:"status", state:"busy", sessionId}`; when `docs["pi.live"].generation.message` grows → `{type:"text_delta", text:<appended text>}` (first delta preceded by `status text_start`; thinking deltas are NOT emitted as text — emit `status think_start/think_end` around them); `pi.live.tools[]` status `running` → `{type:"tool_start", name, toolId: callId}`; `done` → `{type:"tool_end", name, toolId, summary: first 120 chars of output, detail:{input: args, output}}`; run ends (`pi.live.run` disappears) → `status text_end`, `{type:"running_stats", durationMs, inputTokens, outputTokens}` (from `pi.usage` if present, else zeros), `{type:"result", success: !runFailure, text:"", sessionId, costUsd:0, provider:"claude", turns, durationMs, inputTokens, outputTokens}`, `{type:"status", state:"idle", sessionId}`; `pi.live.runFailure` → `{type:"error", message: reason + detail}` before the result. Exactly one `user_prompt` per run (the hub's replay logic depends on it).

- [ ] **Step 1: Write failing tests**

`test/durable-sessions.test.mjs`: create → get round-trip (`sid` starts with `dur-`), `byConversation`, `list` sorted by `created_at` desc and filtered by cwd, `archive` hides from `list`. Use a temp dir.

`test/durable-wire.test.mjs`: feed hand-built view snapshots (fixtures written in the test as plain objects; no Durable needed) through `ViewTranslator` and assert the emitted frame sequence for: (a) a plain text turn → `user_prompt, status busy, status text_start, text_delta×n, status text_end, running_stats, result, status idle`; (b) a turn with one tool call → `tool_start` before `tool_end` with `toolId` equal; (c) a failed run → one `error` frame then `result{success:false}`; (d) two consecutive snapshots with identical generation text emit no duplicate `text_delta`.

- [ ] **Step 2: Run → fail.** 
- [ ] **Step 3: Implement the three modules.** `harness.mjs` must set `process.env.PI_TELEMETRY = "0"` before importing Durable if telemetry is env-gated (check `pi-telemetry`'s `.d.ts`/README; otherwise pass `telemetry: undefined`/noop in `HarnessOptions`).
- [ ] **Step 4: Run → pass; `npm test` → fail 0.**
- [ ] **Step 5: Commit** — `Add the Durable harness bootstrap, session map and wire translator`.

### Task 3: Guard extension (path confinement, command vetting, resource caps)

**Files:**
- Create: `src/providers/durable/guard.mjs`
- Test: `test/durable-guard.test.mjs`

**Interfaces:**
- Produces: `judgeCommand(cmd, cwd, home = os.homedir()) → { block?: string }` (pure; port of the deny rules of `judgeBash` in `~/github/lets-code/lets-code:1306` — read it first; keep the rule list in one exported array `RULES = [{ re, why }]`), `confinePath(p, cwd, home) → { ok: boolean, why? }` (resolves `..`, `~`, `$HOME`, absolute paths and symlinks via `fs.realpathSync` on the deepest existing ancestor; allowed roots = `[cwd, "/tmp"]`; denied = `[~/.ssh, ~/.aws, ~/.config, ~/.even-terminal, ~/.pi, ~/.gnupg, "/etc"]` even when under an allowed root via symlink), `createGuardExtension({ cwdOf: (conversationId) => string, caps = { memoryMax: "600M", cpuQuota: "200%" }, wrapper = detectWrapper() }) → extension` (via `defineExtension({ name: "even-guard", hooks: [hook(ToolTask, { beforeTool })], tools: [createBashTool({ prepare })] })` — the bash tool is re-declared here so `prepare` can prefix the command; install this extension **after** `CodingTools` so its `bash` wins), `detectWrapper() → "systemd-run"|"bwrap"|"none"` (`bwrap` only if `process.env.BWRAP === "1"` and the binary exists).
- `beforeTool(call)`: for `bash` → `judgeCommand` and, for each absolute/`~` path token in the command, `confinePath`; for `read/write/edit` → `confinePath(args.path)`; return `{ block: why }` to refuse. Blocks are logged with `[durable:guard]`.
- `prepare(execution)`: when wrapper is `systemd-run`, set `execution.command = \`systemd-run --user --scope -q -p MemoryMax=${memoryMax} -p CPUQuota=${cpuQuota} -- bash -lc ${shellQuote(cmd)}\``; `bwrap`: `bwrap --ro-bind / / --bind ${cwd} ${cwd} --bind /tmp /tmp --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- bash -lc ${shellQuote(cmd)}`; `none`: unchanged.

- [ ] **Step 1: Write failing tests** covering: `judgeCommand` blocks `git push --force`, `git reset --hard`, `rm -rf /`, `rm -rf ~`, `rm -rf ../x`, `sudo apt`, `curl … | sh`, `cat ~/.ssh/id_ed25519`, `echo x > .env`; allows `npm test`, `git status`, `rm -rf ./node_modules`, `ls /tmp`. `confinePath`: `./a/b` ok; `../x` not ok; `/tmp/x` ok; `~/.ssh/x` not ok; a symlink inside cwd pointing to `~/.ssh` not ok (create one in a temp dir). `prepare` with wrapper `systemd-run` prefixes exactly as specified (string equality) and with `none` leaves the command alone.
- [ ] **Step 2: Run → fail.** 
- [ ] **Step 3: Implement.** 
- [ ] **Step 4: Run → pass; `npm test` → fail 0.** Also verify by hand on borealis: `systemd-run --user --scope -q -p MemoryMax=600M -- bash -lc 'echo ok'` prints `ok`.
- [ ] **Step 5: Commit** — `Add the guard extension: path confinement, command vetting and resource caps`.

### Task 4: The `durable` provider

**Files:**
- Create: `src/providers/durable/provider.mjs`
- Test: `test/durable-provider.test.mjs` (uses `openMemoryStorage` from `@earendil-works/pi-durable/storage/memory` and a fake model: pi-ai test helpers if exported, else a provider whose `baseUrl` points at a tiny local HTTP stub started in the test that streams a fixed OpenAI-style SSE completion — write the stub in `test/helpers/fake-openai.mjs`)

**Interfaces:**
- Consumes: Task 1 `loadPiModels`, `thinkingLevelFor`; Task 2 `openDurable`, `SessionMap`, `ViewTranslator`; Task 3 `createGuardExtension`.
- Produces: `createDurableProvider(emit, { hub, storePath = "~/.even-terminal/durable.sqlite", modelsPath, defaultCwd, allowedCwds = [], log = console })` → object with exactly the pi provider's contract (`src/providers/pi/provider.mjs`): `name: "durable"`, `wireProvider: "claude"`, `probe(sid)` (sync: `sid.startsWith("dur-") && map.get(sid)` → `claim(sid, "durable")`), `listSessions(limit, cwd)` → rows `{id: sid, title: name, timestamp: last_seen*1000, cwd, provider: "claude", status: null}`, `async getSessionStatus(sid)` → `"busy"|"idle"` (busy iff the latest view has `pi.live.run`), `async getInfo()` → `{account:{loggedIn:true,email:"durable",scope:"local"}, model: default model id, version: "pi-durable 1.5.0", provider:"claude"}`, `getHistory(sid, limit)` → last `limit` `{role, text}` from `pi.user`/`pi.assistant` entries, `async seedTranscript(sid)` → seed the ring from history when empty, `watchTranscript(sid)`/`unwatchTranscript(sid)` → start/stop a `conv.watch()` feeding a `ViewTranslator` (ref-counted; keep one watcher per live conversation while busy even without clients so the ring fills), `async prompt(sessionId, text, cwd, opts = {})` with `opts = { name?, model?, maxTurns?, requestId?, origin? }`: new session → `map.create`, `harness.createConversation({ ownership: {kind:"ownerless"}, agent: { model: ref, thinkingLevel, cwd, maxTurns, instructions: AGENT_INSTRUCTIONS, extensions: … } }, ctx)`, then `submit({type:"input", content:text, requestId: opts.requestId ?? randomUUID(), whenBusy:"steer"}, ctx)`; existing session → `submit` with `whenBusy:"steer"`; returns `{sessionId: sid, provider:"claude"}`; `interrupt(sid)` → `conv.abort(ctx)` (sync wrapper: fire and forget, throw 404-style error if unknown); `respondPermission(sid)` → `false` (Durable has no permission dialogs; 400 is correct), `respondQuestion(sid, answer)` → `prompt(sid, answer)` (question-by-terminate pattern: a question ends the run; the answer is the next input); `getStatus(sid)` **synchronous** → `{state, provider:"claude"}` from the cached last view or `null`; `forgetSession(sid)` → `map.archive`; `async stopAll()` → abort every busy conversation, `harness.close(ctx)`; `_map`, `_harness` for tests. Also `async stopSession(sid)` = abort + archive (used by the reaper endpoint in Task 5). Extra: `async listAgents()` → `[{sid, name, cwd, model, state, createdAt, lastSeen, lastLine}]` for the shim.
- `AGENT_INSTRUCTIONS` (exported const): "You are an autonomous coding agent started from smart glasses. Work in the given directory only. Finish with a two-sentence summary of what you did and what is left. If you need a decision from the user, ask one concise question and stop." 

- [ ] **Step 1: Write failing tests** (memory storage, fake model): `new session creates a conversation and emits a full turn to the hub` (collect `emit` frames: `user_prompt` … `result` … `status idle`), `prompt while busy steers` (two prompts before the fake model answers → one run, inbox had one steer: assert via a second `user_prompt` not appearing until the first run ends), `requestId is stable across prompt retries` (same `requestId` twice → one submission; `harness.submission` ids equal), `interrupt aborts and emits result success:false`, `getStatus is sync and null for unknown sid`, `listSessions rows look like pi rows` (keys `id,title,timestamp,cwd,provider,status`).
- [ ] **Step 2: Run → fail.** 
- [ ] **Step 3: Implement.** Registry: `createRegistry().install(CodingTools)` then `.install(createGuardExtension({ cwdOf }))`; `envFor = ({cwd}) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd, shellEnv: { ...process.env, PI_TELEMETRY: "0" } })`. On open, iterate `map.list()` and re-attach watchers for conversations whose view is busy (resume after restart).
- [ ] **Step 4: Run → pass; `npm test` → fail 0.**
- [ ] **Step 5: Commit** — `Add the durable provider: Pi Durable conversations behind the bridge's provider contract`.

### Task 5: Wiring: server, router fields, agent endpoints, flag

**Files:**
- Modify: `src/server.mjs` (construct the provider when `EVEN_BRIDGE_DURABLE_ENABLE=1`; push into `providers` after `piProvider`; call `durableProvider?.stopAll()` in `shutdown()`), `src/ext-router.mjs` (`POST /prompt` also reads `name`, `model`, `maxTurns`, `requestId`, `origin` and passes `opts` as 4th arg to `p.prompt`; new `GET /agents` → `provider.listAgents()` (404 when the durable provider is absent); new `POST /agents/:sid/stop` → `stopSession`), `src/ownership.mjs` (`EXTENDED_PROVIDERS` add `"durable"`), `README.md` (env table: `EVEN_BRIDGE_DURABLE_ENABLE`, `EVEN_BRIDGE_DURABLE_STORE`, `EVEN_BRIDGE_DURABLE_MODELS`, `EVEN_BRIDGE_DURABLE_CWDS`, `BWRAP`)
- Test: `test/ext-router.test.mjs` (extend), `test/server-durable.test.mjs`

- [ ] **Step 1: Write failing tests**: router passes `{name, model, maxTurns, requestId, origin}` to a fake provider's `prompt` 4th argument; `GET /agents` returns the fake's `listAgents()`; `POST /agents/:sid/stop` calls `stopSession`; with the flag unset `server.mjs`'s provider list has no `durable` (unit-test the small factory function `buildProviders(env, deps)` — extract it from `startServer` if it is inline).
- [ ] **Step 2: Run → fail.** 
- [ ] **Step 3: Implement** (keep every existing route's behaviour byte-identical for other providers; `name`/`model` are ignored by pi/rc providers as today).
- [ ] **Step 4: `npm test` → fail 0.**
- [ ] **Step 5: Commit** — `Wire the durable provider into the server and router behind EVEN_BRIDGE_DURABLE_ENABLE`.

### Task 6: Real-life run on borealis (second bridge instance, real vLLM)

**Files:**
- Create: `scripts/durable-smoke.mjs` (starts the bridge in-process on `PORT=3466` with `EVEN_BRIDGE_DURABLE_ENABLE=1`, `EVEN_BRIDGE_DURABLE_STORE=/tmp/durable-smoke/durable.sqlite`, `EVEN_BRIDGE_PI_ENABLE=0`, `EVEN_BRIDGE_RC_ENABLE=0`, `EVEN_BRIDGE_CC_DISABLED=1`, token from `~/.even-terminal/config.json`; then: `POST /api/prompt {provider:"durable", text:"Create hello.txt containing 'hi' and list the directory.", cwd:"/tmp/durable-smoke/work", name:"smoke"}` → poll `/api/status` until idle → `GET /api/sessions/:id/history` → assert `hello.txt` exists; then `POST /api/prompt` with a blocked command (`"run: cat ~/.ssh/id_ed25519"`) → history shows the guard refusal; prints RSS of the process before/after; kills itself; removes `/tmp/durable-smoke`), `docs/durable.md` (how it works, env, limits, guard, restart/resume, backup: `close` + copy; store growth caveat; rollback = unset the flag).

- [ ] **Step 1: Run the smoke** — `bash -lc 'node scripts/durable-smoke.mjs'` with `LETS_CODE_TOKEN` from the unit drop-in (read `/etc/systemd/system/even-bridge.service.d/pi-lets-code.conf`). Expected: prints `SMOKE OK`, RSS numbers, and the guard refusal line. Record the numbers in `docs/durable.md`. If the vLLM model ignores the tool schema, fix prompt/`thinkingLevel` (`medium`) — do not weaken the guard.
- [ ] **Step 2: Restart-safety check** — run the smoke with `--kill-mid-turn` (kills the in-process harness 2 s after the prompt by calling `close`, reopens, `resume()`, waits for idle) → history shows exactly one assistant answer.
- [ ] **Step 3: Commit** — `Add the durable smoke run and docs`.

### Task 7: Agent-file loader and the `subagent` tool (owned children)

**Files:**
- Create: `src/providers/durable/agent-files.mjs`, `src/providers/durable/subagent.mjs`
- Test: `test/durable-agent-files.test.mjs`, `test/durable-subagent.test.mjs`

**Interfaces:**
- Produces: `loadAgentFiles(dir = "~/.pi/agent/agents") → Map<name, {name, description, tools?: string[], disallowed?: string[], thinking?, timeout?, role?, body}>` (frontmatter `---` block + body; parse rules from `parseAgentFile` in `~/github/lets-code/lets-code` — read it; unknown keys kept in `extra`), `createSubagentExtension({ agents: Map, defaultTimeoutS = 900 })` → `defineExtension({ name: "even-subagent", tools: [subagent] })` where `subagent` is `defineTool({ name: "subagent", replay: "safe", parameters: obj({ agent: str, task: str }), execute })` following README example 21 verbatim: `scanConversations({ownerTaskId: api.taskId},1)` → reuse or `createConversation({ownership:{kind:"task", taskId: api.taskId}})` + `configure(tx, id, { instructions: body, tools: tools, extensions: { remove: ["even-subagent"] }, thinkingLevel })`, `submit({type:"input", content: task, requestId: \`subagent:${api.taskId}\`})`, `wait` with `withAbortSignal(AbortSignal.timeout(timeout*1000))` → output = the child's last assistant text (≤ 4000 chars) or the timeout note. Children inherit the guard (not removed). The tool description lists the available agents (name — description).

- [ ] **Step 1: Failing tests**: loader parses `scout.md` fixture (name, description, tools list, role, body) and ignores a file without frontmatter; subagent tool (memory storage + fake model) runs a child and returns its text; a second call in the same task reuses the child; a child that exceeds `timeout` returns a timeout note and is aborted.
- [ ] **Step 2 → 4: fail, implement, pass (`npm test` fail 0).**
- [ ] **Step 5: Wire** `createSubagentExtension` into the registry in Task 4's provider (install order: CodingTools, guard, subagent). Commit — `Add the lets-code agent-file loader and the subagent tool`.

## Part B — even-cloud-shim (`~/github/even-cloud-shim`, branch `agents`)

### Task 8: Agents module: registry, bridge client, pending dispatch, audit log

**Files:**
- Create: `shim/agents.py`
- Modify: `shim/prefs.py` (new keys with defaults: `agents.max_running=2`, `agents.ttl_s=7200`, `agents.max_turns=60`, `agents.default_model="qwen"`, `agents.confirm_ttl_s=90`), `docs/PREFS.md`
- Test: `tests/test_agents.py`

**Interfaces:**
- Produces: `class AgentRegistry(db_path)` — table `agents(id TEXT PK, label TEXT UNIQUE, sid TEXT, cwd TEXT, model TEXT, created_ts INT, ttl_s INT, confirm_frame_id TEXT, state TEXT ('pending'|'running'|'stopped'|'archived'), last_seen INT)` + `pending_dispatch(token TEXT PK, session_id TEXT, task TEXT, label TEXT, cwd TEXT, model TEXT, created_ts INT, expires_ts INT)`; methods `stage(session_id, task, label, cwd, model) → token`, `take(token, session_id, now) → row|None` (deletes; `None` when expired/unknown/other session), `latest_pending(session_id, now) → row|None`, `add_running(label, sid, cwd, model, ttl_s, confirm_frame_id)`, `running() → list`, `by_label(label)`, `set_state(label, state)`, `touch(label)`.
- Produces: `class BridgeClient(base_url="http://127.0.0.1:3456", token_file="~/.even-terminal/config.json", timeout=8.0)` (async, `httpx`; token = `json["token"]`; override `SHIM_BRIDGE_URL`, `SHIM_BRIDGE_TOKEN_FILE`): `prompt(text, *, cwd, name, model, request_id, session_id=None) → {"sessionId", "provider"}`, `agents() → list`, `status(sid) → state|None`, `history(sid, limit=3) → list`, `interrupt(sid)`, `stop(sid)`.
- Produces: `class AuditLog(path="~/even-app/shim-data/agents.log")` → `write(event: dict)` (append JSONL, 0600, `ts` added).
- Produces: `CWD_ALLOWED(cwd, prefs) → bool` (expands `~`; allowed roots from `SHIM_AGENT_CWDS` env or default `["~/github", "~/sandbox/agents"]`; a bare root is NOT allowed; must exist on disk OR be under `~/sandbox/agents/` (created on dispatch)).
- Produces: `CONFIRM_RE = re.compile(r"^(yes|yeah|yep|do it|go ahead|confirm|please do|sure)\b", re.I)` and `DENY_RE`.

- [ ] **Step 1: Failing tests** (pytest, tmp DB, `respx`/`httpx.MockTransport` for the client): stage/take round-trip; `take` after expiry → None; `take` from another session → None; second `stage` for the same session replaces the first (`latest_pending` returns the newest only); `add_running` refuses a third running row (`AgentLimit` error) and duplicate labels; `CWD_ALLOWED` cases (`~/github/lets-code` ok, `~` no, `~/github` no, `/etc` no, `~/sandbox/agents/x` ok even if missing); `BridgeClient.prompt` sends `Authorization: Bearer <token>` and the body `{text, provider:"durable", cwd, name, model, requestId, origin:"evenai"}`; `AuditLog.write` appends one JSON line with `ts`.
- [ ] **Step 2 → 4: fail, implement, pass** (`.venv/bin/python -m pytest -q` → all pass; current baseline 713).
- [ ] **Step 5: Commit** — `agents: registry, bridge client, pending dispatch tokens, audit log`.

### Task 9: Even AI tools, two-turn confirmation, honest wording, reaper

**Files:**
- Modify: `shim/ai.py` (TOOLS + dispatch + SYSTEM prompt + `_run_turn` pre-LLM confirmation hook + `_honest_agent_answer`), `shim/app.py` (start the reaper task at startup when `SHIM_AGENTS_ENABLE=1`), `docs/README`/`docs/QA.md`
- Test: `tests/test_ai_agents.py`

**Interfaces:**
- Tools (OpenAI function schemas appended to `TOOLS`): `dispatch_agent(task, label, cwd, model?)`, `list_agents()`, `agent_status(label)`, `message_agent(label, text)`, `stop_agent(label)` (`"all"` allowed). No `confirm_dispatch` tool for the LLM: confirmation is deterministic code.
- Dispatch flow: `dispatch_agent` validates (label ≤ 24 chars `[a-z0-9-]`, cwd allowed, limit not reached, model alias known) → `registry.stage` → returns `{"status": "needs_confirmation", "say": "Shall I start agent '<label>' in <cwd> on <model>? Say yes to confirm."}`; the deterministic `_honest_agent_answer` forces the spoken answer to that sentence. On the **next** `request` from the same session: if `registry.latest_pending` exists and `CONFIRM_RE` matches the normalised text → skip the LLM, `take` → `bridge.prompt(...)` → `registry.add_running` → audit → send `cmd terminal on` (reuse the existing control_app sending path) → text `"Started agent '<label>'. Say 'open terminal' to watch it."` → end; if `DENY_RE` or anything else → drop the token (`audit {"outcome":"declined"}`) and continue the normal turn ("Okay, not starting it." only when `DENY_RE` matched).
- `list_agents` → registry ⨝ `bridge.agents()`: `"<label>: <state>, started <age>; last: <≤120 chars>"` lines, or "No agents are running."; `agent_status(label)` → `bridge.history(sid, 3)` → the last assistant text, condensed by the LLM to ≤ 2 sentences (tool result carries the raw text; SYSTEM rule says summarise); `message_agent` → `bridge.prompt(text, session_id=sid)` → "Sent."; `stop_agent` → `bridge.stop(sid)` + `set_state stopped` (+ `all`).
- Honest wording: `_honest_agent_answer(answer, agent_results)` — if any `dispatch_agent` result is `needs_confirmation`, the answer is replaced by its `say`; if a tool failed (`error`), an answer claiming success (regex `started|dispatched|running` without negation) is replaced by `"I couldn't start the agent: <reason>."`.
- SYSTEM additions: agents exist only after the user confirms; never claim one was started unless the tool result says `started`; summarise agent output, never read transcripts aloud; the Terminal feature shows full output.
- Reaper: `async def reaper_loop(registry, bridge, prefs, audit, stop_event, interval_s=60)` in `shim/agents.py`: skip entirely while `~/.even-terminal/agents.disabled` exists; for each `running` row: `bridge.status(sid)` None → `stopped`; `now - created_ts > ttl_s` and idle → `bridge.stop` + `stopped` (audit `ttl_idle`); busy past `2*ttl_s` → stop (audit `ttl_hard`); bridge agents with `origin == "evenai"` and no row → `bridge.stop` (audit `stray`). `dispatch_agent` also refuses while the disable file exists.

- [ ] **Step 1: Failing tests** (reuse `make_ai`, `FakeWS`, `_drive` from `tests/test_ai.py`; mock `BridgeClient` with an in-memory fake): `dispatch stages and asks for confirmation` (no bridge call; spoken answer is the `say` sentence); `yes on the next turn starts the agent and opens terminal` (fake bridge got one `prompt`; a `cmd` frame `terminal on` was sent; text says Started); `no on the next turn declines` (no prompt; token gone); `expired token is refused` (advance `now`); `answer cannot claim a dispatch that did not happen` (LLM says "I've started it" after a failed tool → replaced); `third agent is refused`; `stop_agent all stops every running agent`; reaper: `idle past TTL is stopped once` (two loop iterations → one stop), `disable file suspends the reaper and dispatch`.
- [ ] **Step 2 → 4: fail, implement, pass** (full pytest green). Then real check against the running shim: `tools/ai_sandbox.py "start an agent called smoke in github slash even-search that lists the repo files"` → expects the confirmation sentence; `tools/ai_sandbox.py "yes"` in the **same session** (add `--session` to `ai_sandbox.py` if it lacks one) → with `SHIM_BRIDGE_URL` pointed at the Task 6 smoke instance on :3466 (start it with `--keep` for this) → `Started agent 'smoke'…` and `GET /api/agents` on :3466 lists it. Record the transcript in `docs/QA.md`.
- [ ] **Step 5: Commit** — `ai: agent tools with two-turn confirmation, honest wording and the reaper`.

### Task 10: QA scenarios, HUD-confirm spike flag, docs, roadmap

**Files:**
- Modify: `tools/qa_runner.py` (category `agents`: dispatch → text_has("say yes"); "list agents" → text_only; negative "start an agent in slash etc" → text_has("couldn't", "not allowed") ; each via a fake bridge? — the runner hits the live shim: set `SHIM_AGENTS_ENABLE=1` + `SHIM_BRIDGE_URL` to an unreachable port for the negative/limit cases and assert honest failure wording), `shim/ai.py` (behind `SHIM_AGENT_HUD_CONFIRM=1`: send `cmd {app:"terminal", action:"on", confirm:true, confirm_text:…}` and treat `reply.content.result == "confirmed"` as the confirmation; log the raw reply frames at INFO so a device test reveals the real shapes), `docs/QA.md`, `README.md`, borealis `~/tasks/even-selfhost-roadmap.md` (state block: what shipped, what needs the bridge restart, the HUD spike instructions, experts/factory deferred).
- [ ] Steps: tests for the flag path (frame shape sent; `confirmed` reply → dispatch; `dismissed` → declined; timeout → spoken fallback) → implement → `pytest` + `tools/qa_all.sh` green → commit `qa: agent scenarios; HUD confirm spike behind a flag; docs`.

### Deployment (end of plan — needs the user for sudo)
1. Shim: merge `agents` → `main`, restart `even-cloud-shim` (user units are ours), relaunch the app, re-run `tools/qa_all.sh`.
2. Bridge: PR `feat/durable-provider` → `main`; borealis checkout to `main`; add drop-in `durable.conf` (`EVEN_BRIDGE_DURABLE_ENABLE=1`, `EVEN_BRIDGE_DURABLE_CWDS=/home/ay/github:/home/ay/sandbox/agents`) via the user: `! ssh -t borealis.local sudo bash -c 'printf "[Service]\nEnvironment=EVEN_BRIDGE_DURABLE_ENABLE=1\n" > /etc/systemd/system/even-bridge.service.d/durable.conf && systemctl daemon-reload && systemctl restart even-bridge'` (this also activates the pending `zz-security.conf` loopback bind — `cterm` keeps working through nginx; the shim reaches the bridge on 127.0.0.1).
3. Set `SHIM_AGENTS_ENABLE=1` in both shim env files; on-glasses test: "start an agent called demo in github even-search that counts the python files" → "yes" → Terminal shows it.
