import os from "node:os";

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * Other paths are returned unchanged. Does NOT handle `~user/...` —
 * POSIX user-tilde expansion is out of scope and rarely useful here.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return os.homedir() + p.slice(1);
  return p;
}
