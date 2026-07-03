# Shared account-config helpers. Source this: . "$(dirname "$0")/lib/accounts.sh"
# Requires: jq.

# Emit validated accounts as "name<TAB>configDir" lines. Fatal (return 1) on bad config.
sp2s_load_accounts() {
  local cfg="$HOME/.sigmapi2sigma/accounts.json"
  if [[ ! -f "$cfg" ]]; then
    printf 'default\t%s\n' "$HOME/.claude"
    return 0
  fi
  local json
  json=$(cat "$cfg") || { echo "accounts.sh: cannot read $cfg" >&2; return 1; }
  echo "$json" | jq -e '.accounts | type=="array" and length>0' >/dev/null 2>&1 \
    || { echo "accounts.sh: $cfg has no non-empty 'accounts' array" >&2; return 1; }
  local names="" name pth
  while IFS=$'\t' read -r name pth; do
    pth="${pth/#\~/$HOME}"
    [[ -d "$pth" ]] || { echo "accounts.sh: account '$name' path does not exist: $pth" >&2; return 1; }
    case " $names " in *" $name "*) echo "accounts.sh: duplicate account name '$name'" >&2; return 1;; esac
    names="$names $name"
    printf '%s\t%s\n' "$name" "$pth"
  done < <(echo "$json" | jq -r '.accounts[] | [.name, .path] | @tsv')
}

# Descend the process tree from $1 to find a process named "claude". Echoes its pid or "".
sp2s_find_claude_pid() {
  local root="$1" queue=("$1") pid c children
  while ((${#queue[@]})); do
    pid="${queue[0]}"; queue=("${queue[@]:1}")
    [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == "claude" ]] && { echo "$pid"; return 0; }
    children=$(cat "/proc/$pid/task/$pid/children" 2>/dev/null)
    for c in $children; do queue+=("$c"); done
  done
  echo ""
}

# Account name of the running claude under pane root pid $1 (via /proc environ). Echoes name or "".
sp2s_account_for_pid() {
  local root="$1" cpid ccd
  cpid=$(sp2s_find_claude_pid "$root")
  [[ -n "$cpid" ]] || { echo ""; return 0; }
  ccd=$(tr '\0' '\n' < "/proc/$cpid/environ" 2>/dev/null | sed -n 's/^CLAUDE_CONFIG_DIR=//p' | head -1)
  [[ -n "$ccd" ]] || ccd="$HOME/.claude"   # plain `claude` → default account
  # Map configDir → name.
  local name pth
  while IFS=$'\t' read -r name pth; do
    [[ "$pth" == "$ccd" ]] && { echo "$name"; return 0; }
  done < <(sp2s_load_accounts)
  echo ""
}
