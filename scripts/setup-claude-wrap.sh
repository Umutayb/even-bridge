#!/usr/bin/env bash
# setup-claude-wrap.sh — install / switch / remove the `claude` shell wrapper.
#
#   scripts/setup-claude-wrap.sh rc|tmux|none
#
# Run as the USER (it edits your shell rc files), not with sudo.
#   rc|tmux  copy scripts/claude-wrap.sh to ~/.config/even-bridge/ with that
#            mode, and add one marked `source` line to ~/.bashrc / ~/.zshrc
#            (whichever exist; your login shell's if neither does)
#   none     remove the marked lines and the wrapper file
# Idempotent: re-running with any mode leaves exactly one marker per rc file.

set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  rc|tmux|none) ;;
  *) echo "usage: $0 rc|tmux|none" >&2; exit 2 ;;
esac

SRC="$(cd "$(dirname "$0")" && pwd)/claude-wrap.sh"
DEST_DIR="$HOME/.config/even-bridge"
DEST="$DEST_DIR/claude-wrap.sh"
MARK="# even-bridge claude wrap"
LINE="[ -f \"\$HOME/.config/even-bridge/claude-wrap.sh\" ] && . \"\$HOME/.config/even-bridge/claude-wrap.sh\"  $MARK"

rc_files=()
for f in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$f" ] && rc_files+=("$f")
done
if [ "${#rc_files[@]}" -eq 0 ] && [ "$MODE" != none ]; then
  case "$(basename "${SHELL:-bash}")" in
    zsh) rc_files=("$HOME/.zshrc") ;;
    *) rc_files=("$HOME/.bashrc") ;;
  esac
  : > "${rc_files[0]}"
fi

strip_marker() { # remove our line(s) from $1, leaving everything else byte-identical
  local f="$1" tmp
  grep -qF "$MARK" "$f" || return 0
  tmp="$(mktemp)"
  grep -vF "$MARK" "$f" > "$tmp" || true
  cat "$tmp" > "$f" # keep the original file's inode/permissions
  rm -f "$tmp"
}

if [ "$MODE" = none ]; then
  for f in "${rc_files[@]}"; do strip_marker "$f"; done
  rm -f "$DEST"
  rmdir "$DEST_DIR" 2>/dev/null || true
  echo "claude wrap: removed (terminal claude sessions are no longer wrapped)"
  exit 0
fi

mkdir -p "$DEST_DIR"
{
  echo "# managed by even-bridge scripts/setup-claude-wrap.sh — re-run it to change mode"
  echo "EVEN_CLAUDE_WRAP_MODE=$MODE"
  cat "$SRC"
} > "$DEST"

for f in "${rc_files[@]}"; do
  strip_marker "$f"
  printf '%s\n' "$LINE" >> "$f"
done
echo "claude wrap: mode=$MODE (${rc_files[*]}) — open a new shell for it to take effect"
