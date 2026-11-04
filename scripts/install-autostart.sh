#!/usr/bin/env bash
# Open the workspace at Windows login: a Windows Terminal window with a sigmapi2sigma
# tab (the app, with its own icon) and a tmux tab (restored sessions). Idempotent.
# Writes only two things, both on the Windows side, and uninstall-autostart.sh removes both:
#   - a shortcut in the user's Startup folder
#   - a Windows Terminal fragment adding a "sigmapi2sigma" profile, so settings.json
#     is never edited (fragment icons need Windows Terminal 1.24+)
set -euo pipefail

. "$(dirname "$0")/lib/autostart-paths.sh"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
AUTOSTART="$REPO/scripts/autostart.sh"

mkdir -p "$FRAGMENT_DIR"
cp "$REPO/scripts/assets/sigmapi2sigma-icon.png" "$FRAGMENT_DIR/"
jq -n --arg cmd "wsl.exe -d $SP2S_DISTRO --exec $AUTOSTART app" \
  '{profiles: [{name: "sigmapi2sigma", tabTitle: "sp2s", suppressApplicationTitle: true,
                commandline: $cmd, icon: "sigmapi2sigma-icon.png"}]}' \
  > "$FRAGMENT_DIR/sigmapi2sigma.json"

# Tab 2 stays on the stock Ubuntu profile so it looks like any other WSL tab, and is
# opened last so it is the tab in front. Profile names are unquoted because neither
# has spaces, which avoids quoting through wsl -> powershell -> the shortcut.
wt_args="-p sigmapi2sigma ; new-tab -p $SP2S_DISTRO --title tmux wsl.exe -d $SP2S_DISTRO --exec $AUTOSTART sessions"

SP2S_WT="$WT_EXE" SP2S_LNK="$(wslpath -w "$SHORTCUT")" SP2S_ARGS="$wt_args" \
WSLENV="${WSLENV:-}:SP2S_WT:SP2S_LNK:SP2S_ARGS" powershell.exe -NoProfile -NonInteractive -Command '
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SP2S_LNK)
  $s.TargetPath = $env:SP2S_WT
  $s.Arguments = $env:SP2S_ARGS
  $s.Description = "Open sigmapi2sigma and restore the latest tmux snapshot"
  $s.Save()
'

echo "Installed. At each Windows login this opens:"
echo "  tab 1  sigmapi2sigma  npm run dev"
echo "  tab 2  tmux           latest snapshot restored"
echo
echo "Shortcut:  $SHORTCUT"
echo "Profile:   $FRAGMENT_DIR"
echo "Undo with: npm run uninstall-autostart"
