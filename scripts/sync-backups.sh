#!/usr/bin/env bash
# Mirror ~/.sigmapi2sigma/backups/*.tar.gz to the configured rclone remote.
# Decoupled from backup.sh so we can run backups frequently but only push to
# the cloud a couple of times per day.
#
# Reads BACKUP_REMOTE from ~/.sigmapi2sigma/backup-config (e.g. PoloGDrive:Backups/sigmapi2sigma).
# No-op if BACKUP_REMOTE is unset or rclone isn't installed.
set -euo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
BACKUP_DIR="$DATA_DIR/backups"
CONFIG="$DATA_DIR/backup-config"
LOG="$BACKUP_DIR/sync.log"

mkdir -p "$BACKUP_DIR"

# Log errors so cron failures aren't silently swallowed.
exec 2> >(tee -a "$LOG" >&2)

if [ ! -f "$CONFIG" ]; then
  echo "$(date -Iseconds) no backup-config; skipping sync."
  exit 0
fi

# shellcheck disable=SC1090
source "$CONFIG"

if [ -z "${BACKUP_REMOTE:-}" ]; then
  echo "$(date -Iseconds) BACKUP_REMOTE not set; skipping sync."
  exit 0
fi

if ! command -v rclone >/dev/null 2>&1; then
  echo "$(date -Iseconds) rclone not installed; skipping sync." >&2
  exit 1
fi

echo "$(date -Iseconds) sync start → $BACKUP_REMOTE"
rclone sync "$BACKUP_DIR" "$BACKUP_REMOTE" --include "*.tar.gz" 2>&1
echo "$(date -Iseconds) sync done"
