import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { buildTmuxTree, isTmuxRunning } from "../lib/tmux.js";
import type { TmuxSession } from "../lib/tmux.js";
import { DATA_DIR } from "../lib/pathEncoding.js";
import { readSavedTmux, pinSession, forgetSession } from "../lib/savedTmux.js";

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
