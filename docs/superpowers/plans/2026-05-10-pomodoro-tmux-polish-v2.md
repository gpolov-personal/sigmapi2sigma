# Pomodoro / Tmux Map Polish v2 — Plan + Design

**Goal:** Five small UX improvements bundled into one branch.

**Tech Stack:** TypeScript + Express server, React 19 + Tailwind frontend. No tests in repo — verification is `npx tsc -p . --noEmit` + `npm run build:web` + manual UI check.

**Process:** Personal tool, light review. Implement inline (not subagent-driven). Commit per task. Merge to main directly.

## Design

### A. Pomodoro state in the in-app tab label

When a pomodoro is active, the `Pomodoro` button in the top tab strip becomes `Pomodoro · Work 18:42`. When in rest, `Pomodoro · Break 4:23`. When idle, plain `Pomodoro`. State read from localStorage (`loadActive()`, `loadRest()`); the tab strip polls every second.

No floating overlay. The existing in-page rest UI on the Pomodoro tab is unchanged. When the user clicks the tab they see the existing skip/continue/different-pomodoro buttons.

**File:** `web/src/App.tsx`

### B. Recent table + drawer redesign

The Recent table currently shows compact `Abbr › Task` chips. Replace with vertical layout per row: project full name on its own line, then tasks as bullets indented underneath. The `PomodoroDetailDrawer` chip section becomes a per-project block with the project's color stripe + full name + task bullets.

Free pomodoros render the `freeTaskLabel` (Component C) where a task name would otherwise appear.

**Files:** `web/src/pages/Pomodoro.tsx`, `web/src/components/PomodoroDetailDrawer.tsx`

### C. Free-project task label

`Pomodoro` interface gains `freeTaskLabel: string` (defaults to `""`). Server route stores and returns it. Picker shows a text input "What are you working on?" only when Free is among selected projects. Renders alongside other tasks: where defined-project pomodoros show `Abbr › task.name`, free pomodoros show `Free › freeTaskLabel`.

If Free is selected but `freeTaskLabel` is empty, render a plain `Free` chip (current behavior).

Storage migration: existing pomodoros without the field default to `""` on read.

**Files:** `server/routes/pomodoros.ts` (schema validation + read backfill), `web/src/api.ts` (interface), `web/src/pages/Pomodoro.tsx` (picker input + finalize), `web/src/components/PomodoroDetailDrawer.tsx`, `web/src/components/ProjectChip.tsx` (already supports `task` or `label` props — extend rendering logic in callers, no chip change required).

### D. Task notes editor

Inline collapsible textarea per task in the project drawer's tasks list. Each row gets a small `notes` button that toggles a textarea below the row. Saves via existing `PATCH /api/tasks/:id` with `{ notes }`.

`Task.notes` field already exists; only frontend wiring needed.

**File:** `web/src/pages/Projects.tsx`

### E. Save & Kill + hide-saved-from-dead

Replace the existing `📌 Save for later` button on **alive** session rows with a single `📌 Save & kill`. Confirmation modal (reuse the `ForceConfirmModal` pattern visually) lists windows/panes/cwds/Claude convos: "Pin to saved-tmux.json AND kill the running session?". On confirm: POST `/api/saved-tmux/pin` then POST a new endpoint `/api/tmux/sessions/:name/kill`.

Dead rows in the live tree keep their `📌 Save for later` button (they're already dead, no kill needed) — this is the only remaining "plain Save for later" entry point. **Edit:** since the user wants a single button, dead-row Save also stays as just "Save for later" (no force, no kill — the session is already gone).

`TmuxMap.tsx`'s merge `useMemo` filters out any session whose name appears in `saved.sessions[*].name` from the live-tree render. So a saved session never appears as a dead row — only in the amber Saved-for-Later section.

**Files:** `server/routes/tmux.ts` (new kill endpoint), `web/src/pages/TmuxMap.tsx` (button rewire, modal, filter)

## Data model summary

- `Pomodoro` gains optional `freeTaskLabel?: string` (server defaults to `""` on read; new pomodoros set it explicitly).
- `Task.notes` unchanged (already exists).
- `saved-tmux.json` unchanged.
- No snapshot/JSONL changes.

## File structure

| File | Tasks |
|---|---|
| `web/src/App.tsx` | T1 |
| `web/src/api.ts` | T3 (interface) |
| `server/routes/pomodoros.ts` | T3 (validation + backfill) |
| `web/src/pages/Pomodoro.tsx` | T2, T3 |
| `web/src/components/PomodoroDetailDrawer.tsx` | T2, T3 |
| `web/src/pages/Projects.tsx` | T4 |
| `server/routes/tmux.ts` | T5 (new kill endpoint) |
| `web/src/pages/TmuxMap.tsx` | T5 (button + modal + filter) |

## Tasks

### Task 1: Pomodoro state in the tab label

Add a tiny live-state hook in `App.tsx` that polls `loadActive()` + `loadRest()` every second and computes a label suffix.

- Read live state, derive `pomodoroLabel: string`:
  - If `rest` is active: `Pomodoro · Break MM:SS` (countdown to `rest.restEndsAt`)
  - Else if `active` is set and not yet expired: `Pomodoro · Work MM:SS` (remaining = `targetDurationMinutes * 60000 - (now - startedAt)`)
  - Else if `active` exists but expired (post-target): `Pomodoro · Done` (waiting for user stop)
  - Else: `Pomodoro` (plain)
- Replace `<button>{t.label}</button>` for the pomodoro tab with the dynamic label.

Verification: TS check + manually start a pomodoro and watch the tab label tick.

### Task 2: Recent table + drawer redesign

Pomodoro.tsx Recent table: replace the compact chip cell with a vertical layout per row. Each pomodoro row shows:
- Project name (colored stripe + name) on first line
- Tasks indented as `· task name` lines below (or `(project-level)` if no tasks for that project)
- For free pomodoros with `freeTaskLabel`, the label renders where a task name would.

PomodoroDetailDrawer.tsx: replace the flat chip list with per-project blocks (colored left border, project name header, task bullets underneath).

Verification: TS check + open the drawer for a pomodoro with multiple projects + tasks, confirm grouping renders.

### Task 3: Free-project task label

Server: `server/routes/pomodoros.ts` — accept `freeTaskLabel` (string ≤ 200 chars, defaults to `""`) in POST and PATCH; return it in GET. Backfill missing field as `""` on read.

Frontend type: `web/src/api.ts` — add `freeTaskLabel: string` to `Pomodoro`.

Picker (Pomodoro.tsx): when Free's id is in `selectedProjects`, show a text input "What are you working on? (Free)". Bind to local state `freeTaskLabel`. Pass on commit.

Chip rendering: callers that build chips for pomodoros render `Free › freeTaskLabel` when project is Free and label is non-empty, else plain `Free`. The `ProjectChip` component already supports `label` prop — pass `Free › <label>` as `label` for those cases, OR pass it as a synthetic Task (cleaner). Implement: in PomodoroDetailDrawer.tsx and Pomodoro.tsx Recent rendering, when project is Free and `pomodoro.freeTaskLabel` is non-empty, render `<ProjectChip project={freeProject} label={"Free › " + freeTaskLabel} />`.

Verification: TS check + start a free pomodoro with a label, finalize, see it in Recent and drawer.

### Task 4: Task notes editor

Projects.tsx: in the per-task row inside the drawer, add a `notes` toggle button. When expanded, render a textarea bound to local state `taskNotes[t.id]`. Save on blur via the existing `updateTask(t.id, { notes })`.

If the task has notes, show a small `📝` indicator next to the task name (always visible).

Verification: TS check + edit a task note, refresh page, note persists.

### Task 5: Save & Kill + filter saved from dead rows

Server (`server/routes/tmux.ts`):

```typescript
tmuxRouter.post("/tmux/sessions/:name/kill", async (req, res) => {
  const name = req.params.name;
  if (/[\s.:]/.test(name)) {
    return res.status(400).json({ error: "invalid tmux session name" });
  }
  try {
    await pexec("tmux", ["kill-session", "-t", `=${name}`]);
    res.json({ ok: true });
  } catch (e: any) {
    if (String(e?.stderr ?? e?.message ?? "").includes("can't find session")) {
      return res.status(404).json({ error: `tmux session "${name}" not found` });
    }
    res.status(500).json({ error: String(e?.stderr ?? e?.message ?? e) });
  }
});
```

(`pexec` is already imported. Need to also export from `server/lib/tmux.ts` or pexec'd inline. Use `pexec("tmux", ...)` directly here matching the existing pattern in this file.)

Frontend (`web/src/pages/TmuxMap.tsx`):

1. Replace the alive-row `📌 Save for later` button with `📌 Save & kill`. Wire to a new `tryForceSaveAndKill(s)` that opens a confirm modal listing the live session details, similar to `tryForceRestore`. On confirm: POST `/api/saved-tmux/pin` then POST `/api/tmux/sessions/<name>/kill`, then `refresh()`.
2. Keep the dead-row `Save for later` button as-is (no kill — already gone).
3. In the existing merge `useMemo`, filter out any session whose name is in `saved.sessions[*].name` after the merge, so saved sessions never appear in the live-tree session list (alive or dead).

Verification: TS check + save+kill an alive session, confirm it disappears from live tree and appears in amber section. Verify a saved session that's killed externally also doesn't double-render.

## Verification gates

- `npx tsc -p . --noEmit` after each task — zero errors
- `npm run build:web` after T5 — clean Vite build
- Manual UI walkthrough at the end

## Commit log expected

```
feat(app): show pomodoro state in the tab label
feat(pomodoro): per-project blocks + task lists in Recent + drawer
feat(pomodoro): free project task label per pomodoro
feat(projects): editable notes per task
feat(tmux-map): Save & kill + filter saved sessions from live tree
```
