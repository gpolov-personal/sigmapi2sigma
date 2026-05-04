#!/usr/bin/env bash
# Capture tmux state + claude session IDs. Writes rotated snapshots.
# No-op if tmux is not running. Safe to call from cron.
set -euo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
SNAP_DIR="$DATA_DIR/snapshots"
CLAUDE_PROJECTS="$HOME/.claude/projects"

mkdir -p "$SNAP_DIR"

tmux list-sessions >/dev/null 2>&1 || exit 0

# Encode a cwd to Claude Code's project-dir form: replace /._ with -.
encode_cwd() {
  printf '%s' "$1" | sed 's|[/._]|-|g'
}

# Given a pane cwd and command, resolve the most recently active claude session id.
# Echoes sessionId or empty string.
resolve_claude_session() {
  local cwd="$1" cmd="$2"
  [[ "$cmd" == "claude" ]] || { echo ""; return 0; }
  local enc proj newest
  enc=$(encode_cwd "$cwd")
  proj="$CLAUDE_PROJECTS/$enc"
  [[ -d "$proj" ]] || { echo ""; return 0; }
  # Most recently modified top-level JSONL (not in subagents/).
  newest=$(find "$proj" -maxdepth 1 -name "*.jsonl" -printf "%T@ %p\n" 2>/dev/null \
    | sort -rn | head -1 | awk '{print $2}')
  [[ -n "$newest" ]] || { echo ""; return 0; }
  # Filename is <uuid>.jsonl.
  basename "$newest" .jsonl
}

# Given a pane cwd and session id, read the JSONL tail (last 256 KB) and extract
# the most recent "cwd" field. Echoes path or empty string.
resolve_claude_last_cwd() {
  local cwd="$1" sid="$2"
  [[ -n "$sid" ]] || { echo ""; return 0; }
  local enc proj file
  enc=$(encode_cwd "$cwd")
  file="$CLAUDE_PROJECTS/$enc/$sid.jsonl"
  [[ -f "$file" ]] || { echo ""; return 0; }
  tail -c 262144 "$file" 2>/dev/null \
    | awk -F'"cwd":"' 'NF>1 { split($2, a, "\""); last=a[1] } END { if (last) print last }'
}

# Read JSONL header (~8 KB) and extract the first permissionMode it finds
# (the launch-time permission mode). Echoes mode or empty string.
resolve_claude_permission_mode() {
  local cwd="$1" sid="$2"
  [[ -n "$sid" ]] || { echo ""; return 0; }
  local enc file
  enc=$(encode_cwd "$cwd")
  file="$CLAUDE_PROJECTS/$enc/$sid.jsonl"
  [[ -f "$file" ]] || { echo ""; return 0; }
  head -c 8192 "$file" 2>/dev/null \
    | awk -F'"permissionMode":"' 'NF>1 { split($2, a, "\""); print a[1]; exit }'
}

# Gather tmux tree. We build JSON with jq for safety.
TMUX_VERSION=$(tmux -V | awk '{print $2}')
TS=$(date -Iseconds)

# Sessions JSON array built incrementally.
sessions_json="[]"

while IFS=$'\t' read -r sess_name; do
  [[ -n "$sess_name" ]] || continue
  windows_json="[]"
  while IFS=$'\t' read -r win_idx win_name win_layout; do
    [[ -n "$win_idx" ]] || continue
    panes_json="[]"
    while IFS=$'\t' read -r pane_idx pane_id pane_pid pane_cmd pane_cwd; do
      [[ -n "$pane_idx" ]] || continue
      claude_sid=$(resolve_claude_session "$pane_cwd" "$pane_cmd")
      claude_last_cwd=$(resolve_claude_last_cwd "$pane_cwd" "$claude_sid")
      claude_perm_mode=$(resolve_claude_permission_mode "$pane_cwd" "$claude_sid")
      pane_obj=$(jq -n \
        --argjson index "$pane_idx" \
        --arg paneId "$pane_id" \
        --argjson pid "$pane_pid" \
        --arg cmd "$pane_cmd" \
        --arg cwd "$pane_cwd" \
        --arg claudeSessionId "$claude_sid" \
        --arg claudeLastCwd "$claude_last_cwd" \
        --arg claudePermissionMode "$claude_perm_mode" \
        '{index:$index, paneId:$paneId, pid:$pid, cmd:$cmd, cwd:$cwd,
          claudeSessionId:      (if $claudeSessionId==""      then null else $claudeSessionId      end),
          claudeLastCwd:        (if $claudeLastCwd==""        then null else $claudeLastCwd        end),
          claudePermissionMode: (if $claudePermissionMode=="" then null else $claudePermissionMode end)}')
      panes_json=$(jq --argjson p "$pane_obj" '. + [$p]' <<<"$panes_json")
    done < <(tmux list-panes -t "$sess_name:$win_idx" \
      -F "#{pane_index}	#{pane_id}	#{pane_pid}	#{pane_current_command}	#{pane_current_path}")
    win_obj=$(jq -n \
      --argjson index "$win_idx" \
      --arg name "$win_name" \
      --arg layout "$win_layout" \
      --argjson panes "$panes_json" \
      '{index:$index, name:$name, layout:$layout, panes:$panes}')
    windows_json=$(jq --argjson w "$win_obj" '. + [$w]' <<<"$windows_json")
  done < <(tmux list-windows -t "$sess_name" \
    -F "#{window_index}	#{window_name}	#{window_layout}")
  sess_obj=$(jq -n \
    --arg name "$sess_name" \
    --argjson windows "$windows_json" \
    '{name:$name, windows:$windows}')
  sessions_json=$(jq --argjson s "$sess_obj" '. + [$s]' <<<"$sessions_json")
done < <(tmux list-sessions -F "#{session_name}")

final=$(jq -n \
  --arg version "1" \
  --arg ts "$TS" \
  --arg tmuxVersion "$TMUX_VERSION" \
  --argjson sessions "$sessions_json" \
  '{version:($version|tonumber), ts:$ts, tmuxVersion:$tmuxVersion, sessions:$sessions}')

tmp=$(mktemp "$SNAP_DIR/.new.XXXXXX.json")
printf '%s\n' "$final" >"$tmp"

# Diff guard: normalize new and latest (strip noise), compare.
# Ignored: ts (always different), tmuxVersion (rare), pane.pid (changes on each tmux restart),
# window.name (tmux auto-rename flickers based on foreground process).
# Compared: session names, pane structure, paneId, cmd, cwd, claude*, layout.
NORMALIZE='del(.ts, .tmuxVersion)
  | .sessions |= map(.windows |= map(.name = ""))
  | walk(if type=="object" and has("pid") then del(.pid) else . end)'
if [[ -f "$SNAP_DIR/latest.json" ]]; then
  norm_new=$(jq -S "$NORMALIZE" "$tmp" 2>/dev/null || true)
  norm_old=$(jq -S "$NORMALIZE" "$SNAP_DIR/latest.json" 2>/dev/null || true)
  if [[ -n "$norm_new" && "$norm_new" == "$norm_old" ]]; then
    rm -f "$tmp"
    exit 0
  fi
fi

# State changed → rotate. Keep latest + prev + prev2..prev$((MAX_KEEP-1)).
MAX_KEEP=7
# Shift highest down to lowest to avoid clobbering.
# prev6 ← prev5, prev5 ← prev4, ..., prev2 ← prev, then prev ← latest.
for ((i=MAX_KEEP-1; i>=2; i--)); do
  prev_lower=$((i-1))
  src="$SNAP_DIR/prev${prev_lower}.json"
  [[ "$prev_lower" -eq 1 ]] && src="$SNAP_DIR/prev.json"
  dst="$SNAP_DIR/prev${i}.json"
  [[ -f "$src" ]] && mv -f "$src" "$dst"
done
[[ -f "$SNAP_DIR/latest.json" ]] && mv -f "$SNAP_DIR/latest.json" "$SNAP_DIR/prev.json"
mv -f "$tmp" "$SNAP_DIR/latest.json"
