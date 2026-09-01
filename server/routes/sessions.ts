import { Router } from "express";
import { listDedupedSessions, readSessionMeta, readSessionDetail } from "../lib/jsonl.js";
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

  // Note the units are mixed: lastActivityMs is a message timestamp when the tail
  // had one and a filesystem mtime otherwise, and this machine's clock is not
  // monotonic (WSL jumps on suspend). A session that falls back to mtime can pull
  // the anchor forward; that was already true when every input was an mtime.
  // Anchor = max(last activity) across ALL sessions, regardless of the window filter.
  // The window is then [anchor - hours*3600*1000, anchor]. Activity, not mtime:
  // a metadata-only append (a /rename) must not drag an idle session into the window.
  const anchorMs = allMetas.length > 0
    ? Math.max(...allMetas.map(m => m.lastActivityMs))
    : null;
  const anchorIso = anchorMs !== null ? new Date(anchorMs).toISOString() : null;

  const cutoff = useWindow && anchorMs !== null
    ? anchorMs - hours * 3600 * 1000
    : 0;

  const metas = allMetas
    .filter(m => m.lastActivityMs >= cutoff)
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);

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
  const deduped = await listDedupedSessions();
  const d = deduped.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "not found" });
  const meta = await readSessionMeta(d.path);
  const detail = await readSessionDetail(d.path);
  res.json({ meta: meta ? { ...meta, accounts: d.accounts } : meta, detail });
});
