#!/usr/bin/env bash
# install-services.sh — provision and start the even-bridge stack.
#
# Spins up the systemd services that make up the setup:
#
#   1. even-bridge.service        — the phone-facing superserver
#      (local Claude Code + Claude Remote Control + pi sessions, port 3456)
#   2. claude-remote-bridge.service — the RC engine (claude-remote-terminal
#      fork; spawns `claude --remote-control`, glasses TUI, port 8790)
#   3. even-pi-tmux.service       — reboot-persistent tmux session hosting the
#      pi terminal (the glasses can only inject prompts into a tmux pi)
#
# Idempotent: safe to re-run. Existing unit files and the token env file are
# left untouched (they win); missing pieces are created.
#
# Usage:
#   sudo scripts/install-services.sh
#
# Env overrides:
#   HOST_USER        user the services run as          (default: the sudo caller)
#   EVEN_BRIDGE_DIR  even-bridge checkout              (default: this repo)
#   NODE_BIN         node binary for the units         (default: newest nvm node)
#   TOKEN_ENV_FILE   token file for systemd            (default: /etc/even-terminal.env)
#   RC_BRIDGE_BIN    RC bridge binary                  (default: ~/.local/bin/claude-remote-terminal-bridge)
#   RC_BRIDGE_PORT   RC bridge port                    (default: 8790)
#   EVEN_PI_CWD      project dir the persistent tmux pi runs in (default: ~/github)
#   EVEN_PI_TMUX_SESSION  tmux session name            (default: even)
#   KEEP_OFFICIAL=1  do not disable the old official even-terminal.service

set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo "This script installs system services — run it with sudo:" >&2
  echo "  sudo $0" >&2
  exit 1
fi

HOST_USER="${HOST_USER:-${SUDO_USER:-root}}"
[ "$HOST_USER" = "root" ] && HOST_USER="$(whoami)"
HOME_DIR="${HOME_DIR:-/home/$HOST_USER}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EVEN_BRIDGE_DIR="${EVEN_BRIDGE_DIR:-$REPO_DIR}"
TOKEN_ENV_FILE="${TOKEN_ENV_FILE:-/etc/even-terminal.env}"
RC_BRIDGE_PORT="${RC_BRIDGE_PORT:-8790}"
RC_BRIDGE_BIN="${RC_BRIDGE_BIN:-}"

say()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '   \033[1;33mWARN: %s\033[0m\n' "$*"; }

# ── 0. Sanity ────────────────────────────────────────────────────────────────
say "sanity checks"
[ -d "$HOME_DIR" ] || { echo "HOME_DIR $HOME_DIR does not exist" >&2; exit 1; }
[ -f "$EVEN_BRIDGE_DIR/bin/even-bridge.mjs" ] || {
  echo "EVEN_BRIDGE_DIR $EVEN_BRIDGE_DIR has no bin/even-bridge.mjs" >&2; exit 1; }

# ── 1. node binary for the units ─────────────────────────────────────────────
# systemd shells are non-interactive: pin a full node path, prefer the newest
# nvm version (the system node may be EOL).
say "resolving node"
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -d "$HOME_DIR"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(su -s /bin/bash "$HOST_USER" -c 'command -v node' 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "No usable node found (set NODE_BIN=/path/to/node)." >&2; exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || warn "node major $NODE_MAJOR < 18 (even-bridge needs >= 18)"
note "node: $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null))"

# ── 2. even-bridge dependencies ──────────────────────────────────────────────
if [ ! -d "$EVEN_BRIDGE_DIR/node_modules" ]; then
  say "installing npm dependencies (as $HOST_USER)"
  su -s /bin/bash "$HOST_USER" -c "cd '$EVEN_BRIDGE_DIR' && npm install" || {
    warn "npm install failed — the bridge will not start until dependencies are installed"; }
else
  note "node_modules present in $EVEN_BRIDGE_DIR"
fi

# ── 3. token env file (systemd passes it to the service; kept out of ps) ─────
say "token env file: $TOKEN_ENV_FILE"
TOKEN_CREATED=0
if [ ! -f "$TOKEN_ENV_FILE" ]; then
  TOKEN="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'BRIDGE_TOKEN=%s\n' "$TOKEN" > "$TOKEN_ENV_FILE"
  chown root:root "$TOKEN_ENV_FILE"
  chmod 600 "$TOKEN_ENV_FILE"
  TOKEN_CREATED=1
  note "created with a fresh token (shown once, now):"
  echo "    BRIDGE_TOKEN=$TOKEN"
else
  note "existing file kept (phone pairing unchanged)"
fi
# Model auth: bridge-spawned pi sessions inherit THIS env file, not your
# interactive shell. pi refuses to call a provider whose "$VAR" apiKey resolves
# to nothing (the request hangs before the first model call). The endpoint here
# (vllm.example.com) does NOT validate the key — any non-empty value works — so
# we best-effort copy the host user's value and fall back to a placeholder.
# For a validating endpoint, put the real value in this file instead.
MODEL_TOKEN_VAR="LETS_CODE_TOKEN"
MODEL_TOKEN_VAL=""
if [ -n "${HOST_USER:-}" ]; then
  MODEL_TOKEN_VAL="$(su -s /bin/sh -c 'printenv '"$MODEL_TOKEN_VAR"'' "$HOST_USER" 2>/dev/null | tail -1)"
fi
if [ -z "$MODEL_TOKEN_VAL" ]; then
  MODEL_TOKEN_VAL="lets-code-local"
  MODEL_TOKEN_PLACEHOLDER=1
fi
if grep -q "^${MODEL_TOKEN_VAR}=\$" "$TOKEN_ENV_FILE" 2>/dev/null; then
  note "$MODEL_TOKEN_VAR already in env file — left untouched"
else
  printf '%s=%s\n' "$MODEL_TOKEN_VAR" "$MODEL_TOKEN_VAL" >> "$TOKEN_ENV_FILE"
  if [ "${MODEL_TOKEN_PLACEHOLDER:-0}" = "1" ]; then
    note "$MODEL_TOKEN_VAR set to placeholder (endpoint does not validate keys; use a real value if yours does)"
  else
    note "$MODEL_TOKEN_VAR copied from $HOST_USER's environment"
  fi
fi

# ── 4. network flags (Tailscale wg0 when present) ────────────────────────────
if ip link show wg0 >/dev/null 2>&1; then
  NETFLAGS="--interface wg0"
else
  NETFLAGS=""
fi
if [ -n "$NETFLAGS" ]; then
  note "network flags: $NETFLAGS"
else
  note "network flags: (none — uses the config's network mode)"
fi

# ── 5. even-bridge.service ───────────────────────────────────────────────────
UNIT_EB=/etc/systemd/system/even-bridge.service
say "unit: even-bridge.service"
if [ -f "$UNIT_EB" ]; then
  note "already present — not modified"
else
  mkdir -p "$(dirname "$UNIT_EB")"
  cat > "$UNIT_EB" <<EOF
[Unit]
Description=even-bridge — superserver AI bridge for Even Realities glasses: local Claude + Claude Remote Control + pi sessions (port 3456${NETFLAGS:+, advertised on wg0})
Documentation=https://www.npmjs.com/package/@evenrealities/even-terminal
Wants=network-online.target${NETFLAGS:+ wg-quick@wg0.service}
After=network-online.target${NETFLAGS:+ wg-quick@wg0.service}
# Never give up restarting: wg0 may be slow to come up, or the port briefly held.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$HOST_USER
Group=$HOST_USER
WorkingDirectory=$HOME_DIR

# nvm's node is pinned by full path: non-interactive systemd shells otherwise get
# the EOL /usr/bin/node. Update both paths if the nvm default version changes.
Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.local/bin:$("$NODE_BIN" -e 'console.log(require("path").dirname(process.execPath))'):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=$TOKEN_ENV_FILE

ExecStart=$NODE_BIN \
    $EVEN_BRIDGE_DIR/bin/even-bridge.mjs \
    $NETFLAGS --log-file $HOME_DIR/.even-terminal/even-bridge.log

Restart=always
RestartSec=5

# The bridge spawns pi / claude child processes; stop the whole cgroup with it.
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
  note "created"
fi

# ── 6. claude-remote-bridge.service (the RC engine) ──────────────────────────
if [ -z "$RC_BRIDGE_BIN" ]; then
  for cand in "$HOME_DIR/.local/bin/claude-remote-terminal-bridge" \
              "$(su -s /bin/bash "$HOST_USER" -c 'command -v claude-remote-terminal-bridge' 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then RC_BRIDGE_BIN="$cand"; break; fi
  done
fi

UNIT_RC=/etc/systemd/system/claude-remote-bridge.service
say "unit: claude-remote-bridge.service"
if [ -z "$RC_BRIDGE_BIN" ]; then
  note "claude-remote-terminal-bridge binary not found — RC sessions disabled (local + pi still served)"
  note "install the fork and re-run (RC_BRIDGE_BIN=/path/to/binary) to enable RC"
  RC_UNIT=0
elif [ -f "$UNIT_RC" ]; then
  note "already present — not modified"
  RC_UNIT=1
else
  mkdir -p "$(dirname "$UNIT_RC")"
  cat > "$UNIT_RC" <<EOF
[Unit]
Description=claude-remote-bridge — Claude Remote Control engine (port $RC_BRIDGE_PORT)
Documentation=https://github.com/Umutayb/claude-remote-terminal
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$HOST_USER
Group=$HOST_USER
WorkingDirectory=$HOME_DIR

Environment=HOME=$HOME_DIR
Environment=PATH=$HOME_DIR/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ExecStart=$RC_BRIDGE_BIN --host 127.0.0.1 --port $RC_BRIDGE_PORT

Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
  note "created (rc binary: $RC_BRIDGE_BIN)"
  RC_UNIT=1
fi

# ── 6b. even-pi-tmux.service (reboot-persistent terminal pi) ────────────────
# The glasses can only INJECT prompts into a pi running under tmux, so the
# terminal pi surface must survive reboots. The script is idempotent and
# refuses to start a second driver while a live pi already runs in the cwd.
UNIT_PT=/etc/systemd/system/even-pi-tmux.service
say "unit: even-pi-tmux.service"
if ! command -v tmux >/dev/null 2>&1; then
  note "tmux not found — terminal-pi persistence disabled (install tmux and re-run)"
  PI_UNIT=0
elif [ -f "$UNIT_PT" ]; then
  note "already present — not modified"
  PI_UNIT=1
else
  mkdir -p "$(dirname "$UNIT_PT")"
  cat > "$UNIT_PT" <<EOF
[Unit]
Description=Reboot-persistent tmux session '${EVEN_PI_TMUX_SESSION:-even}' hosting the pi terminal (glasses-injectable surface)
Wants=even-bridge.service
After=even-bridge.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=$HOST_USER
Group=$HOST_USER
Environment=HOME=$HOME_DIR
Environment=EVEN_PI_CWD=${EVEN_PI_CWD:-$HOME_DIR/github}
Environment=PATH=$HOME_DIR/.local/bin:$("$NODE_BIN" -e 'console.log(require("path").dirname(process.execPath))'):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# pi's lets-code provider needs $LETS_CODE_TOKEN (any non-empty value) or it
# hangs before the first model call; the script passes it into the pane (-e).
EnvironmentFile=-$TOKEN_ENV_FILE
ExecStart=$EVEN_BRIDGE_DIR/scripts/ensure-pi-tmux.sh

[Install]
WantedBy=multi-user.target
EOF
  note "created"
  PI_UNIT=1
fi

# ── 7. old official service replacement ──────────────────────────────────────
if [ "${KEEP_OFFICIAL:-0}" != "1" ] && [ "$(systemctl is-active even-terminal 2>/dev/null || true)" = "active" ]; then
  say "disabling the old official even-terminal.service (port 3456 conflict)"
  systemctl disable --now even-terminal.service || warn "failed to stop even-terminal.service"
fi

# ── 8. start ─────────────────────────────────────────────────────────────────
say "starting services"
systemctl daemon-reload
systemctl enable --now even-bridge.service
[ "${RC_UNIT:-0}" = "1" ] && systemctl enable --now claude-remote-bridge.service
# --now is safe here: the script no-ops when a live pi already runs in the cwd.
[ "${PI_UNIT:-0}" = "1" ] && systemctl enable --now even-pi-tmux.service

# ── 9. summary ───────────────────────────────────────────────────────────────
say "status"
printf '   %-32s %s\n' "even-bridge:"        "$(systemctl is-active even-bridge 2>/dev/null || echo n/a)"
[ "${RC_UNIT:-0}" = "1" ] && printf '   %-32s %s\n' "claude-remote-bridge:" "$(systemctl is-active claude-remote-bridge 2>/dev/null || echo n/a)"
[ "${PI_UNIT:-0}" = "1" ] && printf '   %-32s %s\n' "even-pi-tmux (tmux pi):"  "$(systemctl is-active even-pi-tmux 2>/dev/null || echo n/a)"
sleep 2
ss -tln 2>/dev/null | grep -E ':3456 |:8790 |:8791 ' | sed 's/^/   /' || true
printf '\n'
note "phone pairing: existing token in $TOKEN_ENV_FILE (unchanged if pre-existing)."
[ "$TOKEN_CREATED" = "1" ] && note "pair the phone with the fresh token printed above."
note "logs: journalctl -u even-bridge | sudo -n journalctl -u claude-remote-bridge"
note "stop: systemctl stop even-bridge claude-remote-bridge"
