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
    const safe = String(only).replace(/[^a-zA-Z0-9._-]/g, "");
    if (safe) args.push("--only", safe);
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

snapshotsRouter.post("/resume", async (req, res) => {
  const { sessionId, cwd, tmuxSessionName, permissionMode, account } = req.body ?? {};
  if (!sessionId || !cwd || !tmuxSessionName) {
    return res.status(400).json({ ok: false, error: "sessionId, cwd, tmuxSessionName required" });
  }
  const safeMode = permissionMode && VALID_PERM_MODES.has(permissionMode) && permissionMode !== "default"
    ? permissionMode : null;
  const acc = account ? loadAccounts().find(a => a.name === account) : null;
  const envPrefix = acc ? `CLAUDE_CONFIG_DIR=${JSON.stringify(acc.configDir)} ` : "";
  const claudeCmd = safeMode
    ? `${envPrefix}claude --permission-mode ${safeMode} --resume ${sessionId}`
    : `${envPrefix}claude --resume ${sessionId}`;
  try {
    await pexec("tmux", [
      "new-session", "-d", "-s", tmuxSessionName, "-c", expandHome(cwd),
      claudeCmd,
    ]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e.stderr ?? e.message ?? e) });
  }
});
