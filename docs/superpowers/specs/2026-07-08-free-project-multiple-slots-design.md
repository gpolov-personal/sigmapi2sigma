# Free project: multiple slots per pomodoro

**Date:** 2026-07-08
**Status:** Approved

## Problem

The **Free** system project (`FREE_PROJECT_ID = "free"`) lets a pomodoro carry one
free-text label (`freeTaskLabel`) describing a non-project task. But a single pomodoro
often covers 2–3 unrelated non-project things (e.g. "emails", "taxes", "invoices").
Today you can only name one of them.

## Goal

Let the Free project hold **multiple labels ("slots")** in one pomodoro, with each slot
counted as its own time unit — so a 25-min pomodoro with 2 Free slots + 1 other project
splits into 3 units of ~8.3 min each.

## Non-goals (YAGNI)

- No cross-pomodoro aggregation of Free labels by name. Labels stay anonymous strings,
  shown per-pomodoro only (they have no stable IDs).
- No data-file migration. Legacy records normalize on read.
- No new "Free task" persistence — Free stays ephemeral, type-and-go.

## Data model

Rename the single string field to a list, everywhere it appears:

- **Server** `server/routes/pomodoros.ts`: `Pomodoro.freeTaskLabel: string`
  → `freeTaskLabels: string[]`.
- **Web** `web/src/api.ts`: same rename on the `Pomodoro` type.
- **Web** `web/src/lib/liveTimer.ts`: `LiveTimerState.freeTaskLabel?: string`
  → `freeTaskLabels?: string[]`, and `RestState.proposal.freeTaskLabel?`
  → `freeTaskLabels?: string[]`.
- **Web** `web/src/pages/Pomodoro.tsx`: `NextPomodoroProposal.freeTaskLabel?`
  → `freeTaskLabels?: string[]`.

## Backward compatibility

No file migration; normalize on read.

- **Server `normalize()`**: if `freeTaskLabels` is missing/not an array, derive it —
  legacy non-empty `freeTaskLabel` string → `[freeTaskLabel]`, otherwise `[]`. Mark
  `changed` so read-time normalization applies. Keep tolerating the old field on input.
- **`liveTimer.ts` load guards** (`loadActive`, `loadRest`): same fallback for
  localStorage state written by an older build.

## Validation (server POST + PATCH)

`freeTaskLabels`, when present, must be:
- an array of at most **8** entries,
- each a string ≤ 200 chars.

Empty / whitespace-only entries are **dropped silently** — server-side before store, and
client-side before send. Invalid shape (non-array, > 8, non-string, > 200) → HTTP 400.

The PATCH endpoint's allowed-field set replaces `freeTaskLabel` with `freeTaskLabels`,
applying the same validation and empty-drop.

## Time attribution (the behavioral change)

Attribution runs only on the frontend, in two mirrored functions:
`attribute()` in `web/src/pages/Pomodoro.tsx` and `attributeMinutes()` in
`web/src/pages/Projects.tsx`. Both build a list of "units" (each picked task, plus each
picked project with no task) and divide `duration / units.length`.

Change: when `pid === FREE_PROJECT_ID`, emit **one project-level unit per non-empty
label** (`{ project: FREE_PROJECT_ID, task: null }` repeated N times), falling back to a
single unit when there are no labels. Free's per-project total is the sum of its slot
units; each slot gets `duration / totalUnits`. Free labels are not tasks, so they do not
appear in the `byTask` breakdown (unchanged).

## Picker UI (`PomodoroPage`)

- State: `freeTaskLabel: string` → `freeTaskLabels: string[]`.
- Replace the single Free text input with an add/remove row list, shown only when Free is
  among the picked projects:
  - one `<input>` per slot,
  - a `×` button per row to remove it,
  - a `+ Add slot` button (disabled at 8 rows),
  - start with one empty row when Free is first picked.
- Empty rows are ignored (trimmed + filtered) on start / finalize.
- All flows carrying the label array: `startTimer`, `startTimerFromProposal`,
  `finalizePomodoro` (POST body), the auto-stop sync effect, `stopTimer`, and
  `cancelRest` (prefill).

## Rendering

Iterate labels instead of using the single value:

- **`PomodoroProjectsCell`** (Pomodoro.tsx): one white pill per label under the Free row;
  `(no label)` italic only when the array is empty.
- **`PomodoroChips`** (Pomodoro.tsx): one `Free › <label>` chip per label.
- **`PomodoroDetailDrawer`** (components/): one `› <label>` line per label in the Free
  block.

## Files touched

- `server/routes/pomodoros.ts` — type, normalize, POST validation/store, PATCH.
- `web/src/api.ts` — Pomodoro type.
- `web/src/lib/liveTimer.ts` — LiveTimerState, RestState, load guards.
- `web/src/pages/Pomodoro.tsx` — proposal type, picker state + UI, start/stop/finalize/
  auto-stop/cancelRest flows, `attribute()`, `PomodoroProjectsCell`, `PomodoroChips`.
- `web/src/pages/Projects.tsx` — `attributeMinutes()`.
- `web/src/components/PomodoroDetailDrawer.tsx` — Free block rendering.

## Verification

- `npx tsc --noEmit` (web) and `npm run build:web` typecheck clean.
- `npm test` (server lib tests) still pass.
- Manual: run the app, start a Free pomodoro with 2 slots, confirm chips render both, the
  detail drawer lists both, and Today/Projects time splits across all units.
