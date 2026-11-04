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

# Log everything: cron discards this script's output, so sync.log is the only record.
exec > >(tee -a "$LOG") 2>&1

# Prefer a user-installed rclone: cron's PATH would otherwise find only the distro
# package in /usr/bin, which on Ubuntu 22.04 is far older than the required 1.62.
PATH="$HOME/.local/bin:$PATH"

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

# sync mirrors, so an empty folder would empty the remote: a fresh install, or the
# disk being restored from these very backups.
if ! compgen -G "$BACKUP_DIR/*.tar.gz" >/dev/null; then
  echo "$(date -Iseconds) SYNC SKIPPED: no local backups, refusing to mirror an empty folder"
  exit 1
fi

# rclone's default client ID shares its Drive quota with other users, so the first
# request is often refused with a 403. rclone gives up on that immediately instead
# of using its own retries, hence retrying the whole command here.
MAX_ATTEMPTS=8
RETRY_DELAY="${SP2S_SYNC_RETRY_DELAY:-30}"

echo "$(date -Iseconds) sync start → $BACKUP_REMOTE ($(rclone version | head -1))"
for ((attempt=1; attempt<=MAX_ATTEMPTS; attempt++)); do
  if rclone sync "$BACKUP_DIR" "$BACKUP_REMOTE" --include "*.tar.gz" --stats-one-line -v; then
    echo "$(date -Iseconds) sync done (attempt $attempt)"
    exit 0
  fi
  echo "$(date -Iseconds) attempt $attempt/$MAX_ATTEMPTS failed"
  (( attempt < MAX_ATTEMPTS )) && sleep "$RETRY_DELAY"
done

echo "$(date -Iseconds) SYNC FAILED after $MAX_ATTEMPTS attempts"
exit 1
