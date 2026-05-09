# Tmux Map UX Hardening: Folding + Force-Confirm + Working-Dir Fixes

**Date:** 2026-05-09
**Status:** Approved for implementation planning
**Affected files:**
- `web/src/pages/TmuxMap.tsx` (folding, confirm modal)
- `web/src/pages/Projects.tsx` (mismatch warning)
- `server/lib/paths.ts` (new — tilde expansion helper)
- `server/routes/tmux.ts` (apply tilde expansion + return existing-session cwds)
- `server/routes/snapshots.ts` (apply tilde expansion to /resume)

## Problem

Four UX/correctness gaps observed on the Tmux Map and Projects pages:

1. **The `📌 Saved for Later` section can't be collapsed.** Every other session row in the live tree has a `▶/▼` caret to fold the pane grid. The saved section header has no caret, and saved entries can't be folded individually either. With even a few pinned sessions, the section dominates the page.

2. **`Restore --force` can silently destroy a running tmux session.** The `--force` flag tells `restore.sh` to `tmux kill-session -t NAME` before recreating from snapshot. If the user has the session running with active panes (cwds, Claude conversations, scrollback), all of that is lost without any prompt. There are two `Restore --force` buttons with this behavior:
   - In the Saved-for-Later section, on each saved entry
   - In the main live tree, on dead-session row headers

3. **A project's `working_dir` containing a tilde (`~/foo`) silently lands at `$HOME`.** `tmux new-session -c "~/foo"` passes the literal string to `chdir()`, which doesn't expand the tilde. Tmux falls back to `$HOME` with no warning. Reproduced empirically: `tmux new-session -d -s X -c '~/foo' && tmux list-panes -t X -F '#{pane_current_path}'` → `/home/dsu`. Affects both `POST /api/tmux/sessions` (Project drawer's Assign button) and `POST /api/resume` (Sessions drawer's "Resume in new tmux" button).

4. **Re-clicking Assign on an existing session ignores the new `working_dir`.** Tmux can't change the cwd of an existing session. Today, `smartAssign()` in `Projects.tsx` returns "reusing it" when the session already exists, dropping the requested cwd silently. Users edit the working_dir, click Assign again, and nothing happens — but the UI gives no signal that the existing session's cwd is wrong.

## Goals

- Make the saved section foldable like every other session block
- Make individual saved entries foldable (mirroring live-tree session entries)
- Persist fold state across page refreshes
- Add a confirmation modal for `Restore --force` — but only when the action would actually destroy a live session
- Reuse one modal component for both `Restore --force` paths
- Expand `~/...` cwds server-side before passing to tmux, so working_dirs that start with a tilde just work
- Surface a yellow warning under the Assign button when the existing tmux session's panes don't sit in the project's working_dir, with concrete fix instructions

## Non-goals

- No backend / API changes for folding (frontend only) — but tilde expansion and existing-session cwd reporting do require small backend additions
- No fold/persistence for the live-tree pane-card state (only at session and section level)
- No scope change to `Forget` (already has a `confirm()` prompt)
- No retroactive UX changes to other tabs (Sessions, Pomodoro, etc.)
- No automatic kill+recreate on cwd mismatch (warning-only; the destructive path is left to the user explicitly)
- No `~user/...` expansion (only `~` and `~/...` — POSIX user-tilde expansion needs `/etc/passwd` parsing and is rarely useful here)
- No retroactive expansion of stored `working_dir` in `projects.json` — storage stays literal so the path is portable across machines, expansion happens only at the moment we hand it to tmux

## Architecture overview

Four independent improvements split across frontend and backend:

| Component | Where | Lines (approx) |
|---|---|---|
| A. Fold + persistence | `web/src/pages/TmuxMap.tsx` | ~80 |
| B. Force-confirm modal | `web/src/pages/TmuxMap.tsx` (modal alongside `ScrollbackModal`) | ~70 |
| C. Tilde expansion | new `server/lib/paths.ts` + 2 route call sites | ~25 |
| D. Cwd-mismatch warning | `server/routes/tmux.ts` enriches 409 + `web/src/pages/Projects.tsx` renders | ~50 |

A and B touch only `TmuxMap.tsx`. C and D touch backend + `Projects.tsx`. No cross-component coupling — they can be implemented and verified independently. Implementation order is suggested as A → B → C → D so the lightest changes land first, but the dependency graph is empty.

## Component A — Folding (section + per-entry, persisted)

### Namespaced collapsed keys

The existing code uses raw session names (`s.name`) as keys in `collapsed`. To track three distinct foldable surfaces without collision risk, all keys move to a namespaced form:

```typescript
const KEY_SAVED_SECTION = "section:saved";
const keyForSavedEntry  = (name: string) => `saved:${name}`;
const keyForLiveSession = (name: string) => `live:${name}`;
```

This is the **only** breaking change to the existing `collapsed` semantics. The migration is mechanical:

| Before | After |
|---|---|
| `collapsed.has(s.name)` (in live tree) | `collapsed.has(keyForLiveSession(s.name))` |
| `toggle(s.name)` (in live tree) | `toggle(keyForLiveSession(s.name))` |
| `setCollapsed(new Set(sessions.map(s => s.name)))` (foldAll) | `setCollapsed(new Set([KEY_SAVED_SECTION, ...savedNames.map(keyForSavedEntry), ...liveNames.map(keyForLiveSession)]))` |
| `setCollapsed(new Set())` (unfoldAll) | unchanged |

No data migration in localStorage is needed because the existing `collapsed` state was session-only (in-memory) before this change. There is no persisted state to convert.

### localStorage persistence

```typescript
const COLLAPSE_LS = "tmuxMap:collapsed";

const [collapsed, setCollapsed] = useState<Set<string>>(() => {
  try {
    const raw = localStorage.getItem(COLLAPSE_LS);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
});

useEffect(() => {
  try { localStorage.setItem(COLLAPSE_LS, JSON.stringify([...collapsed])); }
  catch { /* full quota / private mode → ignore */ }
}, [collapsed]);
```

Both the read (init) and write (effect) paths are wrapped in try/catch to degrade gracefully when localStorage is unavailable (private browsing, quota exceeded, disabled by browser settings). On failure, the feature falls back to in-memory-only fold state, equivalent to today's behavior.

### Section-level caret

The existing `📌 Saved for Later` panel header gains a `▶/▼` caret button on the left, identical in style and behavior to the per-session caret in the live tree:

```tsx
<div className="px-4 py-2 font-semibold border-b border-amber-800/60 flex items-center gap-3">
  <button
    onClick={() => toggle(KEY_SAVED_SECTION)}
    className="text-slate-400 hover:text-white w-4"
  >{collapsed.has(KEY_SAVED_SECTION) ? "▶" : "▼"}</button>
  <span className="text-amber-300">📌 Saved for Later</span>
  ...
```

When `collapsed.has(KEY_SAVED_SECTION)` is true, the entries grid (the `<div className="divide-y divide-amber-900/40">` block) is not rendered.

### Per-entry caret

Each saved entry gets its own caret immediately before the session name. When `collapsed.has(keyForSavedEntry(s.name))` is true, the pane-card grid for that entry is hidden, but the entry header (name, badges, action buttons) remains visible.

```tsx
<div className="flex items-center gap-3 mb-2">
  <button
    onClick={() => toggle(keyForSavedEntry(s.name))}
    className="text-slate-400 hover:text-white w-4"
  >{collapsed.has(keyForSavedEntry(s.name)) ? "▶" : "▼"}</button>
  <span className="font-semibold">{s.name}</span>
  ...
```

### Fold-all / Unfold-all extension

The existing `foldAll` builds a Set from live-session names. After the change it must also include `KEY_SAVED_SECTION` and one entry per `saved.sessions.name`:

```typescript
function foldAll() {
  const keys: string[] = [];
  if (saved && saved.sessions.length > 0) {
    keys.push(KEY_SAVED_SECTION);
    for (const s of saved.sessions) keys.push(keyForSavedEntry(s.name));
  }
  for (const s of (sessions as TmuxSession[])) keys.push(keyForLiveSession(s.name));
  setCollapsed(new Set(keys));
}
function unfoldAll() { setCollapsed(new Set()); }
```

## Component B — Smart confirmation on Restore --force

### Trigger condition

The modal fires only when both:
1. The user clicked `Restore --force` (either from the saved section or from a dead-row in the live tree)
2. `liveSessionNames.has(name)` is true at click time

When `liveSessionNames.has(name)` is false, `--force` has nothing to kill — the operation is equivalent to plain `Restore`. In that case, proceed silently.

### State + context

```typescript
type ForceContext = {
  name: string;
  source: "saved" | "snapshot";          // which file the restore reads from
  sourceLabel: string;                    // human-readable: "saved 57s ago" or "snapshot 5m ago"
  liveSession: TmuxSession;               // pulled from data.tree, used to render details
};

const [forceConfirm, setForceConfirm] = useState<ForceContext | null>(null);
```

### Wiring

Today's `Restore --force` buttons call `restoreOnly(name, true)` (live tree dead-row) or `restoreSaved(name, true)` (saved section) directly. The new pattern wraps both behind a single guard:

```typescript
function tryForceRestore(source: "saved" | "snapshot", name: string, sourceLabel: string) {
  if (!liveSessionNames.has(name)) {
    // No conflict — proceed without prompt.
    return source === "saved" ? restoreSaved(name, true) : restoreOnly(name, true);
  }
  const liveSession = (data?.source === "live" ? data.tree : []).find(s => s.name === name);
  if (!liveSession) {
    // Defensive: liveSessionNames was true but lookup failed → just proceed.
    return source === "saved" ? restoreSaved(name, true) : restoreOnly(name, true);
  }
  setForceConfirm({ name, source, sourceLabel, liveSession });
}
```

Both `Restore --force` buttons change to call `tryForceRestore` instead of the underlying handler. `restoreOnly` and `restoreSaved` themselves are unchanged.

### Modal `<ForceConfirmModal>` (inline component)

Rendered when `forceConfirm !== null`. Defined alongside `ScrollbackModal` in the same file. Approximate shape:

```tsx
function ForceConfirmModal({ ctx, onCancel, onConfirm }: {
  ctx: ForceContext;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const allPanes = ctx.liveSession.windows.flatMap(w => w.panes);
  const cwds = [...new Set(allPanes.map(p => p.cwd))];
  const claudeIds = allPanes
    .filter(p => p.cmd === "claude" && p.claudeSessionId)
    .map(p => p.claudeSessionId!);

  // Esc key dismisses without action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-slate-900 border border-red-700 rounded p-6 max-w-2xl w-full mx-4"
      >
        <h2 className="text-lg font-semibold text-red-300 mb-3">Replace running tmux session?</h2>
        <p className="text-sm mb-2">
          A live tmux session named <code className="text-amber-300">{ctx.name}</code> is currently running with:
        </p>
        <ul className="text-sm space-y-1 mb-3 text-slate-300">
          <li>• {ctx.liveSession.windows.length} window{ctx.liveSession.windows.length === 1 ? "" : "s"}, {allPanes.length} pane{allPanes.length === 1 ? "" : "s"}</li>
          {cwds.slice(0, 4).map(c => <li key={c} className="font-mono text-xs truncate">• cwd: {c}</li>)}
          {cwds.length > 4 && <li className="text-xs text-slate-500">  (+{cwds.length - 4} more cwds)</li>}
          {claudeIds.length > 0 && (
            <li>• {claudeIds.length} Claude conversation{claudeIds.length === 1 ? "" : "s"}</li>
          )}
        </ul>
        <p className="text-sm text-slate-400 mb-4">
          <b>Restore --force</b> will <b className="text-red-300">kill the running session</b> and recreate it from {ctx.sourceLabel}.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-sm hover:bg-slate-700"
          >Cancel</button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 bg-red-700 rounded text-sm hover:bg-red-600"
          >Replace</button>
        </div>
      </div>
    </div>
  );
}
```

The modal is dismissable by:
- Clicking `Cancel`
- Pressing `Escape`
- Clicking the backdrop (outside the modal box)

**Outside-click does NOT auto-confirm — it cancels.** This matches industry convention and matches the user's earlier explicit guidance about not letting outside-click dismiss the rest cycle (a similar destructive concern).

### Source-label computation at the call site

Both call sites compute `sourceLabel` at click time:

- Saved-section button: `sourceLabel = "saved-tmux.json (saved " + relativeTime(new Date(meta.savedAt).getTime()) + ")"`
- Live-tree dead-row button: `sourceLabel = "snapshot " + relativeTime(new Date(data.snapshot.ts).getTime())`

If snapshot data isn't available (`data.snapshot === null`), the dead-row force-restore button can't have been visible (the row is from a snapshot), so this case is unreachable in practice; defensive code may use `"the latest snapshot"` as a fallback.

## Data flow

```
[user clicks Restore --force]
        │
        ├─ tryForceRestore(source, name, sourceLabel)
        │       │
        │       ├─ liveSessionNames.has(name)?
        │       │       │
        │       │       ├─ no  → call restoreSaved/restoreOnly directly with force=true (silent)
        │       │       │
        │       │       └─ yes → setForceConfirm({...})
        │       │              ▼
        │       │      [modal renders]
        │       │              │
        │       │              ├─ user clicks Cancel/Esc/backdrop → setForceConfirm(null), no action
        │       │              │
        │       │              └─ user clicks Replace → setForceConfirm(null), call restoreSaved/restoreOnly with force=true
        │       │
        │       ▼
        │  [restore.sh runs server-side, response renders in restoreLog panel]
        │
        ▼
   [refresh() refreshes the live tree]
```

## Component C — Tilde expansion (server-side)

### Helper

New file `server/lib/paths.ts`:

```typescript
import os from "node:os";

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * Other paths are returned unchanged. Does NOT handle `~user/...` —
 * POSIX user-tilde expansion is out of scope and rarely useful here.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return os.homedir() + p.slice(1);
  return p;
}
```

### Call sites

**1. `server/routes/tmux.ts`** — `POST /api/tmux/sessions`. Currently:

```typescript
await createDetachedSession(name, typeof cwd === "string" && cwd.length > 0 ? cwd : undefined);
```

Change to expand before passing through:

```typescript
const expanded = typeof cwd === "string" && cwd.length > 0 ? expandHome(cwd) : undefined;
await createDetachedSession(name, expanded);
```

**2. `server/routes/snapshots.ts`** — `POST /api/resume`. Currently:

```typescript
await pexec("tmux", [
  "new-session", "-d",
  "-s", tmuxSessionName,
  "-c", cwd,
  claudeCmd,
]);
```

Change `-c` arg to expanded form:

```typescript
await pexec("tmux", [
  "new-session", "-d",
  "-s", tmuxSessionName,
  "-c", expandHome(cwd),
  claudeCmd,
]);
```

(`cwd` is the request-body field, after the existing 400-validation has already enforced it as a non-empty string.)

### Storage stays literal

The user's `project.working_dir` keeps the form they typed (`~/foo`). Expansion happens only at the moment we hand the value to tmux. No migration of existing data needed.

### Verification

```bash
# Before fix:
tmux new-session -d -s _t -c '~/pProjects/sigmapi2sigma' && tmux list-panes -t _t -F '#{pane_current_path}'
#  → /home/dsu          (wrong)
tmux kill-session -t _t

# After fix, exercising the API:
curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"_t","cwd":"~/pProjects/sigmapi2sigma"}' \
  http://127.0.0.1:5174/api/tmux/sessions
tmux list-panes -t _t -F '#{pane_current_path}'
#  → /home/dsu/pProjects/sigmapi2sigma   (correct)
tmux kill-session -t _t
```

## Component D — Cwd-mismatch warning on Assign

### Backend: enrich the 409 response

When `POST /api/tmux/sessions` detects an existing session, the route currently returns:

```typescript
return res.status(409).json({ error: `tmux session "${name}" already exists` });
```

After the fix, also include the existing session's distinct pane cwds and a `cwdMismatch` boolean computed against the requested cwd (with tilde expansion already applied):

```typescript
if (String(e?.message ?? "").includes("already exists")) {
  // Probe the existing session's panes for the warning UI.
  let existingCwds: string[] = [];
  let cwdMismatch = false;
  try {
    const tree = await buildTmuxTree();
    const hit = tree.find(s => s.name === name);
    if (hit) {
      existingCwds = [...new Set(hit.windows.flatMap(w => w.panes.map(p => p.cwd)))];
      const targetCwd = typeof cwd === "string" && cwd.length > 0 ? expandHome(cwd) : null;
      cwdMismatch = !!targetCwd && !existingCwds.includes(targetCwd);
    }
  } catch { /* fail open: empty list, no mismatch flag */ }
  return res.status(409).json({
    error: `tmux session "${name}" already exists`,
    existingCwds,
    cwdMismatch,
  });
}
```

The shape change is additive — existing 409 consumers keep working since they only read `error`. Today the only consumer is `smartAssign()` in Projects.tsx; saved-tmux's pin route also surfaces 404/400 but never 409 from this endpoint.

### Frontend: render the warning

`web/src/pages/Projects.tsx`'s `smartAssign` function changes from:

```typescript
if (err.includes("already exists")) {
  info = `Tmux session "${name}" already exists; reusing it.`;
}
```

to read the structured fields and surface a warning if there's a mismatch. The display element in the drawer (`error` state, rendered with `whitespace-pre-wrap` styling) accepts multi-line text:

```typescript
if (err.includes("already exists")) {
  const body = r.body as { error: string; existingCwds?: string[]; cwdMismatch?: boolean };
  if (body.cwdMismatch && workingDir.trim()) {
    const cwds = (body.existingCwds ?? []).map(c => `  • ${c}`).join("\n");
    info =
      `⚠ Tmux session "${name}" already exists, but no pane is in your working_dir (${workingDir.trim()}).\n` +
      `Existing panes are in:\n${cwds}\n\n` +
      `Tmux can't change an existing session's cwd. To use the new working_dir:\n` +
      `  1. tmux kill-session -t ${name}\n` +
      `  2. Click Assign again\n` +
      `Or non-destructively add a window:\n` +
      `  tmux new-window -t ${name} -c "${workingDir.trim()}"`;
  } else {
    info = `Tmux session "${name}" already exists; reusing it.`;
  }
}
```

If the existing error display element doesn't already preserve newlines, the implementer should add `whitespace-pre-wrap` to its className. Color the warning text amber (`text-amber-300`) when `cwdMismatch` is true to distinguish from the neutral "reusing it" case.

### Failure-open semantics

If the server can't build the tmux tree (tmux down, command errors), the 409 response degrades to `{ error, existingCwds: [], cwdMismatch: false }`. The frontend shows the original "reusing it" message — the warning is best-effort, not a guarantee. No exception bubbles up.

### Verification

1. Create a project with `working_dir: /home/dsu/pProjects/sigmapi2sigma` and abbreviation `sig`.
2. Manually create a tmux session with a different cwd: `tmux new-session -d -s sig -c /tmp`.
3. Open the project drawer, click Assign with name `sig`.
4. Expect the amber warning listing `/tmp` as the existing cwd, with the `tmux kill-session` instructions.
5. `tmux kill-session -t sig`, click Assign again → fresh session at the right cwd, no warning, "Created tmux session" message.

## Components & responsibility

- `web/src/pages/TmuxMap.tsx` — Components A (fold + persistence) and B (force-confirm modal)
- New inline `ForceConfirmModal` alongside `ScrollbackModal` (Component B)
- `server/lib/paths.ts` (new) — `expandHome` helper (Component C)
- `server/routes/tmux.ts` — apply `expandHome` + enrich 409 (Components C, D)
- `server/routes/snapshots.ts` — apply `expandHome` to `/resume` (Component C)
- `web/src/pages/Projects.tsx` — read enriched 409 and render warning (Component D)

## Error handling

- **localStorage unavailable.** Both read (in `useState` init) and write (in `useEffect`) are wrapped in `try/catch`. Failure degrades silently to in-memory fold state — equivalent to today's behavior, no loss of functionality. (Component A)
- **Lookup of `liveSession` fails despite `liveSessionNames.has(name)`.** Treated as "no conflict" and the restore proceeds without a prompt. This case is theoretically impossible (the Set is built from the same array we look up in) but the guard prevents a hard crash. (Component B)
- **`data.snapshot` is null when computing dead-row sourceLabel.** Defensive fallback to `"the latest snapshot"`. The dead-row `Restore --force` button only renders when `sessionState !== "alive"` and a snapshot exists, so this code path is unreachable in practice. (Component B)
- **`expandHome` receives a non-string or empty.** Type guard at the call site (`typeof cwd === "string" && cwd.length > 0`) means `expandHome` only ever sees a non-empty string. The function itself is total: returns input unchanged when there's no leading tilde. (Component C)
- **`buildTmuxTree` throws while computing the existing session's cwds.** Wrapped in `try/catch`; on failure the 409 response degrades to `existingCwds: []` and `cwdMismatch: false` and the frontend shows the original "reusing it" message. (Component D)

## Verification

This codebase has no test framework. Verification is manual + type/build gates.

**Gates (must pass):**
- `npx tsc -p . --noEmit` — zero errors
- `npm run build:web` — clean Vite build

**Manual checks (folding — Component A):**
1. Pin a session via `📌 Save for later` (saved section appears with `📌 Saved for Later` header).
2. Click the section caret: section collapses to a single header line; refresh page; section stays collapsed.
3. Unfold section, click a saved-entry caret: pane grid for that entry hides; refresh page; entry stays collapsed.
4. `Fold all`: section + every saved entry + every live session collapse together.
5. `Unfold all`: everything expands.

**Manual checks (force-confirm — Component B):**
6. With a session named `X` currently alive, click `Restore --force` on a saved entry named `X`:
   - Modal appears, listing windows/panes/cwds/Claude convos for the running session
   - Press `Escape` → modal closes, no restore happens, live session intact
   - Click outside the modal box → same behavior as Escape (cancel, no action)
   - Click `Replace` → modal closes, live session is killed and recreated from saved data
7. With no live session named `Y`, click `Restore --force` on a saved entry named `Y` → no modal, restore happens silently.
8. Same checks (6+7) on dead-row `Restore --force` in the main live tree.

**Manual checks (tilde expansion — Component C):**
9. Set a project's working_dir to `~/pProjects/sigmapi2sigma`.
10. Click Assign on a name not yet in tmux. Run `tmux list-panes -t NAME -F '#{pane_current_path}'` → expanded `/home/dsu/pProjects/sigmapi2sigma`.
11. From Sessions tab, click "Resume in new tmux" with a Claude session whose LWD starts with `~/...` → the new tmux session lands at the expanded path.

**Manual checks (cwd-mismatch warning — Component D):**
12. Project with absolute working_dir `/home/dsu/pProjects/sigmapi2sigma`. Manually create a conflicting session: `tmux new-session -d -s NAME -c /tmp`.
13. Open project drawer, click Assign with name `NAME` → amber warning appears listing `/tmp` and the kill-then-Assign instructions.
14. `tmux kill-session -t NAME`, click Assign → no warning, session created at the correct cwd.
15. Tmux down (`tmux kill-server`), click Assign → no exception in server logs; frontend gets a 500 or graceful error consistent with current behavior.

## Open trade-offs (acknowledged, not blocking)

**Smart confirmation creates inconsistent UX.** Sometimes `Restore --force` prompts, sometimes it doesn't. A user who has seen the prompt once and dismissed it might be surprised the next time it doesn't appear. Mitigation: the existing tooltip on the button ("Kill any existing session with this name first") accurately describes both branches; the modal is purely a guardrail when a real kill is imminent. The trade-off favors confirmation fatigue avoidance over absolute consistency.

**localStorage namespace collision risk.** The keys `tmuxMap:collapsed` and the namespace prefixes (`section:`, `saved:`, `live:`) are arbitrary; nothing in the rest of the codebase claims them today. If future features add their own localStorage keys they should pick non-overlapping prefixes.
