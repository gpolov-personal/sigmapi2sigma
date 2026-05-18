# Pomodoro pause / resume — design spec

**Date:** 2026-05-18
**Status:** Draft for user review
**Author:** Claude + gpolov

## Problem

A pomodoro session today is binary: start, then it counts down (or you press Stop to finalize early). Once started, the timer cannot be paused. Real life is messier — phone calls, interruptions, the door — and right now those minutes count as work. Same problem for rest periods: a rest cannot be paused either.

Two consequences:

1. **Inaccurate time attribution.** A 25-minute pomodoro that was actually 18 minutes of focus + 7 minutes of interruption is still attributed as 25 minutes to the picked projects/tasks.
2. **No graceful interruption.** The only options today are "let it keep counting" or "Stop and discard the partial work" — neither matches the natural behavior of "I'll pick this back up in two minutes".

## Goal

Add the ability to pause and resume an active pomodoro (and an active rest) one or more times within a single session, store the total paused duration on the pomodoro record, and subtract it from every place that computes pomodoro minutes — so attribution reflects actual focus time, not wall-clock elapsed.

## The model

### Data shape — `Pomodoro` (server + frontend type)

One new field:

```ts
paused_ms: number   // total ms spent paused during this pomodoro; default 0
```

Read-time normalization backfills `0` for legacy records. No data migration script.

Wall-clock duration remains `ended_at - started_at`. Attributable duration becomes `ended_at - started_at - paused_ms`.

### Data shape — LocalStorage live state

Both `csv:active-pomodoro` and `csv:active-rest` gain two fields:

```ts
pausedAt: number | null      // ms timestamp when currently paused; null if running
accumulatedPausedMs: number  // total paused ms across prior pause spans in this session
```

Invariants:
- `pausedAt === null` → running. `accumulatedPausedMs` is the total of all completed pause spans.
- `pausedAt !== null` → paused. `accumulatedPausedMs` excludes the in-progress span.

### Transitions

**Pause** (running → paused):
```
pausedAt = Date.now()
```

**Resume** (paused → running):
```
accumulatedPausedMs += (Date.now() - pausedAt)
pausedAt = null
```

**Finalize** (any state → done; written into the persisted `Pomodoro`):
```
paused_ms = accumulatedPausedMs + (pausedAt !== null ? Date.now() - pausedAt : 0)
```

The same triplet applies symmetrically to the rest state.

### Adjusted countdown / auto-stop

Today:
```
remainingMs = startedAt + targetDurationMinutes * 60_000 - now
auto-stop when remainingMs <= 0
```

New:
```
totalPausedMs = accumulatedPausedMs + (pausedAt !== null ? now - pausedAt : 0)
remainingMs   = startedAt + totalPausedMs + targetDurationMinutes * 60_000 - now
auto-stop when remainingMs <= 0
```

Net effect: the auto-stop target slides later by however long you've been paused. A 25-minute pomodoro guarantees 25 minutes of actual work, not 25 minutes of wall-clock. While paused, `remainingMs` is constant.

Same arithmetic applied to rest's `restEndsAt` (which is a similar "target" timestamp).

### UI — active pomodoro card

Add a **Pause** button next to the existing **Stop** button. When paused, the button label becomes **Resume**, and a small "⏸ paused" indicator appears under the timer.

```
running:           [ Stop ] [ Pause ]    elapsed 14:32 / target 25m
paused:            [ Stop ] [ Resume ]   ⏸ paused — elapsed frozen at 14:32 / target 25m
```

The "elapsed" counter freezes while paused. The "remaining" countdown freezes too.

### UI — active rest card

Same pattern. A **Pause / Resume** button on the rest card. While paused, the rest end-time effectively slides back by the cumulative pause; the displayed remaining time freezes.

### Tab label (`usePomodoroTabLabel` in `web/src/App.tsx`)

Today:
```
Pomodoro · Work MM:SS
Pomodoro · Break MM:SS
```

New (when paused):
```
Pomodoro · ⏸ Work MM:SS
Pomodoro · ⏸ Break MM:SS
```

The MM:SS is frozen at the moment of pause. Same hook, same 1-second interval — the tick now considers `pausedAt`.

## Duration math consolidation

Today, six files duplicate the wall-clock duration formula:

```
web/src/pages/Pomodoro.tsx:18           pomDurMin
web/src/components/DayDrawer.tsx:21     pomDurMin
web/src/components/HeatmapCalendar.tsx:23  inline
web/src/components/MonthGrid.tsx:18     inline
web/src/components/PomodoroDetailDrawer.tsx:11  inline
web/src/pages/Projects.tsx:15           pomDur
web/src/pages/Projects.tsx:850          inline (second occurrence)
```

The change creates one shared helper, replaces all callsites with imports:

```ts
// web/src/lib/pomodoro.ts (new file)
import type { Pomodoro } from "../api";

export function pomodoroMinutes(p: Pomodoro): number {
  const elapsed = Date.parse(p.ended_at) - Date.parse(p.started_at);
  const paused  = p.paused_ms ?? 0;
  return Math.max(0, (elapsed - paused) / 60000);
}
```

Backward-compatible — legacy records without `paused_ms` get `0` → same result as today.

## Server-side validation

`POST /api/pomodoros` adds:

```ts
if (paused_ms !== undefined) {
  if (!Number.isFinite(paused_ms) || paused_ms < 0) {
    return res.status(400).json({ error: "paused_ms must be a non-negative number" });
  }
  const elapsed = Date.parse(ended_at) - Date.parse(started_at);
  if (paused_ms > elapsed) {
    return res.status(400).json({ error: "paused_ms cannot exceed elapsed wall-clock duration" });
  }
}
```

Default to `0` when omitted. The frontend always sends it.

`PATCH /api/pomodoros` does not allow editing `paused_ms` (only `notes` and `freeTaskLabel` remain patchable, as today). Pause time is set at creation and immutable.

## Server-side activity slice (`server/lib/activity.ts`)

**No changes.** `computeActivitySlice` operates on the wall-clock window `[started_at, ended_at]`, collecting Claude messages and shell commands that fall in that range. This is a forensic view ("what happened during the pomodoro window") and showing events that occurred during paused intervals is fine — the user can see what interrupted them. Duration accounting is the only thing that needs the correction, and that's handled by `pomodoroMinutes()`.

## Persistence behavior

If the browser is closed (or refreshed) while the pomodoro is paused, `pausedAt` and `accumulatedPausedMs` persist in localStorage. On reopen:
- The active pomodoro is reloaded with `pausedAt !== null` → it remains paused.
- No auto-resume; user must click Resume.
- The frozen elapsed/remaining values display correctly because they're computed from `startedAt + accumulatedPausedMs + (pausedAt ? now - pausedAt : 0)` — wait, this would still drift because `now - pausedAt` keeps growing. We freeze by checking `if (pausedAt !== null) remaining = startedAt + accumulatedPausedMs + target - pausedAt;` — i.e. use `pausedAt` instead of `now` for the upper bound while paused. Same for elapsed.

Concrete frontend math (replaces the existing `targetMs`, `elapsedMs` calculations near `Pomodoro.tsx:103-105`):

```ts
const referenceMs = active.pausedAt ?? now;
const totalPausedMs = active.accumulatedPausedMs + (active.pausedAt ? 0 : 0);
const elapsedMs = referenceMs - active.startedAt - active.accumulatedPausedMs;
const targetMs  = active.startedAt + active.accumulatedPausedMs + active.targetDurationMinutes * 60_000;
const remainingMs = targetMs - referenceMs;
```

(Simplified: while paused, `referenceMs` stops at `pausedAt`; while running, it's `now`. `accumulatedPausedMs` is always subtracted from elapsed and added to target.)

## UI placement — active pomodoro card

The existing button row (around `Pomodoro.tsx:361-366`):

```
[ Start ]                        ← only when no active pomodoro
[ Stop  ]                        ← when active
```

Becomes:

```
                       ← when no active pomodoro
[ Start ]
                       ← when active and running
[ Stop ] [ Pause ]
                       ← when active and paused
[ Stop ] [ Resume ]   ⏸ paused
```

Colors (using existing palette in this codebase):
- Stop: `bg-red-700 hover:bg-red-600` (existing)
- Pause: `bg-amber-700 hover:bg-amber-600` (new — distinct from Stop)
- Resume: `bg-green-700 hover:bg-green-600` (new — distinct on hover from idle Pause)

## Edge cases

| Case | Behavior |
|---|---|
| User pauses then closes tab | State persisted. Reopen → still paused. User clicks Resume to continue. |
| User clicks Stop while paused | Finalize immediately. `paused_ms = accumulatedPausedMs + (now - pausedAt)`. The Stop button is always enabled. |
| Manual (post-hoc) pomodoro creation | Has no live session, no pause history. `paused_ms` defaults to `0` in the POST body. UI for manual creation does not expose pause. |
| Auto-stop while paused | Cannot fire — adjusted `remainingMs` only decreases when running. Resume is the only way to reach target. |
| Browser tab in background | No special handling. `setInterval` still ticks every second in modern browsers (throttled but accurate enough). Auto-stop check uses real timestamps, not interval counts. |
| User restarts the browser many hours into a paused pomodoro | Same — still paused. The pomodoro might have been paused for 8 hours; that's fine, the math just accumulates. No timeout. |
| Pause during rest, then resume | Rest end-time slides back by paused duration. Same arithmetic. |
| Pause-resume-pause-resume in one pomodoro | Each completed pause span adds to `accumulatedPausedMs`. On Stop, all accumulated time + in-progress span (if any) → `paused_ms`. |
| `paused_ms > elapsed` (client bug) | Server 400. Frontend won't naturally produce this, but the guard is defensive. |
| Pomodoro tab label refresh frequency | Existing 1-second interval. While paused, the value doesn't change but the tick still fires — costless. |

## Out of scope

- Storing the list of individual pause spans (only the total is kept).
- A maximum pause duration limit.
- Reporting "paused minutes" as a separate stat anywhere in the UI.
- Manual-pomodoro creation flow gaining a paused-ms field (it always defaults to 0).
- Visualizing pauses on the heatmap or month grid.
- Pausing in some kind of automated "I went away from the keyboard" detection — purely manual.

## Testing strategy

Manual verification only (no automated test runner in repo):

**Live pomodoro**
1. Start a 1-minute pomodoro. Wait ~10s. Pause. Verify elapsed freezes; remaining freezes; "⏸ paused" indicator visible; tab label has ⏸.
2. Resume. Verify counters un-freeze and continue from where they were.
3. Pause again. Wait. Resume. Confirm `accumulatedPausedMs` correctly tracks both spans (visible indirectly via the elapsed counter still being only ~10s after pauses).
4. Let it run to target (without pausing further). Verify auto-stop fires at `startedAt + accumulatedPausedMs + targetDurationMinutes * 60_000`, not at `startedAt + targetDurationMinutes * 60_000`. The finalized pomodoro's `paused_ms` should match what you observed.

**Pause while finalizing**
5. Start a pomodoro, pause it, click Stop. Verify it finalizes; the stored `paused_ms` includes the in-progress pause span.

**Persistence**
6. Start a pomodoro, pause it, hard-refresh the browser. Verify it's still paused on reopen, with the correct accumulated pause time.

**Rest**
7. Finish a pomodoro to enter rest. Pause the rest. Verify rest end-time slides back. Resume. Verify rest end-time slides back by exactly the paused duration.

**Duration math**
8. After creating a pomodoro with non-zero `paused_ms`, verify every UI that shows pomodoro minutes (Pomodoro tab "today" / "month" totals, Projects tab time attribution, Calendar heatmap, DayDrawer, PomodoroDetailDrawer, MonthGrid) shows the corrected value (wall-clock minus paused).

**Server validation**
9. POST a pomodoro with `paused_ms: -1` → 400.
10. POST a pomodoro with `paused_ms` greater than `ended_at - started_at` → 400.

**Legacy compatibility**
11. Existing pomodoros (with no `paused_ms` field on disk) display as before — `paused_ms` is normalized to `0` and `pomodoroMinutes` returns the original wall-clock duration.

## Files affected

```
server/
  routes/
    pomodoros.ts                MODIFY — add paused_ms field, normalize, validate

web/src/
  api.ts                        MODIFY — add paused_ms: number to Pomodoro type
  lib/
    pomodoro.ts                 NEW    — pomodoroMinutes() shared helper
    liveTimer.ts                MODIFY — pausedAt + accumulatedPausedMs on both states
  pages/
    Pomodoro.tsx                MODIFY — Pause/Resume buttons, paused indicator,
                                          freeze logic on elapsed/remaining,
                                          adjusted auto-stop, finalize merges paused_ms,
                                          rest pause/resume, drop local pomDurMin
    Projects.tsx                MODIFY — drop local pomDur, import pomodoroMinutes
  App.tsx                       MODIFY — usePomodoroTabLabel: ⏸ when paused
  components/
    DayDrawer.tsx               MODIFY — drop local pomDurMin, import pomodoroMinutes
    HeatmapCalendar.tsx         MODIFY — replace inline calc with pomodoroMinutes
    MonthGrid.tsx               MODIFY — replace inline calc with pomodoroMinutes
    PomodoroDetailDrawer.tsx    MODIFY — replace inline calc with pomodoroMinutes
```

10 files modified, 1 file created.

## Open questions

None — confirmed in chat. Ready for written review.
