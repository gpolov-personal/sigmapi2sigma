import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { buildTmuxTree, capturePane, createDetachedSession, isTmuxRunning } from "../lib/tmux.js";
import { DATA_DIR } from "../lib/pathEncoding.js";
import { expandHome } from "../lib/paths.js";

export const tmuxRouter = Router();

tmuxRouter.get("/tmux", async (_req, res) => {
  const live = await isTmuxRunning();
  const snapshots = await readRecentSnapshots();
  const snapshot = snapshots[0] ?? null;
  if (live) {
    const tree = await buildTmuxTree();
    const livePaneIds = new Set<string>();
    for (const s of tree) for (const w of s.windows) for (const p of w.panes) livePaneIds.add(p.paneId);
    return res.json({ source: "live", tree, snapshot, snapshots, livePaneIds: [...livePaneIds] });
  }
  res.json({ source: "snapshot", tree: snapshot?.sessions ?? [], snapshot, snapshots, livePaneIds: [] });
});

// Create an empty detached tmux session. Used by the project drawer's "Create tmux session" button.
tmuxRouter.post("/tmux/sessions", async (req, res) => {
  const body = req.body ?? {};
  const name: unknown = body.name;
  const cwd: unknown = body.cwd;
  if (typeof name !== "string" || name.length < 1 || name.length > 100) {
    return res.status(400).json({ error: "name must be a string 1-100 chars" });
  }
  // Tmux session names: forbid '.' ':' and whitespace per tmux conventions.
  if (/[\s.:]/.test(name)) {
    return res.status(400).json({ error: "tmux session name cannot contain spaces, '.' or ':'" });
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length > 500)) {
    return res.status(400).json({ error: "cwd must be a string ≤500 chars" });
  }
  try {
    const expanded = typeof cwd === "string" && cwd.length > 0 ? expandHome(cwd) : undefined;
    await createDetachedSession(name, expanded);
    res.json({ ok: true, name });
  } catch (e: any) {
    if (String(e?.message ?? "").includes("already exists")) {
      let existingCwds: string[] = [];
      let cwdMismatch = false;
      try {
        const tree = await buildTmuxTree();
        const hit = tree.find(s => s.name === name);
        if (hit) {
          existingCwds = [...new Set(hit.windows.flatMap(w => w.panes.map(p => p.cwd)))];
          const targetCwd = typeof cwd === "string" && cwd.length > 0 ? expandHome(cwd) : null;
          cwdMismatch = !!targetCwd && !existingCwds.includes(targetCwd);
        }
      } catch { /* fail open: empty list, no mismatch flag */ }
      return res.status(409).json({
        error: `tmux session "${name}" already exists`,
        existingCwds,
        cwdMismatch,
      });
    }
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

tmuxRouter.get("/panes/:paneId/scrollback", async (req, res) => {
  const lines = Number(req.query.lines ?? 500);
  const text = await capturePane(req.params.paneId, Number.isFinite(lines) ? lines : 500);
  res.type("text/plain").send(text);
});

async function readLatestSnapshot() {
  const p = path.join(DATA_DIR, "snapshots", "latest.json");
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

// Read latest.json + prev.json + prev{N}.json files in oldest-step order.
// "step" 0 = latest, 1 = prev, 2 = prev2, etc. Result ordered by step ascending (newest first).
async function readRecentSnapshots() {
  const dir = path.join(DATA_DIR, "snapshots");
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
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
    try {
      const txt = await fs.readFile(path.join(dir, name), "utf8");
      const parsed = JSON.parse(txt);
      parsed._fileName = name;
      out.push(parsed);
    } catch { /* skip */ }
  }
  return out;
}
