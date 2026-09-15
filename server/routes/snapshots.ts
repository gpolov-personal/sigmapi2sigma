import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "../lib/pathEncoding.js";
import { expandHome } from "../lib/paths.js";
import { loadAccounts } from "../lib/accounts.js";

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

export const snapshotsRouter = Router();

snapshotsRouter.get("/snapshots", async (_req, res) => {
  const dir = path.join(DATA_DIR, "snapshots");
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return res.json({ snapshots: [] }); }
  const ordered: { name: string; step: number }[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (f === "latest.json") ordered.push({ name: f, step: 0 });
    else if (f === "prev.json") ordered.push({ name: f, step: 1 });
    else {
      const m = f.match(/^prev(\d+)\.json$/);
      if (m) ordered.push({ name: f, step: Number(m[1]) });
    }
  }
  ordered.sort((a, b) => a.step - b.step);
  const out: any[] = [];
  for (const { name } of ordered) {
    const p = path.join(dir, name);
    try {
      const stat = await fs.stat(p);
      const content = JSON.parse(await fs.readFile(p, "utf8"));
      out.push({ name, mtime: stat.mtimeMs, ts: content.ts, sessions: content.sessions });
    } catch { /* skip */ }
  }
  res.json({ snapshots: out });
});

snapshotsRouter.post("/snapshot", async (_req, res) => {
  try {
    await pexec("bash", [path.join(REPO, "scripts", "snapshot.sh")]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e.stderr ?? e.message ?? e) });
  }
});

snapshotsRouter.post("/restore", async (req, res) => {
  const { snapshot, snapshotName, dryRun, force, only } = req.body ?? {};
  const args = [path.join(REPO, "scripts", "restore.sh")];
  if (snapshotName) {
    const safe = String(snapshotName).replace(/[^a-zA-Z0-9._-]/g, "");
    args.push(path.join(DATA_DIR, "snapshots", safe));
  } else if (snapshot) {
    args.push(snapshot);
  }
  if (dryRun)  args.push("--dry-run");
  if (force)   args.push("--force");
  if (only) {
    // Reject rather than strip. The old sanitiser silently rewrote the name, so a
    // session restore.sh could never match ("my session" -> "mysession") came back as
    // a confusing "not found in snapshot" instead of naming the real problem.
    const name = String(only);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.json({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        error: `session name "${name}" contains characters this endpoint will not pass to restore.sh (allowed: letters, digits, . _ -)`,
      });
    }
    args.push("--only", name);
  }
  // Always return HTTP 200; success/failure is conveyed by `ok`. Restore.sh exit 0
  // means at least one success (or nothing to do); exit 1 means total failure.
  try {
    const { stdout, stderr } = await pexec("bash", args, { maxBuffer: 4 * 1024 * 1024 });
    res.json({ ok: true, exitCode: 0, stdout, stderr });
  } catch (e: any) {
    res.json({
      ok: false,
      exitCode: e.code ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      error: String(e.message ?? e),
    });
  }
});

const VALID_PERM_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);

/** True when a tmux session of exactly this name is running. `=` forces an exact
 *  match; without it "free" would also match "freedom". */
async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await pexec("tmux", ["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;   // no server running, or no such session
  }
}

snapshotsRouter.post("/resume", async (req, res) => {
  const { sessionId, cwd, tmuxSessionName, permissionMode, account, windowName } = req.body ?? {};
  if (!sessionId || !cwd || !tmuxSessionName) {
    return res.status(400).json({ ok: false, error: "sessionId, cwd, tmuxSessionName required" });
  }
  // sessionId lands inside a command string typed into a live shell, so it must be
  // a bare UUID — never trust the request body with shell metacharacters.
  if (!/^[0-9a-fA-F-]{36}$/.test(String(sessionId))) {
    return res.status(400).json({ ok: false, error: "sessionId must be a UUID" });
  }
  // The name is interpolated into a tmux target ("=free:3"), where ':' and '.' are
  // the separators. tmux forbids them in session names for the same reason.
  const sessName = String(tmuxSessionName);
  if (/[\s.:]/.test(sessName) || sessName.length > 100) {
    return res.status(400).json({
      ok: false,
      error: "tmux session name cannot contain spaces, '.' or ':' (max 100 chars)",
    });
  }
  const safeMode = permissionMode && VALID_PERM_MODES.has(permissionMode) && permissionMode !== "default"
    ? permissionMode : null;
  const acc = account ? loadAccounts().find(a => a.name === account) : null;
  // Prefer the account's launcher (claudep/claudew) so the pane reads like a
  // hand-launched one. A launcher is a shell function, so it only resolves inside an
  // interactive shell — hence new-session + send-keys rather than a direct tmux exec.
  const envPrefix = acc && !acc.launcher ? `CLAUDE_CONFIG_DIR=${JSON.stringify(acc.configDir)} ` : "";
  const launchCmd = acc?.launcher ?? "claude";
  const claudeCmd = safeMode
    ? `${envPrefix}${launchCmd} --permission-mode ${safeMode} --resume ${sessionId}`
    : `${envPrefix}${launchCmd} --resume ${sessionId}`;
  // A window name keeps a restored pane identifiable in the status bar; tmux also
  // stops auto-renaming a window once it has an explicit name, so it survives the
  // claude process starting. Anything tmux cannot render on one line is dropped.
  const winName = typeof windowName === "string"
    ? windowName.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 40)
    : "";
  const nameArgs = winName ? ["-n", winName] : [];
  try {
    // Reuse an existing session by appending a window rather than failing on
    // "duplicate session": several conversations legitimately belong to one tmux
    // session. -P -F prints the new window's index, and send-keys MUST target that
    // index — targeting "<session>:" would type the resume command into whichever
    // window is currently active, on top of whatever is running there.
    const exists = await tmuxSessionExists(sessName);
    const { stdout } = exists
      ? await pexec("tmux", [
          "new-window", "-d", "-t", `=${sessName}:`, "-c", expandHome(cwd),
          ...nameArgs, "-P", "-F", "#{window_index}",
        ])
      : await pexec("tmux", [
          "new-session", "-d", "-s", sessName, "-c", expandHome(cwd),
          ...nameArgs, "-P", "-F", "#{window_index}",
        ]);
    const windowIndex = stdout.trim();
    if (!/^\d+$/.test(windowIndex)) {
      throw new Error(`tmux did not report a window index (got ${JSON.stringify(stdout)})`);
    }
    await pexec("tmux", ["send-keys", "-t", `=${sessName}:${windowIndex}`, claudeCmd, "Enter"]);
    res.json({
      ok: true,
      tmuxSessionName: sessName,
      windowIndex: Number(windowIndex),
      createdSession: !exists,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e.stderr ?? e.message ?? e) });
  }
});
