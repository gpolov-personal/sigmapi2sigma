#!/usr/bin/env bash
# Remove the sigmapi2sigma crontab block.
set -euo pipefail

MARKER_BEGIN="# BEGIN sigmapi2sigma"
MARKER_END="# END sigmapi2sigma"

current=$(crontab -l 2>/dev/null || true)
if ! grep -qF "$MARKER_BEGIN" <<<"$current"; then
  echo "No cron entries from sigmapi2sigma found."
  exit 0
fi

awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
  $0==b {inblock=1; next}
  $0==e {inblock=0; next}
  !inblock {print}
' <<<"$current" | crontab -

echo "Uninstalled cron entries."
