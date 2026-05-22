#!/usr/bin/env bash
# Bundle a disaster-recovery snapshot under ~/.sigmapi2sigma/backups/.
#
# Contents:
#   - Core JSONs:        projects, tasks, assignments, pomodoros, settings
#   - Tmux state:        saved-tmux.json, tmux-bindings.jsonl, snapshots/
#   - Shell history:     last 3 days of shell-history/*.jsonl
#   - Claude sessions:   ~/.claude/projects/<encoded-cwd>/*.jsonl modified in last 7 days
#                        (ALL projects, not just this one) — staged under claude-conversations/
#
# Skips if no source has changed since the last bundle (use --force to override).
# Mirrors to BACKUP_REMOTE (rclone) if configured in ~/.sigmapi2sigma/backup-config.
set -euo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
BACKUP_DIR="$DATA_DIR/backups"
CONFIG="$DATA_DIR/backup-config"
CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"

mkdir -p "$BACKUP_DIR"

TS=$(date +%Y-%m-%d-%H%M%S)
BUNDLE="$BACKUP_DIR/sigmapi2sigma-$TS.tar.gz"

FORCE=0
for arg in "$@"; do [ "$arg" = "--force" ] && FORCE=1; done

# Collect source paths (absolute) for the change-detection check.
SOURCES=()
for f in projects.json tasks.json assignments.json pomodoros.json settings.json \
         saved-tmux.json tmux-bindings.jsonl; do
  [ -f "$DATA_DIR/$f" ] && SOURCES+=("$DATA_DIR/$f")
done
[ -d "$DATA_DIR/snapshots" ] && while IFS= read -r -d '' s; do SOURCES+=("$s"); done \
  < <(find "$DATA_DIR/snapshots" -maxdepth 1 -type f -name "*.json" -print0)

# Last 3 days of shell history.
SHELL_DAYS=()
if [ -d "$DATA_DIR/shell-history" ]; then
  for offset in 0 1 2; do
    DAY=$(date -d "$offset days ago" +%Y-%m-%d 2>/dev/null || date -v "-${offset}d" +%Y-%m-%d)
    F="$DATA_DIR/shell-history/$DAY.jsonl"
    if [ -f "$F" ]; then
      SOURCES+=("$F")
      SHELL_DAYS+=("$DAY")
    fi
  done
fi

# Last 7 days of Claude conversations across ALL projects.
CLAUDE_FILES=()
if [ -d "$CLAUDE_PROJECTS_DIR" ]; then
  while IFS= read -r -d '' f; do
    CLAUDE_FILES+=("$f")
    SOURCES+=("$f")
  done < <(find "$CLAUDE_PROJECTS_DIR" -type f -name "*.jsonl" -mtime -7 -print0)
fi

if [ ${#SOURCES[@]} -eq 0 ]; then
  echo "Nothing to back up yet (no source files found)."
  exit 0
fi

# Skip-on-no-change: if every source is older than the latest bundle, bail.
if [ $FORCE -eq 0 ]; then
  LAST_BACKUP=$(ls -t "$BACKUP_DIR"/sigmapi2sigma-*.tar.gz 2>/dev/null | head -1 || true)
  if [ -n "$LAST_BACKUP" ]; then
    CHANGED=0
    for s in "${SOURCES[@]}"; do
      if [ "$s" -nt "$LAST_BACKUP" ]; then CHANGED=1; break; fi
    done
    if [ $CHANGED -eq 0 ]; then
      echo "No source changes since $(basename "$LAST_BACKUP") — skipping."
      exit 0
    fi
  fi
fi

# Stage everything into a temp dir so tar can build a clean layout
# that mixes data-dir contents with files from outside the data dir
# (Claude conversations).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Data-dir files at the bundle root.
for f in projects.json tasks.json assignments.json pomodoros.json settings.json \
         saved-tmux.json tmux-bindings.jsonl; do
  [ -f "$DATA_DIR/$f" ] && ln "$DATA_DIR/$f" "$STAGE/$f" 2>/dev/null || \
    { [ -f "$DATA_DIR/$f" ] && cp "$DATA_DIR/$f" "$STAGE/$f"; }
done

# Snapshots subdir.
if [ -d "$DATA_DIR/snapshots" ]; then
  mkdir -p "$STAGE/snapshots"
  for src in "$DATA_DIR/snapshots"/*.json; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    ln "$src" "$STAGE/snapshots/$base" 2>/dev/null || cp "$src" "$STAGE/snapshots/$base"
  done
fi

# Shell-history (last 3 days).
if [ ${#SHELL_DAYS[@]} -gt 0 ]; then
  mkdir -p "$STAGE/shell-history"
  for d in "${SHELL_DAYS[@]}"; do
    src="$DATA_DIR/shell-history/$d.jsonl"
    [ -f "$src" ] || continue
    ln "$src" "$STAGE/shell-history/$d.jsonl" 2>/dev/null || cp "$src" "$STAGE/shell-history/$d.jsonl"
  done
fi

# Claude conversations (last 7 days, all projects), preserving the <encoded-cwd>/<uuid>.jsonl layout.
if [ ${#CLAUDE_FILES[@]} -gt 0 ]; then
  mkdir -p "$STAGE/claude-conversations"
  for src in "${CLAUDE_FILES[@]}"; do
    rel="${src#$CLAUDE_PROJECTS_DIR/}"
    dest="$STAGE/claude-conversations/$rel"
    mkdir -p "$(dirname "$dest")"
    ln "$src" "$dest" 2>/dev/null || cp "$src" "$dest"
  done
fi

# Build the bundle.
tar -C "$STAGE" -czf "$BUNDLE" .

# Retention: keep all <=24h, one per day for 1–30d, one per month for 30–365d, drop >365d.
node -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const now = Date.now();
  const DAY = 86_400_000;
  const files = fs.readdirSync(dir).filter(f => /^sigmapi2sigma-.*\.tar\.gz$/.test(f));
  const parsed = files.map(f => {
    const m = /^sigmapi2sigma-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})?\.tar\.gz$/.exec(f);
    if (!m) return null;
    const [, y, mo, d, hh, mm, ss] = m;
    const ts = new Date(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0).getTime();
    return { f, ts, day: `${y}-${mo}-${d}`, month: `${y}-${mo}` };
  }).filter(Boolean).sort((a, b) => b.ts - a.ts);
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
  }
  for (const f of toDelete) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`pruned ${f}`);
  }
' "$BACKUP_DIR"

SIZE=$(du -h "$BUNDLE" | cut -f1)
echo "wrote $BUNDLE ($SIZE)"

# Optional cloud mirror.
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
