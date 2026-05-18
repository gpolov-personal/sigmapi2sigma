# Pomodoro Pause / Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ability to pause and resume an active pomodoro (and rest) one or more times within a session, store total paused_ms on the persisted Pomodoro record, and subtract it from every place that computes pomodoro minutes so attribution reflects actual focus time, not wall-clock elapsed.

**Architecture:** Add a single `paused_ms` field to the `Pomodoro` server schema, normalize legacy records read-time. Extend the localStorage live state (`csv:active-pomodoro` and `csv:active-rest`) with `pausedAt` + `accumulatedPausedMs` fields. Consolidate the six duplicate duration formulas into one shared `pomodoroMinutes()` helper that subtracts `paused_ms`. UI gains Pause/Resume buttons + paused indicators on both active-pomodoro and active-rest cards; tab label shows `⏸` when paused.

**Tech Stack:** Node 22 + Express 4 + TypeScript via tsx (ESM, `.js` imports). React 19 + Tailwind via Vite. Atomic JSON storage. No test runner — manual verification.

**Reference design spec:** `docs/superpowers/specs/2026-05-18-pomodoro-pause-resume-design.md`

---

## File Structure

```
server/
  routes/
    pomodoros.ts                  MODIFY — add paused_ms to interface, normalize, validate

web/src/
  api.ts                          MODIFY — add paused_ms: number to Pomodoro type
  lib/
    pomodoro.ts                   NEW    — pomodoroMinutes() shared helper
    liveTimer.ts                  MODIFY — pausedAt + accumulatedPausedMs (active),
                                            pausedAt (rest), normalization
  pages/
    Pomodoro.tsx                  MODIFY — Pause/Resume on active pomodoro,
                                            paused indicator, frozen counters,
                                            adjusted auto-stop, finalize merges paused_ms,
                                            Pause/Resume on rest card with restEndsAt shift,
                                            drop local pomDurMin
    Projects.tsx                  MODIFY — drop local pomDur, import pomodoroMinutes
  App.tsx                         MODIFY — usePomodoroTabLabel: ⏸ + frozen value when paused
  components/
    DayDrawer.tsx                 MODIFY — drop local pomDurMin, import pomodoroMinutes
    HeatmapCalendar.tsx           MODIFY — replace inline calc with pomodoroMinutes
    MonthGrid.tsx                 MODIFY — replace inline calc with pomodoroMinutes
    PomodoroDetailDrawer.tsx      MODIFY — replace inline calc with pomodoroMinutes
```

10 files modified, 1 new. Nine implementation commits + 1 release commit.

Each task below is self-contained and produces one commit. Steps inside a task should take 2–5 minutes each.

---

## Task 1: Add `pomodoroMinutes()` shared helper

**Files:**
- Create: `web/src/lib/pomodoro.ts`

- [ ] **Step 1: Create the file**

```ts
// web/src/lib/pomodoro.ts
import type { Pomodoro } from "../api";

/**
 * Attributable duration of a pomodoro in minutes.
 *
 * Wall-clock elapsed (ended_at - started_at) minus paused_ms.
 * Legacy records without paused_ms are treated as 0 (no pauses).
 */
export function pomodoroMinutes(p: Pomodoro): number {
  const elapsed = Date.parse(p.ended_at) - Date.parse(p.started_at);
  const paused  = p.paused_ms ?? 0;
  return Math.max(0, (elapsed - paused) / 60000);
}
```

The `p.paused_ms ?? 0` makes this safe to call before the `Pomodoro` type officially has the field (Task 3 adds it). TypeScript will accept the optional chain because `Pomodoro` is a plain interface that doesn't enforce extra fields.

- [ ] **Step 2: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors. (No consumers yet — this is a stand-alone helper.)

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/pomodoro.ts
git commit -m "$(cat <<'EOF'
feat(web): shared pomodoroMinutes() helper

Single source of truth for attributable pomodoro duration. Subtracts
paused_ms from wall-clock elapsed; legacy records without paused_ms
behave identically to before (defaults to 0). No callers yet; later
tasks migrate the six duplicate sites.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `paused_ms` to server `Pomodoro` schema

**Files:**
- Modify: `server/routes/pomodoros.ts`

- [ ] **Step 1: Add field to the `Pomodoro` interface**

In `server/routes/pomodoros.ts`, find the `export interface Pomodoro` block (around line 16). Add a new field just before the closing `}`:

```ts
  /** Total milliseconds the pomodoro was paused. 0 for legacy records and never-paused sessions. */
  paused_ms: number;
```

- [ ] **Step 2: Normalize on read**

Find the existing `normalize()` function (around line 73-77):

```ts
function normalize(p: Pomodoro): Pomodoro {
  if (typeof p.freeTaskLabel !== "string") return { ...p, freeTaskLabel: "" };
  return p;
}
```

Replace with:

```ts
function normalize(p: Pomodoro): Pomodoro {
  const patched: any = { ...p };
  let changed = false;
  if (typeof patched.freeTaskLabel !== "string") { patched.freeTaskLabel = ""; changed = true; }
  if (typeof patched.paused_ms !== "number" || !Number.isFinite(patched.paused_ms) || patched.paused_ms < 0) {
    patched.paused_ms = 0;
    changed = true;
  }
  return changed ? patched : p;
}
```

- [ ] **Step 3: Add validation in POST**

In the POST handler (`pomodorosRouter.post("/pomodoros", ...)` around line 118), find this line:

```ts
const { started_at, ended_at, target_duration_minutes, project_ids, task_ids, notes, freeTaskLabel, source, context } = body;
```

Replace with:

```ts
const { started_at, ended_at, target_duration_minutes, project_ids, task_ids, notes, freeTaskLabel, paused_ms, source, context } = body;
```

Then after the existing `freeTaskLabel` validation block (around line 141-143), add:

```ts
  if (paused_ms !== undefined) {
    if (typeof paused_ms !== "number" || !Number.isFinite(paused_ms) || paused_ms < 0) {
      return res.status(400).json({ error: "paused_ms must be a non-negative finite number" });
    }
    const elapsed = Date.parse(ended_at) - Date.parse(started_at);
    if (paused_ms > elapsed) {
      return res.status(400).json({ error: "paused_ms cannot exceed wall-clock duration" });
    }
  }
```

- [ ] **Step 4: Persist `paused_ms` on the new pomodoro record**

In the POST handler, find the `const pomodoro: Pomodoro = { ... }` literal (around line 176-187). Add a field just before the closing `}` (before `context: ctx,`):

```ts
    paused_ms: typeof paused_ms === "number" && Number.isFinite(paused_ms) ? paused_ms : 0,
```

- [ ] **Step 5: Verify server compiles and the new field round-trips**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors.

Start the dev server briefly:

```bash
npm run dev
```

Post a manual pomodoro with paused_ms via curl (use a non-completed project ID — `tmux ls` and pick `Sim` if alive, or use the SigmaPi2Sigma project ID from `~/.sigmapi2sigma/projects.json`):

```bash
curl -s -X POST http://localhost:5174/api/pomodoros \
  -H "content-type: application/json" \
  -d '{
    "started_at": "2026-05-18T10:00:00Z",
    "ended_at":   "2026-05-18T10:25:00Z",
    "target_duration_minutes": 25,
    "project_ids": ["03144b8b-e191-469f-a49c-8b8a898ed07d"],
    "task_ids": [],
    "source": "manual",
    "paused_ms": 180000
  }' | python3 -m json.tool
```

Expected: the response includes `"paused_ms": 180000`.

Test the validation:

```bash
curl -s -X POST http://localhost:5174/api/pomodoros \
  -H "content-type: application/json" \
  -d '{
    "started_at": "2026-05-18T11:00:00Z",
    "ended_at":   "2026-05-18T11:01:00Z",
    "target_duration_minutes": 1,
    "project_ids": ["03144b8b-e191-469f-a49c-8b8a898ed07d"],
    "task_ids": [],
    "source": "manual",
    "paused_ms": 999999999
  }'
```

Expected: HTTP 400, `{"error":"paused_ms cannot exceed wall-clock duration"}`.

Delete the test pomodoro via direct file edit OR leave it — it's just a 25-min manual record. **Note:** if you want to clean up, find the record in `~/.sigmapi2sigma/pomodoros.json` (search for `"paused_ms": 180000` and `"source": "manual"`) and remove its array entry. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add server/routes/pomodoros.ts
git commit -m "$(cat <<'EOF'
feat(server): pomodoros gain paused_ms field

POST /api/pomodoros accepts an optional non-negative paused_ms; rejects
values exceeding wall-clock elapsed. Read-time normalize legacy records
to 0 (same pattern as freeTaskLabel). The field is immutable post-create
— PATCH still only permits notes and freeTaskLabel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `paused_ms` to frontend `Pomodoro` type

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add field to the Pomodoro interface**

In `web/src/api.ts`, find the `export interface Pomodoro` (around line 133). Add a field after `freeTaskLabel`:

```ts
  /** Total ms paused during this pomodoro. 0 for legacy records and never-paused sessions. */
  paused_ms: number;
```

- [ ] **Step 2: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors. (The `pomodoroMinutes()` helper already uses `?? 0`, so no callers break.)

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "$(cat <<'EOF'
feat(web): Pomodoro type gains paused_ms field

Matches the server schema. pomodoroMinutes() already reads it with
?? 0 fallback so legacy records without the field continue to work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `liveTimer.ts` with pause state

**Files:**
- Modify: `web/src/lib/liveTimer.ts`

- [ ] **Step 1: Extend `LiveTimerState`**

In `web/src/lib/liveTimer.ts`, find the `LiveTimerState` interface (around line 45-51). Replace it with:

```ts
export interface LiveTimerState {
  startedAt: number;
  targetDurationMinutes: number;
  topicIds: string[];        // legacy field name kept for backwards compat: holds project IDs
  taskIds?: string[];        // optional, defaults to [] on load
  freeTaskLabel?: string;    // optional Free-project label, defaults to "" on load
  pausedAt?: number | null;  // ms timestamp when currently paused; null/undefined = running
  accumulatedPausedMs?: number; // total paused ms across prior pause spans; default 0
}
```

- [ ] **Step 2: Normalize pause fields in `loadActive`**

In the same file, find `loadActive()` (around line 53-73). Replace the entire function body inside the `try { ... }` block — keep the validation check, but add the two new fields to the returned object:

```ts
export function loadActive(): LiveTimerState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      typeof v?.startedAt === "number" &&
      typeof v?.targetDurationMinutes === "number" &&
      Array.isArray(v?.topicIds)
    ) {
      return {
        startedAt: v.startedAt,
        targetDurationMinutes: v.targetDurationMinutes,
        topicIds: v.topicIds,
        taskIds: Array.isArray(v.taskIds) ? v.taskIds : [],
        freeTaskLabel: typeof v.freeTaskLabel === "string" ? v.freeTaskLabel : "",
        pausedAt: typeof v.pausedAt === "number" ? v.pausedAt : null,
        accumulatedPausedMs: typeof v.accumulatedPausedMs === "number" && v.accumulatedPausedMs >= 0
          ? v.accumulatedPausedMs : 0,
      };
    }
  } catch {}
  return null;
}
```

- [ ] **Step 3: Extend `LiveRestState`**

In the same file, find the `LiveRestState` interface (around line 6-9). Replace with:

```ts
export interface LiveRestState {
  restEndsAt: number;
  proposal: { projectIds: string[]; taskIds: string[]; durationMinutes: number; freeTaskLabel?: string };
  pausedAt?: number | null;  // ms timestamp when currently paused; null/undefined = running
}
```

Rests do NOT need `accumulatedPausedMs` because they're not persisted as records — we shift `restEndsAt` forward on resume and never look back.

- [ ] **Step 4: Normalize `pausedAt` in `loadRest`**

Find `loadRest()` (around line 11-35). The current return object inside the `if (...) { return { ... } }` block needs one new field. Replace the entire `return { ... }` with:

```ts
      return {
        restEndsAt: v.restEndsAt,
        proposal: {
          projectIds: v.proposal.projectIds,
          taskIds: v.proposal.taskIds,
          durationMinutes: v.proposal.durationMinutes,
          freeTaskLabel: typeof v.proposal.freeTaskLabel === "string" ? v.proposal.freeTaskLabel : "",
        },
        pausedAt: typeof v.pausedAt === "number" ? v.pausedAt : null,
      };
```

- [ ] **Step 5: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors. No consumers use the new fields yet; Task 6 and Task 7 read them.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/liveTimer.ts
git commit -m "$(cat <<'EOF'
feat(web): liveTimer state gains pausedAt + accumulatedPausedMs

LiveTimerState (active pomodoro): pausedAt (number|null) and
accumulatedPausedMs (number) — null/0 defaults preserve backward
compat with existing localStorage entries.

LiveRestState (active rest): pausedAt only — rest is not persisted as
a record, so we shift restEndsAt on resume instead of tracking total
paused time.

Read-time normalization in loadActive() / loadRest() backfills the new
fields for any stale entries left in localStorage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Replace duplicate duration math with `pomodoroMinutes()`

**Files:**
- Modify: `web/src/pages/Pomodoro.tsx`
- Modify: `web/src/pages/Projects.tsx`
- Modify: `web/src/components/DayDrawer.tsx`
- Modify: `web/src/components/HeatmapCalendar.tsx`
- Modify: `web/src/components/MonthGrid.tsx`
- Modify: `web/src/components/PomodoroDetailDrawer.tsx`

- [ ] **Step 1: `web/src/pages/Pomodoro.tsx` — drop `pomDurMin`, import helper**

Around line 18-20, delete:

```ts
function pomDurMin(p: Pomodoro): number {
  return Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
}
```

Add to the imports at the top of the file (after the existing `import { ... } from "../lib/liveTimer";` line):

```ts
import { pomodoroMinutes } from "../lib/pomodoro";
```

Replace all `pomDurMin(...)` calls in this file with `pomodoroMinutes(...)`. There are 3 call sites (`attribute()`, `todayMinutes` reduce, and a render at line 559).

- [ ] **Step 2: `web/src/pages/Projects.tsx` — drop `pomDur`, import helper**

Around line 15-17, delete:

```ts
function pomDur(p: Pomodoro): number {
  return Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
}
```

Add to imports near the top:

```ts
import { pomodoroMinutes } from "../lib/pomodoro";
```

Replace the call in `attributeMinutes()` (around line 26): `const dur = pomDur(p);` → `const dur = pomodoroMinutes(p);`.

Also find the inline calc at line ~850: `const min = (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000;` — replace with `const min = pomodoroMinutes(p);`.

- [ ] **Step 3: `web/src/components/DayDrawer.tsx` — drop `pomDurMin`, import helper**

Around line 21-23, delete:

```ts
function pomDurMin(p: Pomodoro): number {
  return Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
}
```

Add to imports:

```ts
import { pomodoroMinutes } from "../lib/pomodoro";
```

Replace `pomDurMin(...)` call sites (line 34 and 57) with `pomodoroMinutes(...)`.

- [ ] **Step 4: `web/src/components/HeatmapCalendar.tsx` — replace inline calc**

Around line 23 find:

```ts
  const dur = Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
```

Add to imports near the top:

```ts
import { pomodoroMinutes } from "../lib/pomodoro";
```

Replace the inline line with:

```ts
  const dur = pomodoroMinutes(p);
```

- [ ] **Step 5: `web/src/components/MonthGrid.tsx` — replace inline calc**

Same pattern. Around line 18 find:

```ts
  const dur = Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
```

Add import:

```ts
import { pomodoroMinutes } from "../lib/pomodoro";
```

Replace with:

```ts
  const dur = pomodoroMinutes(p);
```

- [ ] **Step 6: `web/src/components/PomodoroDetailDrawer.tsx` — replace inline calc**

Around line 11. Add import:

```ts
import { pomodoroMinutes } from "../lib/pomodoro";
```

Replace:

```ts
  return Math.max(0, (Date.parse(p.ended_at) - Date.parse(p.started_at)) / 60000);
```

With:

```ts
  return pomodoroMinutes(p);
```

(Or replace the whole helper function it's inside with a direct call site. Depends on file shape — preserve the function's signature if other code in the file calls it.)

- [ ] **Step 7: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors. If the build catches an unused `Pomodoro` import in any file (because the local helper that referenced it is gone), remove the import — `pomodoroMinutes` already accepts `Pomodoro`.

- [ ] **Step 8: Grep sanity check**

```bash
grep -rn "Date.parse(p.ended_at) - Date.parse(p.started_at)" web/src/
```

Expected: zero matches. If any inline calc remains, replace it.

```bash
grep -rn "pomDur\|pomDurMin" web/src/
```

Expected: zero matches (only the new `pomodoroMinutes` is in use).

- [ ] **Step 9: Visual smoke test**

```bash
npm run dev
```

Open the Pomodoro tab — the "today" minutes count, the by-project breakdown, and the recent table all render numbers matching what they showed before this change (legacy `paused_ms` is 0, so `pomodoroMinutes` = old `pomDurMin`).

Open the Projects tab — same check on the time-attribution numbers.

Open the Calendar tab — heatmap and month grid still render.

Stop the dev server (Ctrl-C).

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/Pomodoro.tsx web/src/pages/Projects.tsx web/src/components/DayDrawer.tsx web/src/components/HeatmapCalendar.tsx web/src/components/MonthGrid.tsx web/src/components/PomodoroDetailDrawer.tsx
git commit -m "$(cat <<'EOF'
refactor(web): consolidate duration math into pomodoroMinutes()

Six call sites duplicated the same wall-clock formula. They now all
import the shared helper from lib/pomodoro.ts. No behavioral change
for existing data (paused_ms defaults to 0); enables the paused-time
subtraction once Pause/Resume UI lands in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Pause/Resume for active pomodoro

**Files:**
- Modify: `web/src/pages/Pomodoro.tsx`

This task adds Pause/Resume controls, frozen-while-paused counters, adjusted auto-stop, and `paused_ms` plumbing into `finalizePomodoro`. It does NOT change the rest card (Task 7) or the tab label (Task 8).

- [ ] **Step 1: Import the Pause/Play icons**

In `web/src/pages/Pomodoro.tsx`, find the lucide-react import line (line 2):

```tsx
import { Plus, X, AlarmClock, Coffee, Play } from "lucide-react";
```

Replace with:

```tsx
import { Plus, X, AlarmClock, Coffee, Play, Pause } from "lucide-react";
```

(`Play` is already there; `Pause` is added.)

- [ ] **Step 2: Replace the elapsed/remaining/target math**

Find these three lines (around line 103-105):

```ts
const targetMs = active ? active.startedAt + active.targetDurationMinutes * 60_000 : 0;
const remainingMs = active ? targetMs - now : 0;
const elapsedMs = active ? now - active.startedAt : 0;
```

Replace with:

```ts
// When paused, "reference time" is frozen at pausedAt — so elapsed and remaining stop ticking.
// When running, reference is `now`. accumulatedPausedMs is always subtracted from elapsed
// and added to the target so a 25-min pomodoro means 25 mins of work, not wall-clock.
const isPaused = !!(active && active.pausedAt);
const accumulatedPausedMs = active?.accumulatedPausedMs ?? 0;
const referenceMs = active ? (active.pausedAt ?? now) : now;
const targetMs = active
  ? active.startedAt + accumulatedPausedMs + active.targetDurationMinutes * 60_000
  : 0;
const remainingMs = active ? targetMs - referenceMs : 0;
const elapsedMs = active ? referenceMs - active.startedAt - accumulatedPausedMs : 0;
```

- [ ] **Step 3: Add `pauseTimer` and `resumeTimer` callbacks**

Insert these two functions after the existing `stopTimer` (around line 233):

```ts
  function pauseTimer() {
    if (!active || active.pausedAt) return;
    const next: LiveTimerState = { ...active, pausedAt: Date.now() };
    saveActive(next);
    setActive(next);
  }

  function resumeTimer() {
    if (!active || !active.pausedAt) return;
    const additional = Date.now() - active.pausedAt;
    const next: LiveTimerState = {
      ...active,
      pausedAt: null,
      accumulatedPausedMs: (active.accumulatedPausedMs ?? 0) + additional,
    };
    saveActive(next);
    setActive(next);
  }
```

- [ ] **Step 4: Update `finalizePomodoro` to persist `paused_ms`**

Find `finalizePomodoro` (around line 129-151). Replace the body of the function — specifically, change the POST body to include `paused_ms`. Replace the function with:

```ts
  // Use the timer state's taskIds (which is persisted to localStorage) — single source of truth.
  const finalizePomodoro = useCallback(async (state: LiveTimerState, endedAtMs: number) => {
    const startedAt = new Date(state.startedAt).toISOString();
    const endedAt = new Date(endedAtMs).toISOString();
    const accumulatedPausedMs = state.accumulatedPausedMs ?? 0;
    const inProgressPausedMs = state.pausedAt ? Math.max(0, endedAtMs - state.pausedAt) : 0;
    const paused_ms = accumulatedPausedMs + inProgressPausedMs;
    const r = await apiRequest<Pomodoro>("POST", "/api/pomodoros", {
      started_at: startedAt,
      ended_at: endedAt,
      target_duration_minutes: state.targetDurationMinutes,
      project_ids: state.topicIds,
      task_ids: state.taskIds ?? [],
      notes: "",
      freeTaskLabel: state.freeTaskLabel ?? "",
      paused_ms,
      source: "live-timer",
    });
    clearActive();
    setActive(null);
    if (r.ok) {
      const saved = r.body as Pomodoro;
      setPostFlow({ stage: "notes", pomodoro: saved });
      await refreshList();
    } else {
      setError((r.body as { error: string }).error);
    }
  }, [refreshList]);
```

- [ ] **Step 5: Make the auto-stop watcher pause-aware**

Find the auto-stop watcher useEffect (around line 156-172). The check `if (now < targetMs) return;` is still correct because `targetMs` now already includes `accumulatedPausedMs` (from Step 2). But while paused, `referenceMs` is frozen at `active.pausedAt`, so `remainingMs` stays positive. We need to also gate on paused state explicitly to be defensive: replace `if (now < targetMs) return;` with:

```ts
    if (active.pausedAt) return;  // can't auto-stop while paused
    if (now < targetMs) return;
```

- [ ] **Step 6: Render the Pause/Resume button on the active pomodoro card**

Find the active-state button row (around line 363-369):

```tsx
                <>
                  <button onClick={keepGoing} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm">Keep going (+{settings.defaultPomodoroDuration}m)</button>
                  <button onClick={stopTimer} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm text-white">Stop</button>
                  <button onClick={discardActive} title="Discard without saving" className="px-2 py-1.5 text-xs text-slate-500 hover:text-white">discard</button>
                </>
```

Replace with:

```tsx
                <>
                  <button onClick={keepGoing} disabled={isPaused} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm disabled:opacity-40">Keep going (+{settings.defaultPomodoroDuration}m)</button>
                  {isPaused ? (
                    <button onClick={resumeTimer} className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm text-white">
                      <Play size={14} /> Resume
                    </button>
                  ) : (
                    <button onClick={pauseTimer} className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 rounded text-sm text-white">
                      <Pause size={14} /> Pause
                    </button>
                  )}
                  <button onClick={stopTimer} className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded text-sm text-white">Stop</button>
                  <button onClick={discardActive} title="Discard without saving" className="px-2 py-1.5 text-xs text-slate-500 hover:text-white">discard</button>
                </>
```

- [ ] **Step 7: Add a "paused" indicator below the timer**

Find the elapsed-display line (around line 357):

```tsx
              {active && (
                <div className="text-xs text-slate-400">elapsed {fmtMmSs(elapsedMs)} / target {active.targetDurationMinutes}m</div>
              )}
```

Replace with:

```tsx
              {active && (
                <div className="text-xs text-slate-400 flex items-center gap-2">
                  <span>elapsed {fmtMmSs(elapsedMs)} / target {active.targetDurationMinutes}m</span>
                  {isPaused && <span className="text-amber-300">⏸ paused</span>}
                </div>
              )}
```

- [ ] **Step 8: Visual verification**

```bash
npm run dev
```

Open the Pomodoro tab. Test sequence:
1. Pick a project, set duration to 1 minute, click Start. Timer starts counting down.
2. After ~10 seconds, click **Pause**. The elapsed counter freezes at ~0:10. The remaining freezes at ~0:50. The button changes to **Resume**. "⏸ paused" appears.
3. Wait another ~20 seconds. Click **Resume**. Timer continues from where it was (elapsed ~0:10, remaining ~0:50).
4. Let it run to 1:00 elapsed. Auto-stop fires. The persisted pomodoro should have `paused_ms ≈ 20000`. Verify by reading the latest entry in `~/.sigmapi2sigma/pomodoros.json`:

```bash
tail -200 ~/.sigmapi2sigma/pomodoros.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['pomodoros'][-1])"
```

Expected: the most recent pomodoro has a non-zero `paused_ms` value (within ~2s of the actual pause duration).

5. Open Pomodoro tab again. The "today" total minutes should reflect the *adjusted* duration (wall-clock minus paused), not the wall-clock duration.

Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/Pomodoro.tsx
git commit -m "$(cat <<'EOF'
feat(web): Pause / Resume on active pomodoro

Amber Pause button next to red Stop; while paused it becomes green
Resume. Elapsed and remaining counters freeze at pausedAt; auto-stop
target shifts later by accumulatedPausedMs so a 25-min pomodoro means
25 mins of work, not wall-clock. On finalize, paused_ms is computed
from accumulatedPausedMs + any in-progress paused span and persisted
on the Pomodoro record.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Pause/Resume for active rest

**Files:**
- Modify: `web/src/pages/Pomodoro.tsx`

- [ ] **Step 1: Update the rest postFlow type to carry pausedAt**

Find the `postFlow` state declaration (around line 70-80):

```tsx
  const [postFlow, setPostFlow] = useState<
    | null
    | { stage: "notes"; pomodoro: Pomodoro }
    | { stage: "rest"; proposal: NextPomodoroProposal; restEndsAt: number }
    | { stage: "restart-prompt"; proposal: NextPomodoroProposal }
  >(() => {
    // Restore rest state from localStorage if present.
    const r = loadRest();
    if (r) return { stage: "rest", proposal: r.proposal, restEndsAt: r.restEndsAt };
    return null;
  });
```

Replace with:

```tsx
  const [postFlow, setPostFlow] = useState<
    | null
    | { stage: "notes"; pomodoro: Pomodoro }
    | { stage: "rest"; proposal: NextPomodoroProposal; restEndsAt: number; pausedAt: number | null }
    | { stage: "restart-prompt"; proposal: NextPomodoroProposal }
  >(() => {
    // Restore rest state from localStorage if present.
    const r = loadRest();
    if (r) return { stage: "rest", proposal: r.proposal, restEndsAt: r.restEndsAt, pausedAt: r.pausedAt ?? null };
    return null;
  });
```

- [ ] **Step 2: Update rest-remaining computation to freeze while paused**

Find this line (around line 285):

```tsx
const restRemainingMs = postFlow?.stage === "rest" ? Math.max(0, postFlow.restEndsAt - now) : 0;
```

Replace with:

```tsx
const restIsPaused = postFlow?.stage === "rest" && !!postFlow.pausedAt;
const restReferenceMs = postFlow?.stage === "rest" ? (postFlow.pausedAt ?? now) : now;
const restRemainingMs = postFlow?.stage === "rest" ? Math.max(0, postFlow.restEndsAt - restReferenceMs) : 0;
```

- [ ] **Step 3: Add `pauseRest` and `resumeRest` callbacks**

Insert after `skipRest()` (around line 301):

```tsx
  function pauseRest() {
    if (postFlow?.stage !== "rest" || postFlow.pausedAt) return;
    const pausedAt = Date.now();
    saveRest({ restEndsAt: postFlow.restEndsAt, proposal: postFlow.proposal, pausedAt });
    setPostFlow({ ...postFlow, pausedAt });
  }

  function resumeRest() {
    if (postFlow?.stage !== "rest" || !postFlow.pausedAt) return;
    const additional = Date.now() - postFlow.pausedAt;
    const newEndsAt = postFlow.restEndsAt + additional;
    saveRest({ restEndsAt: newEndsAt, proposal: postFlow.proposal, pausedAt: null });
    setPostFlow({ ...postFlow, restEndsAt: newEndsAt, pausedAt: null });
  }
```

- [ ] **Step 4: Gate the rest auto-stop watcher on `pausedAt`**

Find the rest watcher (around line 176-188). Add the paused gate after the stage check:

```tsx
  useEffect(() => {
    if (postFlow?.stage !== "rest") {
      firedRestEndRef.current = null;
      return;
    }
    if (postFlow.pausedAt) return;        // ← NEW: don't auto-end a paused rest
    if (now < postFlow.restEndsAt) return;
```

(Only one line is added: `if (postFlow.pausedAt) return;`. Keep everything else as-is.)

- [ ] **Step 5: Find every `setPostFlow({ stage: "rest", ... })` and pass `pausedAt: null`**

There's one place that creates a fresh rest state (search for `stage: "rest", proposal, restEndsAt` around line 606-608). The current code:

```tsx
            const restEndsAt = Date.now() + restMin * 60_000;
            saveRest({ restEndsAt, proposal });
            setPostFlow({ stage: "rest", proposal, restEndsAt });
```

Replace with:

```tsx
            const restEndsAt = Date.now() + restMin * 60_000;
            saveRest({ restEndsAt, proposal, pausedAt: null });
            setPostFlow({ stage: "rest", proposal, restEndsAt, pausedAt: null });
```

Search for any other `setPostFlow({ stage: "rest"` occurrence in the file — there should only be the one above plus the one inside the `useState` initializer (already updated in Step 1).

- [ ] **Step 6: Render Pause/Resume button on the rest card**

Find the rest card's button row (around line 317-320):

```tsx
              <button onClick={skipRest}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Skip rest</button>
              <button onClick={cancelRest}
                className="px-2 py-1.5 text-xs text-slate-400 hover:text-white">cancel</button>
```

Replace with:

```tsx
              {restIsPaused ? (
                <button onClick={resumeRest} className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-sm text-white">
                  <Play size={14} /> Resume
                </button>
              ) : (
                <button onClick={pauseRest} className="inline-flex items-center gap-1 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 rounded text-sm text-white">
                  <Pause size={14} /> Pause
                </button>
              )}
              <button onClick={skipRest}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white">Skip rest</button>
              <button onClick={cancelRest}
                className="px-2 py-1.5 text-xs text-slate-400 hover:text-white">cancel</button>
```

- [ ] **Step 7: Show "⏸ paused" indicator on the rest card**

Find the "resting · of N min" subtitle (around line 315):

```tsx
              <div className="text-xs text-amber-300/80">resting · of {settings.restMinutes} min</div>
```

Replace with:

```tsx
              <div className="text-xs text-amber-300/80 flex items-center gap-2">
                <span>resting · of {settings.restMinutes} min</span>
                {restIsPaused && <span className="text-amber-200">⏸ paused</span>}
              </div>
```

- [ ] **Step 8: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors.

- [ ] **Step 9: Visual verification**

```bash
npm run dev
```

Open the Pomodoro tab. Test sequence:
1. Start and complete a 1-minute pomodoro to enter rest.
2. While resting, click **Pause**. The rest countdown freezes; "⏸ paused" appears next to the duration subtitle.
3. Wait ~15 seconds. Click **Resume**. The rest countdown un-freezes and continues from where it was.
4. Let the rest finish naturally. The end-of-rest watcher fires; the page transitions to the restart-prompt.

Stop the dev server.

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/Pomodoro.tsx
git commit -m "$(cat <<'EOF'
feat(web): Pause / Resume on active rest

Same amber Pause / green Resume buttons as the active pomodoro. On
pause the rest countdown freezes; on resume restEndsAt slides forward
by exactly the paused span. Rest auto-end watcher is gated so it can't
fire while paused. The rest is not persisted as a record so no
paused_ms tracking is needed — only the shifted end-time matters.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Tab label shows ⏸ when paused

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Update `usePomodoroTabLabel`**

In `web/src/App.tsx`, find the `usePomodoroTabLabel` function (around line 29-53). Replace the entire function body with:

```tsx
function usePomodoroTabLabel(): string {
  const [label, setLabel] = useState("Pomodoro");
  useEffect(() => {
    const tick = () => {
      const rest = loadRest();
      if (rest) {
        const isPaused = !!rest.pausedAt;
        const reference = rest.pausedAt ?? Date.now();
        const remaining = rest.restEndsAt - reference;
        const prefix = isPaused ? "Pomodoro · ⏸ Break" : "Pomodoro · Break";
        if (remaining > 0) { setLabel(`${prefix} ${fmtMmSs(remaining)}`); return; }
        setLabel("Pomodoro · Break done"); return;
      }
      const active = loadActive();
      if (active) {
        const isPaused = !!active.pausedAt;
        const accumulatedPausedMs = active.accumulatedPausedMs ?? 0;
        const reference = active.pausedAt ?? Date.now();
        const targetAt = active.startedAt + accumulatedPausedMs + active.targetDurationMinutes * 60_000;
        const remaining = targetAt - reference;
        const prefix = isPaused ? "Pomodoro · ⏸ Work" : "Pomodoro · Work";
        if (remaining > 0) { setLabel(`${prefix} ${fmtMmSs(remaining)}`); return; }
        setLabel("Pomodoro · Done"); return;
      }
      setLabel("Pomodoro");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return label;
}
```

- [ ] **Step 2: TypeScript build check**

```bash
npx tsc --noEmit -p .
```

Expected: zero errors.

- [ ] **Step 3: Visual verification**

```bash
npm run dev
```

In the Pomodoro tab, start a 1-min pomodoro. Watch the top-bar Pomodoro button text — it should read `Pomodoro · Work MM:SS` and count down.

Click Pause. The button text should change to `Pomodoro · ⏸ Work MM:SS` and the MM:SS should freeze.

Resume. The text returns to `Pomodoro · Work MM:SS` and counts down again.

After the pomodoro finishes, during rest, repeat the same check for `Pomodoro · Break MM:SS` ↔ `Pomodoro · ⏸ Break MM:SS`.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): tab label shows ⏸ when pomodoro or rest is paused

usePomodoroTabLabel now reads pausedAt / accumulatedPausedMs from the
live state. Frozen MM:SS while paused; ⏸ prefix in front of Work or
Break to make pause status visible without clicking the tab.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: e2e verification + v0.4.0 bump

**Files:**
- Modify: `package.json` (version field)
- Modify: `package-lock.json` (version field — top-level only)

- [ ] **Step 1: Run the full verification matrix from the spec**

```bash
npm run dev
```

Open http://localhost:5173 and verify each scenario from the spec's testing strategy:

**Live pomodoro**
- [ ] Start a 1-min pomodoro. After ~10s, Pause. Elapsed freezes; remaining freezes; "⏸ paused" indicator visible; tab label has ⏸.
- [ ] Resume. Counters un-freeze and continue.
- [ ] Pause again. Wait. Resume. The accumulated paused time is reflected (elapsed counter only shows ~10s of work after 60s of wall-clock if you've paused 50s).
- [ ] Without further pauses, let it run to target. Auto-stop fires when `referenceMs ≥ startedAt + accumulatedPausedMs + target`. Stored `paused_ms` matches observed pause time.

**Pause while finalizing**
- [ ] Start a pomodoro, pause it, click Stop. Pomodoro finalizes; stored `paused_ms` includes the in-progress pause span.

**Persistence**
- [ ] Start a pomodoro, pause it, hard-refresh the browser. Verify still paused with correct accumulated pause time.

**Rest**
- [ ] Finish a pomodoro to enter rest. Pause the rest. End-time slides back. Resume. End-time slides back by exactly the paused duration.

**Duration math**
- [ ] After creating a pomodoro with non-zero `paused_ms`, check every UI surfacing pomodoro minutes:
  - Pomodoro tab "today" / "month" totals
  - Projects tab time attribution (today/week/all)
  - Calendar tab heatmap / month grid
  - DayDrawer (open a day in Calendar)
  - PomodoroDetailDrawer (click a pomodoro row)
  All show wall-clock minus paused.

**Server validation**
- [ ] `paused_ms: -1` → 400.
- [ ] `paused_ms` greater than `(ended_at - started_at)` → 400.

**Legacy compatibility**
- [ ] Pre-existing pomodoros (no `paused_ms` field on disk) display identically to before.

- [ ] **Step 2: Bump version**

Edit `package.json` line 4:

```json
  "version": "0.4.0",
```

And `package-lock.json` lines 3 and 9:

```json
  "version": "0.4.0",
  ...
      "version": "0.4.0",
```

Verify only the top-level descriptor matches:

```bash
grep -n '"version": "0.3.0"' package.json package-lock.json
```

Expected: no matches. (Confirm 0.3.0 is fully replaced.)

- [ ] **Step 3: Stop dev server (Ctrl-C)**

- [ ] **Step 4: Commit and tag**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: bump version to 0.4.0

v0.4.0 ships pomodoro pause/resume. Active pomodoros and rests gain
amber Pause / green Resume buttons; while paused, the timer freezes,
the tab label shows ⏸, and the auto-stop target slides later so a
25-min pomodoro always means 25 minutes of actual work. Total paused
time is persisted on each Pomodoro record (paused_ms) and subtracted
from every duration-attribution site via a new shared
pomodoroMinutes() helper.

See docs/superpowers/specs/2026-05-18-pomodoro-pause-resume-design.md
for the design, and docs/superpowers/plans/2026-05-18-pomodoro-pause-resume.md
for the implementation plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git tag -a v0.4.0 -m "v0.4.0"
```

- [ ] **Step 5: Push (only after explicit user confirmation)**

Do NOT run automatically. Ask the user:

```bash
git push origin main
git push origin v0.4.0
```

---

## Notes for the implementing engineer

1. **No test runner.** Verification is `npx tsc --noEmit -p .` for type checks and manual browser/curl checks. Don't skip the manual verifications.

2. **ESM imports.** Server `.ts` imports use `.js` extension; frontend imports don't.

3. **The `?? 0` defaults are load-bearing.** Legacy localStorage entries and on-disk pomodoros lack `pausedAt` / `accumulatedPausedMs` / `paused_ms`. Every read site must fall back to `0` / `null`. The plan's normalization in `loadActive()`, `loadRest()`, server `normalize()`, and `pomodoroMinutes()` covers all consumers.

4. **`accumulatedPausedMs` excludes the in-progress span.** Only on Resume does the current span fold into the accumulator. On Stop (while still paused), the finalize math adds the in-progress span separately.

5. **Rest doesn't accumulate.** Because rests aren't persisted, we just slide `restEndsAt` forward on resume. Don't add `accumulatedPausedMs` to `LiveRestState`.

6. **One file per task except Task 5.** Task 5 touches six files in one commit because the change is the same mechanical replacement everywhere; splitting it would create six trivially-similar commits with no review value.

7. **Browser HMR.** Vite hot-reloads the frontend automatically; you don't need to restart the dev server between most changes. Restart only if you suspect cached state issues.

8. **If a verification step fails.** Don't `--no-verify` past the commit. Diagnose, fix in-place, and re-stage.

9. **Plan vs spec.** This plan implements the spec at `docs/superpowers/specs/2026-05-18-pomodoro-pause-resume-design.md`. If you hit a contradiction, the spec wins; flag rather than guess.
