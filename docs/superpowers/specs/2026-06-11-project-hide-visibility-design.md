# Project hide / visibility + engagement sectioning — design

**Date:** 2026-06-11
**Status:** approved (pending spec review)

## Problem

The Projects page renders every non-completed project in a single list, sorted
active-first. The user wants to:

1. See **parked** projects visually separated from **active** ones.
2. **Hide** individual projects they're confident they won't touch for a while,
   so the page isn't cluttered by long-dormant work — without deleting or
   completing them.
3. Reveal hidden projects on demand via a toggle, with a count of what's hidden
   broken down by engagement.

Crucially, "hidden" is **not** a new status. The existing three orthogonal
fields (`progress`, `engagement`, `tmux_attached`) are unchanged. Hiding is a
pure **presentation/visibility** concern, layered on top — the same way the
existing "Show completed" toggle already is.

## Model

### New field: `hidden`

- A manual `hidden: boolean` on each project. Default `false`.
- Read-time normalized: any project loaded without the field is treated as
  `hidden: false`. No schema-version bump required (same approach used for
  pomodoro `paused_ms`).
- **Orthogonal to status.** `hidden` does not affect `progress`, `engagement`,
  the global pomodoro anchor, tmux attachment, or pomodoro eligibility. A hidden
  project still derives `active`/`parked` exactly as before; it is merely
  filtered out of the default view.

### Interaction with `completed`

- **You cannot hide a completed project.** The drawer Hide control is disabled
  when `completed_at` is set.
- **Completing a project clears its `hidden` flag.** When `completed_at` is set
  via the PATCH endpoint, `hidden` is forced to `false` server-side, so there is
  never a hidden-and-completed ghost state. (Reopening a project leaves it
  un-hidden; the user can re-hide if they wish.)

## UI

### Page sections

The Projects page renders these sections in order:

```
Active (N)        — visible (hidden=false), engagement=active
Parked (N)        — visible (hidden=false), engagement=parked
Completed (N)     — behind the existing "Show completed" toggle (unchanged)

[Hidden group]    — only when "Show hidden" is ticked:
Hidden
  Active (N)      — hidden=true, engagement=active
  Parked (N)      — hidden=true, engagement=parked
```

- The main **Active** and **Parked** sections contain only non-hidden projects.
- Hidden projects are pulled entirely out of those sections and appear only in
  the **Hidden** group, itself sub-split into Active and Parked sub-sections.
- **Completed** is independent of the hide mechanism and never appears under
  Hidden. It continues to use its own "Show completed" toggle.
- Sorting within each (sub)section keeps the existing rules: within an
  engagement group, `in_progress` before `not_started`, then by name. Completed
  sorted by `completed_at` descending.

### Header controls

Next to the existing "Show completed" checkbox:

- **"Show hidden" checkbox**, shown **only when at least one project is hidden**.
  When zero projects are hidden, the control is absent entirely.
- Adjacent count, broken down by engagement of the hidden projects:
  `Show hidden (2 active, 2 parked)`. Active count first, parked second; a zero
  bucket is still shown for clarity only if the other is non-zero
  (e.g. `(0 active, 3 parked)` is acceptable; never render the control at all
  when both are zero).

### Drawer Hide control

In the project drawer, alongside Mark complete / Reopen:

- A **Hide** button when `hidden=false`, **Unhide** when `hidden=true`.
- **Disabled when the project is completed** (`completed_at` set), with a tooltip
  explaining completed projects can't be hidden.
- Clicking calls `updateProject(id, { hidden: <toggled> })`.

## Server

- `PATCH /api/projects/:id` accepts `hidden: boolean`. Validate type; reject
  non-boolean.
- When the same PATCH (or any PATCH) results in `completed_at` being set, force
  `hidden: false`.
- GET responses include `hidden` (normalized to `false` when absent) on each
  project, flowing through the existing `ProjectWithStatus` shape.

## Out of scope

- Quick-hide affordance on the card itself (drawer-only for now).
- Bulk hide/unhide.
- Auto-hiding based on age or engagement (this stays fully manual; the automatic
  cool-down is what `parked` already does).
- Any change to the derivation of `progress` / `engagement` / `tmux_attached`.

## Testing

- Derivation/normalization: a project without `hidden` reads as `false`.
- PATCH `hidden=true` on an open project → persisted; appears in Hidden group.
- PATCH `completed_at` on a hidden project → `hidden` cleared to `false`.
- Hide button disabled for completed projects.
- "Show hidden" control hidden when nothing is hidden; count reflects engagement
  split when present.
- Hidden projects absent from main Active/Parked sections; present under Hidden
  sub-sections when toggled on.
