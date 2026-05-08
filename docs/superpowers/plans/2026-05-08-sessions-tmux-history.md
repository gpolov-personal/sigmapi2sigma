# Historical TMUX Column on Sessions Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, for every Claude session in the Sessions tab, the tmux pane it last lived in — even when the session isn't currently live. Today the TMUX column is empty for non-live entries.

**Architecture:** A new long-term store `~/.sigmapi2sigma/tmux-bindings.jsonl` records every observed `(claudeSessionId, tmuxSession, window, pane, cwd, ts)` tuple. `scripts/snapshot.sh` appends to it after every successful capture (cheap, dedup happens at read time). A backfill script seeds it from existing `prev*.json` files so the feature lights up immediately. A new lib `server/lib/tmuxBindings.ts` reads the log + scans recent snapshots and exposes `getLastLocationsBySessionId(ids)` returning the newest known binding per id. `GET /api/sessions` enriches each meta with `lastTmuxLocation`. The Sessions tab renders historical bindings dimmed with a "last seen X ago" tooltip.

**Tech Stack:** Node 22 + Express 4 + TypeScript (tsx). React 19 + Tailwind. Bash + jq.

**Out of scope (for v1):** showing **all** historical locations (only the most recent), pruning the bindings log (it grows ~50 KB/day max in normal use; revisit if it ever becomes a concern), filtering Sessions by tmux session.

**Codebase notes for implementer:**
- Sessions endpoint is in `server/routes/sessions.ts`. It returns `{ sessions: SessionMeta[] }` from `listAllSessionFiles()` + `readSessionMeta`. Each meta has the session's id (`m.id`).
- Frontend renders the TMUX column with the `liveById` map; non-live entries get `undefined`. The cell at `web/src/pages/Sessions.tsx:125-140` is the render site.
- Snapshots layout: `latest.json`, `prev.json`, `prev2.json` … `prev6.json` in `~/.sigmapi2sigma/snapshots/`. Each contains `{ ts, sessions: [{ name, windows: [{ index, panes: [{ index, claudeSessionId, cwd, ... }]}]}]}`.
- `snapshot.sh` exits early via the diff-guard (line 132–135) when nothing relevant changed. The bindings append must run **before** that early exit, otherwise we'd miss the first capture after a fresh install. Implementation: append unconditionally on every `tmux list-sessions`-success run; dedup at read time.

---

### Task 1: Define the binding format and write the reader library

**Files:**
- Create: `server/lib/tmuxBindings.ts`

**Format (one JSON object per line, append-only):**

```json
{"ts":"2026-05-08T22:35:00Z","claudeSessionId":"abc-uuid","tmuxSession":"ctsw","windowIndex":1,"paneIndex":1,"cwd":"/home/dsu/pProjects/sigmapi2sigma"}
```

- [ ] **Step 1: Create the library**

Create `server/lib/tmuxBindings.ts`:

```typescript
import path from "node:path";
import fs from "node:fs/promises";
import { DATA_DIR } from "./pathEncoding.js";

export const TMUX_BINDINGS_FILE = path.join(DATA_DIR, "tmux-bindings.jsonl");

export interface TmuxBinding {
  ts: string;
  claudeSessionId: string;
  tmuxSession: string;
  windowIndex: number;
  paneIndex: number;
  cwd: string;
}

/**
 * Read the entire bindings file. Lines that fail to parse are silently skipped.
 * The file is small (a few hundred KB at most under normal use) so we read it whole.
 */
export async function readBindings(): Promise<TmuxBinding[]> {
  let txt: string;
  try { txt = await fs.readFile(TMUX_BINDINGS_FILE, "utf8"); }
  catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  const out: TmuxBinding[] = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.ts === "string" &&
          typeof obj.claudeSessionId === "string" &&
          typeof obj.tmuxSession === "string" &&
          typeof obj.windowIndex === "number" &&
          typeof obj.paneIndex === "number" &&
          typeof obj.cwd === "string") {
        out.push(obj);
      }
    } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Also harvest bindings from the rotated snapshot files. This covers the period
 * before the bindings log existed, and any time snapshot.sh failed to append.
 */
async function readBindingsFromSnapshots(): Promise<TmuxBinding[]> {
  const dir = path.join(DATA_DIR, "snapshots");
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const out: TmuxBinding[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (f !== "latest.json" && f !== "prev.json" && !/^prev\d+\.json$/.test(f)) continue;
    try {
      const txt = await fs.readFile(path.join(dir, f), "utf8");
      const parsed = JSON.parse(txt);
      const ts = typeof parsed.ts === "string" ? parsed.ts : new Date().toISOString();
      for (const s of parsed.sessions ?? []) {
        for (const w of s.windows ?? []) {
          for (const p of w.panes ?? []) {
            if (!p?.claudeSessionId) continue;
            out.push({
              ts,
              claudeSessionId: p.claudeSessionId,
              tmuxSession: s.name,
              windowIndex: w.index,
              paneIndex: p.index,
              cwd: p.cwd ?? "",
            });
          }
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

/**
 * For a set of session ids, return the most recent (by ts) binding for each one.
 * Sources combined: tmux-bindings.jsonl + the current snapshot rotation.
 */
export async function getLastLocationsBySessionId(ids: Set<string>): Promise<Map<string, TmuxBinding>> {
  const all = [...await readBindings(), ...await readBindingsFromSnapshots()];
  const newest = new Map<string, TmuxBinding>();
  for (const b of all) {
    if (!ids.has(b.claudeSessionId)) continue;
    const cur = newest.get(b.claudeSessionId);
    if (!cur || cur.ts < b.ts) newest.set(b.claudeSessionId, b);
  }
  return newest;
}
```

- [ ] **Step 2: TypeScript build check**

Run: `npx tsc -p . --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/lib/tmuxBindings.ts
git commit -m "feat(tmux-bindings): reader library merging jsonl + snapshots"
```

---

### Task 2: Enrich GET /api/sessions with lastTmuxLocation

**Files:**
- Modify: `server/routes/sessions.ts`

- [ ] **Step 1: Update the route**

Replace the body of `sessionsRouter.get("/sessions", ...)` (currently lines 6–19 of `server/routes/sessions.ts`) with:

```typescript
import { Router } from "express";
import { listAllSessionFiles, readSessionMeta, readSessionDetail } from "../lib/jsonl.js";
import { getLastLocationsBySessionId } from "../lib/tmuxBindings.js";

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

  res.json({ sessions: enriched });
});

sessionsRouter.get("/sessions/:id", async (req, res) => {
  const files = await listAllSessionFiles();
  const match = files.find(f => f.endsWith(`/${req.params.id}.jsonl`));
  if (!match) return res.status(404).json({ error: "not found" });
  const meta = await readSessionMeta(match);
  const detail = await readSessionDetail(match);
  res.json({ meta, detail });
});
```

- [ ] **Step 2: Restart server and verify**

```bash
npm run stop && npm run dev
```

```bash
curl -s 'http://127.0.0.1:5174/api/sessions?hours=720' | \
  jq '.sessions[] | {id, lwd: .cwd, last: .lastTmuxLocation}' | head -30
```

Expected: at least the entries with conversations that ever ran in the current snapshot rotation should have `last` populated; older sessions show `null`. (Coverage will jump to "almost everything from the last few days" once Task 4 backfill runs.)

- [ ] **Step 3: Commit**

```bash
git add server/routes/sessions.ts
git commit -m "feat(sessions): attach lastTmuxLocation per session"
```

---

### Task 3: snapshot.sh appends to tmux-bindings.jsonl

**Files:**
- Modify: `scripts/snapshot.sh`

**Rationale:** Append unconditionally per claude pane on every snapshot run. The append must happen even when the diff-guard exits early (otherwise we'd lose data when state is stable). The reader dedups at query time (newest-by-ts wins per session id), so duplicates are harmless.

- [ ] **Step 1: Insert the append block**

In `scripts/snapshot.sh`, immediately **before** the diff-guard at line 129 (the `if [[ -f "$SNAP_DIR/latest.json" ]]; then` line), insert this block:

```bash
# Append every observed (claudeSessionId, tmuxSession, window, pane, cwd) tuple
# to ~/.sigmapi2sigma/tmux-bindings.jsonl. Append-only; dedup happens at read time.
# Appended even when the diff-guard below skips the rotation, so the log stays
# fresh during steady-state work.
BINDINGS_FILE="$DATA_DIR/tmux-bindings.jsonl"
{
  jq -c --arg ts "$TS" '
    .sessions[] as $s
    | $s.windows[] as $w
    | $w.panes[]
    | select(.claudeSessionId != null)
    | {ts: $ts, claudeSessionId: .claudeSessionId, tmuxSession: $s.name,
       windowIndex: $w.index, paneIndex: .index, cwd: .cwd}
  ' "$tmp"
} >> "$BINDINGS_FILE" 2>/dev/null || true
```

(Indentation: must match surrounding 0-space top-level lines. The script is `set -euo pipefail`, so the trailing `|| true` is essential — never fail the snapshot just because the bindings append failed.)

- [ ] **Step 2: Smoke test**

```bash
rm -f ~/.sigmapi2sigma/tmux-bindings.jsonl
bash scripts/snapshot.sh
wc -l ~/.sigmapi2sigma/tmux-bindings.jsonl
```

Expected: `wc -l` matches the number of claude panes currently running across all your tmux sessions (could be 0 if no claude pane is alive — that's also valid).

```bash
head -3 ~/.sigmapi2sigma/tmux-bindings.jsonl 2>/dev/null | jq -c '{ts, claudeSessionId, tmuxSession, windowIndex, paneIndex}'
```

Expected: each line has all the fields, ts is the same ISO timestamp across the run.

- [ ] **Step 3: Commit**

```bash
git add scripts/snapshot.sh
git commit -m "feat(snapshot): append claude-pane bindings to tmux-bindings.jsonl"
```

---

### Task 4: One-time backfill script

**Files:**
- Create: `scripts/backfill-bindings.sh`

**Rationale:** Read every snapshot file currently on disk and emit one bindings entry per claude pane found. This populates the log for sessions that disappeared from the rotation before the new code ran.

- [ ] **Step 1: Create the script**

Create `scripts/backfill-bindings.sh`:

```bash
#!/usr/bin/env bash
# One-time backfill: scan all current snapshot files and emit any claude-pane
# bindings into ~/.sigmapi2sigma/tmux-bindings.jsonl. Safe to re-run; the
# tmux-bindings reader dedups at query time (newest-ts wins per session id).
set -euo pipefail

DATA_DIR="$HOME/.sigmapi2sigma"
SNAP_DIR="$DATA_DIR/snapshots"
BINDINGS_FILE="$DATA_DIR/tmux-bindings.jsonl"

[[ -d "$SNAP_DIR" ]] || { echo "no snapshots dir: $SNAP_DIR" >&2; exit 0; }

count=0
for f in "$SNAP_DIR"/latest.json "$SNAP_DIR"/prev.json "$SNAP_DIR"/prev*.json; do
  [[ -f "$f" ]] || continue
  added=$(jq -c '
    .ts as $ts
    | .sessions[] as $s
    | $s.windows[] as $w
    | $w.panes[]
    | select(.claudeSessionId != null)
    | {ts: $ts, claudeSessionId: .claudeSessionId, tmuxSession: $s.name,
       windowIndex: $w.index, paneIndex: .index, cwd: .cwd}
  ' "$f" 2>/dev/null) || continue
  if [[ -n "$added" ]]; then
    n=$(wc -l <<<"$added")
    count=$((count + n))
    printf '%s\n' "$added" >> "$BINDINGS_FILE"
  fi
done

echo "backfilled $count bindings into $BINDINGS_FILE"
```

- [ ] **Step 2: Make it executable and run it**

```bash
chmod +x scripts/backfill-bindings.sh
bash scripts/backfill-bindings.sh
wc -l ~/.sigmapi2sigma/tmux-bindings.jsonl
```

Expected: line count > 0 (your snapshot rotation has 7 files; if each captured 2–3 claude panes you'll see 14–21 lines, plus whatever Task 3 already wrote).

- [ ] **Step 3: Verify reader picks them up**

```bash
curl -s 'http://127.0.0.1:5174/api/sessions?hours=720' | \
  jq '[.sessions[] | select(.lastTmuxLocation != null)] | length'
```

Expected: a number > 0, hopefully significantly more than before the backfill.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-bindings.sh
git commit -m "feat(tmux-bindings): one-time backfill script from existing snapshots"
```

---

### Task 5: Frontend types

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add the field to SessionMeta**

In `web/src/api.ts`, change the `SessionMeta` interface (currently lines 47–62) to include the new field:

```typescript
export interface SessionMeta {
  id: string;
  jsonlPath: string;
  projectDir: string;
  cwd: string | null;
  lastCwd: string | null;
  gitBranch: string | null;
  version: string | null;
  permissionMode: string | null;
  mtime: number;
  size: number;
  firstTs: string | null;
  lastTs: string | null;
  lastUserPrompt: string | null;
  lastUserTs: string | null;
  /** Most recent (claudeSessionId, tmuxSession, window, pane) tuple ever observed for this session. */
  lastTmuxLocation: { tmuxSession: string; windowIndex: number; paneIndex: number; ts: string } | null;
}
```

- [ ] **Step 2: Build check**

Run: `npx tsc -p . --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(sessions): add lastTmuxLocation to SessionMeta type"
```

---

### Task 6: Sessions table renders historical TMUX cell

**Files:**
- Modify: `web/src/pages/Sessions.tsx`

- [ ] **Step 1: Update the TMUX cell**

In `web/src/pages/Sessions.tsx`, find the TMUX `<td>` block at lines 125–140 and replace it with:

```tsx
                  <td className="px-3 py-2 text-xs font-mono text-slate-400 whitespace-nowrap">
                    {liveLocs && liveLocs.length > 0 ? (
                      <div className="space-y-0.5">
                        {liveLocs.map(loc => {
                          const projectId = assignmentsByTmux.get(loc.tmuxSession);
                          const project = projectId ? projectById.get(projectId) : null;
                          return (
                            <div key={loc.paneId} className="flex items-center gap-1.5">
                              <span>{loc.tmuxSession}:{loc.windowIndex}.{loc.paneIndex}</span>
                              {project && <ProjectChip project={project} />}
                            </div>
                          );
                        })}
                      </div>
                    ) : s.lastTmuxLocation ? (
                      (() => {
                        const loc = s.lastTmuxLocation;
                        const projectId = assignmentsByTmux.get(loc.tmuxSession);
                        const project = projectId ? projectById.get(projectId) : null;
                        return (
                          <div
                            className="flex items-center gap-1.5 text-slate-500"
                            title={`Last seen ${relativeTime(new Date(loc.ts).getTime())} (${new Date(loc.ts).toLocaleString()})`}
                          >
                            <span>{loc.tmuxSession}:{loc.windowIndex}.{loc.paneIndex}</span>
                            {project && <ProjectChip project={project} />}
                          </div>
                        );
                      })()
                    ) : null}
                  </td>
```

- [ ] **Step 2: Verify in the browser**

Open http://127.0.0.1:5173, click the **Sessions** tab.

Expected:
- Live entries (green dot): TMUX column shows the location in normal slate-400 text — same as before.
- Non-live entries with a known historical binding: TMUX column shows the location in dimmer slate-500 text. Hovering reveals a tooltip "Last seen 3h ago (May 8, 2026, 7:35 PM)" or similar.
- Non-live entries with no historical record: TMUX cell is empty — same as before.

For verification you can pick a non-live row and confirm that the displayed `tmuxSession:window.pane` matches an entry in `~/.sigmapi2sigma/tmux-bindings.jsonl`:

```bash
SID=<paste a session id from the UI>
grep "\"$SID\"" ~/.sigmapi2sigma/tmux-bindings.jsonl | jq -s 'sort_by(.ts) | last'
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Sessions.tsx
git commit -m "feat(sessions): render historical tmux location for non-live entries"
```

---

## Self-Review

**Spec coverage:**
- Show, for each non-live Claude session, the tmux session/window/pane it last lived in → Tasks 5, 6.
- Snapshot-scan is the immediate source of data → Task 1 (`readBindingsFromSnapshots`).
- Append-only log for unbounded historical coverage → Task 1 (reader), Task 3 (writer in snapshot.sh).
- One-time backfill from existing snapshots → Task 4.
- Visually distinguish historical vs. live in the column → Task 6 (live: slate-400 normal; historical: slate-500 dim + tooltip).

**Placeholder scan:** Every step has runnable code. The grep verification in Task 6 needs a real session id pasted by the implementer; this is documented inline.

**Type consistency:**
- `lastTmuxLocation` shape is identical between the server response in Task 2 (`{ tmuxSession, windowIndex, paneIndex, ts }`) and the frontend interface in Task 5.
- `claudeSessionId` field name used everywhere (matches the existing `TmuxPane` field).
- `TMUX_BINDINGS_FILE` constant exported from the lib but the bash scripts hard-code the same path; both write to `~/.sigmapi2sigma/tmux-bindings.jsonl`.
- `getLastLocationsBySessionId` signature: `Set<string> → Map<string, TmuxBinding>` — used in Task 2 with `new Set(metas.map(m => m.id))`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-sessions-tmux-history.md`.
