import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { encodeCwd } from "./pathEncoding.js";
import { loadAccounts } from "./accounts.js";
import { accountForPanePid } from "./procEnviron.js";
import { readSessionMeta } from "./jsonl.js";
import { readPaneBindings } from "./paneBindings.js";
import type { PaneBinding } from "./paneBindings.js";

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
  /**
   * How claudeSessionId was determined:
   *  - "binding" — authoritative, from the SessionStart hook (per-pane)
   *  - "mtime"   — a GUESS: newest .jsonl in the project dir. Identical for every pane
   *                in that dir, so it cannot distinguish two conversations. UI must
   *                surface this rather than presenting it as fact.
   */
  claudeSessionSource: "binding" | "mtime" | null;
  /** Name set with Claude Code's /rename, for the conversation in this pane. */
  claudeCustomTitle: string | null;
  /** Claude Code's auto-generated topic title for that conversation. */
  claudeAiTitle: string | null;
  /** Authoritative account (from /proc environ) of the running claude, or null. */
  claudeAccount: string | null;
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

/**
 * Which conversation is this pane running?
 *
 * Prefers the SessionStart hook's binding, which is per-pane and re-fires on /clear.
 * Falls back to newest-mtime, which returns the SAME answer for every pane in a
 * project dir — fine with one conversation per directory, wrong the moment there are
 * two. The fallback is reported as "mtime" so callers can mark it as a guess rather
 * than pass it off as fact.
 */
async function resolveClaudeSessionId(
  cwd: string,
  cmd: string,
  account: string | null,
  paneId: string,
  bindings: Map<string, PaneBinding>,
): Promise<{ id: string | null; source: "binding" | "mtime" | null }> {
  if (cmd !== "claude") return { id: null, source: null };
  if (!account) return { id: null, source: null };
  const acc = loadAccounts().find(a => a.name === account);
  if (!acc) return { id: null, source: null };

  const bound = bindings.get(paneId);
  if (bound && bound.sessionId) {
    // Guard against a binding from a different account, and against a conversation
    // that has since been deleted — either way fall through to the guess.
    const sameAccount = !bound.configDir || path.resolve(bound.configDir) === acc.configDir;
    if (sameAccount) {
      const file = path.join(acc.projectsDir, encodeCwd(cwd), `${bound.sessionId}.jsonl`);
      try {
        if ((await fs.stat(file)).isFile()) return { id: bound.sessionId, source: "binding" };
      } catch { /* transcript gone — fall back */ }
    }
  }
  const proj = path.join(acc.projectsDir, encodeCwd(cwd));
  let entries;
  try { entries = await fs.readdir(proj); } catch { return { id: null, source: null }; }
  const files: { name: string; mtime: number }[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const s = await fs.stat(path.join(proj, f));
      if (s.isFile()) files.push({ name: f, mtime: s.mtimeMs });
    } catch { /* skip */ }
  }
  if (!files.length) return { id: null, source: null };
  files.sort((a, b) => b.mtime - a.mtime);
  return { id: files[0].name.replace(/\.jsonl$/, ""), source: "mtime" };
}

export async function buildTmuxTree(): Promise<TmuxSession[]> {
  if (!(await isTmuxRunning())) return [];
  const sessNames = (await tmux(["list-sessions", "-F", "#{session_name}"])).trim().split("\n").filter(Boolean);
  const sessions: TmuxSession[] = [];
  // Read once for the whole tree rather than per pane.
  const bindings = await readPaneBindings();
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
        const claudeAccount = pcmd === "claude" ? await accountForPanePid(Number(ppid)) : null;
        const resolved = await resolveClaudeSessionId(pcwd, pcmd, claudeAccount, pid_, bindings);
        const claudeSessionId = resolved.id;
        let claudeLastCwd: string | null = null;
        let claudePermissionMode: string | null = null;
        let claudeCustomTitle: string | null = null;
        let claudeAiTitle: string | null = null;
        if (claudeSessionId) {
          const acc = loadAccounts().find(a => a.name === claudeAccount);
          if (acc) {
            const meta = await readSessionMeta(path.join(acc.projectsDir, encodeCwd(pcwd), `${claudeSessionId}.jsonl`));
            claudeLastCwd = meta?.lastCwd ?? null;
            claudePermissionMode = meta?.permissionMode ?? null;
            claudeCustomTitle = meta?.customTitle ?? null;
            claudeAiTitle = meta?.aiTitle ?? null;
          }
        }
        panes.push({
          index: Number(pidx),
          paneId: pid_,
          pid: Number(ppid),
          cmd: pcmd,
          cwd: pcwd,
          claudeLastCwd,
          claudeSessionId,
          claudeSessionSource: resolved.source,
          claudeCustomTitle,
          claudeAiTitle,
          claudeAccount,
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
