# Save-for-Later for Tmux Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pin specific tmux sessions to a non-rotating "saved" file so they survive snapshot rotation, and restore them later through the existing `restore.sh` pipeline.

**Architecture:** Pinned sessions live in `~/.sigmapi2sigma/saved-tmux.json` with a top-level shape identical to a normal snapshot (`{ version, ts, sessions: [...] }`) so `scripts/restore.sh` consumes it unmodified. Per-session UX metadata (savedAt, lastSeenAt) lives in a sibling `meta` map keyed by session name. New routes mounted under `/api/saved-tmux` handle pin/forget/restore. `restore.sh` already has the name-conflict guard (skip-unless-`--force`), so we get that for free. Snapshot rotation already ignores anything not named `latest|prev*.json`, so saved-tmux.json is naturally immortal.

**Tech Stack:** Node 22 + Express 4 + TypeScript (tsx). React 19 + Tailwind. Bash + tmux + jq for restore.

**Out of scope (for v1):** notes/labels per saved entry, bulk save, reordering, automatic cleanup, save-from-live-without-killing helpers (the user manages that themselves with normal tmux commands).

**Codebase notes for implementer:**
- Data dir is `~/.sigmapi2sigma/`. Path constant: `DATA_DIR` from `server/lib/pathEncoding.ts`.
- Atomic writes: use `writeJsonAtomic` from `server/lib/dataStore.ts` (writes to `.tmp.<pid>.<ts>` then renames).
- Existing restore: `POST /api/restore` body `{ snapshot?: string; snapshotName?: string; only?: string; force?: boolean; dryRun?: boolean }` — see `server/routes/snapshots.ts:49`.
- TmuxMap renders `(sessions as TmuxSession[]).map(s => ...)` with per-session header containing existing "Restore this session" / "Restore --force" buttons (lines 219–235). The new "📌 Save for later" button goes in that same row.
- New "Saved for Later" section renders **above** the existing tmux session list, inside the same `<div className="space-y-4">`.

---

### Task 1: Add saved-tmux read/write library

**Files:**
- Create: `server/lib/savedTmux.ts`

**Rationale:** All state mutation goes through one place so the schema is enforced and writes are atomic.

- [ ] **Step 1: Create the library file**

Create `server/lib/savedTmux.ts`:

```typescript
import path from "node:path";
import { DATA_DIR } from "./pathEncoding.js";
import { readJsonSafe, writeJsonAtomic } from "./dataStore.js";
import type { TmuxSession } from "./tmux.js";

export const SAVED_TMUX_FILE = path.join(DATA_DIR, "saved-tmux.json");

export interface SavedSessionMeta {
  savedAt: string;     // ISO when the user clicked "Save for later"
  lastSeenAt: string;  // ISO of the snapshot the session data was copied from (or "now" if from live)
}

export interface SavedTmuxFile {
  version: 1;
  ts: string;                              // last-write time of this file
  sessions: TmuxSession[];                 // restore.sh consumes this directly
  meta: Record<string, SavedSessionMeta>;  // keyed by session name
}

const EMPTY: SavedTmuxFile = { version: 1, ts: new Date(0).toISOString(), sessions: [], meta: {} };

export async function readSavedTmux(): Promise<SavedTmuxFile> {
  const raw = await readJsonSafe<Partial<SavedTmuxFile>>(SAVED_TMUX_FILE, EMPTY);
  return {
    version: 1,
    ts: typeof raw.ts === "string" ? raw.ts : EMPTY.ts,
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
  };
}

async function writeSavedTmux(data: SavedTmuxFile): Promise<void> {
  data.ts = new Date().toISOString();
  await writeJsonAtomic(SAVED_TMUX_FILE, data);
}

/**
 * Pin a session. If a saved entry with the same name already exists, replace it
 * (the user explicitly re-saved it, presumably with fresher data).
 */
export async function pinSession(
  session: TmuxSession,
  lastSeenAt: string,
): Promise<SavedTmuxFile> {
  const file = await readSavedTmux();
  const idx = file.sessions.findIndex(s => s.name === session.name);
  if (idx >= 0) file.sessions[idx] = session;
  else file.sessions.push(session);
  file.meta[session.name] = {
    savedAt: file.meta[session.name]?.savedAt ?? new Date().toISOString(),
    lastSeenAt,
  };
  await writeSavedTmux(file);
  return file;
}

/**
 * Forget a saved session. Returns true if anything was removed.
 */
export async function forgetSession(name: string): Promise<boolean> {
  const file = await readSavedTmux();
  const before = file.sessions.length;
  file.sessions = file.sessions.filter(s => s.name !== name);
  delete file.meta[name];
  if (file.sessions.length === before) return false;
  await writeSavedTmux(file);
  return true;
}
```

- [ ] **Step 2: TypeScript build check**

Run: `npx tsc -p . --noEmit`
Expected: no errors. (sigmapi2sigma uses tsx for runtime; this is a pure compile check.)

- [ ] **Step 3: Commit**

```bash
git add server/lib/savedTmux.ts
git commit -m "feat(saved-tmux): add read/write library for pinned sessions"
```

---

### Task 2: Wire the GET endpoint and a quick read-back test

**Files:**
- Create: `server/routes/saved-tmux.ts`
- Modify: `server/index.ts` (add the import + `app.use`)

- [ ] **Step 1: Create the router with the read endpoint only**

Create `server/routes/saved-tmux.ts`:

```typescript
import { Router } from "express";
import { readSavedTmux } from "../lib/savedTmux.js";

export const savedTmuxRouter = Router();

savedTmuxRouter.get("/saved-tmux", async (_req, res) => {
  const file = await readSavedTmux();
  res.json(file);
});
```

- [ ] **Step 2: Mount the router in `server/index.ts`**

Add the import after the other route imports (alphabetically near `snapshots`):

```typescript
import { savedTmuxRouter } from "./routes/saved-tmux.js";
```

Add the `app.use` after the others, just before the `health` route:

```typescript
app.use("/api", savedTmuxRouter);
```

- [ ] **Step 3: Restart the dev server and verify GET works**

```bash
npm run stop
npm run dev
```

In another terminal:

```bash
curl -s http://127.0.0.1:5174/api/saved-tmux | jq
```

Expected:

```json
{
  "version": 1,
  "ts": "1970-01-01T00:00:00.000Z",
  "sessions": [],
  "meta": {}
}
```

- [ ] **Step 4: Commit**

```bash
git add server/routes/saved-tmux.ts server/index.ts
git commit -m "feat(saved-tmux): GET /api/saved-tmux endpoint"
```

---

### Task 3: Implement POST /pin (pin a session by name from live tree or snapshots)

**Files:**
- Modify: `server/routes/saved-tmux.ts`

**Rationale:** Pin lookup order — live tree first (covers the case "session is alive but I want to bookmark it before killing it"), then newest snapshot, then older. First hit wins.

- [ ] **Step 1: Add the lookup helper**

Append to `server/routes/saved-tmux.ts`, above the route definitions:

```typescript
import path from "node:path";
import fs from "node:fs/promises";
import { buildTmuxTree, isTmuxRunning } from "../lib/tmux.js";
import type { TmuxSession } from "../lib/tmux.js";
import { DATA_DIR } from "../lib/pathEncoding.js";
import { pinSession, forgetSession } from "../lib/savedTmux.js";

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
```

- [ ] **Step 2: Add the POST /pin route**

Append after the GET route in the same file:

```typescript
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
```

- [ ] **Step 3: Restart server, end-to-end verify**

```bash
npm run stop && npm run dev
```

In another terminal — pick a session name that exists in your `tmux list-sessions` output (or any name visible in the Tmux Map UI):

```bash
SNAME=$(tmux list-sessions -F '#{session_name}' | head -1)
echo "pinning: $SNAME"
curl -s -X POST -H 'content-type: application/json' \
  -d "{\"sessionName\":\"$SNAME\"}" \
  http://127.0.0.1:5174/api/saved-tmux/pin | jq '.ok, .file.sessions | length, .file.meta'
curl -s http://127.0.0.1:5174/api/saved-tmux | jq '.sessions[0].name, .meta'
```

Expected:
- `.ok` is `true`
- `.file.sessions` array length `1` (or whatever the prior pinned count + 1 is)
- `.meta` has an entry keyed by `$SNAME` with `savedAt` and `lastSeenAt`
- The file at `~/.sigmapi2sigma/saved-tmux.json` exists.

Negative test:

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"sessionName":"definitely-not-a-real-session-xyz"}' \
  http://127.0.0.1:5174/api/saved-tmux/pin
```

Expected: HTTP 404 with `{"error":"tmux session \"definitely-not-a-real-session-xyz\" not found ..."}`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/saved-tmux.ts
git commit -m "feat(saved-tmux): POST /pin to bookmark a session by name"
```

---

### Task 4: Implement DELETE (forget) and POST /:name/restore

**Files:**
- Modify: `server/routes/saved-tmux.ts`

- [ ] **Step 1: Add the DELETE route**

Append:

```typescript
savedTmuxRouter.delete("/saved-tmux/:name", async (req, res) => {
  const ok = await forgetSession(req.params.name);
  if (!ok) return res.status(404).json({ error: `no saved session "${req.params.name}"` });
  res.json({ ok: true });
});
```

- [ ] **Step 2: Add the restore route**

This wraps `scripts/restore.sh` exactly the way `/api/restore` does in `server/routes/snapshots.ts`, but always passes `~/.sigmapi2sigma/saved-tmux.json` as the snapshot file.

Append, with the existing imports updated to include `execFile` + `promisify`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

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
```

- [ ] **Step 3: Restart and verify both routes**

```bash
npm run stop && npm run dev
```

Restore (without `--force`) — expect skip if a tmux session with the same name already exists, or success if not:

```bash
SNAME=$(curl -s http://127.0.0.1:5174/api/saved-tmux | jq -r '.sessions[0].name')
curl -s -X POST -H 'content-type: application/json' -d '{"force":false}' \
  http://127.0.0.1:5174/api/saved-tmux/$SNAME/restore | jq '.ok, .stdout, .stderr'
```

Expected `.stdout` contains either `restored: 1` (if no conflict) or `skipped: 1` with `(already exists; use --force to replace)`.

Forget:

```bash
curl -s -X DELETE http://127.0.0.1:5174/api/saved-tmux/$SNAME | jq
curl -s http://127.0.0.1:5174/api/saved-tmux | jq '.sessions | length'
```

Expected: forget returns `{"ok": true}`, then sessions count is one less.

- [ ] **Step 4: Commit**

```bash
git add server/routes/saved-tmux.ts
git commit -m "feat(saved-tmux): DELETE forget + POST restore (reuses restore.sh)"
```

---

### Task 5: Frontend — API types + helper

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add the response type**

Append at the end of `web/src/api.ts`, after `PROJECT_PALETTE`:

```typescript
export interface SavedSessionMeta {
  savedAt: string;
  lastSeenAt: string;
}
export interface SavedTmuxFile {
  version: 1;
  ts: string;
  sessions: TmuxSession[];
  meta: Record<string, SavedSessionMeta>;
}
```

- [ ] **Step 2: Build check**

Run: `npx tsc -p . --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(saved-tmux): frontend types"
```

---

### Task 6: Frontend — render Saved-for-Later section above the live tree

**Files:**
- Modify: `web/src/pages/TmuxMap.tsx`

**Rationale:** The saved entries should look almost identical to dead sessions in the existing list, just visually separated and never rotated out. This task introduces the section, the load, and the Forget button. Restore reuses the existing button styling and a new endpoint. Save button is added in Task 7 (separate concern: writes vs. reads).

- [ ] **Step 1: Import the new types and add state + loader**

In `web/src/pages/TmuxMap.tsx`, change the import line at the top to also bring in the saved-tmux type:

```typescript
import { getJSON, getText, postJSON, TmuxResponse, TmuxPane, TmuxWindow, TmuxSession, ShellEntry, SavedTmuxFile } from "../api";
```

Inside the `TmuxMap` component, after the `restoreLog` state (line 13), add:

```typescript
  const [saved, setSaved] = useState<SavedTmuxFile | null>(null);
```

In the `refresh` function (line 15), change it to also fetch saved:

```typescript
  async function refresh() {
    setLoading(true);
    try {
      const [tmuxData, savedData] = await Promise.all([
        getJSON<TmuxResponse>("/api/tmux"),
        getJSON<SavedTmuxFile>("/api/saved-tmux"),
      ]);
      setData(tmuxData);
      setSaved(savedData);
    } finally { setLoading(false); }
  }
```

- [ ] **Step 2: Add the forget + restore-saved actions**

Below the existing `restoreOnly` function, add:

```typescript
  async function restoreSaved(name: string, force: boolean) {
    setRestoreLog(`Restoring saved "${name}"…`);
    try {
      const r = await postJSON<{
        ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string;
      }>(`/api/saved-tmux/${encodeURIComponent(name)}/restore`, { force });
      const header = r.ok ? "" : `RESTORE FAILED (exit ${r.exitCode ?? "?"})\n\n`;
      setRestoreLog(
        header +
        (r.stdout ?? "(no stdout)") +
        (r.stderr ? `\n\n--- warnings/errors ---\n${r.stderr}` : "") +
        (r.error  ? `\n\n--- node error ---\n${r.error}`  : "")
      );
      await refresh();
    } catch (e: any) {
      setRestoreLog(`request failed: ${e.message ?? e}`);
    }
  }

  async function forget(name: string) {
    if (!confirm(`Forget saved session "${name}"? This removes the bookmark but doesn't touch tmux.`)) return;
    await fetch(`/api/saved-tmux/${encodeURIComponent(name)}`, { method: "DELETE" });
    await refresh();
  }
```

- [ ] **Step 3: Render the saved section above the live list**

Inside the JSX `return`, find the line `{sessions.length === 0 && (` and insert this block **directly above it** (i.e., after the legend `<div>` that includes the alive/dead/unknown swatches):

```tsx
      {saved && saved.sessions.length > 0 && (
        <div className="border border-amber-700/60 bg-amber-950/20 rounded">
          <div className="px-4 py-2 font-semibold border-b border-amber-800/60 flex items-center gap-3">
            <span className="text-amber-300">📌 Saved for Later</span>
            <span className="text-xs text-slate-400">{saved.sessions.length} pinned · survives snapshot rotation</span>
          </div>
          <div className="divide-y divide-amber-900/40">
            {saved.sessions.map(s => {
              const m = saved.meta[s.name];
              const aliveNow = liveSessionNames.has(s.name);
              const allPaneIds = s.windows.flatMap(w => w.panes.map(p => p.paneId));
              return (
                <div key={s.name} className="px-4 py-2">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="font-semibold">{s.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200">saved</span>
                    {aliveNow && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/40 text-green-300">currently alive</span>
                    )}
                    <span className="text-xs text-slate-500">
                      {s.windows.length}w · {allPaneIds.length}p
                    </span>
                    {m && (
                      <span className="text-xs text-slate-500" title={`saved ${m.savedAt}; last seen ${m.lastSeenAt}`}>
                        saved {relativeTime(new Date(m.savedAt).getTime())} · last seen {relativeTime(new Date(m.lastSeenAt).getTime())}
                      </span>
                    )}
                    <div className="ml-auto flex gap-2">
                      <button
                        onClick={() => copy(`tmux attach -t ${s.name}`)}
                        className="text-xs text-slate-400 hover:text-white"
                      >copy attach</button>
                      <button
                        onClick={() => restoreSaved(s.name, false)}
                        disabled={aliveNow}
                        className="text-xs px-2 py-0.5 bg-blue-600 rounded hover:bg-blue-500 disabled:opacity-40"
                        title={aliveNow ? "Already running — kill it first or use --force" : "Recreate the tmux session from the saved data"}
                      >Restore</button>
                      <button
                        onClick={() => restoreSaved(s.name, true)}
                        className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                        title="Kill any existing session with this name first"
                      >Restore --force</button>
                      <button
                        onClick={() => forget(s.name)}
                        className="text-xs px-2 py-0.5 bg-slate-800 border border-slate-700 rounded hover:bg-slate-700"
                      >Forget</button>
                    </div>
                  </div>
                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))" }}>
                    {s.windows.flatMap(w => w.panes.map(p => (
                      <PaneCard
                        key={`${w.index}.${p.index}.${p.paneId}`}
                        pane={p}
                        state="unknown"
                        onCommands={() => openCommands(p.paneId)}
                      />
                    )))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
```

- [ ] **Step 4: Verify in the browser**

```bash
# (server should still be running from earlier task)
```

Open http://127.0.0.1:5173 and click the **Tmux Map** tab. You should see the amber "📌 Saved for Later" panel at the top showing whatever you pinned in Task 3, with Restore / Restore --force / Forget buttons.

Click **Forget** — entry disappears.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/TmuxMap.tsx
git commit -m "feat(saved-tmux): render Saved-for-Later section + restore/forget actions"
```

---

### Task 7: Frontend — Save button on dead session cards

**Files:**
- Modify: `web/src/pages/TmuxMap.tsx`

- [ ] **Step 1: Add the save handler**

Below the `forget` function added in Task 6, add:

```typescript
  async function saveForLater(name: string) {
    try {
      await postJSON("/api/saved-tmux/pin", { sessionName: name });
      await refresh();
    } catch (e: any) {
      setRestoreLog(`Save failed: ${e.message ?? e}`);
    }
  }
```

- [ ] **Step 2: Render the "📌 Save for later" button**

In the existing per-session header, find the block (around line 219 of the original file):

```tsx
                {sessionState !== "alive" && (
                  <>
                    <button
                      onClick={() => restoreOnly(s.name, false)}
                      className="text-xs px-2 py-0.5 bg-blue-600 rounded hover:bg-blue-500"
                    >
                      Restore this session
                    </button>
                    <button
                      onClick={() => restoreOnly(s.name, true)}
                      className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                      title="Kill any existing session with this name first"
                    >
                      Restore --force
                    </button>
                  </>
                )}
```

Change it to also include the save button **and** suppress it when the session is already pinned:

```tsx
                {sessionState !== "alive" && (
                  <>
                    {!saved?.sessions.some(x => x.name === s.name) && (
                      <button
                        onClick={() => saveForLater(s.name)}
                        className="text-xs px-2 py-0.5 bg-amber-700 rounded hover:bg-amber-600"
                        title="Pin this session into ~/.sigmapi2sigma/saved-tmux.json so it survives snapshot rotation"
                      >📌 Save for later</button>
                    )}
                    <button
                      onClick={() => restoreOnly(s.name, false)}
                      className="text-xs px-2 py-0.5 bg-blue-600 rounded hover:bg-blue-500"
                    >Restore this session</button>
                    <button
                      onClick={() => restoreOnly(s.name, true)}
                      className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                      title="Kill any existing session with this name first"
                    >Restore --force</button>
                  </>
                )}
```

Also offer save on **alive** sessions (the user explicitly wanted "I'll close this and come back to it in 3 days" workflows). Add a separate small block right after the existing one:

```tsx
                {sessionState === "alive" && !saved?.sessions.some(x => x.name === s.name) && (
                  <button
                    onClick={() => saveForLater(s.name)}
                    className="text-xs px-2 py-0.5 bg-amber-700 rounded hover:bg-amber-600"
                    title="Bookmark this session before killing it — survives snapshot rotation"
                  >📌 Save for later</button>
                )}
```

- [ ] **Step 3: End-to-end verify in the browser**

1. Tmux Map → find any session (alive or dead) → click 📌 **Save for later**.
2. The amber "Saved for Later" panel at the top now shows the session.
3. The Save button on that session row disappears (already pinned).
4. In a terminal: `kill` the corresponding tmux session — `tmux kill-session -t <name>` — and force a snapshot run: `bash scripts/snapshot.sh && bash scripts/snapshot.sh && bash scripts/snapshot.sh && bash scripts/snapshot.sh && bash scripts/snapshot.sh && bash scripts/snapshot.sh && bash scripts/snapshot.sh && bash scripts/snapshot.sh` (8 times, more than `MAX_KEEP`) — each iteration must change state, so to make state actually differ between runs you can `tmux new-session -d -s tmp$(date +%s) && tmux kill-session -t tmp$(date +%s)` between calls; or just simulate with `for i in 1 2 3 4 5 6 7 8; do tmux new-session -d -s ttt$i; bash scripts/snapshot.sh; tmux kill-session -t ttt$i; bash scripts/snapshot.sh; done`. (This step is optional — its only purpose is to show the saved entry survives rotation.)
5. Refresh Tmux Map — the saved session is still there in the amber panel even though it has rolled off the regular `prev*.json` snapshots.
6. Click **Restore** in the saved panel — output panel at the bottom shows `restored: 1  + <name>`. Run `tmux list-sessions` — the session is back.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/TmuxMap.tsx
git commit -m "feat(saved-tmux): Save-for-Later buttons on alive and dead session rows"
```

---

## Self-Review

**Spec coverage:**
- Pin a tmux session by name → Task 3 (POST /pin), Task 7 (button)
- Survives snapshot rotation → Task 1 (separate file, never touched by snapshot.sh's rotation regex)
- Active restore → Task 4 (route reuses restore.sh) + Task 6 (UI Restore button)
- Name-conflict guard with warning → Task 4 (restore.sh skips by default; `--force` button labeled clearly with "Kill any existing session with this name first" tooltip; UI also disables non-force Restore when `aliveNow`)
- Per-pane info preserved (cwd, cmd, claudeSessionId, layout) → Task 1 (entire `TmuxSession` shape persisted), Task 6 (rendered with the existing `PaneCard`)
- Forget mechanism → Task 4 (DELETE) + Task 6 (button)

**Placeholder scan:** All steps contain real code. The tmux-rotation simulation in Task 7 Step 3 is optional and explicitly marked as such; it does not gate completion.

**Type consistency:**
- `SavedTmuxFile` shape — used identically in `server/lib/savedTmux.ts` and `web/src/api.ts`.
- `SAVED_TMUX_FILE` exported from `server/lib/savedTmux.ts`; the route uses `path.join(DATA_DIR, "saved-tmux.json")` directly when invoking restore.sh — identical paths.
- Function names: `pinSession`, `forgetSession`, `readSavedTmux` consistent across imports.
- Route paths: `/api/saved-tmux` (GET), `/api/saved-tmux/pin` (POST), `/api/saved-tmux/:name` (DELETE), `/api/saved-tmux/:name/restore` (POST) — matching frontend fetch calls.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-save-for-later.md`.
