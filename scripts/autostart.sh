#!/usr/bin/env bash
# Rebuild the usual workspace at Windows login. The Startup shortcut created by
# install-autostart.sh runs this once per Windows Terminal tab:
#   autostart.sh app       tab 1: the normal `npm run dev`
#   autostart.sh sessions  tab 2: restore the latest snapshot, then show tmux
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HOME/.sigmapi2sigma"

# `wsl.exe --exec` skips the login shell, and tmux draws "_" for UTF-8 without a locale.
export LANG="${LANG:-C.UTF-8}"

case "${1:-}" in
  app)
    cd "$REPO" || exit 1
    if curl -fs http://127.0.0.1:5174/api/health >/dev/null; then
      echo "sigmapi2sigma is already running."
      exec zsh -i
    fi
    # Through an interactive zsh so nvm's node is on PATH. The trap keeps this zsh
    # alive through Ctrl+C (npm still receives it), so stopping the app leaves a
    # usable shell in the tab instead of ending it.
    exec zsh -ic 'trap : INT; npm run dev; trap - INT; exec zsh -i'
    ;;
  sessions)
    # Only restore into an empty tmux: if sessions exist this is a re-login, not a
    # boot, and restoring over them would at best skip and at worst duplicate work.
    if ! tmux list-sessions >/dev/null 2>&1; then
      mkdir -p "$DATA_DIR"
      touch "$DATA_DIR/restore-in-progress"   # pauses snapshot.sh; see the check there
      "$REPO/scripts/restore.sh" 2>&1 | tee -a "$DATA_DIR/autostart.log"
    fi
    tmux attach || exec tmux new-session
    ;;
  *)
    echo "usage: autostart.sh app|sessions" >&2
    exit 2
    ;;
esac
