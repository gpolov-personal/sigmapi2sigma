import fs from "node:fs/promises";
import { accountForConfigDir } from "./accounts.js";

async function findClaudePid(root: number): Promise<number | null> {
  const queue: number[] = [root];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    let comm = "";
    try { comm = (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim(); } catch { continue; }
    if (comm === "claude") return pid;
    try {
      const kids = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
      for (const k of kids.split(/\s+/).filter(Boolean)) queue.push(Number(k));
    } catch { /* no children file */ }
  }
  return null;
}

// Account name of the claude process running under a pane's root pid, via /proc environ.
// null when no claude process, no CLAUDE_CONFIG_DIR match, or /proc is unreadable.
export async function accountForPanePid(panePid: number): Promise<string | null> {
  const cpid = await findClaudePid(panePid);
  if (cpid === null) return null;
  let environ: string;
  try { environ = await fs.readFile(`/proc/${cpid}/environ`, "utf8"); } catch { return null; }
  const m = environ.split("\0").find(kv => kv.startsWith("CLAUDE_CONFIG_DIR="));
  const dir = m ? m.slice("CLAUDE_CONFIG_DIR=".length) : `${process.env.HOME}/.claude`;
  return accountForConfigDir(dir);
}
