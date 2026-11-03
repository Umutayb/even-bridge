# Deploying the lets-code engine and the overseer (operator checklist)

Plan Task 7. Everything below is done by the operator, by hand, on borealis. No implementer task
restarts a live service. Flags go on in four stages; check the banner and the listed items after each
stage, and keep at least the time it takes to run the [GLASSES] checks between stages. Items marked
**[GLASSES]** need the phone and the glasses and stay a checklist for the user.

Reference: `docs/durable.md` (sections *The lets-code engine*, *The overseer*, *Restart and resume*,
*Accepted limits (v1)*, *Rollback*). Shim side: `even-cloud-shim` `docs/PREFS.md` and `docs/QA.md`.

**The factory stays DISABLED.** It is not enabled in any stage. It waits for a separate
confinement task ("3b": host-level confinement of the lets-code child through bwrap or a `systemd-run
--user` service that hides `~/.ssh`, `~/.even-terminal` and `~/.pi`, writes only under
`~/sandbox/agents` and the factory root, and even-guard as a global pi extension that is inert
without `EVEN_GUARD_CWD`). Do **not** run `/experts enable` and do not edit
`~/.pi/agent/lets-code-state.json`: with the five factory experts off every factory request answers
409 `experts_disabled`, which is the intended state.

Live layout today: `even-bridge.service` (system unit, `User=ay`, runs `~/github/even-bridge` on
`main`, loopback `127.0.0.1:3456`, log `~/.even-terminal/even-bridge.log`, drop-ins in
`/etc/systemd/system/even-bridge.service.d/`: `durable.conf`, `pi-lets-code.conf` (0600, holds
`LETS_CODE_TOKEN`), `remote-control.conf`, `zz-security.conf`), and `even-cloud-shim.service` (user
unit, runs `~/github/even-cloud-shim` on `main`, `127.0.0.1:8810`, env `~/.config/even-cloud-shim/env`).

Helper used below (the bridge token, never printed):

```sh
T=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.even-terminal/config.json","utf8")).token)')
banner() { grep -a '\[bridge\] extensions:' ~/.even-terminal/even-bridge.log | tail -1 | grep -o 'durable=.*'; }
```

## 0. Push and open the PRs

From a machine with push rights and `gh` (gh is not installed on borealis). The PR texts are in
`~/tmp/overseer-pr-bridge.md` and `~/tmp/overseer-pr-shim.md` on borealis (first line = title).

```sh
# on borealis
git -C ~/github/even-bridge-overseer push -u origin feat/overseer
git -C ~/github/even-cloud-shim-overseer push -u origin overseer
# wherever gh runs (copy the two files over first, e.g. scp borealis.local:tmp/overseer-pr-*.md .)
gh pr create --repo Umutayb/even-bridge --base main --head feat/overseer \
  --title "$(head -1 overseer-pr-bridge.md | sed 's/^# //')" --body "$(tail -n +3 overseer-pr-bridge.md)"
gh pr create --repo Umutayb/even-cloud-shim --base main --head overseer \
  --title "$(head -1 overseer-pr-shim.md | sed 's/^# //')" --body "$(tail -n +3 overseer-pr-shim.md)"
```

Before merging:

- **Shim:** the branch `overseer` was cut from `main` 50f7af8; `main` is 15 commits ahead (AI backend,
  sessions-tool, …). Merge `main` into the branch (or rebase), resolve conflicts (likely in
  `shim/ai.py`, `tools/qa_runner.py`, `docs/QA.md`, `docs/PREFS.md`), and run the full suite again
  (`.venv/bin/python -m pytest -q`, exit 0) before the merge.
- **Bridge:** `main` is 2 docs commits ahead (an amended overseer plan and the Even AI agent design);
  `docs/superpowers/plans/2026-11-03-overseer.md` differs on both sides: keep main's version and add
  the Task 6b accepted-limit line to its Global Constraints (pi RPC messages to existing pi sessions are
  not confined to `~/sandbox/agents`). Full suite before the merge:
  `TMPDIR=~/tmp/ovs-tmp node --test --test-timeout=180000 "test/*.test.mjs"` (exit 0; plain `npm test`
  can hang on the known `upstream-pump` flake).

After both are merged and deployed: remove the worktrees and delete the branches
(`git -C ~/github/even-bridge worktree remove ~/github/even-bridge-overseer && git -C ~/github/even-bridge branch -d feat/overseer && git -C ~/github/even-bridge push origin --delete feat/overseer`,
the same for the shim with `~/github/even-cloud-shim-overseer` and `overseer`).

## 1. Housekeeping before the deploy

- [ ] **Leftover test processes** from the 2026-11-03 implementer runs (a hung `upstream-pump` run;
  they hold no port). List and kill by pid, never with `pkill -f`:
  ```sh
  pgrep -af 'node --test'          # seen at 16:3x: 534635 534636 536972
  kill <pid> ...                   # then pgrep again; kill -9 only if one survives
  ```
- [ ] **The 15:06 accidental QA run** (Task 6b incident: `qa_runner.py` drove the live shim; it
  started and stopped agent `qasmoke`, sid `dur-3dbcb081-…`). At 15:1x the live `/api/agents` listed
  0 rows. Confirm it is still gone:
  ```sh
  curl -s -H "authorization: Bearer $T" http://127.0.0.1:3456/api/agents
  # a row with sid dur-3dbcb081… → curl -s -X POST -H "authorization: Bearer $T" http://127.0.0.1:3456/api/agents/<sid>/stop
  ```
- [ ] Optional: prune the QA rows the incident and earlier QA runs left in the live shim's
  databases (`~/even-app/shim-data/`). Count first, then decide; back up first (step 2):
  ```sh
  cd ~/github/even-cloud-shim
  .venv/bin/python - <<'EOF'
  import sqlite3, os
  d = os.path.expanduser("~/even-app/shim-data/")
  e = sqlite3.connect(d + "even.db"); a = sqlite3.connect(d + "agents.db")
  print("messages qa-*:", e.execute("SELECT count(*) FROM messages WHERE session_id LIKE 'qa-%'").fetchone()[0])
  print("pending_dispatch qa-*:", a.execute("SELECT count(*) FROM pending_dispatch WHERE session_id LIKE 'qa-%'").fetchone()[0])
  print("agents qasmoke:", a.execute("SELECT label, state, sid FROM agents WHERE label LIKE 'qasmoke%'").fetchall())
  EOF
  ```
  Delete only with the shim stopped (`systemctl --user stop even-cloud-shim`), e.g.
  `DELETE FROM messages WHERE session_id LIKE 'qa-%'`; restart the shim afterwards.
- [ ] Empty `~/sandbox/agents/qasmoke` can be removed (created by an earlier QA run at 12:20).

## 2. Pre-flight and backup

- [ ] Tools and kernel:
  ```sh
  command -v bwrap socat                       # both: /usr/bin/bwrap /usr/bin/socat
  cat /sys/fs/cgroup/cgroup.controllers        # lists memory (banner will say mem)
  cat /proc/swaps                              # /dev/zram0 present (children get MemorySwapMax=0)
  ls -l ~/.local/bin/lets-code ~/.config/lets-code/config
  sudo grep -c LETS_CODE_TOKEN /etc/systemd/system/even-bridge.service.d/pi-lets-code.conf   # ≥ 1 (the overseer's model key)
  ```
- [ ] The factory experts are OFF (must stay so): `cat ~/.pi/agent/lets-code-state.json` shows no
  `developer`, `expert-reviewer`, `design-reviewer`, `tester` or `acceptance-judge` set to true (today:
  only `researcher`).
- [ ] No agent is running on the live bridge (`/api/agents` empty or all idle). Stop running ones first.
- [ ] **Backup** (the session map migrates to schema v2 on the first start of the new code; copy the
  store only while the bridge is stopped):
  ```sh
  B=~/backups/overseer-$(date +%Y%m%d-%H%M); mkdir -p -m 700 $B
  sudo systemctl stop even-bridge
  cp -p ~/.even-terminal/durable.sqlite* $B/
  cp -p ~/even-app/shim-data/agents.db* $B/     # the shim's registry (pending_dispatch/kv migrate too)
  ls -l $B
  ```
- [ ] Update the live checkouts to the merged code (bridge stays stopped until stage 1 is written):
  ```sh
  git -C ~/github/even-bridge pull --ff-only && git -C ~/github/even-bridge log --oneline -1
  ```
  (No dependency changes: `package.json` and `package-lock.json` are unchanged.)

## 3. Stage 1: the lets-code engine (bridge)

- [ ] Write the drop-in and start:
  ```sh
  printf '[Service]\nEnvironment=EVEN_BRIDGE_DURABLE_ENGINE_LETSCODE=1\nEnvironment=EVEN_BRIDGE_LC_BIN=/home/ay/.local/bin/lets-code\n' \
    | sudo tee /etc/systemd/system/even-bridge.service.d/overseer.conf
  sudo systemctl daemon-reload
  sudo systemctl start even-bridge      # (sudo systemctl restart even-bridge if it is already up)
  sleep 5; banner
  ```
  Expected banner: `durable=on wrapper=systemd-run lc=on(sandbox,mem)`.
  `lc=on(sandbox-missing,…)` → bwrap/socat not found by the unit (every lets-code start would be 503);
  `wrapper=none` → the user manager was unreachable; either one: roll back this stage.
- [ ] `curl -s -H "authorization: Bearer $T" http://127.0.0.1:3456/api/agents` → `{"agents":[…],"engines":["native","lets-code"]}`.
- [ ] `systemctl --user list-units 'even-lc-*'` → nothing yet.

The live shim (old code) ignores `engines`; nothing changes for the glasses until stage 2.

## 4. Stage 2: the shim

- [ ] Deploy and restart:
  ```sh
  git -C ~/github/even-cloud-shim pull --ff-only && git -C ~/github/even-cloud-shim log --oneline -1
  (cd ~/github/even-cloud-shim && .venv/bin/python -m pytest -q)      # exit 0 before the restart
  systemctl --user restart even-cloud-shim
  sleep 3; systemctl --user status even-cloud-shim --no-pager | head -5
  ~/tmp/ph.sh restart                                                  # restart the Even app on the phone
  ```
  With the bridge advertising `lets-code`, a voice dispatch defaults to lets-code ("… on qwen with
  lets-code to …?") and `agent_factory` is offered (its yes is refused, see G3). `SHIM_OVERSEER_ENABLE`
  stays unset in this stage.
- [ ] Never run `tools/qa_runner.py` against the live shim except through `tools/qa_all.sh` (it
  passes `--live` and skips the agent scenarios unless `SHIM_QA_AGENTS=1`). The `overseer` and
  `sessions` categories belong to a throwaway pair (docs/QA.md).
- [ ] **[GLASSES] G1, lets-code smoke.** Say "start an agent called glass-lc that writes hi to
  hi.txt". Hear "Shall I start agent 'glass-lc' in ~/sandbox/agents/glass-lc on qwen with lets-code
  to …? Say yes to confirm." Say "yes": "Started agent 'glass-lc'. Say 'open terminal' to watch it."
  Then `cat ~/sandbox/agents/glass-lc/hi.txt` → `hi`, and `systemctl --user list-units 'even-lc-*'`
  shows `even-lc-dur-….scope` while the child lives (≈ 2 min after the run). Watch for a write loop
  (see *Accepted limits*: in QA one agent rewrote hi.txt 68 times); stop it ("stop agent glass-lc")
  if it keeps going.
- [ ] **[GLASSES] G2, kill mid-turn.** Say "start an agent called glass-kill that runs sleep 30 and
  then writes done to done.txt", "yes". About 5 s later: `sudo systemctl restart even-bridge`. After
  the restart the run resumes by itself: `cat ~/sandbox/agents/glass-kill/done.txt` → `done`, and the
  child's session file holds exactly one cut-off prompt:
  `grep -c 'You were cut off by a restart of the bridge' ~/.even-terminal/lc-sessions/<sid>/*.jsonl` → 1.
  The phone Terminal shows the agent busy again, then idle.
- [ ] **[GLASSES] G3, factory toggle by voice (expected refusal).** Say "turn on factory for agent
  glass-lc", "yes". Expected: "I couldn't switch the factory: the factory's experts are off; enable
  them in lets-code first." (409 `experts_disabled`). Anything else ("Factory is on …") is a bug: roll
  back stage 1.
- [ ] A mandate question reaches the phone: an agent asked to write outside its folder (e.g. "… that
  writes hi to ~/tmp/glass-outside.txt") shows one Yes/No permission prompt; answer No.

## 5. Stage 3: the overseer (bridge)

- [ ] Add the flag and restart:
  ```sh
  echo 'Environment=EVEN_BRIDGE_OVERSEER_ENABLE=1' | sudo tee -a /etc/systemd/system/even-bridge.service.d/overseer.conf
  sudo systemctl daemon-reload && sudo systemctl restart even-bridge
  sleep 5; banner
  ```
  Expected: `durable=on wrapper=systemd-run lc=on(sandbox,mem), overseer=on`.
  `overseer=failed: …` → the routes fall through and nothing else changes; read the reason, roll back.
- [ ] `curl -s -H "authorization: Bearer $T" http://127.0.0.1:3456/api/agents` → also `"overseer":true`.
- [ ] `curl -s -H "authorization: Bearer $T" 'http://127.0.0.1:3456/api/sessions' | head -c 300` →
  `dur-overseer` ("Overseer") first. It cannot be stopped or archived (403 from the provider).
- [ ] The shim picks the overseer up within 60 s (its engines cache): `overseer_ask`, `overseer_tell`,
  `list_sessions`, `message_session` and "what's new". No shim restart is needed.
- [ ] **[GLASSES] G4, overseer Q&A.** Say "ask the overseer which agents are running". Hear "Asking
  the overseer." and an answer that names the agents (or "The overseer is still working on it. Ask me
  what's new in a minute …"). Measure the time to the first spoken frame against the app's own
  deadline (Task 4 concern: it is the first LLM step plus the call). Then "what's new?" (no LLM; up to
  3 items) and a second "what's new?" → "Nothing new from the overseer."
- [ ] **[GLASSES] G5, phone Terminal.** Open "Overseer" in the phone's session list and chat with it.
- [ ] **[GLASSES] G6, voice confirmation.** Say "tell the overseer to stop glass-lc". Hear "Stop agent
  'glass-lc'? Say yes to confirm.", say "yes": "Done: stopped agent 'glass-lc'." Check
  `tail -3 ~/.even-terminal/overseer-actions.log` (propose, confirm, execute) and
  `stat -c %a ~/.even-terminal/overseer-actions.log` → 600.
- [ ] **[GLASSES] G7, phone confirmation.** Say "tell the overseer to start a lets-code agent called
  glass-ph that writes hi to hi.txt"; when the question is spoken, answer on the PHONE instead: the
  Overseer session shows a permission prompt with the same summary; tap Yes → the agent starts. Repeat
  with No → the action is denied, nothing starts. (The phone's answer carries no action id; only one
  overseer proposal can wait at a time.)
- [ ] **[GLASSES] G8, expiry.** Let an overseer question ("… Say yes to confirm." after "tell the overseer …") go unanswered for more than 90 s, then say "yes":
  "That confirmation expired — ask the overseer again."
- [ ] **Capture real terminal screens** (the tmux allowlist is rebuilt from sources; it fails closed).
  In a scratch folder, e.g. `mkdir -p ~/sandbox/agents/capture`:
  ```sh
  tmux new -d -s cap-pi -c ~/sandbox/agents/capture pi
  tmux new -d -s cap-cc -c ~/sandbox/agents/capture claude
  cap() { tmux capture-pane -p -t "$1" > ~/tmp/cap-$2.txt; tmux capture-pane -p -e -t "$1" > ~/tmp/cap-$2.ansi; }
  ```
  Bring each screen up by hand (`tmux attach -t …`, detach with C-b d) and run `cap`:
  - pi: idle (empty editor) `cap cap-pi pi-idle`; a typed, unsent draft `pi-draft`; a menu or submenu
    (e.g. the thinking level selector) `pi-menu`; a confirm ("→ Yes / No") `pi-confirm`;
  - Claude Code: the trust prompt at first start ("Yes, I trust this folder") `cc-trust`; idle with
    the dim placeholder `cc-idle-placeholder`; idle with an empty box after a turn `cc-idle-empty`; a
    draft `cc-draft`; a permission menu ("Do you want to proceed?") `cc-perm`; bash mode (type `!`)
    `cc-bash`.
  Check the placeholder style: `grep -c $'\e\[2m' ~/tmp/cap-cc-idle-placeholder.ansi` must be ≥ 1 on
  the input line. **If Claude Code's placeholder is not SGR 2 (dim)** (e.g. a grey colour `90` /
  `38;5;n`, or an inverse-video first cell), every message to a Claude Code terminal is refused as
  "has unsent text in its terminal" (safe: nothing is typed) until the fixtures and `inputReady` in
  `src/providers/pi/detect.mjs` are corrected. Check also that pi draws no visible cursor glyph in
  `pi-idle.txt`. Add the captures as fixtures in `test/overseer-delivery.test.mjs` (replacing the
  rebuilt ones) in a follow-up commit, run the suite, then deploy that.
  Clean up: `tmux kill-session -t cap-pi; tmux kill-session -t cap-cc`.
- [ ] **[GLASSES] G9, sessions.** "list my coding sessions" → a spoken summary ("N Claude sessions, N
  pi sessions, …"). After the captures confirm the allowlist: start `pi` in tmux, then "tell the
  <label> session to say hello" → "Shall I send pi session '<label>': say hello? Say yes." → "yes" →
  "Sent to pi session '<label>'. Ask me what's new for its reply." A pi showing a menu or a draft must
  be refused with the spoken reason, nothing typed.

## 6. Stage 4: one gate in the shim (`SHIM_OVERSEER_ENABLE=1`)

- [ ] ```sh
  grep -q '^SHIM_OVERSEER_ENABLE=' ~/.config/even-cloud-shim/env || echo 'SHIM_OVERSEER_ENABLE=1' >> ~/.config/even-cloud-shim/env
  systemctl --user restart even-cloud-shim
  ```
  Needs `SHIM_AGENTS_ENABLE=1` (set) and the bridge advertising the overseer. From now on a confirmed
  voice `dispatch_agent` / `message_agent` runs through `POST /api/overseer/actions` + `/confirm` (one
  audit trail, one limit check) instead of `POST /api/prompt`.
- [ ] **[GLASSES] G10, one gate.** A voice dispatch + "yes" starts the agent as before; the audit log
  shows `propose`, `confirm`, `execute` with `"origin":"evenai"`. While an overseer proposal waits,
  Even AI's dispatch is not blocked (only overseer proposals are one-at-a-time).
- [ ] **[GLASSES] G11, HUD confirm** (only if `SHIM_AGENT_HUD_CONFIRM=1` is set in the shim env): an
  overseer START opens the HUD confirmation; confirmed → started; dismissed → denied on the bridge.
  Other overseer kinds keep the spoken path.

## 7. After the deploy

- [ ] `systemctl --user list-units 'even-lc-*'` empty when no lets-code agent works (a child lingers
  2 min after a run).
- [ ] `ls -l ~/.even-terminal/durable.sqlite* ~/.even-terminal/overseer-actions.log`: note the sizes;
  there is no pruning (store growth is an open item).
- [ ] Emergency brake: `touch ~/.even-terminal/agents.disabled` → every confirm answers 423, check-ins
  are skipped, the shim refuses dispatches. `rm` it to resume.
- [ ] Keep the factory off (see the top). Overnight hand-offs stay off (`EVEN_BRIDGE_OVERSEER_HANDOFF`
  unset; no producer yet).

## Rollback

Per stage, newest first; each is a drop-in or env edit plus a restart, then the banner check.

- **Stage 4:** remove `SHIM_OVERSEER_ENABLE=1` from `~/.config/even-cloud-shim/env`,
  `systemctl --user restart even-cloud-shim`. Dispatches go to `POST /api/prompt` again.
- **Stage 3:** delete the `EVEN_BRIDGE_OVERSEER_ENABLE=1` line from
  `/etc/systemd/system/even-bridge.service.d/overseer.conf`, `sudo systemctl daemon-reload && sudo
  systemctl restart even-bridge`; banner without `overseer=`. The shim drops the overseer tools within
  60 s. Root conversation, notes, outbox, actions and the audit log stay on disk.
- **Stage 2:** `git -C ~/github/even-cloud-shim checkout <previous main sha>` (or revert the merge),
  restart the shim. The new `agents.db` columns are additive; the old code ignores them.
- **Stage 1:** first stop live lets-code agents (`POST /api/agents/<sid>/stop`), then remove
  `overseer.conf` (or its `ENGINE_LETSCODE` line), `daemon-reload`, restart; banner `lc=off` /
  without `lc=`. Check `systemctl --user list-units 'even-lc-*'` is empty (with the engine off the
  startup cleanup of lets-code scopes does not run). Session files stay in
  `~/.even-terminal/lc-sessions/`.
- **The code:** `git -C ~/github/even-bridge checkout <previous main sha>` and restart. main's code
  opens the v2 session map. For the exact pre-deploy store: `sudo systemctl stop even-bridge`, copy
  the backup pair from step 2 back, start.
