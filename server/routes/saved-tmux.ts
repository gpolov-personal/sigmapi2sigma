import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildTmuxTree, isTmuxRunning } from "../lib/tmux.js";
import type { TmuxSession } from "../lib/tmux.js";
import { DATA_DIR } from "../lib/pathEncoding.js";
import { readSavedTmux, pinSession, forgetSession } from "../lib/savedTmux.js";

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

export const savedTmuxRouter = Router();

interface SnapshotFile { ts: string; sessions: TmuxSession[]; }

async function findSessionByName(name: string): Promise<{ session: TmuxSession; lastSeenAt: string } | null> {
  // 1. Live tree.
  if (await isTmuxRunning()) {
    const tree = await buildTmuxTree();
    const hit = tree.find(s => s.name === name);
    if (hit) return { session: hit, lastSeenAt: new Date().toISOString() };
  }
  // 2. Snapshots, newest-first.
  const dir = path.join(DATA_DIR, "snapshots");
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return null; }
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
  for (const { name: file } of ordered) {
    try {
      const txt = await fs.readFile(path.join(dir, file), "utf8");
      const parsed = JSON.parse(txt) as SnapshotFile;
      const hit = parsed.sessions?.find(s => s.name === name);
      if (hit) return { session: hit, lastSeenAt: parsed.ts };
    } catch { /* skip */ }
  }
  return null;
}

savedTmuxRouter.get("/saved-tmux", async (_req, res) => {
  const file = await readSavedTmux();
  res.json(file);
});

savedTmuxRouter.post("/saved-tmux/pin", async (req, res) => {
  const body = req.body ?? {};
  const name: unknown = body.sessionName;
  if (typeof name !== "string" || name.length < 1 || name.length > 100) {
    return res.status(400).json({ error: "sessionName must be a string 1-100 chars" });
  }
  const found = await findSessionByName(name);
  if (!found) {
    return res.status(404).json({ error: `tmux session "${name}" not found in live tree or any snapshot` });
  }
  const file = await pinSession(found.session, found.lastSeenAt);
  res.json({ ok: true, file });
});

savedTmuxRouter.delete("/saved-tmux/:name", async (req, res) => {
  const ok = await forgetSession(req.params.name);
  if (!ok) return res.status(404).json({ error: `no saved session "${req.params.name}"` });
  res.json({ ok: true });
});

savedTmuxRouter.post("/saved-tmux/:name/restore", async (req, res) => {
  const name = req.params.name;
  const force = !!(req.body ?? {}).force;
  // Verify the session is actually in the saved file before invoking restore.sh
  // (better error than letting the script silently no-op via --only mismatch).
  const file = await (await import("../lib/savedTmux.js")).readSavedTmux();
  if (!file.sessions.some(s => s.name === name)) {
    return res.status(404).json({ ok: false, error: `no saved session "${name}"` });
  }
  const args = [
    path.join(REPO, "scripts", "restore.sh"),
    path.join(DATA_DIR, "saved-tmux.json"),
    "--only", name,
  ];
  if (force) args.push("--force");
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
