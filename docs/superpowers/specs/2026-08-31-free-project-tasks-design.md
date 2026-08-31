# Free project: real tasks alongside one-off labels

**Date:** 2026-08-31
**Status:** Approved

## Problem

The **Free** system project (`FREE_PROJECT_ID = "free"`) currently holds only
*ephemeral* per-pomodoro labels (`freeTaskLabels`), plus an MRU fold offering the last
20 distinct labels for reuse.

That covers the genuinely one-off case ("reply to landlord"), but not the other one:
a recurring thing too small to deserve its own project ("taxes", "invoices", "car MOT").
Today those live only as strings you retype or re-pick from history. They have no
identity, cannot be completed, and never roll up into a per-task total.

## Goal

Let Free hold **real, persistent tasks** like any other project, *without* removing the
one-off labels. When Free is picked in a pomodoro, offer both, clearly separated:

- **Tasks** — real `Task` rows under `project_id: "free"`. Persist, complete, accumulate
  time per task.
- **One-off** — the existing `freeTaskLabels`, scoped to that single pomodoro.

The two may overlap in name; that is expected and not deduplicated.

## What already works (no change needed)

The **server needs no changes at all**:

- `POST /tasks` with `project_id: "free"` already succeeds. Free always exists in
  `projects.json` (`loadProjects()` recreates it) and can never be completed, so neither
  the 404 nor the 409 guard in `tasksRouter.post` fires.
- `POST /pomodoros` already accepts Free task IDs in `task_ids`: the only check is that
  each task's `project_id` appears in `project_ids`.
- The Projects tab's `ProjectDrawer` already renders an "add task" box for Free, guarded
  only by `!!project.completed_at`.

So Free tasks were always *creatable*. They were simply never *offered* or *counted*.

## The four frontend gaps

1. **Picker** (`Pomodoro.tsx`) — the Free branch returns `<FreeSlotsEditor>` early, so
   Free's real tasks are never rendered as pickable buttons.
2. **Attribution** — `attribute()` (Pomodoro.tsx) and `attributeMinutes()` (Projects.tsx)
   both count `max(1, labels.length)` units for Free and **ignore `tasks` entirely**, so a
   picked Free task would be silently dropped from the time split and absent from
   `byTask`.
3. **Renderers** — `PomodoroProjectsCell` and `PomodoroDetailDrawer` render Free's labels
   only. `PomodoroChips` is inconsistent: it renders Free's real tasks, but only when the
   label array happens to be empty.
4. **Manual log modal** — same early return as the picker.

## Time attribution (the behavioural change)

Generalize the Free branch so it is the union of both kinds:

```
units(Free) = (one unit per picked Free task) + (one unit per non-empty label)
              fallback to a single project-level unit when both are empty
```

This strictly extends the two prior behaviours: with no tasks it reduces to today's
label-per-unit rule; with no labels it reduces to the normal project rule. Free tasks now
appear in the `byTask` breakdown (labels still do not, having no stable ID).

No existing record is affected: no logged pomodoro can currently carry a Free task,
because none were ever pickable. There is no migration.

Both mirrored functions must change identically.

## Picker UI

Free's block becomes two labelled rows, keeping the existing picker density:

```
Free:
  Tasks:    (taxes) (invoices) (car MOT)   + new
  One-off:  ▾ [ reply to landlord      ] ⇧ ×
            + Add slot
```

- **Tasks row** — one toggle button per *non-completed* Free task, styled exactly like a
  normal project's task buttons. Completed Free tasks are hidden, matching
  `eligibleTasksForPicked`'s existing filter for every other project.
- **One-off row** — the existing `FreeSlotsEditor`, MRU fold unchanged. Labelled
  `One-off:` with a `(this pomodoro only)` hint so the two kinds cannot be confused.
- The Tasks row renders even when Free has no tasks yet, so `+ new` is always reachable.
  It shows no "no tasks (project-level time)" empty state; the One-off row below covers
  that case.

### `+ new` (inline task creation)

Click `+ new` → an inline input appears in the Tasks row. Enter creates a real Free task
and **auto-selects it** for the current pomodoro. Esc or blur-while-empty cancels.

### `⇧` (promote a one-off to a real task)

Each non-empty one-off slot gets a `⇧` button: it turns that label into a persistent Free
task, selects it, and removes the slot. This is the "it turned out to be a recurring
thing" path.

### Name collisions

Task names are unique per project (case-insensitive, server-enforced, HTTP 409 with
`details.existingId`). Both `+ new` and `⇧` therefore resolve rather than fail:

- Name matches an existing **open** Free task → select it, create nothing.
- Name matches a **completed** Free task → reopen it (`PATCH completed_at: null`) and
  select it. Selecting an invisible completed task would look like a no-op, and re-running
  a closed errand is exactly the intent.
- Lost race (409 from a concurrent tab) → fall back to `details.existingId`.

The client checks the loaded task list first, so the common case makes no request.

Note this bypasses `ProjectsContext.createTask`, which throws away `details` when it
converts the response into an `Error`. The picker calls `apiRequest` directly and then
`refresh()`.

## While the timer runs

Unchanged in shape: real Free tasks appear in the generic read-only "Tasks:" chip row
alongside every other project's tasks, and the one-off slots stay editable (they are
synced into the live timer state at stop time). Tasks cannot be added mid-pomodoro, which
is the existing behaviour for all projects.

## Rendering a logged pomodoro

All three renderers show both kinds under Free, distinguished by chip style:

- **real task** → solid white pill (identical to any other project's task)
- **one-off label** → white pill with a **dashed border**, tooltip `one-off label`

Specifically:

- `PomodoroProjectsCell` — real tasks first, then labels; `(no label)` italic only when
  *both* are empty.
- `PomodoroChips` — `Free › <task>` for real tasks (via the existing `task` prop),
  `Free › <label>` dashed for labels; the Free branch no longer swallows real tasks.
- `PomodoroDetailDrawer` — `› <task>` lines then `› <label>` lines, labels marked
  `(one-off)`; the `(project-level — no specific task)` line only when both are empty.

## Non-goals (YAGNI)

- No migration of historical labels into tasks. The MRU fold already covers reuse, and
  promoting is a deliberate per-label action.
- No deduplication between a label and a same-named Free task. Overlap is allowed by
  design; they are different things that happen to share a string.
- No filtering of the MRU list against existing Free task names, for the same reason.
- No completing a Free task from the picker. That stays in the Projects tab.

## Files touched

- `web/src/pages/Pomodoro.tsx` — `attribute()`, new `FreeProjectPicker` block,
  `FreeSlotsEditor` gains `onPromote`, `ensureFreeTask` helper, `PomodoroProjectsCell`,
  `PomodoroChips`, `ManualPomodoroModal`.
- `web/src/pages/Projects.tsx` — `attributeMinutes()` (mirror of `attribute()`).
- `web/src/components/PomodoroDetailDrawer.tsx` — Free block.
- `README.md` — Free project description.

No server file changes.

## Verification

- `npx tsc --noEmit` and `npm run build:web` clean.
- `npm test` (server lib tests) still pass.
- Manual: add two Free tasks from the Projects tab; confirm they appear in the picker's
  Tasks row. Log a pomodoro with 1 Free task + 1 one-off label + 1 other project → 3 units,
  time split three ways, both kinds visible and visually distinct in the row, chips and
  detail drawer. Promote a label, confirm it becomes a selected task and the slot goes.
  `+ new` with the name of a completed Free task reopens it.
