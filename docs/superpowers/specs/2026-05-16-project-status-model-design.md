# Project status model — design spec

**Date:** 2026-05-16
**Status:** Draft for user review
**Author:** Claude + gpolov

## Problem

The current Projects tab shows each project as `active`, `parked`, or `completed`. Today's derivation:

```
if completed_at is set                          → completed
else if any assignments.json entry → this id    → active
else                                            → parked
```

Two practical problems:

1. **Stale "active"**: an assignment row created weeks ago keeps a project marked `active` forever, even if the tmux session is long dead and you haven't touched the project in days. Example in current data: `StarCompliance Investor` shows `active` because of a leftover `StarCompInv → 45d8dc3b…` assignment, despite no live tmux and no recent pomodoros.

2. **Conflated concepts**: the single `status` field collapses three orthogonal facts — lifecycle progress, current engagement, and tmux presence — into one value, so none of them is correctly captured.

## Goal

Replace the single derived status with **three orthogonal fields**, each derived from observed activity rather than maintained by hand, with one well-scoped manual override.

## The model

A project has three computed fields:

| Field | Values | Derivation |
|---|---|---|
| `progress` | `not_started` / `in_progress` / `completed` | Derived from pomodoros + a manual `completed_at` override |
| `engagement` | `active` / `parked` | Derived from pomodoros, using a global anchor + configurable window |
| `tmux_attached` | `true` / `false` | Derived from live tmux + assignments |

### Progress

```
if project.completed_at is set         → completed
else if any pomodoro exists for it     → in_progress
else                                   → not_started
```

`completed_at` is the **only** manual lever in the system. It is set or cleared from the Project drawer (`Mark complete` / `Reopen` button).

### Engagement

```
anchor = max(pomodoro.ended_at) across ALL projects, regardless of which project
       = null if no pomodoros exist anywhere

X = settings.activeWindowHours (default 72)

if project.progress == completed              → parked
else if anchor is null                        → parked
else if project has any pomodoro p where
    (anchor - X*3600*1000) ≤ p.ended_at ≤ anchor
                                              → active
else                                          → parked
```

The anchor floats with your actual activity. Working Friday 17:00 then resuming Monday 09:00: between Friday-17:00 and Monday-09:00 the anchor stays at Friday-17:00 (no newer pomodoros), so projects worked on Friday remain `active` over the weekend. Monday's first pomodoro snaps the anchor forward.

Completed projects are never `active`, even with recent pomodoros — the engagement field reads as `parked` once a project is completed.

### Tmux attached

```
yes  iff  there exists an entry in assignments.json mapping
          some tmuxName → this project.id
          AND that tmuxName appears in the live tmux tree right now
no   otherwise
```

Two-stage check: assignment row + live presence. Orphan assignments (no live tmux) contribute nothing to status; they remain useful only as hints for the Pomodoro picker (auto-selecting the assigned project when you're in a known tmux).

No time window applies — `tmux_attached` is a pure right-now snapshot.

## Manual override scope

The only manual action is **setting or clearing `completed_at`**:

- `Mark complete` → sets `completed_at = now`. Project becomes `progress: completed, engagement: parked` regardless of pomodoros.
- `Reopen` → clears `completed_at`. Project's progress falls back to `in_progress` if any pomodoros exist, else `not_started`. Engagement re-derives from the anchor rule.

There is no manual `mark in_progress`, `mark not_started`, `mark active`, or `mark parked`. Those states are projections of observed activity.

## Rules that change behavior elsewhere

### Pomodoros for completed projects are blocked

Server-side validation: `POST /api/pomodoros` rejects with HTTP 400 if any `project_ids` entry points to a project with `completed_at` set. Error message:

> `Project '<name>' is completed. Reopen it before logging time.`

This matches the existing rule that `PUT /api/assignments` rejects completed projects.

### Existing assignments to completed projects

Already enforced. No changes needed.

## UI changes

### Projects tab — row layout

Replace the single status pill with three small chips per row:

```
● StarCompliance Investor   [in-progress] [parked]
● Simulacrum                [in-progress] [active] [⌗ Sim]
● VS AI Strategy            [not-started] [parked]
● Old Project               [✓ completed] [parked]
```

- **Progress chip** — gray `not-started` / blue `in-progress` / green `✓ completed`.
- **Engagement chip** — amber `active` / slate `parked`.
- **Tmux chip** — only when `tmux_attached = true`, monospace tmux session name (e.g. `⌗ Sim`). Hidden otherwise.

Sort order:
1. `engagement = active` projects first
2. then `in_progress + parked`
3. then `not_started`
4. then `completed` last
5. within each group, alphabetical by name

### Anchor header strip

A small persistent header on the Projects tab:

```
Active window: 72h since last pomodoro at Fri 16:42
```

Always visible. Click anywhere on it could jump to the Settings tab section for `activeWindowHours` (nice-to-have, not required for v1).

If no pomodoros exist anywhere, the header reads `No pomodoros yet — all projects are parked.`

### Mark complete / Reopen — drawer-only

Both buttons live exclusively inside the Project drawer (opened by clicking a project row). No buttons in the row itself. Reduces visual clutter; the action is rare enough that an extra click is acceptable.

The drawer shows exactly one of:
- `[ Mark complete ]` — if `completed_at` is null. Asks for confirmation.
- `[ ↩ Reopen ]` — if `completed_at` is set. No confirmation needed.

### Pomodoro picker — completed projects hidden

In the project-selection picker (Pomodoro tab when starting a session):

- Completed projects are hidden by default.
- A `Show completed` toggle in the picker header reveals them, rendered grayed and **unselectable** (click does nothing or shows a tooltip).
- The intent is to make completed projects discoverable for un-completion via Projects tab, not for direct logging.

### Sessions tab — anchor mode

Existing dropdown `Last: 1h / 6h / 24h / 72h / 168h / all time` keeps its values, but the **meaning** changes:

- Old: filter sessions where `mtime ≥ now - hours*3600*1000`.
- New: anchor = `max(mtime)` across all sessions. Filter where `mtime ≥ anchor - hours*3600*1000`.

A small line below the dropdown:

```
Anchor: last interaction Fri 16:42 — showing sessions Wed 16:42 → Fri 16:42
```

For `all time` selection, anchor is hidden and all sessions are shown.

### TmuxMap

No structural changes for v1.

## Server-side changes

### `GET /api/projects` — extended response

Each project in the response gains a `derivedStatus` object:

```ts
interface DerivedStatus {
  progress: "not_started" | "in_progress" | "completed";
  engagement: "active" | "parked";
  tmux_attached: boolean;
  tmux_session_name: string | null; // if attached, which tmux session
  last_pomodoro_at: string | null;  // ISO timestamp, for tooltip
}
```

The response also includes a top-level `anchor`:

```ts
interface ProjectsResponse {
  schemaVersion: 1;
  projects: ProjectWithStatus[];
  anchor: {
    ts: string | null;          // ISO of max(pomodoro.ended_at), or null
    activeWindowHours: number;  // current setting value
  };
}
```

Computation happens server-side:

1. Load `projects.json`, `pomodoros.json`, `assignments.json`, `settings.json` (small files, atomically read).
2. Query live tmux tree once.
3. Compute anchor = max ended_at over all pomodoros.
4. For each project, derive the three fields per the rules above.
5. Return.

If the live tmux query fails (tmux dead), treat live session list as empty → all projects get `tmux_attached: false`. This degrades gracefully without erroring.

### `POST /api/pomodoros` — completed-project guard

Added validation before write:

```ts
for (const pid of body.project_ids) {
  const p = projects.find(x => x.id === pid);
  if (p?.completed_at) {
    return res.status(400).json({
      error: `Project '${p.name}' is completed. Reopen it before logging time.`
    });
  }
}
```

### `GET /api/sessions` — anchor field

Response gains an `anchor` field:

```ts
{
  sessions: SessionMeta[];
  anchor: string | null;  // ISO of max(metas[].mtime), null if no sessions or hours=0/all-time
}
```

Filter logic in the handler:

```ts
if (hours > 0) {
  const anchor = metas.length > 0 ? Math.max(...metas.map(m => m.mtime)) : null;
  const cutoff = anchor !== null ? anchor - hours * 3600 * 1000 : 0;
  filtered = metas.filter(m => m.mtime >= cutoff);
}
```

### `PATCH /api/projects/:id` — already supports completion

No new endpoint needed. The existing PATCH handler accepts `completed_at: ISO | null` and writes it.

### `settings.json` — new key

```json
{
  "activeWindowHours": 72,
  // ...existing keys
}
```

Validated 1 ≤ N ≤ 8760 (1h to 1 year). Default 72 if missing. Editable from Settings tab via existing `PATCH /api/settings`.

### Data migrations

None. The model uses existing fields:

- `projects.completed_at` already exists.
- `pomodoros.ended_at` already exists.
- `assignments.json` schema unchanged.
- `settings.json` gains one optional key; missing key implies default.

No existing project has `completed_at` set, so no data needs touching.

## Frontend changes

### `ProjectsContext` — fetch and expose derived status

Today the context loads `projects.json` and `assignments.json`. It will be extended to consume `/api/projects` (which now embeds `derivedStatus`) and re-expose:

- `projectById` — unchanged
- `derivedStatusByProjectId` — new map
- `anchor` — new value

The current `assignmentsByTmux` is still loaded separately for the Pomodoro picker and Sessions tab project chip; it's no longer used to compute status.

### Projects tab (`web/src/pages/Projects.tsx`)

- Remove the old `statusOf()` function.
- Render three chips per row using `derivedStatusByProjectId`.
- Add the anchor header.
- Adjust sort to use derived `engagement` and `progress`.
- Drawer: add `Mark complete` / `Reopen` button bound to PATCH.

### Pomodoro picker (`web/src/pages/Pomodoro.tsx` + `PomodoroProjectPicker.tsx`)

- Filter completed projects out of the default list.
- Add `Show completed` toggle in the picker header.
- When toggled on, render completed projects grayed and disable click.

### Sessions tab (`web/src/pages/Sessions.tsx`)

- Read `anchor` from response.
- Display "Anchor: …" line under the hours dropdown.
- (No change to filter semantics — the server now does the new computation.)

### Settings tab

- Add a numeric input for `activeWindowHours`.
- Validation: integer, 1–8760.

## Edge cases

| Case | Behavior |
|---|---|
| No pomodoros exist anywhere | Anchor is null. All projects → `progress: not_started`, `engagement: parked` (except Free if it has different rules). Header reads "No pomodoros yet". |
| Pomodoros exist only for completed projects | Anchor is the latest of those. Other (non-completed, no-pomodoro) projects → `progress: not_started, engagement: parked`. |
| A pomodoro spans multiple projects | Each project's last_pomodoro_at uses that pomodoro's `ended_at`. Anchor uses the same value. Standard multi-project pomodoro behavior. |
| Project marked complete while tmux assigned + live | `progress: completed`, `engagement: parked`, but `tmux_attached: true`. UI shows all three chips honestly. User decision whether to kill tmux or unassign. |
| Live tmux exists for an unassigned name | `tmux_attached: false` for every project — no assignment row to link it. Affects only the Pomodoro picker, not status. |
| `activeWindowHours = 0` | Treat as "always parked" — clamp to minimum 1 on settings PATCH to avoid this. |
| `activeWindowHours = 8760` (1 year) | Functionally "always active if ever worked on". Allowed. |
| User changes `activeWindowHours` | Status re-derives on next `/api/projects` request. No persistence migration. |
| Pomodoro with `ended_at` in the future (clock skew) | Anchor pulls forward to that future time. Edge case; ignore for v1. |

## Testing strategy

This is a personal tool and the existing codebase has no automated test suite. Verification will be **manual**, exercising each of the derivation rules against the live data:

1. **Progress derivation**
   - A new project with zero pomodoros → `not_started`.
   - Same project after one pomodoro → `in_progress`.
   - Mark complete → `completed`. Reopen → back to `in_progress`.
   - Reopen a project that had pomodoros all unassigned later (still has them) → `in_progress`.

2. **Engagement derivation**
   - With `activeWindowHours = 72`: a project whose latest pomodoro is 70h before the anchor → `active`. 74h before anchor → `parked`.
   - Stop all activity. Anchor stays at last pomodoro. Project remains `active` until anchor would shift past the window (i.e., until a newer pomodoro arrives). Verifies the "weekend stays warm" behavior.
   - Complete a recently-worked project → `engagement: parked` even though its pomodoro is within the window.
   - Set `activeWindowHours = 1`. Verify the cutoff narrows.

3. **Tmux_attached derivation**
   - Assign `Sim → Simulacrum`, with `Sim` running in live tmux → `tmux_attached: true`.
   - Kill the `Sim` tmux session → `tmux_attached: false` (assignment row still exists).
   - Stop tmux entirely → all projects report `tmux_attached: false` without errors.

4. **Pomodoro guard**
   - POST a pomodoro that includes a completed project → 400 with the expected error message.
   - POST a pomodoro that picks only non-completed projects → 200.

5. **Anchors**
   - With no pomodoros: `/api/projects` returns `anchor.ts: null`, header reads "No pomodoros yet".
   - With pomodoros: anchor matches `max(ended_at)` in `pomodoros.json`.
   - Sessions tab: with `Last: 24h` and most recent session 5 days ago, the cutoff is "5 days ago minus 24h", not "yesterday".

6. **Sort order on Projects tab**
   - Mixed set of active + in_progress-parked + not_started + completed projects renders in the documented order.

Each rule will be visually confirmed in the running app (browser + dev server) using the user's real data after the changes ship.

## Out of scope for this design

- Multi-user / role-based access.
- History of status transitions (no audit log).
- A "paused" state distinct from `parked`.
- Auto-completing projects after long inactivity.
- Renaming `completed_at` or adding new manual override states.
- Free project special-casing (it remains a project like any other for status purposes).

## Open questions

None currently — all design decisions have been confirmed with the user in chat. This spec is ready for written review before moving to an implementation plan.
