#!/usr/bin/env bash
# Remove the shell-hook block from ~/.zshrc.
set -euo pipefail

RC="${ZDOTDIR:-$HOME}/.zshrc"
MARKER_BEGIN="# BEGIN sigmapi2sigma shell-hook"
MARKER_END="# END sigmapi2sigma shell-hook"

[[ -f "$RC" ]] || { echo "No $RC found."; exit 0; }
if ! grep -qF "$MARKER_BEGIN" "$RC"; then
  echo "Hook not present in $RC."
  exit 0
fi

tmp=$(mktemp)
awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
  $0==b {inblock=1; next}
  $0==e {inblock=0; next}
  !inblock {print}
' "$RC" > "$tmp"
mv "$tmp" "$RC"

echo "Hook removed from $RC."
