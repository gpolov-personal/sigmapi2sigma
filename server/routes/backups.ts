import { Router } from "express";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "../lib/pathEncoding.js";

export const backupsRouter = Router();

const pexec = promisify(execFile);

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const CONFIG_FILE = path.join(DATA_DIR, "backup-config");

// Resolve script paths relative to the server source dir, walking up to repo root.
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
const BACKUP_SH = path.join(REPO_ROOT, "scripts", "backup.sh");
const RESTORE_SH = path.join(REPO_ROOT, "scripts", "restore-backup.sh");

interface BackupFile {
  filename: string;
  ts: string;             // parsed from filename, ISO
  sizeBytes: number;
  mtime: number;
}

function parseFilename(name: string): string | null {
  // Accept both HHMM (legacy) and HHMMSS (current) forms.
  const m = /^sigmapi2sigma-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})?\.tar\.gz$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0).toISOString();
}

async function listBackups(): Promise<BackupFile[]> {
  let entries: string[];
  try { entries = await fs.readdir(BACKUP_DIR); }
  catch { return []; }
  const out: BackupFile[] = [];
  for (const f of entries) {
    if (!f.endsWith(".tar.gz")) continue;
    const ts = parseFilename(f);
    if (!ts) continue;
    try {
      const st = await fs.stat(path.join(BACKUP_DIR, f));
      out.push({ filename: f, ts, sizeBytes: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime);  // newest first
  return out;
}

async function readConfig(): Promise<{ backupRemote: string | null; rcloneInstalled: boolean }> {
  let backupRemote: string | null = null;
  try {
    const txt = await fs.readFile(CONFIG_FILE, "utf8");
    const m = /^\s*BACKUP_REMOTE\s*=\s*(.+?)\s*$/m.exec(txt);
    if (m) backupRemote = m[1].replace(/^['"]|['"]$/g, "");
  } catch {}
  // Check rclone install.
  let rcloneInstalled = false;
  try { await pexec("rclone", ["version"]); rcloneInstalled = true; } catch {}
  return { backupRemote, rcloneInstalled };
}

backupsRouter.get("/backups", async (_req, res) => {
  const [backups, config] = await Promise.all([listBackups(), readConfig()]);
  const totalBytes = backups.reduce((s, b) => s + b.sizeBytes, 0);
  res.json({
    backups,
    count: backups.length,
    totalBytes,
    backupRemote: config.backupRemote,
    rcloneInstalled: config.rcloneInstalled,
    scriptPath: BACKUP_SH,
    backupDir: BACKUP_DIR,
  });
});

backupsRouter.post("/backups/now", async (_req, res) => {
  if (!existsSync(BACKUP_SH)) {
    return res.status(500).json({ error: `backup.sh not found at ${BACKUP_SH}` });
  }
  try {
    // Manual "Backup now" always forces a fresh bundle even if no source changed.
    const { stdout, stderr } = await pexec("bash", [BACKUP_SH, "--force"], { maxBuffer: 4 * 1024 * 1024 });
    res.json({ ok: true, stdout, stderr });
  } catch (e: any) {
    res.json({ ok: false, exitCode: e?.code ?? null, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e) });
  }
});

backupsRouter.post("/backups/:filename/restore", async (req, res) => {
  const filename = req.params.filename;
  if (!/^sigmapi2sigma-\d{4}-\d{2}-\d{2}-\d{4,6}\.tar\.gz$/.test(filename)) {
    return res.status(400).json({ error: "invalid backup filename" });
  }
  const full = path.join(BACKUP_DIR, filename);
  if (!existsSync(full)) {
    return res.status(404).json({ error: "backup not found" });
  }
  if (!existsSync(RESTORE_SH)) {
    return res.status(500).json({ error: `restore-backup.sh not found at ${RESTORE_SH}` });
  }
  try {
    const { stdout, stderr } = await pexec("bash", [RESTORE_SH, full], { maxBuffer: 4 * 1024 * 1024 });
    res.json({ ok: true, stdout, stderr });
  } catch (e: any) {
    res.json({ ok: false, exitCode: e?.code ?? null, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e) });
  }
});

backupsRouter.get("/backups/config", async (_req, res) => {
  const c = await readConfig();
  res.json(c);
});

backupsRouter.put("/backups/config", async (req, res) => {
  const body = req.body ?? {};
  const remote: unknown = body.backupRemote;
  if (remote !== null && (typeof remote !== "string" || remote.length > 200)) {
    return res.status(400).json({ error: "backupRemote must be string ≤200 chars or null" });
  }
  // Light sanity check: rclone remote names look like "name:" or "name:path".
  if (typeof remote === "string" && remote.length > 0 && !/^[A-Za-z0-9_-]+:/.test(remote)) {
    return res.status(400).json({ error: "backupRemote should look like 'remote:' or 'remote:path' (rclone format)" });
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (remote === null || remote === "") {
    // Wipe the line (write empty file or delete it).
    try { await fs.unlink(CONFIG_FILE); } catch {}
  } else {
    const content = `BACKUP_REMOTE=${remote}\n`;
    await fs.writeFile(CONFIG_FILE, content, "utf8");
  }
  const c = await readConfig();
  res.json(c);
});
