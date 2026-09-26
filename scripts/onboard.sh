#!/usr/bin/env bash
# onboard.sh — first-time setup for even-bridge. Run as YOUR user (not sudo):
#
#   scripts/onboard.sh [--yes] [--no-services]
#
# Steps:
#   1. prerequisites   node (required); claude, pi, tmux (optional, explained)
#   2. bridge config   ~/.even-terminal/config.json (created if missing)
#   3. claude wrap     how glasses prompts reach TERMINAL claude sessions:
#                      rc (default) | tmux | none — with the consequences of each
#   4. services        sudo scripts/install-services.sh (systemd units)
#   5. next steps      pairing the phone
#
# Non-interactive (no TTY, or --yes): the wrap mode comes from
# EVEN_CLAUDE_WRAP=rc|tmux|none (default rc). Re-running is safe; change the
# wrap later with scripts/setup-claude-wrap.sh <mode>.

set -euo pipefail

YES=0
SERVICES=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --no-services) SERVICES=0 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" = 0 ]; then
  echo "Run onboarding as your own user, not root/sudo — it configures YOUR shell;" >&2
  echo "it asks for sudo itself when installing the system services." >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
INTERACTIVE=0
[ "$YES" = 0 ] && [ -t 0 ] && [ -t 1 ] && INTERACTIVE=1

say()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '   \033[1;33m! %s\033[0m\n' "$*"; }
ok()   { printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
ask()  { # ask "question" default -> echoes the answer
  local reply
  read -r -p "   $1 " reply </dev/tty || reply=""
  echo "${reply:-$2}"
}

# ── 1. prerequisites ────────────────────────────────────────────────────────
say "1/5  prerequisites"
if ! command -v node >/dev/null 2>&1; then
  echo "   node is required (>= 18). Install it (e.g. via nvm) and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "   node >= 18 required (found $(node -v))" >&2; exit 1; }
ok "node $(node -v)"
if [ ! -d "$REPO/node_modules" ]; then
  note "installing dependencies (npm install)…"
  (cd "$REPO" && npm install --no-fund --no-audit >/dev/null)
fi
ok "dependencies"

HAVE_CLAUDE=0; HAVE_TMUX=0
if command -v claude >/dev/null 2>&1; then HAVE_CLAUDE=1; ok "claude (Claude Code)"; else warn "claude not found — Claude sessions unavailable until Claude Code is installed"; fi
if command -v pi >/dev/null 2>&1; then ok "pi"; else note "pi not found — optional (pi sessions)"; fi
if command -v tmux >/dev/null 2>&1; then HAVE_TMUX=1; ok "tmux"; else note "tmux not found — needed for pi sessions and the tmux wrap mode"; fi
if [ "$HAVE_CLAUDE" = 1 ] && [ ! -f "$HOME/.claude/.credentials.json" ]; then
  warn "no claude.ai login found — Remote Control needs one: run 'claude' then '/login'"
fi

# ── 2. bridge config ────────────────────────────────────────────────────────
say "2/5  bridge config"
if [ -f "$HOME/.even-terminal/config.json" ]; then
  ok "config exists ($HOME/.even-terminal/config.json)"
else
  node "$REPO/bin/even-bridge.mjs" init --cwd "$HOME"
fi

# ── 3. claude wrap ──────────────────────────────────────────────────────────
say "3/5  reaching terminal Claude sessions from the glasses"
cat <<'EOF'
   The bridge can only send glasses messages into a terminal `claude` session
   it can reach. Choose how new terminal sessions start (a shell function in
   ~/.bashrc / ~/.zshrc; IDEs and scripts are never affected):

   [1] rc   (default) sessions start with Remote Control on.
            + messages arrive as real prompts, in any terminal or IDE
            - needs a claude.ai login and an org that allows Remote Control
            - every session is registered with claude.ai (listed there, and
              drivable from claude.ai / the Claude app too)

   [2] tmux sessions start inside their own tmux session.
            + no claude.ai / Remote Control needed
            - tmux keybindings, scrollback and copy/paste in every session;
              closing claude closes that tmux session

   [3] none your shell is left untouched.
            - glasses messages to a terminal session are NOT delivered; the
              glasses show a "not delivered" notice instead (unless you run
              /remote-control in that session, or started it in tmux)
EOF
MODE="${EVEN_CLAUDE_WRAP:-}"
if [ -z "$MODE" ] && [ "$INTERACTIVE" = 1 ]; then
  case "$(ask "Choose [1/2/3] (Enter = 1):" 1)" in
    2|tmux) MODE=tmux ;;
    3|none) MODE=none ;;
    *) MODE=rc ;;
  esac
fi
MODE="${MODE:-rc}"
case "$MODE" in rc|tmux|none) ;; *) echo "   EVEN_CLAUDE_WRAP must be rc|tmux|none (got '$MODE')" >&2; exit 2 ;; esac
[ "$MODE" = tmux ] && [ "$HAVE_TMUX" = 0 ] && warn "tmux is not installed — tmux mode runs claude unwrapped until it is"
bash "$REPO/scripts/setup-claude-wrap.sh" "$MODE" | sed 's/^/   /'
[ "$MODE" != none ] && note "opt out any time: scripts/setup-claude-wrap.sh none (or EVEN_CLAUDE_WRAP=none on re-run); one call: EVEN_CLAUDE_WRAP=off claude"

# ── 4. services ─────────────────────────────────────────────────────────────
say "4/5  system services (even-bridge, RC bridge, pi tmux)"
if [ "$SERVICES" = 0 ]; then
  note "skipped system services (--no-services); later: sudo scripts/install-services.sh"
elif [ "$INTERACTIVE" = 1 ] && [[ "$(ask "Install and start them now with sudo? [Y/n]" y)" =~ ^[Nn] ]]; then
  note "skipped system services; later: sudo scripts/install-services.sh"
else
  sudo "$REPO/scripts/install-services.sh"
fi

# ── 5. next steps ───────────────────────────────────────────────────────────
say "5/5  pair the phone"
note "The bridge prints its pairing QR code when it starts:"
note "  sudo journalctl -u even-bridge -n 80 --no-pager"
note "Scan it in the Even app (or enter the URL + token shown there)."
[ "$MODE" != none ] && note "Open a NEW terminal before starting claude so the '$MODE' wrap is active."
