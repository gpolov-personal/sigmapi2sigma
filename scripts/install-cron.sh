#!/usr/bin/env bash
# Add snapshot + shell-history-prune + backup cron entries. Idempotent.
set -euo pipefail

# Resolve repo dir from the script's own location (works after a project folder rename).
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HOME/.sigmapi2sigma"
MARKER_BEGIN="# BEGIN sigmapi2sigma"
MARKER_END="# END sigmapi2sigma"

current=$(crontab -l 2>/dev/null || true)

if grep -qF "$MARKER_BEGIN" <<<"$current"; then
  echo "cron entries already installed. Skipping."
  exit 0
fi

block="$MARKER_BEGIN
*/5 * * * * $REPO/scripts/snapshot.sh >/dev/null 2>&1
*/30 * * * * $REPO/scripts/backup.sh >/dev/null 2>&1
0 4 * * 0 find $DATA_DIR/shell-history -name '*.jsonl' -mtime +60 -delete >/dev/null 2>&1
$MARKER_END"

{ [[ -n "$current" ]] && printf '%s\n' "$current"; printf '%s\n' "$block"; } | crontab -

echo "Installed:"
echo "$block"
