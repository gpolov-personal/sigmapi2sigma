#!/usr/bin/env bash
# Bundle the 5 core JSONs + last 3 days of shell history into a tar.gz under
# ~/.sigmapi2sigma/backups/, then prune by retention policy. If BACKUP_REMOTE
# is set in ~/.sigmapi2sigma/backup-config, mirror to that rclone remote.
set -euo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
BACKUP_DIR="$DATA_DIR/backups"
CONFIG="$DATA_DIR/backup-config"

mkdir -p "$BACKUP_DIR"

TS=$(date +%Y-%m-%d-%H%M%S)
BUNDLE="$BACKUP_DIR/sigmapi2sigma-$TS.tar.gz"

# Collect targets (skip files that don't exist yet).
TARGETS=()
for f in projects.json tasks.json assignments.json pomodoros.json settings.json; do
  [ -f "$DATA_DIR/$f" ] && TARGETS+=("$f")
done

# Last 3 days of shell history (today + yesterday + day before).
SHELL_DIR_REL="shell-history"
if [ -d "$DATA_DIR/$SHELL_DIR_REL" ]; then
  for offset in 0 1 2; do
    DAY=$(date -d "$offset days ago" +%Y-%m-%d 2>/dev/null || date -v "-${offset}d" +%Y-%m-%d)
    REL="$SHELL_DIR_REL/$DAY.jsonl"
    [ -f "$DATA_DIR/$REL" ] && TARGETS+=("$REL")
  done
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "Nothing to back up yet (no data files found in $DATA_DIR)."
  exit 0
fi

# Skip-on-no-change: if every source file is older than the latest existing backup,
# there's nothing new to capture. Always run when invoked with --force.
FORCE=0
for arg in "$@"; do [ "$arg" = "--force" ] && FORCE=1; done

if [ $FORCE -eq 0 ]; then
  LAST_BACKUP=$(ls -t "$BACKUP_DIR"/sigmapi2sigma-*.tar.gz 2>/dev/null | head -1 || true)
  if [ -n "$LAST_BACKUP" ]; then
    CHANGED=0
    for rel in "${TARGETS[@]}"; do
      if [ "$DATA_DIR/$rel" -nt "$LAST_BACKUP" ]; then
        CHANGED=1; break
      fi
    done
    if [ $CHANGED -eq 0 ]; then
      echo "No source changes since $(basename "$LAST_BACKUP") — skipping."
      exit 0
    fi
  fi
fi

# Build the bundle from the data dir so paths inside are relative.
tar -C "$DATA_DIR" -czf "$BUNDLE" "${TARGETS[@]}"

# Apply retention policy via Node (cleaner than bash for date math + grouping).
node -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const now = Date.now();
  const DAY = 86_400_000;
  const files = fs.readdirSync(dir).filter(f => /^sigmapi2sigma-.*\.tar\.gz$/.test(f));
  const parsed = files.map(f => {
    // Accept both HHMM (legacy) and HHMMSS (current) forms.
    const m = /^sigmapi2sigma-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})?\.tar\.gz$/.exec(f);
    if (!m) return null;
    const [, y, mo, d, hh, mm, ss] = m;
    const ts = new Date(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0).getTime();
    return { f, ts, day: `${y}-${mo}-${d}`, month: `${y}-${mo}` };
  }).filter(Boolean).sort((a, b) => b.ts - a.ts);   // newest first
  const keepDay = new Set();
  const keepMonth = new Set();
  const toDelete = [];
  for (const p of parsed) {
    const ageMs = now - p.ts;
    if (ageMs > 365 * DAY) {
      toDelete.push(p.f);
    } else if (ageMs > 30 * DAY) {
      if (keepMonth.has(p.month)) toDelete.push(p.f);
      else keepMonth.add(p.month);
    } else if (ageMs > DAY) {
      if (keepDay.has(p.day)) toDelete.push(p.f);
      else keepDay.add(p.day);
    }
    // ≤ 24h: keep all
  }
  for (const f of toDelete) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`pruned ${f}`);
  }
' "$BACKUP_DIR"

echo "wrote $BUNDLE"

# Optional cloud mirror via rclone.
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG"
fi
if [ -n "${BACKUP_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone sync "$BACKUP_DIR" "$BACKUP_REMOTE" --include "*.tar.gz" 2>&1 \
      || echo "rclone sync to $BACKUP_REMOTE failed"
  else
    echo "BACKUP_REMOTE set but rclone not installed; skipping cloud sync."
  fi
fi
