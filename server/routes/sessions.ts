import { Router } from "express";
import { listAllSessionFiles, listDedupedSessions, readSessionMeta, readSessionDetail } from "../lib/jsonl.js";
import { getLastLocationsBySessionId } from "../lib/tmuxBindings.js";

export const sessionsRouter = Router();

sessionsRouter.get("/sessions", async (req, res) => {
  const hours = Number(req.query.hours ?? 24);
  const useWindow = Number.isFinite(hours) && hours > 0;

  const deduped = await listDedupedSessions();
  const allMetas = (await Promise.all(deduped.map(async d => {
    const m = await readSessionMeta(d.path);
    return m ? { ...m, accounts: d.accounts } : null;
  }))).filter((m): m is NonNullable<typeof m> => !!m);

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
  const matches = files.filter(f => f.path.endsWith(`/${req.params.id}.jsonl`));
  if (matches.length === 0) return res.status(404).json({ error: "not found" });
  // Newest copy across accounts is the representative.
  let best = matches[0]; let bestM = 0;
  for (const m of matches) {
    let mt = 0; try { mt = (await (await import("node:fs/promises")).stat(m.path)).mtimeMs; } catch {}
    if (mt >= bestM) { bestM = mt; best = m; }
  }
  const accounts = [...new Set(matches.map(m => m.account))].sort();
  const meta = await readSessionMeta(best.path);
  const detail = await readSessionDetail(best.path);
  res.json({ meta: meta ? { ...meta, accounts } : meta, detail });
});
