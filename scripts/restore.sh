#!/usr/bin/env bash
# Rebuild tmux sessions/windows/panes from a snapshot file.
# Usage: restore.sh [snapshot.json] [--dry-run] [--force] [--only NAME]
#
# Per-session resilience: each session restore is isolated. One failing session
# does not abort the rest. Prints a structured summary and exits:
#   0 — at least one session was restored OR there was nothing to do
#   1 — every attempted session failed (no progress)
set -uo pipefail

. "$(dirname "$0")/lib/accounts.sh"

ACCOUNTS_TSV="$(sp2s_load_accounts)" || { echo "FATAL: invalid ~/.sigmapi2sigma/accounts.json (see message above)" >&2; exit 1; }

DATA_DIR="$HOME/.sigmapi2sigma"
SNAP_DIR="$DATA_DIR/snapshots"

SNAP="$SNAP_DIR/latest.json"
DRY_RUN=0
FORCE=0
ONLY=""
prev_arg=""
for arg in "$@"; do
  if [[ "$prev_arg" == "--only" ]]; then
    ONLY="$arg"
    prev_arg=""
    continue
  fi
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --only)    prev_arg="--only" ;;
    *)         SNAP="$arg" ;;
  esac
done

[[ -f "$SNAP" ]] || { echo "Snapshot not found: $SNAP" >&2; exit 1; }

# Existing tmux sessions (empty if no server).
existing_sessions=""
if tmux list-sessions >/dev/null 2>&1; then
  existing_sessions=$(tmux list-sessions -F "#{session_name}")
fi

# In dry-run mode, just print; otherwise eval the command and propagate exit.
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY-RUN: %s\n' "$*"
    return 0
  fi
  eval "$@"
}

# Restore one session. Stdout/stderr are captured by the caller.
# Returns 0 on full success, non-zero on first hard failure.
# select-layout and send-keys failures are downgraded to warnings (cosmetic / non-fatal).
restore_one_session() {
  local si=$1 sname=$2
  set -e
  local win_count w_idx w_name w_layout p_count first_cwd target_win
  local pi p_cwd claude_sid claude_mode p_idx cmd_str
  local claude_account env_prefix acc_dir launcher launch_cmd

  win_count=$(jq ".sessions[$si].windows | length" "$SNAP")
  for ((wi=0; wi<win_count; wi++)); do
    w_idx=$(jq   -r ".sessions[$si].windows[$wi].index"  "$SNAP")
    w_name=$(jq  -r ".sessions[$si].windows[$wi].name"   "$SNAP")
    w_layout=$(jq -r ".sessions[$si].windows[$wi].layout" "$SNAP")
    p_count=$(jq ".sessions[$si].windows[$wi].panes | length" "$SNAP")
    first_cwd=$(jq -r ".sessions[$si].windows[$wi].panes[0].cwd" "$SNAP")

    if [[ "$wi" -eq 0 ]]; then
      run "tmux new-session -d -s $(printf %q "$sname") -n $(printf %q "$w_name") -c $(printf %q "$first_cwd")"
    else
      run "tmux new-window -t $(printf %q "$sname"): -n $(printf %q "$w_name") -c $(printf %q "$first_cwd")"
    fi

    target_win="$sname:$w_idx"

    for ((pi=1; pi<p_count; pi++)); do
      p_cwd=$(jq -r ".sessions[$si].windows[$wi].panes[$pi].cwd" "$SNAP")
      run "tmux split-window -t $(printf %q "$target_win") -c $(printf %q "$p_cwd")"
    done

    # Cosmetic — if layout fails (terminal size mismatch etc.) keep going.
    if ! run "tmux select-layout -t $(printf %q "$target_win") $(printf %q "$w_layout")" 2>/dev/null; then
      echo "  warn: select-layout failed for $target_win (panes restored, geometry may differ)" >&2
    fi

    for ((pi=0; pi<p_count; pi++)); do
      claude_sid=$(jq -r ".sessions[$si].windows[$wi].panes[$pi].claudeSessionId // empty" "$SNAP")
      claude_mode=$(jq -r ".sessions[$si].windows[$wi].panes[$pi].claudePermissionMode // empty" "$SNAP")
      claude_account=$(jq -r ".sessions[$si].windows[$wi].panes[$pi].claudeAccount // empty" "$SNAP")
      p_idx=$(jq -r ".sessions[$si].windows[$wi].panes[$pi].index" "$SNAP")
      [[ -n "$claude_sid" ]] || continue
      case "$claude_mode" in
        acceptEdits|auto|bypassPermissions|default|dontAsk|plan) : ;;
        *) claude_mode="" ;;
      esac
      # Prefer the account's launcher function (claudep/claudew) so a restored pane
      # reads exactly like a hand-launched one; fall back to the env-prefix form when
      # no launcher is configured. send-keys targets an interactive shell, so a shell
      # function is resolvable here (unlike a direct tmux exec).
      env_prefix=""
      launcher=""
      if [[ -n "$claude_account" ]]; then
        acc_dir=$(awk  -F'\t' -v n="$claude_account" '$1==n{print $2}' <<< "$ACCOUNTS_TSV") || true
        launcher=$(awk -F'\t' -v n="$claude_account" '$1==n{print $3}' <<< "$ACCOUNTS_TSV") || true
        [[ -n "$acc_dir" && -z "$launcher" ]] && env_prefix="CLAUDE_CONFIG_DIR=$acc_dir "
      fi
      launch_cmd="${launcher:-claude}"
      if [[ -n "$claude_mode" && "$claude_mode" != "default" ]]; then
        cmd_str="${env_prefix}${launch_cmd} --permission-mode $claude_mode --resume $claude_sid"
      else
        cmd_str="${env_prefix}${launch_cmd} --resume $claude_sid"
      fi
      # Non-fatal: pane may not exist if layout differed or split-window was skipped.
      if ! run "tmux send-keys -t $(printf %q "$target_win.$p_idx") $(printf %q "$cmd_str") Enter" 2>/dev/null; then
        echo "  warn: send-keys failed for $target_win.$p_idx (claude not auto-launched there)" >&2
      fi
    done
  done
}

# Track outcomes.
OK=()
SKIP=()
FAIL=()
only_matched=0

sess_count=$(jq '.sessions | length' "$SNAP")
for ((si=0; si<sess_count; si++)); do
  sname=$(jq -r ".sessions[$si].name" "$SNAP")

  if [[ -n "$ONLY" && "$sname" != "$ONLY" ]]; then
    continue
  fi
  only_matched=1

  if grep -qxF "$sname" <<<"$existing_sessions"; then
    if [[ "$FORCE" -eq 1 ]]; then
      echo "killing existing session: $sname"
      run "tmux kill-session -t $(printf %q "$sname")" 2>/dev/null || true
    else
      SKIP+=("$sname (already exists; use --force to replace)")
      continue
    fi
  fi

  errfile=$(mktemp)
  if restore_one_session "$si" "$sname" 2>"$errfile"; then
    OK+=("$sname")
    # Surface any warnings even on success.
    if [[ -s "$errfile" ]]; then
      cat "$errfile" >&2
    fi
  else
    err_msg=$(head -3 "$errfile" 2>/dev/null | tr '\n' '|' | sed 's/|$//')
    [[ -z "$err_msg" ]] && err_msg="(no error output)"
    FAIL+=("$sname: $err_msg")
    # Best-effort cleanup of partially-built session so the user can retry cleanly.
    if [[ "$DRY_RUN" -eq 0 ]]; then
      tmux kill-session -t "$sname" 2>/dev/null || true
    fi
  fi
  rm -f "$errfile"
done

# A --only that matched no session in the snapshot is a hard error, not a no-op:
# the caller asked to restore a specific session that simply isn't in this file
# (e.g. it rolled out of latest.json). Failing loudly prevents this from looking
# like success. See the source-snapshot fix in the Tmux Map restore path.
if [[ -n "$ONLY" && "$only_matched" -eq 0 ]]; then
  echo "ERROR: session \"$ONLY\" not found in snapshot: $SNAP" >&2
  available=$(jq -r '.sessions[].name' "$SNAP" 2>/dev/null | paste -sd, -)
  echo "  available in this snapshot: ${available:-<none>}" >&2
  exit 2
fi

echo
echo "=== restore summary ==="
echo "restored: ${#OK[@]}"
if (( ${#OK[@]} > 0 )); then
  for s in "${OK[@]}"; do echo "  + $s"; done
fi
echo "skipped:  ${#SKIP[@]}"
if (( ${#SKIP[@]} > 0 )); then
  for s in "${SKIP[@]}"; do echo "  ~ $s"; done
fi
echo "failed:   ${#FAIL[@]}"
if (( ${#FAIL[@]} > 0 )); then
  for s in "${FAIL[@]}"; do echo "  ! $s"; done
fi
[[ "$DRY_RUN" -eq 1 ]] && echo "(dry-run — nothing actually changed)"

# Exit non-zero only if every attempted session failed.
if (( ${#OK[@]} == 0 && ${#FAIL[@]} > 0 )); then
  exit 1
fi
exit 0
