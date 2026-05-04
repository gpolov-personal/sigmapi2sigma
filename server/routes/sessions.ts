import { Router } from "express";
import { listAllSessionFiles, readSessionMeta, readSessionDetail } from "../lib/jsonl.js";

export const sessionsRouter = Router();

sessionsRouter.get("/sessions", async (req, res) => {
  const hours = Number(req.query.hours ?? 24);
  const cutoff = Number.isFinite(hours) && hours > 0
    ? Date.now() - hours * 3600 * 1000
    : 0;

  const files = await listAllSessionFiles();
  const metas = (await Promise.all(files.map(readSessionMeta)))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .filter(m => m.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);

  res.json({ sessions: metas });
});

sessionsRouter.get("/sessions/:id", async (req, res) => {
  const files = await listAllSessionFiles();
  const match = files.find(f => f.endsWith(`/${req.params.id}.jsonl`));
  if (!match) return res.status(404).json({ error: "not found" });
  const meta = await readSessionMeta(match);
  const detail = await readSessionDetail(match);
  res.json({ meta, detail });
});
