#!/usr/bin/env bash
# Restore data from a backup bundle. Always creates a pre-restore backup first.
# Usage:
#   restore-backup.sh /path/to/sigmapi2sigma-YYYY-MM-DD-HHMM.tar.gz [--no-pre-backup]
set -euo pipefail

BUNDLE="${1:-}"
NO_PRE_BACKUP=0
for arg in "$@"; do
  [ "$arg" = "--no-pre-backup" ] && NO_PRE_BACKUP=1
done

if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "Usage: restore-backup.sh /path/to/backup.tar.gz [--no-pre-backup]" >&2
  exit 1
fi

DATA_DIR="$HOME/.sigmapi2sigma"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Restoring from: $BUNDLE"

# Validate the bundle: must contain at least projects.json and parse cleanly.
if ! tar -tzf "$BUNDLE" | grep -q "^projects.json$"; then
  echo "Invalid backup: bundle is missing projects.json (or has wrong layout)." >&2
  exit 1
fi

# Extract to a temp dir for validation.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$BUNDLE" -C "$TMP"

for f in projects.json tasks.json assignments.json pomodoros.json settings.json; do
  if [ -f "$TMP/$f" ]; then
    if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$TMP/$f" 2>/dev/null; then
      echo "Invalid JSON in bundle: $f" >&2
      exit 1
    fi
  fi
done

# Auto pre-restore backup unless explicitly skipped.
if [ "$NO_PRE_BACKUP" -eq 0 ] && [ -f "$SCRIPT_DIR/backup.sh" ]; then
  echo "Creating pre-restore backup of current state..."
  bash "$SCRIPT_DIR/backup.sh"
fi

mkdir -p "$DATA_DIR" "$DATA_DIR/shell-history"

# Atomically swap each file by writing to .tmp and renaming.
for f in projects.json tasks.json assignments.json pomodoros.json settings.json; do
  if [ -f "$TMP/$f" ]; then
    cp "$TMP/$f" "$DATA_DIR/$f.tmp.$$"
    mv "$DATA_DIR/$f.tmp.$$" "$DATA_DIR/$f"
    echo "restored $f"
  fi
done

# Shell history: copy any included day-files (don't wipe non-included days).
if [ -d "$TMP/shell-history" ]; then
  for src in "$TMP/shell-history"/*.jsonl; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    cp "$src" "$DATA_DIR/shell-history/$base.tmp.$$"
    mv "$DATA_DIR/shell-history/$base.tmp.$$" "$DATA_DIR/shell-history/$base"
    echo "restored shell-history/$base"
  done
fi

echo "Restore complete. Restart the dev server (npm run stop && npm run dev) to pick up changes."
