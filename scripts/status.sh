#!/usr/bin/env bash
# Show if the workspace is up: the app and its ports, who started it, tmux, the boot
# task, Tailscale and SSH, the Windows drive, snapshots and backups. Read-only, so it
# is safe to run at any time, also over SSH. Exits 1 if any line is FAIL.
set -uo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
WEB_PORT=5173               # vite.config.ts
API_PORT="${PORT:-5174}"    # server/index.ts
failures=0

if [ -t 1 ]; then G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' D=$'\e[2m' N=$'\e[0m'; else G="" Y="" R="" D="" N=""; fi
ok()   { printf '  %sok%s    %-10s %s\n' "$G" "$N" "$1" "$2"; }
warn() { printf '  %swarn%s  %-10s %s\n' "$Y" "$N" "$1" "$2"; }
fail() { printf '  %sFAIL%s  %-10s %s\n' "$R" "$N" "$1" "$2"; failures=$((failures + 1)); }
hint() { printf '        %-10s %s%s%s\n' "" "$D" "$1" "$N"; }

# Minutes since a file changed, by the wall clock. (Process start times from ps are
# not used: WSL does not count the time the laptop spends in standby.)
age_min() { echo $(( ($(date +%s) - $(stat -c %Y "$1")) / 60 )); }
human() { local m=$1; if ((m < 120)); then echo "${m} min"; elif ((m < 2880)); then echo "$((m / 60)) h"; else echo "$((m / 1440)) days"; fi; }

# The process that listens on a port, and if the boot task is one of its ancestors.
listener_pid() { ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
from_boot_task() {
  local pid=$1
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'autostart.sh boot' && return 0
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
  return 1
}

echo "sigmapi2sigma status"
echo

# --- app
if curl -fs -m 3 "http://127.0.0.1:$API_PORT/api/health" >/dev/null; then
  pid=$(listener_pid "$API_PORT")
  if [ -n "$pid" ] && from_boot_task "$pid"; then
    by="started by the boot task, output in $DATA_DIR/app.log"
  else
    by="started from a terminal, output in that terminal"
  fi
  web=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")
  if [ "$web" = 200 ]; then
    ok app "open http://127.0.0.1:$WEB_PORT  (API :$API_PORT healthy)"
  else
    fail app "API :$API_PORT healthy, but the web UI on :$WEB_PORT does not answer (HTTP ${web:-none})"
  fi
  hint "$by"
else
  fail app "not running: nothing answers on 127.0.0.1:$API_PORT/api/health"
  hint "start it with: npm run dev   (boot task output: tail -50 $DATA_DIR/app.log)"
fi

# --- tmux
if sessions=$(tmux list-sessions -F '#S' 2>/dev/null) && [ -n "$sessions" ]; then
  ok tmux "$(wc -l <<<"$sessions") sessions: $(paste -sd' ' <<<"$sessions")"
else
  warn tmux "no sessions. Restore with: npm run restore"
fi

# --- boot task, seen from WSL (the Windows view needs the drive check below to pass)
last_boot=$(grep -a 'boot: started' "$DATA_DIR/autostart.log" 2>/dev/null | tail -1 | cut -c1-16)
if pgrep -f 'scripts/autostart.sh boot' >/dev/null; then
  ok boot-task "running since ${last_boot:-an unknown time}, keeps WSL up"
  if [ -e "$DATA_DIR/boot-restore" ]; then
    hint "boot restore on: the next Windows start restores tmux and the app before login"
  else
    hint "boot restore off: tmux and the app start at login (npm run boot-restore on)"
  fi
elif [ -n "$last_boot" ]; then
  warn boot-task "not running now (last boot run: $last_boot). WSL stops when no window uses it"
else
  warn boot-task "never ran. Install with: npm run install-boot-task"
fi

# --- Tailscale and SSH
if command -v tailscale >/dev/null; then
  ts=$(tailscale status --json 2>/dev/null)
  state=$(jq -r '.BackendState // empty' <<<"$ts" 2>/dev/null)
  if [ "$state" = Running ]; then
    ok tailscale "online as $(jq -r '.Self.DNSName | rtrimstr(".")' <<<"$ts")"
  else
    fail tailscale "state '${state:-not responding}'. See docs/remote-access.md, section 2"
  fi
fi
if [ "$(systemctl is-active ssh 2>/dev/null)" = active ]; then
  ok ssh "sshd active"
else
  fail ssh "sshd not active. Run: sudo systemctl start ssh"
fi

# --- Windows drive and interop: Windows commands (powershell.exe, explorer.exe) and
# npm run install-autostart need /mnt/c.
if timeout 5 ls /mnt/c >/dev/null 2>&1; then
  ok windows "/mnt/c readable"
  result=$(cd /mnt/c && timeout 20 powershell.exe -NoProfile -NonInteractive -Command \
    '(Get-ScheduledTaskInfo "WSL at boot" -ErrorAction SilentlyContinue).LastTaskResult' 2>/dev/null | tr -d '\r')
  case "$result" in
    267009) hint "Windows task 'WSL at boot': running (267009)" ;;
    "")     hint "Windows task 'WSL at boot': not registered, or not readable from here" ;;
    *)      hint "Windows task 'WSL at boot': LastTaskResult $result, see docs/remote-access.md" ;;
  esac
else
  warn windows "/mnt/c gives an error, so Windows commands do not run from WSL"
  hint "a WSL restart can fix it (PowerShell: wsl --shutdown; Start-ScheduledTask 'WSL at boot')"
fi

# --- snapshots: cron runs snapshot.sh every 5 minutes, but it writes latest.json only
# when the tmux layout changed, so an old file is normal. Check the cron job instead.
if crontab -l 2>/dev/null | grep -q 'scripts/snapshot.sh'; then
  if [ -f "$DATA_DIR/snapshots/latest.json" ]; then
    ok snapshot "cron every 5 min, last change $(human "$(age_min "$DATA_DIR/snapshots/latest.json")") ago"
  else
    warn snapshot "cron installed, but no snapshot yet"
  fi
else
  fail snapshot "no cron job, so nothing saves tmux. Run: npm run install-cron"
fi

# --- backups: local (hourly), then the cloud sync (twice a day)
# shellcheck disable=SC2012  # our own file names, no special characters
newest=$(ls -t "$DATA_DIR"/backups/*.tar.gz 2>/dev/null | head -1)
if [ -n "$newest" ]; then
  m=$(age_min "$newest")
  if ((m <= 120)); then ok backup "latest $(human "$m") ago"; else warn backup "latest $(human "$m") ago (cron runs it hourly)"; fi
else
  warn backup "no local backups yet"
fi
sync_log="$DATA_DIR/backups/sync.log"
last_sync=$(grep -a -E 'sync done|SYNC FAILED|SYNC SKIPPED' "$sync_log" 2>/dev/null | tail -1)
case "$last_sync" in
  *"sync done"*)
    ok cloud "last sync OK at ${last_sync:0:16}" ;;
  *SYNC*)
    since=$(grep -a 'sync done' "$sync_log" | tail -1 | cut -c1-16)
    fail cloud "last sync failed at ${last_sync:0:16} (last OK: ${since:-never})"
    remote=$(sed -n 's/^BACKUP_REMOTE=//p' "$DATA_DIR/backup-config" 2>/dev/null | cut -d: -f1)
    if tail -20 "$sync_log" | grep -q invalid_grant; then
      hint "the login expired. Run: rclone config reconnect ${remote:-<remote>}:"
    else
      hint "details: tail -20 $sync_log"
    fi ;;
  *)
    warn cloud "no sync recorded. See BACKUP_REMOTE in $DATA_DIR/backup-config" ;;
esac

echo
if ((failures)); then echo "$failures problem(s) found."; exit 1; fi
echo "All OK."
