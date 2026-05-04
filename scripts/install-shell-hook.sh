#!/usr/bin/env bash
# Append preexec hook to ~/.zshrc that logs each command run inside tmux.
# Idempotent. Shows diff, asks for confirmation unless SP2S_NONINTERACTIVE=1.
set -euo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
RC="${ZDOTDIR:-$HOME}/.zshrc"
MARKER_BEGIN="# BEGIN sigmapi2sigma shell-hook"
MARKER_END="# END sigmapi2sigma shell-hook"

if [[ -f "$RC" ]] && grep -qF "$MARKER_BEGIN" "$RC"; then
  echo "Hook already installed in $RC. Skipping."
  exit 0
fi

read -r -d '' BLOCK <<EOF || true
$MARKER_BEGIN
_sp2s_shell_log() {
  [[ -n "\$TMUX" ]] || return
  local dir="$DATA_DIR/shell-history"
  mkdir -p "\$dir"
  local file="\$dir/\$(date +%Y-%m-%d).jsonl"
  local ts sess pane cwd cmd
  ts=\$(date -Iseconds)
  sess=\$(tmux display-message -p '#S' 2>/dev/null || printf '')
  pane="\${TMUX_PANE:-}"
  cwd="\$PWD"
  cmd="\$1"
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg ts "\$ts" --arg tmuxSession "\$sess" --arg tmuxPane "\$pane" \\
          --arg cwd "\$cwd" --arg cmd "\$cmd" \\
          '{ts:\$ts, tmuxSession:\$tmuxSession, tmuxPane:\$tmuxPane, cwd:\$cwd, cmd:\$cmd}' >> "\$file" 2>/dev/null || true
  fi
}
preexec_functions+=(_sp2s_shell_log)
$MARKER_END
EOF

echo "About to append this to $RC:"
echo "----"
printf '%s\n' "$BLOCK"
echo "----"

if [[ "${SP2S_NONINTERACTIVE:-0}" != "1" ]]; then
  read -r -p "Proceed? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

[[ -f "$RC" ]] || touch "$RC"
printf '\n%s\n' "$BLOCK" >> "$RC"
mkdir -p "$DATA_DIR/shell-history"
echo "Installed. Open a new tmux shell to start logging."
