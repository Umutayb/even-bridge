#!/bin/sh
# Ensure the reboot-persistent tmux session hosting the pi terminal surface.
#
# The glasses can only INJECT prompts into a pi that runs under tmux (a raw
# terminal pty is not injectable from another server-side process), so the
# canonical terminal pi lives in a tmux session that systemd (re)starts at
# boot. Without this, a reboot leaves the pi conversation terminal-less and
# any ad-hoc `pi` opened in a plain terminal makes the bridge's single-writer
# guard block glasses prompts ("driven from a terminal that is not in tmux").
#
# Idempotent: if the session already exists it does nothing. At boot it
# resumes the NEWEST pi conversation of the target cwd (the standing
# "assistant" session); with no conversation yet it starts a fresh one.
#
# Tunables (env): EVEN_PI_CWD, EVEN_PI_TMUX_SESSION, EVEN_PI_AGENT_DIR.
set -eu

CWD="${EVEN_PI_CWD:-/home/ay/github}"
SESSION_NAME="${EVEN_PI_TMUX_SESSION:-even}"
AGENT_DIR="${EVEN_PI_AGENT_DIR:-$HOME/.pi/agent/sessions}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "ensure-pi-tmux: session '$SESSION_NAME' already running — leaving it alone" >&2
  exit 0
fi

# SAFETY: never start a second driver while a live (non-stopped) pi is already
# running in the target cwd outside tmux — two writers to one transcript wedge.
# (A stopped/T pi is suspended and can't drive, so it doesn't count.)
for d in /proc/[0-9]*; do
  p=${d#/proc/}
  [ -r "$d/comm" ] || continue
  [ "$(cat "$d/comm" 2>/dev/null)" = "pi" ] || continue
  stat=$(cat "$d/stat" 2>/dev/null) || continue
  state=$(printf '%s' "$stat" | sed 's/^.*) //')
  [ "${state%% *}" = "T" ] && continue
  cwdlink=$(readlink "$d/cwd" 2>/dev/null) || continue
  [ "$cwdlink" = "$CWD" ] || continue
  echo "ensure-pi-tmux: pi (pid $p) already runs in $CWD outside tmux — not starting a second driver." >&2
  echo "ensure-pi-tmux: move it into tmux (tmux new; then re-run) or stop it, then re-run: systemctl restart even-pi-tmux" >&2
  exit 0
done

# pi's on-disk session dir for a cwd: strip leading/trailing slashes,
# '/' -> '-', wrapped in double dashes (mirrors encodeCwdDir in
# src/providers/pi/session-files.mjs, which realpaths the cwd first).
real=$(realpath "$CWD" 2>/dev/null || printf '%s' "$CWD")
enc=$(printf '%s' "$real" | sed -e 's#^/*##' -e 's#/*$##' -e 's#/#-#g')
enc="--${enc}--"

latest=""
if [ -d "$AGENT_DIR/$enc" ]; then
  latest=$(ls -1t "$AGENT_DIR/$enc"/*.jsonl 2>/dev/null | head -n 1 || true)
fi

# PATH for the pane's shell: pi lives on the nvm node's bin dir.
PANE_PATH="/home/ay/.local/bin:/home/ay/.nvm/versions/node/v26.7.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [ -n "$latest" ]; then
  echo "ensure-pi-tmux: starting tmux session '$SESSION_NAME' — resuming $(basename "$latest") in $CWD" >&2
  exec tmux new-session -d -s "$SESSION_NAME" -c "$CWD" -e "PATH=$PANE_PATH" "pi --session $latest"
fi

echo "ensure-pi-tmux: starting tmux session '$SESSION_NAME' — fresh pi in $CWD" >&2
exec tmux new-session -d -s "$SESSION_NAME" -c "$CWD" -e "PATH=$PANE_PATH" pi
