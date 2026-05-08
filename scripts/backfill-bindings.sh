#!/usr/bin/env bash
# One-time backfill: scan all current snapshot files and emit any claude-pane
# bindings into ~/.sigmapi2sigma/tmux-bindings.jsonl. Safe to re-run; the
# tmux-bindings reader dedups at query time (newest-ts wins per session id).
set -euo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
SNAP_DIR="$DATA_DIR/snapshots"
BINDINGS_FILE="$DATA_DIR/tmux-bindings.jsonl"

[[ -d "$SNAP_DIR" ]] || { echo "no snapshots dir: $SNAP_DIR" >&2; exit 0; }

count=0
for f in "$SNAP_DIR"/latest.json "$SNAP_DIR"/prev.json "$SNAP_DIR"/prev*.json; do
  [[ -f "$f" ]] || continue
  added=$(jq -c '
    .ts as $ts
    | .sessions[] as $s
    | $s.windows[] as $w
    | $w.panes[]
    | select(.claudeSessionId != null)
    | {ts: $ts, claudeSessionId: .claudeSessionId, tmuxSession: $s.name,
       windowIndex: $w.index, paneIndex: .index, cwd: .cwd}
  ' "$f" 2>/dev/null) || continue
  if [[ -n "$added" ]]; then
    n=$(wc -l <<<"$added")
    count=$((count + n))
    printf '%s\n' "$added" >> "$BINDINGS_FILE"
  fi
done

echo "backfilled $count bindings into $BINDINGS_FILE"
