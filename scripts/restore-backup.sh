#!/usr/bin/env bash
# Restore data from a backup bundle. Always creates a pre-restore backup first.
# Usage:
#   restore-backup.sh /path/to/sigmapi2sigma-YYYY-MM-DD-HHMMSS.tar.gz [--no-pre-backup] [--no-conversations]
set -euo pipefail

BUNDLE="${1:-}"
NO_PRE_BACKUP=0
NO_CONVERSATIONS=0
for arg in "$@"; do
  [ "$arg" = "--no-pre-backup" ] && NO_PRE_BACKUP=1
  [ "$arg" = "--no-conversations" ] && NO_CONVERSATIONS=1
done

if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "Usage: restore-backup.sh /path/to/backup.tar.gz [--no-pre-backup] [--no-conversations]" >&2
  exit 1
fi

DATA_DIR="$HOME/.sigmapi2sigma"
CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Restoring from: $BUNDLE"

# Validate the bundle: must contain at least projects.json.
if ! tar -tzf "$BUNDLE" | grep -qE "^(\./)?projects\.json$"; then
  echo "Invalid backup: bundle is missing projects.json (or has wrong layout)." >&2
  exit 1
fi

# Extract to a temp dir for validation.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$BUNDLE" -C "$TMP"

# Validate JSON files.
for f in projects.json tasks.json assignments.json pomodoros.json settings.json saved-tmux.json; do
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
  bash "$SCRIPT_DIR/backup.sh" --force
fi

mkdir -p "$DATA_DIR" "$DATA_DIR/shell-history" "$DATA_DIR/snapshots"

# Atomic swap helper.
atomic_swap() {
  local src="$1" dest="$2"
  cp "$src" "$dest.tmp.$$"
  mv "$dest.tmp.$$" "$dest"
}

# Top-level data files.
for f in projects.json tasks.json assignments.json pomodoros.json settings.json \
         saved-tmux.json tmux-bindings.jsonl; do
  if [ -f "$TMP/$f" ]; then
    atomic_swap "$TMP/$f" "$DATA_DIR/$f"
    echo "restored $f"
  fi
done

# Snapshots: copy each (don't wipe non-included rotation slots).
if [ -d "$TMP/snapshots" ]; then
  for src in "$TMP/snapshots"/*.json; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    atomic_swap "$src" "$DATA_DIR/snapshots/$base"
    echo "restored snapshots/$base"
  done
fi

# Shell history: copy any included day-files (don't wipe non-included days).
if [ -d "$TMP/shell-history" ]; then
  for src in "$TMP/shell-history"/*.jsonl; do
    [ -f "$src" ] || continue
    base="$(basename "$src")"
    atomic_swap "$src" "$DATA_DIR/shell-history/$base"
    echo "restored shell-history/$base"
  done
fi

# Claude conversations: copy any included files (don't wipe other projects/sessions).
if [ -d "$TMP/claude-conversations" ] && [ "$NO_CONVERSATIONS" -eq 0 ]; then
  mkdir -p "$CLAUDE_PROJECTS_DIR"
  count=0
  while IFS= read -r -d '' src; do
    rel="${src#$TMP/claude-conversations/}"
    dest="$CLAUDE_PROJECTS_DIR/$rel"
    mkdir -p "$(dirname "$dest")"
    atomic_swap "$src" "$dest"
    count=$((count + 1))
  done < <(find "$TMP/claude-conversations" -type f -name "*.jsonl" -print0)
  [ $count -gt 0 ] && echo "restored $count claude-conversation file(s)"
fi

echo "Restore complete. Restart the dev server (npm run stop && npm run dev) to pick up changes."
