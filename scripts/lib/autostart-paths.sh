# Windows-side locations shared by install-autostart.sh and uninstall-autostart.sh.
# Sourced, not run. Asks Windows rather than assuming, since Startup can be redirected.

if [[ -z "${WSL_DISTRO_NAME:-}" ]] || ! command -v powershell.exe >/dev/null 2>&1; then
  echo "autostart needs WSL with Windows interop working (try: whoami.exe)" >&2
  exit 1
fi

SP2S_DISTRO="$WSL_DISTRO_NAME"

# Run from a Windows path: PowerShell warns about a UNC working directory otherwise.
win_paths=$(cd /mnt/c && powershell.exe -NoProfile -NonInteractive -Command \
  "[Environment]::GetFolderPath('Startup'); [Environment]::GetFolderPath('LocalApplicationData')" | tr -d '\r')
STARTUP_DIR=$(wslpath -u "$(sed -n 1p <<<"$win_paths")")
LOCAL_APPDATA_WIN=$(sed -n 2p <<<"$win_paths")
LOCAL_APPDATA=$(wslpath -u "$LOCAL_APPDATA_WIN")

SHORTCUT="$STARTUP_DIR/sigmapi2sigma.lnk"
FRAGMENT_DIR="$LOCAL_APPDATA/Microsoft/Windows Terminal/Fragments/sigmapi2sigma"
WT_EXE="$LOCAL_APPDATA_WIN\\Microsoft\\WindowsApps\\wt.exe"
