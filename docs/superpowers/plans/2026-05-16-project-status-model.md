# Project Status Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single derived "active/parked/completed" status pill on each project with three orthogonal derived fields (`progress`, `engagement`, `tmux_attached`), computed server-side from observed activity with `completed_at` as the only manual lever.

**Architecture:** A new server module `server/lib/projectStatus.ts` owns the derivation rule. The existing `GET /api/projects` endpoint runs this module on every request, joining `projects.json`, `pomodoros.json`, `assignments.json`, `settings.json`, and the live tmux tree, returning per-project `derivedStatus` plus a top-level `anchor` object. The frontend (`ProjectsContext`, `Projects.tsx`, `Pomodoro.tsx`, `Sessions.tsx`, `SettingsModal.tsx`) renders the precomputed status — it does not duplicate the rule. Manual verification only (no test runner in repo).

**Tech Stack:** Node 22 + Express 4 + TypeScript via tsx (ESM, `.js` imports). React 19 + Tailwind via Vite. Atomic JSON storage. No test runner.

**Reference design spec:** `docs/superpowers/specs/2026-05-16-project-status-model-design.md`

---

## File Structure

```
server/
  lib/
    projectStatus.ts          NEW — pure derivation function + types
  routes/
    projects.ts               MODIFY — extend GET /api/projects response
    pomodoros.ts              MODIFY — tighten completed-project guard
    sessions.ts               MODIFY — anchor-relative window + anchor field
    settings.ts               MODIFY — activeWindowHours key + migration to v4

web/src/
  api.ts                      MODIFY — DerivedStatus, ProjectsResponse, SessionsResponse, Settings
  ProjectsContext.tsx         MODIFY — consume derivedStatus + anchor
  SettingsContext.tsx         MODIFY — default activeWindowHours
  pages/
    Projects.tsx              MODIFY — three chips, anchor header, sort
    Pomodoro.tsx              MODIFY — Show completed toggle in picker
    Sessions.tsx              MODIFY — display anchor line
  components/
    SettingsModal.tsx         MODIFY — activeWindowHours numeric input
```

Each task below is one self-contained commit. Steps inside a task should take 2–5 minutes each.

---

## Phase 1 — Server

### Task 1: Add `projectStatus.ts` derivation module

**Files:**
- Create: `server/lib/projectStatus.ts`

- [ ] **Step 1: Create the file with full content**

```ts
// Pure derivation of project status fields. Inputs are plain data — no I/O here.
//
// progress:      not_started | in_progress | completed
//                completed_at takes precedence; else pomodoro count decides.
//
// engagement:    active | parked
//                anchor = max(pomodoro.ended_at) across ALL projects, null if no pomodoros.
//                A project is active iff (progress != completed) AND it has any pomodoro
//                whose ended_at falls within [anchor - X*3600*1000, anchor], where
//                X = activeWindowHours. Completed projects are always parked.
//
// tmux_attached: boolean
//                True iff there is an assignment row tmuxName→this.id AND that
//                tmuxName appears in the supplied liveSessionNames set.

export type Progress = "not_started" | "in_progress" | "completed";
export type Engagement = "active" | "parked";

export interface DerivedStatus {
  progress: Progress;
  engagement: Engagement;
  tmux_attached: boolean;
  tmux_session_name: string | null;
  last_pomodoro_at: string | null;
}

export interface ProjectStatusAnchor {
  ts: string | null;
  activeWindowHours: number;
}

export interface DeriveInputs {
  projects: { id: string; completed_at: string | null }[];
  pomodoros: { project_ids: string[]; ended_at: string }[];
  assignments: Record<string, string>;
  liveSessionNames: Set<string>;
  activeWindowHours: number;
}

export interface DeriveOutput {
  anchor: ProjectStatusAnchor;
  byProjectId: Map<string, DerivedStatus>;
}

export function deriveProjectStatus(input: DeriveInputs): DeriveOutput {
  const { projects, pomodoros, assignments, liveSessionNames, activeWindowHours } = input;

  // Anchor = max(pomodoro.ended_at) across ALL projects.
  let anchorMs: number | null = null;
  let anchorIso: string | null = null;
  for (const p of pomodoros) {
    const ms = Date.parse(p.ended_at);
    if (!Number.isFinite(ms)) continue;
    if (anchorMs === null || ms > anchorMs) {
      anchorMs = ms;
      anchorIso = p.ended_at;
    }
  }

  const cutoffMs = anchorMs !== null
    ? anchorMs - activeWindowHours * 3600 * 1000
    : null;

  // Bucket pomodoros by project for engagement + last_pomodoro_at lookups.
  // Each pomodoro can list multiple project_ids; it counts for each of them.
  const lastEndedMsByProject = new Map<string, number>();
  const lastEndedIsoByProject = new Map<string, string>();
  const hasInWindowByProject = new Map<string, boolean>();

  for (const p of pomodoros) {
    const ms = Date.parse(p.ended_at);
    if (!Number.isFinite(ms)) continue;
    for (const pid of p.project_ids) {
      const prev = lastEndedMsByProject.get(pid);
      if (prev === undefined || ms > prev) {
        lastEndedMsByProject.set(pid, ms);
        lastEndedIsoByProject.set(pid, p.ended_at);
      }
      if (cutoffMs !== null && ms >= cutoffMs && ms <= (anchorMs as number)) {
        hasInWindowByProject.set(pid, true);
      }
    }
  }

  // Reverse assignments for the tmux_attached lookup.
  const tmuxNameByProject = new Map<string, string>();
  for (const [tname, pid] of Object.entries(assignments)) {
    if (liveSessionNames.has(tname)) tmuxNameByProject.set(pid, tname);
  }

  const byProjectId = new Map<string, DerivedStatus>();
  for (const proj of projects) {
    const completed = !!proj.completed_at;
    const hasPomodoro = lastEndedMsByProject.has(proj.id);
    const progress: Progress = completed
      ? "completed"
      : hasPomodoro ? "in_progress" : "not_started";

    const engagement: Engagement = (() => {
      if (completed) return "parked";
      if (anchorMs === null) return "parked";
      return hasInWindowByProject.get(proj.id) ? "active" : "parked";
    })();

    const tmuxName = tmuxNameByProject.get(proj.id) ?? null;

    byProjectId.set(proj.id, {
      progress,
      engagement,
      tmux_attached: tmuxName !== null,
      tmux_session_name: tmuxName,
      last_pomodoro_at: lastEndedIsoByProject.get(proj.id) ?? null,
    });
  }

  return {
    anchor: { ts: anchorIso, activeWindowHours },
    byProjectId,
  };
}
```

- [ ] **Step 2: Manually verify with a sanity check via tsx REPL**

Run from the repo root:

```bash
npx tsx -e "import('./server/lib/projectStatus.js').then(m => { \
  const out = m.deriveProjectStatus({ \
    projects: [{id:'a',completed_at:null},{id:'b',completed_at:'2026-01-01T00:00:00Z'},{id:'c',completed_at:null}], \
    pomodoros: [ \
      {project_ids:['a'],ended_at:'2026-05-15T12:00:00Z'}, \
      {project_ids:['b'],ended_at:'2026-05-15T14:00:00Z'}, \
      {project_ids:['c'],ended_at:'2026-05-10T10:00:00Z'} \
    ], \
    assignments: {'Sim':'a'}, \
    liveSessionNames: new Set(['Sim']), \
    activeWindowHours: 72 \
  }); \
  console.log('anchor', out.anchor); \
  for (const [k,v] of out.byProjectId) console.log(k, v); \
});"
```

Expected output (anchor = 14:00 on May 15; cutoff = 72h before = 12:00 on May 12):

```
anchor { ts: '2026-05-15T14:00:00Z', activeWindowHours: 72 }
a { progress: 'in_progress', engagement: 'active',  tmux_attached: true,  tmux_session_name: 'Sim', last_pomodoro_at: '2026-05-15T12:00:00Z' }
b { progress: 'completed',   engagement: 'parked',  tmux_attached: false, tmux_session_name: null,  last_pomodoro_at: '2026-05-15T14:00:00Z' }
c { progress: 'in_progress', engagement: 'parked',  tmux_attached: false, tmux_session_name: null,  last_pomodoro_at: '2026-05-10T10:00:00Z' }
```

Confirm: project `a` is active (within window + has tmux), `b` is parked because completed (even with newest pomodoro), `c` is parked because its only pomodoro is 5 days old.

- [ ] **Step 3: Commit**

```bash
git add server/lib/projectStatus.ts
git commit -m "feat(server): pure project-status derivation module

Adds server/lib/projectStatus.ts with deriveProjectStatus(): given
projects + pomodoros + assignments + live tmux names + activeWindowHours,
returns per-project (progress, engagement, tmux_attached, …) plus the
global pomodoro anchor. Pure function — no I/O. Used by GET /api/projects
in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extend `GET /api/projects` to embed derivedStatus + anchor

**Files:**
- Modify: `server/routes/projects.ts` (lines 1–11 imports, line 154 GET handler)

- [ ] **Step 1: Add required imports at top of file**

In `server/routes/projects.ts`, replace lines 1–11 with:

```ts
import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  ASSIGNMENTS_FILE,
  POMODOROS_FILE,
  PROJECTS_FILE,
  SETTINGS_FILE,
  TASKS_FILE,
  readJsonSafe,
  writeJsonAtomic,
} from "../lib/dataStore.js";
import { deriveProjectStatus, DerivedStatus, ProjectStatusAnchor } from "../lib/projectStatus.js";
import { buildTmuxTree, isTmuxRunning } from "../lib/tmux.js";
```

Verify that `POMODOROS_FILE` and `SETTINGS_FILE` are exported from `server/lib/dataStore.ts`:

```bash
grep -E "POMODOROS_FILE|SETTINGS_FILE" server/lib/dataStore.ts
```

Expected: both names appear as exports. (If not, add them — they almost certainly already exist since other routes use them.)

- [ ] **Step 2: Add helper types and `loadLiveSessionNames` near top of file**

Insert after the existing `EMPTY_TASKS` constant (around line 46):

```ts
interface PomFile { schemaVersion: number; pomodoros: { project_ids: string[]; ended_at: string }[] }
const EMPTY_POMS: PomFile = { schemaVersion: 1, pomodoros: [] };

interface SettingsLite { activeWindowHours?: number }

async function loadLiveSessionNames(): Promise<Set<string>> {
  if (!(await isTmuxRunning())) return new Set();
  try {
    const tree = await buildTmuxTree();
    return new Set(tree.map(s => s.name));
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 3: Replace the GET handler at line 154**

Replace this block:

```ts
projectsRouter.get("/projects", async (_req, res) => {
  const file = await loadProjects();
  res.json({ projects: file.projects });
});
```

with:

```ts
projectsRouter.get("/projects", async (_req, res) => {
  const file = await loadProjects();

  const [pomFile, assignFile, settings, liveSessionNames] = await Promise.all([
    readJsonSafe<PomFile>(POMODOROS_FILE, EMPTY_POMS),
    readJsonSafe<AssignmentsFile>(ASSIGNMENTS_FILE, EMPTY_ASSIGNMENTS),
    readJsonSafe<SettingsLite>(SETTINGS_FILE, {}),
    loadLiveSessionNames(),
  ]);
  const activeWindowHours = Number.isFinite(settings.activeWindowHours)
    ? Math.max(1, Math.min(8760, settings.activeWindowHours as number))
    : 72;

  const { anchor, byProjectId } = deriveProjectStatus({
    projects: file.projects,
    pomodoros: pomFile.pomodoros,
    assignments: assignFile.assignments,
    liveSessionNames,
    activeWindowHours,
  });

  const projectsWithStatus = file.projects.map(p => ({
    ...p,
    derivedStatus: byProjectId.get(p.id) ?? null,
  }));

  res.json({ projects: projectsWithStatus, anchor });
});
```

- [ ] **Step 4: Start dev server and verify the new response shape**

```bash
npm run dev
```

Open a separate terminal and run:

```bash
curl -s http://localhost:5174/api/projects | python3 -m json.tool | head -40
```

Expected: each project now has a `derivedStatus` object with `progress`, `engagement`, `tmux_attached`, `tmux_session_name`, `last_pomodoro_at`. The response has a top-level `anchor` with `ts` and `activeWindowHours: 72`.

Cross-check against your real data: StarCompliance Investor (no recent pomodoros, no live tmux session named `StarCompInv`) should now show:

```json
"derivedStatus": {
  "progress": "in_progress",   // or "not_started" if it has no pomodoros at all
  "engagement": "parked",       // ← the fix you wanted
  "tmux_attached": false,
  ...
}
```

If `engagement` is still `active` for StarCompInv, check that `tmux ls` doesn't list a session named `StarCompInv`.

- [ ] **Step 5: Stop the dev server (Ctrl-C) and commit**

```bash
git add server/routes/projects.ts
git commit -m "feat(server): GET /api/projects returns derivedStatus + anchor

Joins projects + pomodoros + assignments + live tmux + settings on every
request and runs deriveProjectStatus(). Each project gains a derivedStatus
object; response gains a top-level anchor {ts, activeWindowHours}. The
stale 'StarCompInv is active' bug is resolved as a side effect (active
engagement now requires a recent pomodoro, not a leftover assignment).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tighten completed-project guard in `POST /api/pomodoros`

**Files:**
- Modify: `server/routes/pomodoros.ts` (lines 148–156)

- [ ] **Step 1: Read the current guard**

Open `server/routes/pomodoros.ts`. Find lines 148–156:

```ts
const projects = await readJsonSafe<ProjectsFile>(PROJECTS_FILE, EMPTY_PRJ);
const startMs = Date.parse(started_at);
for (const pid of project_ids) {
  const p = projects.projects.find(x => x.id === pid);
  if (!p) return res.status(404).json({ error: `project not found: ${pid}` });
  if (p.completed_at && Date.parse(p.completed_at) <= startMs) {
    return res.status(409).json({ error: `project completed before start: ${pid}` });
  }
}
```

The current rule allows pomodoros on completed projects if the pomodoro started before completion. The new rule rejects unconditionally.

- [ ] **Step 2: Replace the guard**

Replace lines 148–156 with:

```ts
const projects = await readJsonSafe<ProjectsFile>(PROJECTS_FILE, EMPTY_PRJ);
for (const pid of project_ids) {
  const p = projects.projects.find(x => x.id === pid);
  if (!p) return res.status(404).json({ error: `project not found: ${pid}` });
  if (p.completed_at) {
    return res.status(409).json({
      error: `project '${pid}' is completed — reopen it before logging time`,
    });
  }
}
```

Note: `startMs` is no longer needed. If it's used elsewhere in the function, leave the `const startMs = Date.parse(started_at);` line alone. (Quick search: it's not used elsewhere — safe to drop.)

- [ ] **Step 3: Manual verification — start dev server, try the rejection**

```bash
npm run dev
```

Pick a non-Free project that has `completed_at: null` and temporarily set it to completed for testing:

```bash
curl -s -X PATCH http://localhost:5174/api/projects/<id> \
  -H "content-type: application/json" \
  -d '{"completed_at":"2026-05-16T00:00:00Z"}' | python3 -m json.tool
```

Try to create a pomodoro for it:

```bash
curl -s -X POST http://localhost:5174/api/pomodoros \
  -H "content-type: application/json" \
  -d '{"started_at":"2026-05-16T10:00:00Z","ended_at":"2026-05-16T10:25:00Z","target_duration_minutes":25,"project_ids":["<id>"],"task_ids":[],"source":"manual"}'
```

Expected: HTTP 409 with `{"error":"project '<id>' is completed — reopen it before logging time"}`.

Reopen the project:

```bash
curl -s -X PATCH http://localhost:5174/api/projects/<id> \
  -H "content-type: application/json" \
  -d '{"completed_at":null}'
```

- [ ] **Step 4: Stop dev server and commit**

```bash
git add server/routes/pomodoros.ts
git commit -m "fix(server): block pomodoros on completed projects unconditionally

Previously, POST /api/pomodoros allowed a pomodoro if it started before
completed_at. The new rule rejects any pomodoro touching a completed
project. The Reopen button is the documented escape hatch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Add anchor-relative window to `GET /api/sessions`

**Files:**
- Modify: `server/routes/sessions.ts` (lines 7–32)

- [ ] **Step 1: Replace the GET /sessions handler**

Replace the entire `sessionsRouter.get("/sessions", …)` block (lines 7–32) with:

```ts
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
```

- [ ] **Step 2: Start dev server and verify**

```bash
npm run dev
```

```bash
curl -s "http://localhost:5174/api/sessions?hours=24" | python3 -c "import json,sys; d=json.load(sys.stdin); print('anchor:', d.get('anchor')); print('count:', len(d['sessions']))"
```

Expected: `anchor` is the ISO timestamp of your most-recently-touched Claude JSONL. Count is the number of sessions whose mtime falls within 24h *before that anchor*. With `hours=0` or no `hours` param, `anchor` should be `null` and all sessions returned.

Test all-time:

```bash
curl -s "http://localhost:5174/api/sessions?hours=0" | python3 -c "import json,sys; d=json.load(sys.stdin); print('anchor:', d.get('anchor')); print('count:', len(d['sessions']))"
```

Expected: `anchor: None`, count = all sessions ever.

- [ ] **Step 3: Stop dev server and commit**

```bash
git add server/routes/sessions.ts
git commit -m "feat(server): GET /api/sessions uses anchor-relative window

Anchor = max(mtime) over ALL sessions. Window filters mtime >= anchor - hours*3600*1000.
Response gains an 'anchor' field (ISO or null if hours=0 / no sessions).
Lets the Sessions tab show 'the last 24h of when you were active' instead
of 'the last 24h of wall-clock', which was empty after weekends.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add `activeWindowHours` to settings with v4 migration

**Files:**
- Modify: `server/routes/settings.ts` (multiple regions)

- [ ] **Step 1: Update the Settings interface and DEFAULTS**

Replace lines 8–28 with:

```ts
export interface Settings {
  schemaVersion: number;
  workdayHours: number;
  defaultPomodoroDuration: number;
  restMinutes: number;
  startBeepSound: BeepSound;
  endBeepSound: BeepSound;
  audioEnabled: boolean;
  notificationsEnabled: boolean;
  activeWindowHours: number;
}

const DEFAULTS: Settings = {
  schemaVersion: 4,
  workdayHours: 8,
  defaultPomodoroDuration: 25,
  restMinutes: 5,
  startBeepSound: "soft",
  endBeepSound: "classic",
  audioEnabled: true,
  notificationsEnabled: true,
  activeWindowHours: 72,
};
```

- [ ] **Step 2: Extend the migration function**

Replace the `migrate` function (lines 33–46) with:

```ts
// Migrate legacy v1 (had wuMinutes), v2 (had single beepSound), v3 (no activeWindowHours) → v4.
function migrate(loaded: any): Settings {
  if (!loaded || typeof loaded !== "object") return { ...DEFAULTS };
  const merged: any = { ...DEFAULTS, ...loaded };
  delete merged.wuMinutes;
  // v2 → v3: split beepSound into startBeepSound + endBeepSound.
  if (merged.beepSound !== undefined) {
    if (loaded.endBeepSound === undefined) merged.endBeepSound = merged.beepSound;
    delete merged.beepSound;
  }
  if (!BEEPS.includes(merged.startBeepSound)) merged.startBeepSound = DEFAULTS.startBeepSound;
  if (!BEEPS.includes(merged.endBeepSound)) merged.endBeepSound = DEFAULTS.endBeepSound;
  // v3 → v4: ensure activeWindowHours present and in range.
  if (
    typeof merged.activeWindowHours !== "number" ||
    !Number.isFinite(merged.activeWindowHours) ||
    merged.activeWindowHours < 1 ||
    merged.activeWindowHours > 8760
  ) {
    merged.activeWindowHours = DEFAULTS.activeWindowHours;
  }
  merged.schemaVersion = 4;
  return merged as Settings;
}
```

Update the `loadOrInit` dirty-check (line 56) to also flag a v3-to-v4 migration:

Replace lines 55–59 with:

```ts
  const dirty =
    migrated.schemaVersion !== (cur as any).schemaVersion ||
    (cur as any).wuMinutes !== undefined ||
    (cur as any).beepSound !== undefined ||
    (cur as any).activeWindowHours === undefined;
  if (dirty) await writeJsonAtomic(SETTINGS_FILE, migrated);
```

- [ ] **Step 3: Add validation for `activeWindowHours`**

In `validate()` (around line 97, just before the closing `return null`), add:

```ts
  if (patch.activeWindowHours !== undefined) {
    if (
      !Number.isInteger(patch.activeWindowHours) ||
      patch.activeWindowHours < 1 ||
      patch.activeWindowHours > 8760
    ) {
      return { error: "activeWindowHours must be integer 1-8760" };
    }
  }
```

- [ ] **Step 4: Apply `activeWindowHours` in the PUT merge**

In the `settingsRouter.put` handler, in the spread (around line 122, just before `notificationsEnabled`), add:

```ts
    ...(body.activeWindowHours !== undefined ? { activeWindowHours: body.activeWindowHours } : {}),
```

- [ ] **Step 5: Verify migration writes the new field**

```bash
npm run dev
```

```bash
curl -s http://localhost:5174/api/settings | python3 -m json.tool
```

Expected: response shows `"schemaVersion": 4` and `"activeWindowHours": 72`. Inspect the on-disk file:

```bash
cat ~/.sigmapi2sigma/settings.json | python3 -m json.tool
```

Same fields present.

Test PUT validation:

```bash
curl -s -X PUT http://localhost:5174/api/settings \
  -H "content-type: application/json" \
  -d '{"activeWindowHours": 24}' | python3 -m json.tool
```

Expected: response shows `"activeWindowHours": 24`. Set it back:

```bash
curl -s -X PUT http://localhost:5174/api/settings \
  -H "content-type: application/json" \
  -d '{"activeWindowHours": 72}'
```

Test invalid value:

```bash
curl -s -X PUT http://localhost:5174/api/settings \
  -H "content-type: application/json" \
  -d '{"activeWindowHours": 0}'
```

Expected: HTTP 400, `{"error":"activeWindowHours must be integer 1-8760"}`.

- [ ] **Step 6: Stop dev server and commit**

```bash
git add server/routes/settings.ts
git commit -m "feat(server): add activeWindowHours setting (default 72) with v4 migration

Adds the configurable window (in hours) used by deriveProjectStatus to
decide active vs parked. v3→v4 migration backfills the field with 72.
Range 1-8760 (1h to 1 year). Validated on PUT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Frontend types and contexts

### Task 6: Update `web/src/api.ts` types

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add DerivedStatus types after the existing `Project` interface (line 107)**

Insert after line 107 (just after the closing `}` of `Project`):

```ts
export type Progress = "not_started" | "in_progress" | "completed";
export type Engagement = "active" | "parked";

export interface DerivedStatus {
  progress: Progress;
  engagement: Engagement;
  tmux_attached: boolean;
  tmux_session_name: string | null;
  last_pomodoro_at: string | null;
}

export interface ProjectWithStatus extends Project {
  derivedStatus: DerivedStatus | null;
}

export interface ProjectStatusAnchor {
  ts: string | null;
  activeWindowHours: number;
}

export interface ProjectsResponse {
  projects: ProjectWithStatus[];
  anchor: ProjectStatusAnchor;
}
```

- [ ] **Step 2: Add `activeWindowHours` to the `Settings` interface (line 122)**

Replace the `Settings` interface with:

```ts
export interface Settings {
  schemaVersion: number;
  workdayHours: number;
  defaultPomodoroDuration: number;
  restMinutes: number;
  startBeepSound: BeepSound;
  endBeepSound: BeepSound;
  audioEnabled: boolean;
  notificationsEnabled: boolean;
  activeWindowHours: number;
}
```

- [ ] **Step 3: Extend `SessionMeta` with optional anchor info? No — anchor lives on the response, not per-row**

Add a new response interface after `SessionMeta` (around line 64):

```ts
export interface SessionsResponse {
  sessions: SessionMeta[];
  anchor: string | null;  // ISO; null when hours=0 or no sessions
}
```

- [ ] **Step 4: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors. (If a downstream consumer types break, leave them — they'll be fixed in the next tasks.)

If there ARE compile errors at this point, they're from existing consumers using the old `{projects: Project[]}` shape. That's expected — those consumers (`ProjectsContext.tsx`, etc.) get updated next. If the errors are *only* in those files, proceed.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): add DerivedStatus, ProjectsResponse, SessionsResponse types

Mirrors the new server-side response shapes. activeWindowHours added to
Settings interface. ProjectsResponse wraps the projects array with a
top-level anchor; SessionsResponse adds an optional anchor field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Update `ProjectsContext` to consume derivedStatus + anchor

**Files:**
- Modify: `web/src/ProjectsContext.tsx`

- [ ] **Step 1: Update imports and Ctx interface**

Replace lines 1–35 with:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import {
  apiRequest, Project, Task, DerivedStatus, ProjectStatusAnchor, ProjectsResponse, ProjectWithStatus,
} from "./api";

export interface NewProject {
  name: string;
  color?: string;
  tags?: string[];
  notes?: string;
  abbreviation?: string | null;
  working_dir?: string | null;
}

export interface NewTask {
  project_id: string;
  name: string;
  notes?: string;
}

interface Ctx {
  projects: Project[];
  projectById: Map<string, Project>;
  derivedStatusByProjectId: Map<string, DerivedStatus>;
  projectsAnchor: ProjectStatusAnchor;
  tasks: Task[];
  tasksByProject: Map<string, Task[]>;
  taskById: Map<string, Task>;
  assignmentsByTmux: Map<string, string>;
  loading: boolean;
  refresh: () => Promise<void>;
  createProject: (data: NewProject) => Promise<Project>;
  updateProject: (id: string, patch: Partial<Project>) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  createTask: (data: NewTask) => Promise<Task>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  setAssignment: (tmuxSessionName: string, projectId: string | null) => Promise<void>;
}
```

- [ ] **Step 2: Update the provider to store anchor + derived statuses**

Replace lines 39–55 (state + refresh) with:

```tsx
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectWithStatus[]>([]);
  const [anchor, setAnchor] = useState<ProjectStatusAnchor>({ ts: null, activeWindowHours: 72 });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [pr, tr, ar] = await Promise.all([
      apiRequest<ProjectsResponse>("GET", "/api/projects"),
      apiRequest<{ tasks: Task[] }>("GET", "/api/tasks"),
      apiRequest<{ assignments: Record<string, string> }>("GET", "/api/assignments"),
    ]);
    if (pr.ok) {
      const body = pr.body as ProjectsResponse;
      setProjects(body.projects);
      setAnchor(body.anchor);
    }
    if (tr.ok) setTasks((tr.body as { tasks: Task[] }).tasks);
    if (ar.ok) setAssignments((ar.body as { assignments: Record<string, string> }).assignments);
    setLoading(false);
  }, []);
```

- [ ] **Step 3: Add derivedStatusByProjectId memo and expose it**

After the existing `assignmentsByTmux` memo (around line 132), add:

```tsx
  const derivedStatusByProjectId = useMemo(() => {
    const m = new Map<string, DerivedStatus>();
    for (const p of projects) {
      if (p.derivedStatus) m.set(p.id, p.derivedStatus);
    }
    return m;
  }, [projects]);
```

Update the provider's `value` to expose the new fields (around line 134):

```tsx
  return (
    <ProjectsContext.Provider value={{
      projects, projectById,
      derivedStatusByProjectId,
      projectsAnchor: anchor,
      tasks, tasksByProject, taskById,
      assignmentsByTmux,
      loading, refresh,
      createProject, updateProject, deleteProject,
      createTask, updateTask, deleteTask,
      setAssignment,
    }}>
      {children}
    </ProjectsContext.Provider>
  );
}
```

- [ ] **Step 4: Verify the app still compiles**

```bash
npx tsc --noEmit -p .
```

Errors will appear in `pages/Projects.tsx` (which still uses the removed `statusOf`). That's expected and gets fixed in Task 9. The error count should be small (Projects.tsx + maybe Sessions.tsx).

- [ ] **Step 5: Commit**

```bash
git add web/src/ProjectsContext.tsx
git commit -m "feat(web): ProjectsContext exposes derivedStatusByProjectId + anchor

Switches GET /api/projects consumption to the new {projects, anchor}
shape and re-exposes a derivedStatusByProjectId map plus projectsAnchor
for downstream rendering. Status logic is no longer duplicated client-side.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Update `SettingsContext` defaults

**Files:**
- Modify: `web/src/SettingsContext.tsx` (lines 4–13)

- [ ] **Step 1: Add activeWindowHours to DEFAULTS**

Replace lines 4–13 with:

```tsx
const DEFAULTS: Settings = {
  schemaVersion: 4,
  workdayHours: 8,
  defaultPomodoroDuration: 25,
  restMinutes: 5,
  startBeepSound: "soft",
  endBeepSound: "classic",
  audioEnabled: true,
  notificationsEnabled: true,
  activeWindowHours: 72,
};
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit -p .
```

Same expected errors as before (only in `Projects.tsx`, etc.).

- [ ] **Step 3: Commit**

```bash
git add web/src/SettingsContext.tsx
git commit -m "feat(web): SettingsContext defaults updated for schema v4

activeWindowHours: 72 added to the local DEFAULTS used before the first
fetch resolves. Matches server schema v4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — UI

### Task 9: Replace status pill on Projects tab with three chips + anchor header

**Files:**
- Modify: `web/src/pages/Projects.tsx`

- [ ] **Step 1: Remove the old `statusOf` and `tmuxFor` helpers**

In `web/src/pages/Projects.tsx`, delete lines 10–21 (the type alias `Status` and the two helper functions). The new status comes from the context as `DerivedStatus`.

Update line 10–22 region by replacing with:

```tsx
import type { DerivedStatus } from "../api";
```

(Only the import line — no helper functions needed.)

- [ ] **Step 2: Update the `useProjects()` destructuring in the `Projects` component**

Find the existing `const { ... } = useProjects();` near the top of the `Projects` function (around line 65). Add `derivedStatusByProjectId, projectsAnchor` to the destructured fields. Concretely, the line becomes:

```tsx
const { projects, projectById, tasks, tasksByProject, taskById, assignmentsByTmux, derivedStatusByProjectId, projectsAnchor, loading, createProject, updateProject, deleteProject, createTask, updateTask, deleteTask, setAssignment } = useProjects();
```

(Match the exact set you find in the file — just add the two new names.)

- [ ] **Step 3: Update the sort in `grouped` (around line 126–141)**

Replace the `grouped` useMemo with:

```tsx
  const grouped = useMemo(() => {
    const open: Project[] = [];
    const completed: Project[] = [];
    for (const p of filtered) (p.completed_at ? completed : open).push(p);
    open.sort((a, b) => {
      // Free always first.
      if (a.system && !b.system) return -1;
      if (!a.system && b.system) return 1;
      const da = derivedStatusByProjectId.get(a.id);
      const db = derivedStatusByProjectId.get(b.id);
      // Active before parked.
      const ea = da?.engagement ?? "parked";
      const eb = db?.engagement ?? "parked";
      if (ea !== eb) return ea === "active" ? -1 : 1;
      // Within engagement: in_progress before not_started.
      const pa = da?.progress ?? "not_started";
      const pb = db?.progress ?? "not_started";
      const progOrder = { in_progress: 0, not_started: 1, completed: 2 };
      if (pa !== pb) return progOrder[pa] - progOrder[pb];
      return a.name.localeCompare(b.name);
    });
    completed.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    return { open, completed };
  }, [filtered, derivedStatusByProjectId]);
```

- [ ] **Step 4: Add the anchor header strip**

In the `Projects` component's JSX, right after the existing toolbar `<div>` (the one with the New Project button and search input — ends around line 167), insert an anchor header:

```tsx
      <AnchorHeader anchor={projectsAnchor} />
```

Then add the `AnchorHeader` component at the bottom of the file (before any other helpers):

```tsx
function AnchorHeader({ anchor }: { anchor: { ts: string | null; activeWindowHours: number } }) {
  if (anchor.ts === null) {
    return (
      <div className="text-xs text-slate-500 bg-slate-900/60 border border-slate-800 rounded px-3 py-1.5">
        No pomodoros yet — all projects are parked.
      </div>
    );
  }
  const d = new Date(anchor.ts);
  const fmt = d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
  return (
    <div className="text-xs text-slate-500 bg-slate-900/60 border border-slate-800 rounded px-3 py-1.5">
      Active window: <span className="text-slate-300">{anchor.activeWindowHours}h</span>{" "}
      since last pomodoro at <span className="text-slate-300">{fmt}</span>.
    </div>
  );
}
```

- [ ] **Step 5: Replace the status pill inside `ProjectCard`**

Find the `ProjectCard` component (around line 227). Replace the props destructuring and status pill region.

Replace the `ProjectCard` signature and head (lines 227–290) with:

```tsx
function ProjectCard({ project, tasks, derivedStatus, stats, minsByTask, onClick }: {
  project: Project;
  tasks: Task[];
  derivedStatus: DerivedStatus | null;
  stats: ProjectStats;
  minsByTask: Map<string, number>;
  onClick: () => void;
}) {
  const { settings } = useSettings();
  const fmt = (m: number) => formatDuration(m, settings.workdayHours);

  const openTasks = tasks.filter(t => !t.completed_at);
  const doneTasks = tasks.filter(t => t.completed_at);
  const previewTasks = openTasks.slice(0, 5);

  const progress = derivedStatus?.progress ?? "not_started";
  const engagement = derivedStatus?.engagement ?? "parked";
  const tmuxName = derivedStatus?.tmux_session_name ?? null;

  return (
    <button
      onClick={onClick}
      className="text-left border rounded bg-slate-900/40 hover:bg-slate-900/70 p-4 flex flex-col gap-2 border-slate-800"
      style={{ borderLeft: `5px solid ${project.color}` }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <div className="font-semibold text-base">{project.name}</div>
        {project.system && <span className="text-[10px] text-slate-500 uppercase tracking-wider">system</span>}
        <div className="ml-auto flex items-center gap-1">
          <ProgressChip progress={progress} />
          <EngagementChip engagement={engagement} />
          {tmuxName && <TmuxChip name={tmuxName} />}
        </div>
      </div>
      {project.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {project.tags.map(tag => (
            <span key={tag} className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">{tag}</span>
          ))}
        </div>
      )}
      {progress === "completed" && project.completed_at && (
        <div className="text-xs text-slate-500">completed {new Date(project.completed_at).toLocaleDateString()}</div>
      )}
```

(Continue with the existing stats grid + tasks region unchanged — leave everything from the `<div className="text-sm text-slate-400 grid grid-cols-3 …">` line onward as-is.)

Add the three chip components at the bottom of the file (after `AnchorHeader`):

```tsx
function ProgressChip({ progress }: { progress: "not_started" | "in_progress" | "completed" }) {
  const styles = {
    not_started: { bg: "bg-slate-800", text: "text-slate-400", label: "not started" },
    in_progress: { bg: "bg-blue-900/50", text: "text-blue-300", label: "in progress" },
    completed:   { bg: "bg-green-900/50", text: "text-green-300", label: "✓ completed" },
  }[progress];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles.bg} ${styles.text}`}>{styles.label}</span>;
}

function EngagementChip({ engagement }: { engagement: "active" | "parked" }) {
  const styles = engagement === "active"
    ? { bg: "bg-amber-900/50", text: "text-amber-300" }
    : { bg: "bg-slate-800",    text: "text-slate-500" };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${styles.bg} ${styles.text}`}>{engagement}</span>;
}

function TmuxChip({ name }: { name: string }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-300 font-mono" title={`tmux session: ${name}`}>
      ⌗ {name}
    </span>
  );
}
```

- [ ] **Step 6: Update the call sites that render `ProjectCard`**

Find the two places that render `ProjectCard` (around lines 176 and 194). Update both to pass `derivedStatus` instead of `assignmentsByTmux` + `tmuxClaude`:

```tsx
        {grouped.open.map(p => (
          <ProjectCard
            key={p.id}
            project={p}
            tasks={tasksByProject.get(p.id) ?? []}
            derivedStatus={derivedStatusByProjectId.get(p.id) ?? null}
            stats={statsByProject.get(p.id) ?? emptyStats()}
            minsByTask={minsByTask}
            onClick={() => setSelectedId(p.id)}
          />
        ))}
```

(And the same for the `grouped.completed.map` block.)

- [ ] **Step 7: Remove the now-unused `tmuxClaude` and related code**

Search for `tmuxClaude` in the file and remove any reference that becomes dead. The `BrainCircuit` icon and the "active in <tmux>" subtitle line within ProjectCard (lines ~268–284 before changes) should already be gone after Step 5.

Quick verification:

```bash
grep -n "tmuxClaude\|statusOf\|tmuxFor" web/src/pages/Projects.tsx
```

Expected: no matches. If any remain, delete them.

- [ ] **Step 8: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors in `Projects.tsx`. (Other files may still error pending later tasks.)

- [ ] **Step 9: Visual verification in browser**

```bash
npm run dev
```

Open http://localhost:5173 → Projects tab. Verify:

1. Anchor header reads "Active window: 72h since last pomodoro at <recent date>".
2. Each project card shows three chips top-right: progress chip + engagement chip + (if attached) tmux chip.
3. `Simulacrum` (live tmux `Sim`, presumably has recent pomodoros) shows `[in progress] [active] [⌗ Sim]`.
4. `StarCompliance Investor` (no live tmux, no recent pomodoros) shows `[in progress] [parked]` — **no longer shows "active in StarCompInv"**. Verifies the bug fix.
5. Sort order: any active projects first, then in-progress-parked, then not-started.

- [ ] **Step 10: Stop dev server and commit**

```bash
git add web/src/pages/Projects.tsx
git commit -m "feat(web): Projects tab renders three chips + anchor header

Replaces the old single 'active/parked/completed' pill with separate
ProgressChip + EngagementChip + TmuxChip rendered from server-computed
derivedStatus. Anchor header above the project grid shows the active
window and the most-recent-pomodoro timestamp. Sort: active first, then
in_progress before not_started.

Resolves the 'stale active' bug (StarCompliance Investor no longer
displays as active without a live tmux session).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Add "Show completed" toggle to Pomodoro picker

**Files:**
- Modify: `web/src/pages/Pomodoro.tsx`

- [ ] **Step 1: Locate the eligibleProjects filter (line ~269)**

The current line reads:

```tsx
const eligibleProjects = projects.filter(p => !p.completed_at);
```

This already hides completed projects from the picker. We extend it with a toggle that, when on, shows them grayed and unselectable.

- [ ] **Step 2: Add state for the toggle near other picker state**

Near the top of the `Pomodoro` component (after `pickedProjects` state at line 63), add:

```tsx
const [showCompletedInPicker, setShowCompletedInPicker] = useState(false);
```

- [ ] **Step 3: Replace the `eligibleProjects` computation**

Replace line 269 with:

```tsx
  const eligibleProjects = showCompletedInPicker
    ? projects
    : projects.filter(p => !p.completed_at);
```

- [ ] **Step 4: Find the project picker buttons (around line 377)**

Locate the JSX that maps `eligibleProjects` to clickable buttons. The current code looks something like:

```tsx
{eligibleProjects.map(p => (
  <button
    key={p.id}
    onClick={() => togglePickedProject(p.id)}
    className={`px-2 py-0.5 rounded text-xs border ${pickedProjects.includes(p.id) ? "border-white" : "border-transparent opacity-70 hover:opacity-100"}`}
    ...
```

Replace each `<button>` render to disable clicks on completed projects:

```tsx
{eligibleProjects.map(p => {
  const isCompleted = !!p.completed_at;
  return (
    <button
      key={p.id}
      type="button"
      onClick={isCompleted ? undefined : () => togglePickedProject(p.id)}
      disabled={isCompleted}
      title={isCompleted ? "Project is completed — reopen it from the Projects tab to log time" : undefined}
      className={`px-2 py-0.5 rounded text-xs border ${
        isCompleted ? "border-transparent opacity-40 cursor-not-allowed" :
        pickedProjects.includes(p.id) ? "border-white" : "border-transparent opacity-70 hover:opacity-100"
      }`}
      style={{ background: p.color }}
    >
      {p.name}
    </button>
  );
})}
```

(Preserve any existing className for non-completed state and any project-coloring you find in the actual code — only add the completed-state branch.)

- [ ] **Step 5: Add the Show-completed toggle in the picker header**

Find the picker row (just before the `eligibleProjects.map` block). Add a checkbox to the same row:

```tsx
<label className="flex items-center gap-1 text-xs text-slate-400 ml-2">
  <input
    type="checkbox"
    checked={showCompletedInPicker}
    onChange={e => setShowCompletedInPicker(e.target.checked)}
  />
  Show completed
</label>
```

- [ ] **Step 6: Visual verification**

```bash
npm run dev
```

Pomodoro tab. Verify:

1. Default: completed projects don't appear in the picker (existing behavior preserved).
2. Check "Show completed" → completed projects appear grayed.
3. Click on a grayed completed project → nothing happens (cursor: not-allowed).
4. Click on a non-completed project → normal selection toggles.

- [ ] **Step 7: Stop dev server and commit**

```bash
git add web/src/pages/Pomodoro.tsx
git commit -m "feat(web): Show-completed toggle on Pomodoro picker

Completed projects remain hidden by default. New toggle reveals them
grayed + unselectable, providing discoverability without offering a
direct path to log time on a completed project.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Display anchor on Sessions tab

**Files:**
- Modify: `web/src/pages/Sessions.tsx`

- [ ] **Step 1: Update the sessions fetch to read the new response shape**

In `Sessions.tsx`, update the state and refresh logic. Replace lines 12–29 with:

```tsx
  const [hours, setHours] = useState<number>(24);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [tmux, setTmux] = useState<TmuxResponse | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const { assignmentsByTmux, projectById } = useProjects();

  async function refresh() {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([
        getJSON<{ sessions: SessionMeta[]; anchor: string | null }>(`/api/sessions?hours=${hours || 999999}`),
        getJSON<TmuxResponse>("/api/tmux"),
      ]);
      setSessions(s.sessions);
      setAnchor(s.anchor);
      setTmux(t);
    } finally { setLoading(false); }
  }
```

- [ ] **Step 2: Add the anchor line under the hours dropdown**

In the toolbar JSX (around lines 68–92), after the closing `</div>` of the toolbar row, insert:

```tsx
      <AnchorLine anchor={anchor} hours={hours} />
```

Then add the component at the bottom of the file:

```tsx
function AnchorLine({ anchor, hours }: { anchor: string | null; hours: number }) {
  if (anchor === null || hours <= 0) return null;
  const end = new Date(anchor);
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  const fmt = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
  return (
    <div className="text-xs text-slate-500 -mt-2">
      Anchor: last interaction <span className="text-slate-300">{fmt(end)}</span> —
      showing sessions <span className="text-slate-300">{fmt(start)}</span> → <span className="text-slate-300">{fmt(end)}</span>
    </div>
  );
}
```

- [ ] **Step 3: Visual verification**

```bash
npm run dev
```

Sessions tab. Verify:

1. With `Last: 24h`, the anchor line reads "Anchor: last interaction <recent timestamp> — showing sessions <24h before> → <anchor>".
2. The session list is non-empty even if the most recent interaction is from days ago (the window is anchored, not relative to now).
3. With `Last: all time`, the anchor line disappears.

- [ ] **Step 4: Stop dev server and commit**

```bash
git add web/src/pages/Sessions.tsx
git commit -m "feat(web): Sessions tab shows anchor-relative window

Reads the new {sessions, anchor} response from /api/sessions. Adds an
AnchorLine under the hours picker showing 'last interaction at T,
showing sessions from T-Nh to T'. Hidden when 'all time' is selected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Add `activeWindowHours` input to Settings modal

**Files:**
- Modify: `web/src/components/SettingsModal.tsx`

- [ ] **Step 1: Add state for activeWindowHours**

Near the other useState declarations (after `notificationsEnabled` at line 22), add:

```tsx
const [activeWindowHours, setActiveWindowHours] = useState(settings.activeWindowHours);
```

- [ ] **Step 2: Reset it in the open-effect**

Inside the `useEffect` that resets state when the modal opens (line 26–37), add:

```tsx
setActiveWindowHours(settings.activeWindowHours);
```

- [ ] **Step 3: Include it in the save call**

In `handleSave` (line 45–52), add to the save object:

```tsx
      await save({
        workdayHours,
        defaultPomodoroDuration,
        restMinutes,
        startBeepSound,
        endBeepSound,
        audioEnabled,
        notificationsEnabled,
        activeWindowHours,
      });
```

- [ ] **Step 4: Add the input field in the JSX**

After the existing "Rest duration" label block (around line 98), insert:

```tsx
          <label className="block">
            <span className="text-sm text-slate-300">Active window (h) — project marked active if a pomodoro occurred within this many hours of the most recent one</span>
            <input
              type="number" min={1} max={8760} step={1} value={activeWindowHours}
              onChange={e => setActiveWindowHours(Number(e.target.value))}
              className="mt-1 w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm"
            />
          </label>
```

- [ ] **Step 5: Visual verification**

```bash
npm run dev
```

Click the Settings gear. Verify:

1. The new field renders below "Rest duration" with current value 72.
2. Change it to 24, click Save. Modal closes.
3. Reopen the modal — value persists at 24.
4. Inspect `~/.sigmapi2sigma/settings.json` — `"activeWindowHours": 24`.
5. Projects tab anchor header now reads "Active window: 24h since …".
6. Reset to 72 via the modal and Save.

- [ ] **Step 6: Stop dev server and commit**

```bash
git add web/src/components/SettingsModal.tsx
git commit -m "feat(web): SettingsModal adds activeWindowHours input

Numeric input bound to settings.activeWindowHours. Editing it updates
the Projects tab's anchor header and active/parked derivation on next
refresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Final verification and release

### Task 13: End-to-end manual verification + version bump

**Files:**
- Modify: `package.json` (version field)
- Modify: `package-lock.json` (version field — top-level only, run `npm install` to sync if uncertain)

- [ ] **Step 1: Run the full verification matrix from the spec**

```bash
npm run dev
```

Use the running app (and `curl` as needed) to verify each scenario from the spec's testing strategy:

**Progress derivation**
- [ ] Create a new project "Test progress". Status: `not_started` + `parked`. Drawer shows `[ Mark complete ]`.
- [ ] Run one pomodoro on it (1-minute test pomodoro is fine). After it ends, Projects tab shows `in_progress`.
- [ ] Drawer → Mark complete. Status: `completed` + `parked`. Drawer button changes to `[ ↩ Reopen ]`.
- [ ] Try to start a new pomodoro on it: the Pomodoro tab should not list it (toggle "Show completed" — appears grayed, unselectable).
- [ ] Drawer → Reopen. Back to `in_progress`. Delete the test project.

**Engagement derivation**
- [ ] On a project with a pomodoro from <72h ago: engagement = `active`. Tooltip on chip can be empty for now.
- [ ] Settings → Active window = 1h → Save → refresh Projects: any project whose most-recent pomodoro is >1h old becomes `parked`.
- [ ] Reset to 72h.

**Tmux attached derivation**
- [ ] Open a live tmux session with one of your existing assignment names (`Sim`, `CenDiaUne`). The matching project row shows the `⌗ Sim` chip.
- [ ] Kill that tmux session. Refresh Projects (it auto-refreshes within ~60s, or click anywhere triggering a refetch). The tmux chip disappears.

**Pomodoro guard**
- [ ] Complete a project via PATCH:
  ```bash
  curl -s -X PATCH http://localhost:5174/api/projects/<id> \
    -H "content-type: application/json" \
    -d '{"completed_at":"2026-05-16T00:00:00Z"}'
  ```
- [ ] POST a pomodoro for it → expect 409 with "is completed — reopen it before logging time".
- [ ] PATCH it back to null.

**Anchors**
- [ ] Projects-tab anchor header matches the timestamp of your latest pomodoro.
- [ ] Sessions-tab anchor line matches the timestamp of your latest Claude session interaction.

**Sort order on Projects tab**
- [ ] Visually scan the project grid: active engagement first, then in_progress + parked, then not_started, then completed.

- [ ] **Step 2: Bump version**

Edit `package.json` line 4 from `"version": "0.2.0"` to `"version": "0.3.0"`. Then update `package-lock.json` the same way (lines 3 and ~9 both have a `"version": "0.2.0"` in the top-level package descriptor):

```bash
grep -n '"version": "0.2.0"' package.json package-lock.json
```

For each match, change to `"0.3.0"`.

- [ ] **Step 3: Stop dev server**

Ctrl-C the dev server.

- [ ] **Step 4: Commit and tag**

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 0.3.0

v0.3.0 ships the project status model — three orthogonal derived
fields (progress / engagement / tmux_attached) replacing the single
'active/parked/completed' pill on the Projects tab. Engagement uses a
global pomodoro anchor + configurable activeWindowHours (default 72)
so weekends stay 'warm'. Completed projects are blocked from receiving
new pomodoros. Sessions tab gains the same anchor-relative window for
its hours filter.

See docs/superpowers/specs/2026-05-16-project-status-model-design.md
for the full design, and docs/superpowers/plans/2026-05-16-project-status-model.md
for the implementation plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git tag -a v0.3.0 -m "v0.3.0"
```

- [ ] **Step 5: Push (only after explicit user confirmation)**

This step is intentionally **not run automatically** — pushing to `main` is a shared-state action. Ask the user before running:

```bash
git push origin main
git push origin v0.3.0
```

---

## Notes for the implementing engineer

1. **No test runner.** This codebase has no `npm test`. Verification is `npx tsc --noEmit -p .` for type checks and manual browser/curl checks. Don't skip the manual verifications — they're the only safety net.

2. **Dev server.** `npm run dev` runs both server (5174) and Vite (5173) under `concurrently`. The Vite dev server proxies `/api/*` to the server. Stop with Ctrl-C. The `npm run stop` script is also available as a hammer.

3. **Atomic data writes.** Every JSON write goes through `writeJsonAtomic` (in `server/lib/dataStore.ts`). Don't `fs.writeFile` directly.

4. **ESM imports.** Use `.js` extensions in server `.ts` imports (e.g. `from "../lib/projectStatus.js"`). The build resolves them correctly via tsx.

5. **TypeScript strictness.** The project uses strict mode. If a function returns `T | undefined`, handle the undefined path. The `?? null` and `?? "parked"` defaults in this plan match the existing code style.

6. **Existing Mark-complete / Reopen.** The Projects drawer already has these buttons at `web/src/pages/Projects.tsx:708`. No new wiring needed.

7. **Free project.** The Free project is system-managed and cannot be completed. The PATCH guard at `projects.ts:204-208` already enforces this — no changes needed.

8. **If a step fails.** Don't `--no-verify` past it. Diagnose the failure, fix the underlying issue, and re-commit. If a manual verification step shows wrong output, the implementation in that task is wrong — don't move on.

9. **Plan vs spec.** This plan implements the spec at `docs/superpowers/specs/2026-05-16-project-status-model-design.md`. If you find a contradiction, the spec wins; flag the inconsistency to the human reviewer rather than guessing.
