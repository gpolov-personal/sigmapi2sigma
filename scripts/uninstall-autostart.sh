#!/usr/bin/env bash
# Remove what install-autostart.sh created. Safe to run when nothing is installed.
set -euo pipefail

. "$(dirname "$0")/lib/autostart-paths.sh"

rm -f "$SHORTCUT"
rm -rf "$FRAGMENT_DIR"

echo "Removed the Startup shortcut and the Windows Terminal profile."
