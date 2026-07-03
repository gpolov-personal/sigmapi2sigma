// Claude Code encodes a cwd into a flat project-dir name by replacing
// path-ish characters with "-". Mirrors the logic in our bash scripts.
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, "-");
}

import os from "node:os";
import path from "node:path";

export const DATA_DIR = path.join(os.homedir(), ".sigmapi2sigma");
