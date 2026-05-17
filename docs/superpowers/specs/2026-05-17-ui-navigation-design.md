# UI navigation regrouping — design spec

**Date:** 2026-05-17
**Status:** Draft for user review
**Author:** Claude + gpolov

## Problem

The current top navigation in `web/src/App.tsx` is a single flat row of 7 tabs:

```
Sessions  |  Tmux Map  |  Shell History  |  Snapshots  |  Projects  |  Pomodoro  |  Calendar
```

This treats every tab as equally important and gives no signal about which tabs are conceptually related. Two practical problems:

1. **No grouping.** Projects, Pomodoro, and Calendar are conceptually a single "what am I doing" cluster, but they sit next to Snapshots, which is a rarely-used backup utility.
2. **No demotion.** Snapshots and Shell History are second-class tools (you almost never need them day-to-day) but they look identical to Projects or Pomodoro.

## Goal

Reorganize the existing 7 tabs into three labeled, visually distinct groups on the top bar — without removing, renaming, splitting, or merging any individual tab — so that:

- The "what am I doing" cluster is grouped together.
- The "what's running" cluster is grouped together.
- The "tools I rarely need" cluster is grouped and visually demoted.

## The grouping

```
WORK              ENVIRONMENT          TOOLS
----              -----------          -----------
Projects          Sessions             Snapshots
Pomodoro          Tmux Map             Shell History
Calendar
```

- **WORK** — Projects, Pomodoro, Calendar. The planning + time-tracking cluster.
- **ENVIRONMENT** — Sessions, Tmux Map. Live observability into Claude sessions and the tmux process tree.
- **TOOLS** — Snapshots, Shell History. Forensic/admin utilities accessed only occasionally.

Settings remains accessible via the existing gear icon (not in any group).

## Layout

The top bar grows from one row to two rows:

```
+------------------------------------------------------------------+
| ΣΠ∪ΠΣ                                                    [gear]  |
|------------------------------------------------------------------|
|  WORK              | ENVIRONMENT         |       TOOLS           |
|  Projects Pomodoro | Sessions  Tmux Map  |    snapshots          |
|  Calendar          |                     |    shell hist         |
+------------------------------------------------------------------+
```

- **Row 1** (existing): logo + flex-1 spacer + gear icon.
- **Row 2** (new): three groups, vertically separated by a thin divider. WORK and ENVIRONMENT left-aligned in their cells; TOOLS pushed to the far right of the bar via `ml-auto` on its wrapper.
- Group labels (`WORK`, `ENVIRONMENT`, `TOOLS`) sit as small uppercase text immediately above their tabs (not clickable).
- Inside each group, tab buttons wrap if the bar is narrow (rare — desktop tool).

### Visual treatment

| Element | WORK / ENVIRONMENT | TOOLS |
|---|---|---|
| Group label | `text-xs uppercase tracking-wider text-slate-500` | same |
| Tab text size | `text-sm` (current) | `text-xs` |
| Tab base color | `text-slate-400` (current) | `text-slate-600` (dimmer) |
| Tab hover | `hover:text-white hover:bg-slate-800` (current) | same |
| Tab active | `bg-slate-700 text-white` (current) | `bg-slate-700 text-white` (current — keep contrast when active so it doesn't disappear when you're actually using it) |
| Divider | `border-l border-slate-800 px-3` between groups | same |

Net effect: TOOLS visually recedes in the resting state but still pops when you actually use one.

## Default tab

The initial tab on app load changes from `sessions` to `pomodoro`.

## Component structure

A single file changes: `web/src/App.tsx`. The flat `TABS` array becomes a grouped definition:

```ts
type Tab = "sessions" | "tmux" | "shell" | "snapshots" | "projects" | "pomodoro" | "calendar";

type Group = { label: string; tabs: { id: Tab; label: string }[]; demoted?: boolean };

const NAV_GROUPS: Group[] = [
  {
    label: "WORK",
    tabs: [
      { id: "projects",  label: "Projects" },
      { id: "pomodoro",  label: "Pomodoro" },
      { id: "calendar",  label: "Calendar" },
    ],
  },
  {
    label: "ENVIRONMENT",
    tabs: [
      { id: "sessions",  label: "Sessions" },
      { id: "tmux",      label: "Tmux Map" },
    ],
  },
  {
    label: "TOOLS",
    demoted: true,
    tabs: [
      { id: "snapshots", label: "Snapshots" },
      { id: "shell",     label: "Shell History" },
    ],
  },
];
```

A small `NavGroup` component renders each group (label + buttons), reading `demoted` to apply the smaller/dimmer styles. The TOOLS group additionally uses `ml-auto` on its wrapper so it floats to the right of the second row.

The dynamic Pomodoro label (`Pomodoro · Work 18:32`) is unchanged — the existing `usePomodoroTabLabel()` hook continues to feed the Pomodoro button's text inside the WORK group.

## Out of scope

- Keyboard shortcuts for tab switching.
- Persisting the last-active tab in localStorage.
- Mobile / narrow-screen responsive collapse.
- Renaming any individual tab.
- Merging or splitting any individual tab.
- Changing the Settings modal location or contents.
- Changing routing (the app has no router; tab state is local).
- Adding new tabs.

## Testing strategy

Manual verification only (no automated test runner in repo):

1. **Default tab**: open the app → Pomodoro is selected.
2. **Group layout**: top bar renders two rows; row 2 shows `WORK | ENVIRONMENT | TOOLS` with their respective tabs underneath the labels.
3. **TOOLS demotion**: TOOLS group is right-aligned, label and tab text are smaller and dimmer than WORK/ENVIRONMENT when not selected.
4. **TOOLS contrast on select**: clicking `Snapshots` selects the tab with the same `bg-slate-700 text-white` highlight as any other tab.
5. **Pomodoro live label**: start a pomodoro → the Pomodoro tab text becomes `Pomodoro · Work MM:SS` and counts down. Same for `Pomodoro · Break MM:SS` during rest.
6. **Tab switching**: every tab renders its existing page content unchanged (no routing or props changed).
7. **Gear button**: top-right gear opens the existing Settings modal.

## Edge cases

| Case | Behavior |
|---|---|
| User reloads while on a tab | Always lands on Pomodoro (default). No persistence in v1. |
| Browser window narrower than the bar fits | Tabs wrap naturally onto a second visual row inside their group cell. Acceptable; user is on desktop only. |
| Pomodoro is active and user is on Projects | Pomodoro tab label still counts down in the WORK group. |
| Pomodoro reaches 0 | Existing behavior (label becomes `Pomodoro · Done`). |
| User completes a project (unrelated change) | No nav impact. |

## Open questions

None — all design decisions confirmed in chat. Ready for written review.
