# Overseer phase-0 spike: lets-code over RPC on borealis

2026-11-03, plan `docs/superpowers/plans/2026-11-03-overseer.md` Task 1. Driver: `scripts/lc-spike.mjs`. lets-code `~/.local/bin/lets-code` (21706 lines, via `~/.local/bin/pi-inference`, which only `exec`s it), pi 1.0.3, node 24.21.0, systemd 257, kernel 6.18.50+rpt-rpi-2712. Nothing of the live bridge (`even-bridge.service`, port 3456, its store or children) was touched.

## Decisions

| constant / fact | value | basis |
|---|---|---|
| `LC_MEMORY_MAX` | **500M** (scope `MemoryMax`), and **not enforced on borealis today** | peak with one subagent 322 MB RSS (3 runs: 309, 308, 322) × 1.3 = 419 → 500M. The kernel boots with `cgroup_disable=memory`: no scope has `memory.*` files, so `MemoryMax` is accepted and ignored (see Finding 1) |
| `LC_MAX_LIVE` | **2** (marginal) | 2 × 322 + 600 = 1244 MB ≤ `MemAvailable` 1293 MB at Step 1 (zram 2 GB, 559 MB used then). Later in the day `MemAvailable` was 2.3–2.7 GB but swap was 100 % full. Lower to 1 if `MemAvailable` drops under 1.3 GB after the zram change |
| argv lets-code accepts | `pi-inference --mandate ask --subagents --sandbox --mode rpc --session-dir <dir> -e <ext.ts> [--session <file>]` | `--mandate <mode>` takes the mode as the next word (`--mandate ask`); `-e`/`--extension` and `--session-dir` pass through to pi |
| extra env the child needs | `LETS_CODE_MEM_WATCH=false LETS_CODE_MEM_GUARD=false` (or `--no-mem-watch`) | otherwise lets-code moves pi out of `even-lc-<sid>.scope` (Finding 2) |
| `LETS_CODE_EXPERTS_ON=1` | no effect, harmless | lets-code `unset`s it and sets it itself; experts are on by default (`EXPERTS=true`, needs subagents) |
| `--session-dir` layout | flat: `<dir>/<ISO-ts with - for :>_<uuid>.jsonl`, e.g. `2026-11-03T08-31-50-451Z_01a1a089-….jsonl`; written lazily (not there after `get_state`, there after the first prompt) | `get_state` returns `sessionFile` and `sessionId` at once |
| subagent session files | `~/.pi/agent/lets-code-runs/<parent pi session id>/<run>.pi.jsonl` (+ `.json`, `.prompt.md`), not under `--session-dir` and not under `~/.pi/agent/sessions` | the pi provider does not scan them; nothing leaked into `~/.pi/agent/sessions` |
| mandate-ask dialog | `select`, title `mandate (ask): <what>\n\nAllow?`, options `["Allow once","Allow for this session","Deny"]`; `<what>` e.g. `write outside the project: /tmp/…` | Step 4e |
| what mode `ask` asks about | only sudo/privileged, recursive deletes (destructive), package installs, network-exec and writes/reads outside the project; writes inside cwd run without a question | lets-code manifest `ask: { external: "ask", bash: { "*": "allow", privileged/destructive/package-install/network-exec: "ask" } }` |
| factory checkpoint dialog | `select`, title `Factory <id>: <checkpoint>\n\n<body>` (`id` = `YYYYMMDD-HHMMSS-xxxx`); first checkpoint `acceptance criteria`, options `["Confirm","Edit","Stop"]`; others: `the developer's plan` `["Approve","Edit","Stop"]`, `the result` `["Commit on the run branch","Keep uncommitted","Stop"]` | Step 4g + factory source |
| `cancelled` on a factory checkpoint | **stops the run** (ledger `status: "stopped"`, note "the user stopped it at the criteria checkpoint"); `/factory resume <id>` asks the same checkpoint again | "hold" (ruling Q5) must mean: leave the dialog unanswered, not cancel it |
| `/mode orchestration` under `--mandate ask` | works: `notify` "mode: orchestration", prompt ack `success:true`; `/mode ask` back: notify "mode: ask" | `get_state` has no mode field (keys: model, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile, sessionId, autoCompactionEnabled, messageCount, pendingMessageCount): track the mode from the notify |
| `/factory start` argv | `/factory start <ticket.md> <how-to-run words, unquoted>` | the handler splits on whitespace and joins the rest; quotes stay in and the command then fails to parse (`factory: the test command (how_to_run) is not a shell command that parses: "test -f hello.txt"`) |
| HUD `confirm:true` frames | **not recorded** | [GLASSES][OPERATOR], instructions below |

## Step 1: preconditions

- `bwrap` `/usr/bin/bwrap` (bubblewrap 0.12.0), `socat` `/usr/bin/socat`: found.
- Swap: `/dev/zram0` 2 GB zstd, priority 100 (the original size; the operator plans 6 GB).
- `free -m` at Step 1 (08:26): total 8062, used 6768, free 146, shared 3128, buff/cache 4427, **available 1293**; swap 2047 total, 559 used.
- Later samples: 08:29 available 2463, swap 2045/2047 used; 09:31 available 2506, swap 2047/2047; end 2692, swap 2047/2047. Swap was full for the whole measurement.
- `/tmp` is a 4 GB tmpfs, 3.3 GB used (83 %) at 08:26: that is RAM (the "shared" column). Scratch stores under `/tmp/ovs-*` cost RAM, not disk.

## Step 2: the live launch line

No bridge pi session was live (`pgrep -f -- '--mode rpc'` found only the probe itself), so the line comes from the unit and the code, not from `/proc`:

- `even-bridge.service` env (via `systemctl show -p Environment`; the drop-in `pi-lets-code.conf` itself is not readable): `EVEN_BRIDGE_PI_ENABLE=1 EVEN_BRIDGE_NEW_SESSION_PROVIDER=pi EVEN_BRIDGE_DURABLE_ENABLE=1 EVEN_BRIDGE_DURABLE_CWDS=/home/ay/sandbox/agents EVEN_BRIDGE_DURABLE_DEFAULT_CWD=/home/ay/sandbox/agents/glasses EVEN_BRIDGE_PI_BIN=/home/ay/.local/bin/lets-code EVEN_BRIDGE_PI_MODEL= LETS_CODE_TOKEN=<redacted> EVEN_BRIDGE_CC_RESUME_RC=1 EVEN_HOST_MODE=interface EVEN_HOST_INTERFACE=lo`.
- `PiRpcClient.start()` spawns `<bin> --mode rpc [--session <file>] [--name <n>] [--model <m>]` with env `{...process.env}`.
- So a glasses pi session today is `/home/ay/.local/bin/lets-code --mode rpc [--session …] [--name …]`, no `--mandate`, `--subagents` (default on anyway), `--sandbox`, and **`LETS_CODE_TOKEN` is in the child env** (inherited). No `LETS_CODE_MANDATE`/`_SANDBOX` env is set, so mandate and sandbox are off for those sessions (spec §0 fact 1 confirmed).
- The live bridge runs `lets-code` directly, not `pi-inference`. `isLetsCode(bin)` (`src/providers/pi/provider.mjs`) matches the basename `lets-code` only, so with `pi-inference` as the bin `launcherModel()` would not strip a `lets-code/` model prefix: Task 2 must handle `pi-inference` (or use `lets-code`).
- [GLASSES] To read it from `/proc` anyway: open a new pi session from the phone, then run the plan's Step 2 command and compare.

## Step 4: measurements

Launch (scope, then lets-code, then pi; `systemd-run --scope` and lets-code both `exec`, so the spawned pid ends up being pi):

```
systemd-run --user --scope -q --unit=even-lc-spike -p MemoryMax=1500M -p CPUQuota=200% -- \
  /home/ay/.local/bin/pi-inference --mandate ask --subagents --sandbox --mode rpc \
  --session-dir /tmp/ovs-spike/sessions -e /tmp/ovs-spike/probe-ext.ts
env: LETS_CODE_EXPERTS_ON=1 LETS_CODE_SUBAGENT_CONCURRENCY=1 PI_TELEMETRY=0
     (+ LETS_CODE_MEM_WATCH=false LETS_CODE_MEM_GUARD=false with --no-own-scope)
     no BRIDGE_TOKEN / LETS_CODE_TOKEN: lets-code reads ~/.config/lets-code/config
```

Memory is the sum over pi's process tree (RSS, PSS from `smaps_rollup`, VmSwap) sampled every 1 s, because the scope has no memory accounting (Finding 1). Model `qwen3.8-27b` @ inference.i-bora.com, thinking medium.

| step | result | memory (RSS / PSS, MB) |
|---|---|---|
| startup | ready (`get_state` answers) in 6.0 s / 2.3 s warm; **31.7 s** when an enabled expert's setup runs at launch (ui-tester: `playwright install chromium`) | idle pi ≈ 100–110; launch with ui-tester setup peaked 419 / 374 |
| a `get_state` | sessionId + sessionFile at once; file not yet on disk | — |
| b `Say hi.` | answered in 5.4–6.4 s | idle after: **152 / 117** (pi + one `socat` of the sandbox) |
| c one scout subagent | `subagent` tool ran, answered in 3.7–8.6 s; 4 processes: pi, its socat, the subagent pi, its socat | peak **309 / 223, 308 / 221, 322 / 235** |
| d `echo SPIKE_BLOCK` | the tool result is `even-guard spike`: `-e` loads an extension on pi 1.0.3 under lets-code and its `tool_call` block works | 140 |
| e write inside cwd | `notes.txt` written, **no dialog** (mode ask allows writes in the project) | 139 |
| e write outside cwd | dialog `mandate (ask): write outside the project: /tmp/ovs-spike/outside.txt\n\nAllow?`; `Deny` → not written, model says approval was not granted; repeat + `Allow once` → written | 163 |
| f `/mode orchestration` | notify `mode: orchestration`; `get_state` unchanged shape | 164 |
| g experts + factory | each `/experts enable <n>` → notify `The <n> expert is enabled (remembered).`; `/factory start ticket.md test -f hello.txt` → 4 s later `select` `Factory 20261103-093221-c129: acceptance criteria\n\n(none found in the ticket)` `["Confirm","Edit","Stop"]`; `cancelled` → ledger `status: stopped`, `stage: plan`, `repo: ~/sandbox/agents/lc-spike`, `waiting: null`; `/factory resume <id>` → the same checkpoint again; cancel → stopped again | 164 |
| h SIGKILL mid-turn | `systemctl --user kill -s SIGKILL even-lc-spike.scope` 3 s into `sleep 20 && echo done`: scope gone, session file kept; re-spawn with `--session <file>` ready in **2.6 s**, same sessionId, `get_messages` 17 → 19 (the new user prompt and the assistant's `bash` toolCall are there; **no toolResult** for the killed call) | 157 / 106 |

Factory ledger keys: `v id created updated repo base branch work dir ticket howToRun start constraints conventions tester status waiting note stage rounds criteria plan claim findings sent fixing pending baseline commit entries window outCap stoppedAt`. The run's worktree is `~/.pi/agent/lets-code-factory/<id>/work` (outside `~/sandbox/agents`), and intake **added an empty first commit** to the session's cwd repo ("new project … added an empty first commit").

`inside memory-limited cgroup` never appeared on stderr (it cannot, Finding 1). stderr carried only `[lets-code] qwen3.8-27b (auto) @ inference.i-bora.com · 262k context · thinking medium · vision · 3 guards · 17 extensions` (2 guards / 16 extensions with the memory watcher off) and, on the first run, `sandbox: installing @anthropic-ai/sandbox-runtime 0.0.79 into ~/.pi/agent/extensions/lets-code/sandbox (first run only)`.

## Findings that change plan assumptions

1. **`MemoryMax` does nothing on borealis.** `/proc/cmdline` has `cgroup_disable=memory` (Raspberry Pi OS default); `/sys/fs/cgroup/cgroup.controllers` is `cpuset cpu io pids`; user scopes get `cpu pids` only. Every `-p MemoryMax=` (the plan's `even-lc-*` scopes, and the live bridge's `even-durable-*` wrapper) is accepted and silently not enforced, and `systemctl show -p MemoryCurrent` is `[not set]`. `/boot/firmware/cmdline.txt` does not contain it (the Pi firmware/kernel adds it), so [OPERATOR] fix: append ` cgroup_enable=memory` to the single line of `/boot/firmware/cmdline.txt` (sudo) and reboot; check `cat /sys/fs/cgroup/cgroup.controllers` lists `memory`. `user@1000.service` already has `DelegateControllers=cpu memory pids`, so no drop-in is needed after that. Until then Task 2 must not rely on the cap (and cannot read scope memory from systemd).
2. **lets-code moves pi out of our scope.** Its RAM watcher (`MEM_WATCH=true` by default) re-execs pi under `systemd-run --user --scope --unit=lets-code-<pid>` unless an ancestor cgroup has a finite `memory.max`, which never holds while Finding 1 stands. Observed: `cgroupsSeen = [even-lc-spike.scope, lets-code-2934185.scope]`, and `even-lc-spike.scope` was already gone when the script stopped it. Effects: ruling 3 (stop `even-lc-<sid>.scope`) would kill nothing; ruling 2's `/proc/<pid>/cgroup` check for `even-lc-` would miss the pi and its subagents. Fix for Task 2: put `LETS_CODE_MEM_WATCH=false LETS_CODE_MEM_GUARD=false` in the child env (verified: everything then stays in `even-lc-spike.scope`); after Finding 1 is fixed the `memory.max` check also keeps it in place, but keep the env anyway.
3. **Mode `ask` does not ask for ordinary writes.** Only privileged, destructive, install, network-exec commands and paths outside the project ask. The plan's Step 4e prompt produced no dialog; the spike uses a write outside the project instead. Task 2 tests and the glasses smoke test need such a trigger.
4. **Cancelling a factory checkpoint stops the run.** Ruling Q5 "factory checkpoints are never auto-answered (held)" must be implemented as "the dialog stays open" (or answered later). The bridge's `PiSession.interrupt` cancels open dialogs first, so an interrupt during a checkpoint stops the factory run (resumable with `/factory resume <id>`, which re-asks the checkpoint). Factory checkpoints offer `Edit` (ruling 5 strips it).
5. **`/factory start` takes the how-to-run unquoted.** The plan's `"test -f hello.txt"` fails. Ruling 4's `/factory start .factory/ticket-<epochMs>.md` is fine (no how-to-run).
6. **Experts are global, not per session.** `/experts enable` writes `~/.pi/agent/lets-code-state.json` ("remembered") for every lets-code session on the host, and enabling `tester` also turned on `ui-tester`, whose setup then ran at the next launch (`playwright install chromium`, 31.7 s startup, 419 MB peak). Task 2 must not send `/experts enable` per spawn; the operator enables the factory's experts once. The spike restored the state file afterwards.
7. **`LETS_CODE_EXPERTS_ON=1` is ignored** (lets-code unsets and sets it); experts are on by default with subagents.
8. **The live pi children get `LETS_CODE_TOKEN`** from the bridge env, and the live bin is `lets-code`, not `pi-inference` (Step 2). `isLetsCode` does not recognise `pi-inference`.
9. **A SIGKILLed child leaves state behind:** a stale `~/.pi/agent/lets-code-sessions/<pid>.json` (the sessions extension's registry) and a dangling assistant toolCall without a toolResult in the session file. The resume prompt ("you were cut off") must cope with the missing result; the stale registry entry is lets-code's to clean (it is keyed by a dead pid).
10. **The factory leaves the sandbox:** its worktree is under `~/.pi/agent/lets-code-factory/<id>/work`, and intake commits to the session cwd's repo (an empty first commit in a new folder).
11. **Each sandboxed pi adds a `socat`** (claude-http proxy socket under `/tmp`), so one subagent = 4 processes.
12. **Swap was 100 % used** during all measurements; the numbers above had no swap in pi's tree (VmSwap 0), but the host had no swap headroom.

## Step 6: HUD confirm frames [GLASSES][OPERATOR] (not performed)

1. Operator: the shim is the user unit `even-cloud-shim.service` (`~/.config/systemd/user/`, drop-in `hardening.conf`). Create `~/.config/systemd/user/even-cloud-shim.service.d/hud-confirm.conf` with `[Service]` and `Environment=SHIM_AGENT_HUD_CONFIRM=1`, then `systemctl --user daemon-reload && systemctl --user restart even-cloud-shim`; check `systemctl --user show even-cloud-shim -p Environment | grep HUD_CONFIRM`.
2. Note the time, then the user, wearing the glasses, says to Even AI: "start an agent called spike that writes hi to a file".
3. Operator: from the shim log since that time (`journalctl --user -u even-cloud-shim --since "<time>"`, or the shim's own log file), copy the outgoing request line containing `cmd terminal on` and `confirm:true` verbatim, and every reply frame from the app that follows it until the confirmation is answered (both a yes and, in a second try, a no), with timestamps. Redact tokens.
4. Paste them into this doc under a "HUD confirm frames" heading; then stop the `spike` agent ("stop agent spike") and, if the flag is not wanted live, remove `hud-confirm.conf`, `daemon-reload` and restart the shim.

Tasks 2–4 do not need this; Task 5's HUD path waits for it.

## Clean-up done

`even-lc-spike.scope` stopped (gone); removed `/tmp/ovs-spike`, `~/sandbox/agents/lc-spike`, `~/.pi/agent/lets-code-factory` (created by the spike), the spike's `~/.pi/agent/lets-code-runs/<sid>` dirs and the stale `lets-code-sessions/<pid>.json`; restored `~/.pi/agent/lets-code-state.json` (experts back to `researcher` only). Left in place (lets-code installs, not spike data): `~/.pi/agent/extensions/lets-code/sandbox` (sandbox-runtime 0.0.79, needed by `--sandbox`) and `~/.pi/agent/ui-tester/runtime` (playwright). Raw logs (no tokens) in `~/tmp/ovs-spike-run*.{json,log.jsonl}`.
