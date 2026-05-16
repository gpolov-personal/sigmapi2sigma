import { Router } from "express";
import { listAllSessionFiles, readSessionMeta, readSessionDetail } from "../lib/jsonl.js";
import { getLastLocationsBySessionId } from "../lib/tmuxBindings.js";

export const sessionsRouter = Router();

sessionsRouter.get("/sessions", async (req, res) => {
  const hours = Number(req.query.hours ?? 24);
  const useWindow = Number.isFinite(hours) && hours > 0;

  const files = await listAllSessionFiles();
  const allMetas = (await Promise.all(files.map(readSessionMeta)))
    .filter((m): m is NonNullable<typeof m> => !!m);

  // Anchor = max(mtime) across ALL sessions, regardless of the window filter.
  // The window is then [anchor - hours*3600*1000, anchor].
  const anchorMs = allMetas.length > 0
    ? Math.max(...allMetas.map(m => m.mtime))
    : null;
  const anchorIso = anchorMs !== null ? new Date(anchorMs).toISOString() : null;

  const cutoff = useWindow && anchorMs !== null
    ? anchorMs - hours * 3600 * 1000
    : 0;

  const metas = allMetas
    .filter(m => m.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime);

  const ids = new Set(metas.map(m => m.id));
  const locations = await getLastLocationsBySessionId(ids);
  const enriched = metas.map(m => {
    const loc = locations.get(m.id);
    return { ...m, lastTmuxLocation: loc ? {
      tmuxSession: loc.tmuxSession,
      windowIndex: loc.windowIndex,
      paneIndex: loc.paneIndex,
      ts: loc.ts,
    } : null };
  });

  res.json({
    sessions: enriched,
    anchor: useWindow ? anchorIso : null,
  });
});

sessionsRouter.get("/sessions/:id", async (req, res) => {
  const files = await listAllSessionFiles();
  const match = files.find(f => f.endsWith(`/${req.params.id}.jsonl`));
  if (!match) return res.status(404).json({ error: "not found" });
  const meta = await readSessionMeta(match);
  const detail = await readSessionDetail(match);
  res.json({ meta, detail });
});
