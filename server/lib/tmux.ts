import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { encodeCwd, CLAUDE_PROJECTS_DIR } from "./pathEncoding.js";
import { readSessionMeta } from "./jsonl.js";

const pexec = promisify(execFile);

export interface TmuxPane {
  index: number;
  paneId: string;
  pid: number;
  cmd: string;
  cwd: string;
  /** For claude panes: the most recent cwd tracked inside the conversation (from JSONL tail). */
  claudeLastCwd: string | null;
  claudeSessionId: string | null;
  /** e.g. "bypassPermissions" — used by restore to re-launch with the same permission mode. */
  claudePermissionMode: string | null;
}

export interface TmuxWindow {
  index: number;
  name: string;
  layout: string;
  panes: TmuxPane[];
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await pexec("tmux", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function isTmuxRunning(): Promise<boolean> {
  try {
    await pexec("tmux", ["list-sessions"]);
    return true;
  } catch {
    return false;
  }
}

async function resolveClaudeSessionId(cwd: string, cmd: string): Promise<string | null> {
  if (cmd !== "claude") return null;
  const enc = encodeCwd(cwd);
  const proj = path.join(CLAUDE_PROJECTS_DIR, enc);
  let entries;
  try { entries = await fs.readdir(proj); } catch { return null; }
  const files: { name: string; mtime: number }[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const s = await fs.stat(path.join(proj, f));
      if (s.isFile()) files.push({ name: f, mtime: s.mtimeMs });
    } catch { /* skip */ }
  }
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].name.replace(/\.jsonl$/, "");
}

export async function buildTmuxTree(): Promise<TmuxSession[]> {
  if (!(await isTmuxRunning())) return [];
  const sessNames = (await tmux(["list-sessions", "-F", "#{session_name}"])).trim().split("\n").filter(Boolean);
  const sessions: TmuxSession[] = [];
  for (const sname of sessNames) {
    const winsRaw = (await tmux([
      "list-windows", "-t", sname,
      "-F", "#{window_index}\t#{window_name}\t#{window_layout}",
    ])).trim().split("\n").filter(Boolean);
    const windows: TmuxWindow[] = [];
    for (const wline of winsRaw) {
      const [idxStr, wname, wlayout] = wline.split("\t");
      const panesRaw = (await tmux([
        "list-panes", "-t", `${sname}:${idxStr}`,
        "-F", "#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}",
      ])).trim().split("\n").filter(Boolean);
      const panes: TmuxPane[] = [];
      for (const pline of panesRaw) {
        const [pidx, pid_, ppid, pcmd, pcwd] = pline.split("\t");
        const claudeSessionId = await resolveClaudeSessionId(pcwd, pcmd);
        let claudeLastCwd: string | null = null;
        let claudePermissionMode: string | null = null;
        if (claudeSessionId) {
          const proj = path.join(CLAUDE_PROJECTS_DIR, encodeCwd(pcwd));
          const meta = await readSessionMeta(path.join(proj, `${claudeSessionId}.jsonl`));
          claudeLastCwd = meta?.lastCwd ?? null;
          claudePermissionMode = meta?.permissionMode ?? null;
        }
        panes.push({
          index: Number(pidx),
          paneId: pid_,
          pid: Number(ppid),
          cmd: pcmd,
          cwd: pcwd,
          claudeLastCwd,
          claudeSessionId,
          claudePermissionMode,
        });
      }
      windows.push({ index: Number(idxStr), name: wname, layout: wlayout, panes });
    }
    sessions.push({ name: sname, windows });
  }
  return sessions;
}

export async function capturePane(paneId: string, lines = 500): Promise<string> {
  try {
    return await tmux(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
  } catch (e: any) {
    return `(capture failed: ${e.message ?? e})`;
  }
}

export async function resumeClaudeInNewSession(sessionId: string, cwd: string, tmuxSessionName: string) {
  // Create detached tmux session at cwd, running claude --resume <id>.
  await pexec("tmux", [
    "new-session", "-d",
    "-s", tmuxSessionName,
    "-c", cwd,
    `claude --resume ${sessionId}`,
  ]);
}

// Create an empty detached tmux session. Throws if a session with that name already exists.
export async function createDetachedSession(name: string, cwd?: string): Promise<void> {
  // Probe first — `tmux new-session` is idempotent in some configs but not in others.
  try {
    await pexec("tmux", ["has-session", "-t", `=${name}`]);
    throw new Error(`tmux session "${name}" already exists`);
  } catch (e: any) {
    // has-session exits non-zero when the session does NOT exist (the desired path).
    if (e?.message?.includes("already exists")) throw e;
  }
  const args = ["new-session", "-d", "-s", name];
  if (cwd) { args.push("-c", cwd); }
  await pexec("tmux", args);
}
