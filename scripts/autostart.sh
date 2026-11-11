#!/usr/bin/env bash
# Rebuild the usual workspace. The Startup shortcut created by install-autostart.sh
# runs this once per Windows Terminal tab at login:
#   autostart.sh app       tab 1: the normal `npm run dev`
#   autostart.sh sessions  tab 2: restore the latest snapshot, then show tmux
# and the optional "WSL at boot" scheduled task (README) runs it before any login:
#   autostart.sh boot      no window: the same restore and app, then keep WSL up
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HOME/.sigmapi2sigma"

# `wsl.exe --exec` skips the login shell, and tmux draws "_" for UTF-8 without a locale.
export LANG="${LANG:-C.UTF-8}"

# SSH into this laptop goes through the Tailscale inside WSL (the personal tailnet),
# not the Windows Tailscale app, which is a separate install and login. tailscaled is
# a systemd service, so it normally comes up with WSL. This waits for it, brings it
# back online if it was left `tailscale down`, and says what to run if it cannot.
ensure_tailscale() {
  command -v tailscale >/dev/null || return 0
  local state="" _
  for _ in $(seq 30); do
    state="$(tailscale status --json 2>/dev/null | jq -r '.BackendState // empty')"
    case "$state" in ""|NoState|Starting) sleep 1 ;; *) break ;; esac
  done
  if [ "$state" = Stopped ]; then
    if tailscale up >/dev/null 2>&1; then
      state=Running
    else
      echo "tailscale: stopped, and 'tailscale up' was refused." \
           "Run 'sudo tailscale up' (or once: sudo tailscale set --operator=\$USER)"
      return 1
    fi
  fi
  case "$state" in
    Running) echo "tailscale: online as $(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')" ;;
    NeedsLogin|NeedsMachineAuth) echo "tailscale: logged out. Run 'sudo tailscale up' to log in" ;;
    *) echo "tailscale: not responding (state '${state:-none}'). Run 'sudo systemctl restart tailscaled'" ;;
  esac
  [ "$state" = Running ]
}

app_running() { curl -fs http://127.0.0.1:5174/api/health >/dev/null; }

# Only restore into an empty tmux: if sessions exist this is a re-login (or boot
# already restored), and restoring over them would at best skip and at worst
# duplicate work.
restore_if_empty() {
  tmux list-sessions >/dev/null 2>&1 && return 0
  touch "$DATA_DIR/restore-in-progress"   # pauses snapshot.sh; see the check there
  "$REPO/scripts/restore.sh"
}

stamp() { sed "s/^/$(date '+%F %T') /"; }

mkdir -p "$DATA_DIR"

case "${1:-}" in
  app)
    cd "$REPO" || exit 1
    if app_running; then
      echo "sigmapi2sigma is already running."
      [ -f "$DATA_DIR/app.log" ] && echo "If it started at boot, its output is in: tail -f $DATA_DIR/app.log"
      exec zsh -i
    fi
    # Through an interactive zsh so nvm's node is on PATH. The trap keeps this zsh
    # alive through Ctrl+C (npm still receives it), so stopping the app leaves a
    # usable shell in the tab instead of ending it.
    exec zsh -ic 'trap : INT; npm run dev; trap - INT; exec zsh -i'
    ;;
  sessions)
    ensure_tailscale 2>&1 | stamp | tee -a "$DATA_DIR/autostart.log"
    restore_if_empty 2>&1 | tee -a "$DATA_DIR/autostart.log"
    tmux attach || exec tmux new-session
    ;;
  boot)
    # No terminal and possibly no Windows login: a restart nobody is at should still
    # leave the machine reachable over SSH with the workspace ready. A later login is
    # unaffected, because both tabs above skip what is already done. Restore comes
    # before the app so that an app that fails to start cannot cost the sessions.
    exec >>"$DATA_DIR/autostart.log" 2>&1 </dev/null
    echo "boot: started" | stamp
    ensure_tailscale | stamp
    restore_if_empty
    if app_running; then
      echo "boot: app already running" | stamp
    else
      # Outside tmux, or every snapshot would capture it and a restore would bring it
      # back as an idle shell. setsid gives it its own session, so it does not depend
      # on this script. Stop it with: pkill -f "concurrently.*dev:server"
      echo "boot: starting app, output in $DATA_DIR/app.log" | stamp
      (cd "$REPO" && setsid zsh -ic 'exec npm run dev' >>"$DATA_DIR/app.log" 2>&1 </dev/null &)
    fi
    # WSL shuts down once nothing launched through wsl.exe is left; this keeps it,
    # and with it tailscaled and sshd, running.
    exec sleep infinity
    ;;
  *)
    echo "usage: autostart.sh app|sessions|boot" >&2
    exit 2
    ;;
esac
