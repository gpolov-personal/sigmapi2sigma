import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { encodeCwd } from "./pathEncoding.js";
import { loadAccounts } from "./accounts.js";
import { accountForPanePid } from "./procEnviron.js";
import { readSessionMeta, listDedupedSessions } from "./jsonl.js";
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
  /** True only when no transcript file for this conversation exists under any
   *  configured account — almost always Claude Code's retention having pruned it.
   *  A transcript that exists but could not be read does NOT set this: it may
   *  simply not have been written yet. */
  claudeTranscriptMissing: boolean;
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

/** Fill in conversation names for claude panes that don't have one yet.
 *  buildTmuxTree resolves titles only for *live* panes, and only when the pane's
 *  account could be read from /proc. Everything else arrives without them: panes
 *  read back from a snapshot or from saved-tmux.json (serialised before names
 *  were tracked, or by an older version), and live panes whose account lookup
 *  failed. Resolving the session id against every account's project dirs covers
 *  all of those, whatever cwd or account the conversation was launched under.
 *
 *  Mutates in place — callers pass trees freshly parsed from disk. Skips the
 *  directory scan entirely when every pane already has a title, which is the
 *  common live case; a conversation that genuinely has no name is re-resolved on
 *  every call, since there is nothing to cache it under. That scan is the same
 *  one /api/sessions already performs per poll.
 *
 *  Never throws: these are polled endpoints, and Express 4 does not catch async
 *  rejections, so a transient fs error must degrade to "no names" rather than
 *  take the server down. */
export async function attachConversationTitles(sessions: TmuxSession[]): Promise<void> {
  const pending: TmuxPane[] = [];
  const ids = new Set<string>();
  for (const s of sessions ?? []) {
    for (const w of s?.windows ?? []) {
      for (const p of w?.panes ?? []) {
        if (!p.claudeSessionId || p.claudeCustomTitle || p.claudeAiTitle) continue;
        pending.push(p);
        ids.add(p.claudeSessionId);
      }
    }
  }
  if (ids.size === 0) return;

  const titles = new Map<string, { customTitle: string | null; aiTitle: string | null }>();
  const missing = new Set<string>();
  try {
    const pathById = new Map((await listDedupedSessions()).map(d => [d.id, d.path]));
    for (const id of ids) {
      const jsonlPath = pathById.get(id);
      // No transcript under any configured account: pruned by Claude Code's
      // retention, or deleted. There is no name to recover, now or later.
      if (!jsonlPath) { missing.add(id); continue; }
      // A transcript that exists but reads back empty is left unflagged — it may
      // be a pane that just launched and has not written its first entry yet.
      try {
        const meta = await readSessionMeta(jsonlPath);
        if (meta) titles.set(id, { customTitle: meta.customTitle, aiTitle: meta.aiTitle });
      } catch { /* unreadable right now; try again next poll */ }
    }
  } catch { return; }
  for (const p of pending) {
    const id = p.claudeSessionId!;
    if (missing.has(id)) { p.claudeTranscriptMissing = true; continue; }
    const t = titles.get(id);
    if (!t) continue;
    p.claudeCustomTitle = t.customTitle;
    p.claudeAiTitle = t.aiTitle;
  }
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
          claudeTranscriptMissing: false,
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
