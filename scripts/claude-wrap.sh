# claude-wrap.sh — make terminal `claude` sessions reachable from the glasses.
#
# Installed by scripts/setup-claude-wrap.sh (called from scripts/onboard.sh):
# copied to ~/.config/even-bridge/claude-wrap.sh with the chosen mode and
# sourced from ~/.bashrc / ~/.zshrc. It defines a shell FUNCTION, so only
# interactive shells are affected — IDEs, scripts, the bridge itself and the
# RC fork keep calling the real binary.
#
# Modes (EVEN_CLAUDE_WRAP_MODE, set by the installer):
#   rc    start interactive sessions with Remote Control on: glasses prompts
#         arrive as real user prompts via the claude.ai RC channel
#   tmux  start interactive sessions inside their own tmux session: the
#         bridge types glasses prompts into the pane
#   none  plain pass-through
#
# Per call: `EVEN_CLAUDE_WRAP=off claude …` or `command claude …` skips it.

claude() {
  local mode="${EVEN_CLAUDE_WRAP:-${EVEN_CLAUDE_WRAP_MODE:-none}}"
  case "$mode" in
    rc|tmux) ;;
    *) command claude "$@"; return ;;
  esac

  # Only interactive terminal sessions are wrapped.
  if [ -z "${EVEN_CLAUDE_WRAP_ASSUME_TTY:-}" ] && ! { [ -t 0 ] && [ -t 1 ]; }; then
    command claude "$@"; return
  fi

  # Non-session invocations and explicit choices pass through untouched.
  local a
  for a in "$@"; do
    case "$a" in
      -p|--print|-h|--help|-v|--version|--remote-control|--remote-control=*)
        command claude "$@"; return ;;
    esac
  done
  case "${1:-}" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|\
    project|respawn|rm|setup-token|stop|kill|ultrareview|update|upgrade)
      command claude "$@"; return ;;
  esac

  if [ "$mode" = rc ]; then
    # LAST: --remote-control takes an optional name and would swallow a
    # following positional prompt as that name.
    command claude "$@" --remote-control
    return
  fi

  # tmux
  if [ -n "${TMUX:-}" ]; then
    command claude "$@"; return
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    echo "even-bridge: tmux not found — running claude without it (glasses can't reach this session)" >&2
    command claude "$@"; return
  fi
  # The real binary (`command -v` would name this function): bash / zsh.
  local bin
  bin="$(type -P claude 2>/dev/null || whence -p claude 2>/dev/null)"
  tmux new-session -s "claude-$$-${RANDOM:-0}" -c "$PWD" "${bin:-claude}" "$@"
}
