#!/usr/bin/env bash
# Register (or with -Uninstall, remove) the "WSL at boot" scheduled task through
# boot-task.ps1, in an elevated PowerShell window (UAC prompt). With -DryRun it
# only prints what it would register, in this terminal. See docs/remote-access.md.
set -euo pipefail

if [[ -z "${WSL_DISTRO_NAME:-}" ]] || ! command -v powershell.exe >/dev/null 2>&1; then
  echo "the boot task needs WSL with Windows interop working (try: whoami.exe)" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PS1_WIN="$(wslpath -w "$REPO/scripts/boot-task.ps1")"
SCRIPT="$REPO/scripts/autostart.sh"

# Run from a Windows path: PowerShell warns about a UNC working directory otherwise.
cd /mnt/c
if [[ " $* " == *" -DryRun "* ]]; then
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1_WIN" \
    -Distro "$WSL_DISTRO_NAME" -Script "$SCRIPT" -DryRun | tr -d '\r'
  exit "${PIPESTATUS[0]}"
fi

# Start-Process takes the elevated window's command line as one string, passed in
# through the environment so no layer of quoting touches the \\wsl.localhost path.
# shellcheck disable=SC2016  # $env:SP2S_ARGS is for PowerShell, not bash
SP2S_ARGS="-NoProfile -ExecutionPolicy Bypass -File \"$PS1_WIN\" -Distro $WSL_DISTRO_NAME -Script \"$SCRIPT\" -Pause $*" \
WSLENV="${WSLENV:-}:SP2S_ARGS" powershell.exe -NoProfile -NonInteractive \
  -Command 'Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList $env:SP2S_ARGS'
echo "Done. Check the result in the admin window that opened; details in docs/remote-access.md."
