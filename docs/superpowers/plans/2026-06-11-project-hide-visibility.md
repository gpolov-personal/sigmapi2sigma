# Project Hide / Visibility + Engagement Sectioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual per-project `hidden` flag (pure visibility, not a status) and reorganize the Projects page into Active / Parked / Completed sections plus a toggleable Hidden group sub-split by engagement.

**Architecture:** `hidden` is a new boolean field on `Project`, defaulted to `false` at read time (no schema-version bump). It is orthogonal to the derived `progress` / `engagement` / `tmux_attached` fields — a hidden project still derives `active`/`parked` normally, it's just filtered out of the default view. The drawer gets a Hide/Unhide button (disabled when completed; system/Free project can't be hidden). Completing a project force-clears `hidden`. The Projects page groups open projects by engagement into labeled sections, with hidden projects pulled into a separate Hidden group shown only when the "Show hidden" toggle is ticked.

**Tech Stack:** Node 22 + Express 4 + TypeScript (tsx, ESM, `.js` import specifiers on server) · React 19 + Tailwind + Vite · atomic JSON storage.

**Verification note:** This repo has no unit-test harness (no `test` script, no `*.test.ts`). Per established practice, each task is verified with: `npx tsc` (whole-repo typecheck via root `tsconfig.json`, which has `noEmit`), `npm run build:web` where web code changes, and `curl` smoke tests against the running dev server (backend on `http://localhost:5174`). Start the dev server with `npm run dev` if it isn't already up; check with `curl -s -o /dev/null -w "%{http_code}" http://localhost:5174/api/projects` (expect `200`).

---

### Task 1: Server — add `hidden` field, backfill, validation, PATCH support, guards

**Files:**
- Modify: `server/routes/projects.ts`

- [ ] **Step 1: Add `hidden` to the `Project` interface**

In `server/routes/projects.ts`, the `Project` interface (around line 19-31) — add `hidden` right after `completed_at`:

```ts
export interface Project {
  id: string;
  name: string;
  color: string;
  tags: string[];
  notes: string;
  abbreviation: string | null;    // manual override; null = auto-computed from name
  working_dir: string | null;     // optional cwd used when creating a tmux session for this project
  completed_at: string | null;
  hidden: boolean;                 // manual visibility flag; pure presentation, orthogonal to status
  created_at: string;
  updated_at: string;
  system?: boolean;       // true for the Free project; cannot be deleted/completed
}
```

- [ ] **Step 2: Backfill `hidden` on legacy records in `loadProjects`**

In `loadProjects` (around line 97-101), extend the backfill loop:

```ts
  // Backfill missing fields on legacy records.
  for (const p of file.projects) {
    if (p.abbreviation === undefined) { p.abbreviation = null; mutated = true; }
    if (p.working_dir === undefined) { p.working_dir = null; mutated = true; }
    if (p.hidden === undefined) { p.hidden = false; mutated = true; }
  }
```

- [ ] **Step 3: Default `hidden: false` on the Free project**

In `buildFreeProject` (around line 70-84), add `hidden: false` to the returned object, after `completed_at: null,`:

```ts
    completed_at: null,
    hidden: false,
    created_at: now,
    updated_at: now,
    system: true,
```

- [ ] **Step 4: Validate `hidden` is a boolean**

In `validateProjectInput` (around line 108-171), add this check right before the final `return null;`:

```ts
  if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
    return { status: 400, error: "hidden must be boolean" };
  }
  return null;
```

- [ ] **Step 5: Default `hidden: false` on newly created projects**

In the `POST /projects` handler (around line 216-227), add `hidden: false` to the constructed `project` object, after `completed_at: body.completed_at ?? null,`:

```ts
    completed_at: body.completed_at ?? null,
    hidden: false,
    created_at: now,
    updated_at: now,
```

- [ ] **Step 6: Allow `hidden` through PATCH**

In `server/routes/projects.ts`, update `ALLOWED_PATCH` (line 233):

```ts
const ALLOWED_PATCH = new Set(["name", "color", "tags", "notes", "completed_at", "abbreviation", "working_dir", "hidden"]);
```

- [ ] **Step 7: Add hide guards + merge + force-clear-on-complete in PATCH**

In the `PATCH /projects/:id` handler, after the existing Free-project guards block (the `if (prev.system) { ... }` block ending around line 251) and before the `const err = validateProjectInput(...)` call, insert the hide guards:

```ts
  // Hide guards: completed and system/Free projects cannot be hidden.
  const willBeCompleted = body.completed_at !== undefined
    ? body.completed_at !== null
    : prev.completed_at !== null;
  if (body.hidden === true && willBeCompleted) {
    return res.status(409).json({ error: "completed projects cannot be hidden" });
  }
  if (body.hidden === true && prev.system) {
    return res.status(409).json({ error: "the Free project cannot be hidden" });
  }
```

Then in the `next` object construction (around line 256-266), add the `hidden` merge line after the `working_dir` line and before `updated_at`:

```ts
    ...(body.working_dir !== undefined ? { working_dir: body.working_dir === null || (typeof body.working_dir === "string" && body.working_dir.trim() === "") ? null : body.working_dir.trim() } : {}),
    ...(body.hidden !== undefined ? { hidden: !!body.hidden } : {}),
    updated_at: new Date().toISOString(),
  };

  // Completing a project always clears hidden — completed projects are never hidden.
  if (body.completed_at !== undefined && body.completed_at !== null) {
    next.hidden = false;
  }
```

(The `next.hidden = false` block goes immediately after the `next` object literal closes, before the existing "Auto-release tmux assignment" block.)

- [ ] **Step 8: Typecheck**

Run: `npx tsc`
Expected: no output (exit 0). If `hidden` is missing anywhere a `Project` is constructed, tsc will flag it — fix by adding `hidden: false`.

- [ ] **Step 9: Smoke-test with curl**

Ensure the dev server is running (`npm run dev` in another terminal). Pick a real non-system project id:

```bash
PID=$(curl -s http://localhost:5174/api/projects | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.projects.find(p=>!p.system && !p.completed_at).id)')
echo "using $PID"
# hide it
curl -s -X PATCH http://localhost:5174/api/projects/$PID -H 'Content-Type: application/json' -d '{"hidden":true}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log("hidden=",d.hidden)'
# expect hidden= true
# completing must clear hidden
curl -s -X PATCH http://localhost:5174/api/projects/$PID -H 'Content-Type: application/json' -d '{"completed_at":"2026-06-11T12:00:00Z"}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log("completed=",d.completed_at,"hidden=",d.hidden)'
# expect completed= 2026-06-11T12:00:00Z hidden= false
# hiding a completed project must 409
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://localhost:5174/api/projects/$PID -H 'Content-Type: application/json' -d '{"hidden":true}'
# expect 409
# clean up: reopen + unhide
curl -s -X PATCH http://localhost:5174/api/projects/$PID -H 'Content-Type: application/json' -d '{"completed_at":null,"hidden":false}' >/dev/null
echo "restored"
```

Expected outputs are annotated inline above. **Important:** confirm the project id you picked is restored (not left completed/hidden) at the end.

- [ ] **Step 10: Commit**

```bash
git add server/routes/projects.ts
git commit -m "feat(server): projects gain manual hidden flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Web — add `hidden` to the `Project` type

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add `hidden` to the web `Project` interface**

In `web/src/api.ts`, the `Project` interface (around line 99-111) — add `hidden` after `completed_at`:

```ts
export interface Project {
  id: string;
  name: string;
  color: string;
  tags: string[];
  notes: string;
  abbreviation: string | null;
  working_dir: string | null;
  completed_at: string | null;
  hidden: boolean;
  created_at: string;
  updated_at: string;
  system?: boolean;
}
```

(`ProjectWithStatus extends Project`, so `hidden` flows through to the projects list automatically. `updateProject` already accepts `Partial<Project>`, so no context change is needed.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): Project type gains hidden field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Web — Hide / Unhide button in the project drawer

**Files:**
- Modify: `web/src/pages/Projects.tsx`

- [ ] **Step 1: Import the eye icons**

In `web/src/pages/Projects.tsx`, line 2, add `Eye` and `EyeOff` to the lucide-react import:

```ts
import { Plus, X, Trash2, Check, RotateCcw, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
```

- [ ] **Step 2: Add a `toggleHidden` handler in `ProjectDrawer`**

In the `ProjectDrawer` component, immediately after the `toggleComplete` function (ends around line 455), add:

```ts
  async function toggleHidden() {
    setError(null); setBusy(true);
    try {
      await updateProject(project.id, { hidden: !project.hidden });
      onClose();
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
```

- [ ] **Step 3: Add the Hide/Unhide button to the drawer action row**

In the drawer action row (around line 679-694), insert the Hide button between the Mark-complete button and the Delete button:

```tsx
            {!project.system && (
              <button onClick={toggleComplete} disabled={busy}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm">
                {project.completed_at ? <><RotateCcw size={14} /> Reopen</> : <><Check size={14} /> Mark complete</>}
              </button>
            )}
            {!project.system && (
              <button onClick={toggleHidden} disabled={busy || !!project.completed_at}
                title={project.completed_at
                  ? "Completed projects can't be hidden"
                  : (project.hidden ? "Show this project in the main list" : "Hide this project from the main list")}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm disabled:opacity-50">
                {project.hidden ? <><Eye size={14} /> Unhide</> : <><EyeOff size={14} /> Hide</>}
              </button>
            )}
            {!project.system && (
              <button onClick={doDelete} disabled={busy}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm text-white ml-auto"
              ><Trash2 size={14} /> Delete</button>
            )}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Projects.tsx
git commit -m "feat(web): Hide/Unhide button in project drawer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Web — engagement sections + Show-hidden toggle + Hidden group

**Files:**
- Modify: `web/src/pages/Projects.tsx`

- [ ] **Step 1: Add `showHidden` state**

In the `Projects` component, next to `showCompleted` (line 53):

```ts
  const [showCompleted, setShowCompleted] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
```

- [ ] **Step 2: Replace the `grouped` useMemo with engagement+hidden buckets**

Replace the entire `grouped` useMemo (currently lines 99-122) with:

```ts
  const grouped = useMemo(() => {
    const activeVisible: Project[] = [];
    const parkedVisible: Project[] = [];
    const hiddenActive: Project[] = [];
    const hiddenParked: Project[] = [];
    const completed: Project[] = [];
    for (const p of filtered) {
      if (p.completed_at) { completed.push(p); continue; }
      const eng = derivedStatusByProjectId.get(p.id)?.engagement ?? "parked";
      if (p.hidden) (eng === "active" ? hiddenActive : hiddenParked).push(p);
      else (eng === "active" ? activeVisible : parkedVisible).push(p);
    }
    // Within a section: Free first, in_progress before not_started, then by name.
    const cmp = (a: Project, b: Project) => {
      if (a.system && !b.system) return -1;
      if (!a.system && b.system) return 1;
      const da = derivedStatusByProjectId.get(a.id);
      const db = derivedStatusByProjectId.get(b.id);
      const pa = da?.progress ?? "not_started";
      const pb = db?.progress ?? "not_started";
      const progOrder = { in_progress: 0, not_started: 1, completed: 2 };
      if (pa !== pb) return progOrder[pa] - progOrder[pb];
      return a.name.localeCompare(b.name);
    };
    activeVisible.sort(cmp);
    parkedVisible.sort(cmp);
    hiddenActive.sort(cmp);
    hiddenParked.sort(cmp);
    completed.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    return { activeVisible, parkedVisible, hiddenActive, hiddenParked, completed };
  }, [filtered, derivedStatusByProjectId]);

  const hiddenCount = grouped.hiddenActive.length + grouped.hiddenParked.length;
```

- [ ] **Step 3: Add a `renderGrid` helper inside the component**

Immediately after the `selected` line (currently line 124: `const selected = selectedId ? ... : null;`), add:

```tsx
  const renderGrid = (list: Project[]) => (
    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(26rem, 1fr))" }}>
      {list.map(p => (
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
    </div>
  );
```

- [ ] **Step 4: Replace the header right-side toggles**

Replace the single "Show completed" label (currently lines 141-147) with a right-aligned group holding both toggles:

```tsx
        <div className="ml-auto flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox" checked={showCompleted}
              onChange={e => setShowCompleted(e.target.checked)}
            />
            Show completed
          </label>
          {hiddenCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-slate-400">
              <input
                type="checkbox" checked={showHidden}
                onChange={e => setShowHidden(e.target.checked)}
              />
              Show hidden ({grouped.hiddenActive.length} active, {grouped.hiddenParked.length} parked)
            </label>
          )}
        </div>
```

- [ ] **Step 5: Replace the body (empty-state + grids) with sectioned rendering**

Replace the block from the empty-state line through the end of the Completed section (currently lines 154-189 — the `{!loading && grouped.open.length === 0 ...}` empty state, the open grid, and the `{showCompleted && ...}` completed block) with:

```tsx
      {!loading
        && grouped.activeVisible.length === 0
        && grouped.parkedVisible.length === 0
        && grouped.completed.length === 0
        && hiddenCount === 0 && (
        <div className="text-slate-500 text-sm">No projects yet.</div>
      )}

      {grouped.activeVisible.length > 0 && (
        <>
          <div className="text-sm text-slate-400">Active ({grouped.activeVisible.length})</div>
          {renderGrid(grouped.activeVisible)}
        </>
      )}

      {grouped.parkedVisible.length > 0 && (
        <>
          <div className="text-sm text-slate-400 mt-6">Parked ({grouped.parkedVisible.length})</div>
          {renderGrid(grouped.parkedVisible)}
        </>
      )}

      {showCompleted && grouped.completed.length > 0 && (
        <>
          <div className="text-sm text-slate-400 mt-6">Completed ({grouped.completed.length})</div>
          {renderGrid(grouped.completed)}
        </>
      )}

      {showHidden && hiddenCount > 0 && (
        <>
          <div className="text-sm text-slate-300 mt-8 font-medium">Hidden</div>
          {grouped.hiddenActive.length > 0 && (
            <>
              <div className="text-xs text-slate-500 mt-2 ml-1">Active ({grouped.hiddenActive.length})</div>
              {renderGrid(grouped.hiddenActive)}
            </>
          )}
          {grouped.hiddenParked.length > 0 && (
            <>
              <div className="text-xs text-slate-500 mt-2 ml-1">Parked ({grouped.hiddenParked.length})</div>
              {renderGrid(grouped.hiddenParked)}
            </>
          )}
        </>
      )}
```

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc && npm run build:web`
Expected: tsc no output; vite build completes with no errors (a `dist/` is produced).

- [ ] **Step 7: Manual UI verification**

With `npm run dev` running, open the web UI (Vite on `http://localhost:5173`), go to the Projects tab and confirm:
- Projects appear under **Active (N)** and **Parked (N)** headers (whichever have items).
- Open a non-completed project's drawer → **Hide** → drawer closes; the project disappears from Active/Parked; the header now shows **Show hidden (… active, … parked)**.
- Tick **Show hidden** → a **Hidden** group appears with **Active** / **Parked** sub-headers containing the hidden project.
- Open the hidden project → **Unhide** → it returns to its main section; when nothing is hidden, the "Show hidden" toggle disappears.
- Open a completed project's drawer (tick Show completed first) → the **Hide** button is disabled.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/Projects.tsx
git commit -m "feat(web): Active/Parked sections + Show hidden toggle + Hidden group

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Release — bump to 1.0.0, tag, push

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Bump the version to 1.0.0**

Edit `package.json` line 3: `"version": "0.4.0",` → `"version": "1.0.0",`.
Edit `package-lock.json`: the top-level `"version"` (line ~3) and the root package entry `packages[""]."version"` — both `0.4.0` → `1.0.0`. (Search for `"version": "0.4.0"`; there are two occurrences in the lock file, both for this package.)

- [ ] **Step 2: Verify the bump**

Run: `node -e 'console.log(require("./package.json").version, require("./package-lock.json").version)'`
Expected: `1.0.0 1.0.0`

- [ ] **Step 3: Commit, tag, push**

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 1.0.0

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

Expected: push reports `main -> main` and `[new tag] v1.0.0 -> v1.0.0`.

---

## Self-Review

**Spec coverage:**
- `hidden` field, manual, default false, read-time normalized → Task 1 (steps 1-2), Task 2.
- Orthogonal to status (no derivation change) → confirmed: no edits to `projectStatus.ts`.
- Can't hide completed (button disabled + server 409) → Task 1 step 7, Task 3 step 3.
- Completing clears hidden → Task 1 step 7.
- Three sections Active/Parked/Completed → Task 4 step 5.
- Hidden group sub-split Active/Parked, only when Show hidden ticked → Task 4 step 5.
- Show hidden control only when something hidden, with engagement count → Task 4 step 4.
- Drawer-only hide control → Task 3.
- System/Free project can't be hidden → Task 1 step 7 (server 409) + Task 3 (`!project.system` gate).
- 1.0.0 release marker → Task 5.

**Placeholder scan:** none — every code/command step shows concrete content.

**Type consistency:** `hidden: boolean` used identically in server `Project` (Task 1.1) and web `Project` (Task 2.1); `toggleHidden`, `showHidden`, `hiddenCount`, `renderGrid`, and the `grouped` keys (`activeVisible`/`parkedVisible`/`hiddenActive`/`hiddenParked`/`completed`) are defined once and referenced consistently across Task 4 steps 2-5.
