import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../lib/pathEncoding.js";

export const shellHistoryRouter = Router();

shellHistoryRouter.get("/shell-history", async (req, res) => {
  const days = Math.max(1, Math.min(60, Number(req.query.days ?? 7)));
  const tmuxPane = (req.query.tmuxPane as string) || null;
  const tmuxSession = (req.query.tmuxSession as string) || null;
  const cwdContains = (req.query.cwdContains as string) || null;
  const cmdContains = (req.query.cmdContains as string) || null;

  const dir = path.join(DATA_DIR, "shell-history");
  let files: string[];
  try { files = (await fs.readdir(dir)).filter(f => f.endsWith(".jsonl")); }
  catch { return res.json({ entries: [], installed: false }); }

  files.sort();
  const cutoff = Date.now() - days * 86400 * 1000;
  const recent = files.slice(-days);

  const entries: any[] = [];
  for (const f of recent) {
    let text;
    try { text = await fs.readFile(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (tmuxPane && j.tmuxPane !== tmuxPane) continue;
      if (tmuxSession && j.tmuxSession !== tmuxSession) continue;
      if (cwdContains && !String(j.cwd ?? "").includes(cwdContains)) continue;
      if (cmdContains && !String(j.cmd ?? "").includes(cmdContains)) continue;
      const ts = Date.parse(j.ts ?? "");
      if (Number.isFinite(ts) && ts < cutoff) continue;
      entries.push(j);
    }
  }

  entries.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  res.json({ entries, installed: true, fileCount: recent.length });
});
