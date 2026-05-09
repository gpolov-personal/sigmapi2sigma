# Tmux Map: Folding + Smart Force-Confirmation Design

**Date:** 2026-05-09
**Status:** Approved for implementation planning
**Affected files:** `web/src/pages/TmuxMap.tsx` only (frontend)

## Problem

Two UX gaps in the recently merged Save-for-Later UI on the Tmux Map page:

1. **The `📌 Saved for Later` section can't be collapsed.** Every other session row in the live tree has a `▶/▼` caret to fold the pane grid. The saved section header has no caret, and saved entries can't be folded individually either. With even a few pinned sessions, the section dominates the page.

2. **`Restore --force` can silently destroy a running tmux session.** The `--force` flag tells `restore.sh` to `tmux kill-session -t NAME` before recreating from snapshot. If the user has the session running with active panes (cwds, Claude conversations, scrollback), all of that is lost without any prompt. There are two `Restore --force` buttons with this behavior:
   - In the Saved-for-Later section, on each saved entry
   - In the main live tree, on dead-session row headers

## Goals

- Make the saved section foldable like every other session block
- Make individual saved entries foldable (mirroring live-tree session entries)
- Persist fold state across page refreshes
- Add a confirmation modal for `Restore --force` — but only when the action would actually destroy a live session
- Reuse one modal component for both `Restore --force` paths

## Non-goals

- No backend / API changes
- No fold/persistence for the live-tree pane-card state (only at session and section level)
- No scope change to `Forget` (already has a `confirm()` prompt)
- No retroactive UX changes to other tabs (Sessions, Pomodoro, etc.)

## Architecture overview

All changes live in `web/src/pages/TmuxMap.tsx`. The existing `collapsed: Set<string>` state is reused for fold tracking with namespaced keys; a new `forceConfirm: ForceContext | null` state drives a single shared modal component, used by both `Restore --force` call sites. Persistence is a `useEffect` writing the collapsed Set to `localStorage`.

Net change: ~120-150 lines of TSX, plus one inline modal component (~40 lines) defined alongside the existing `ScrollbackModal` in the same file.

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

## Error handling

- **localStorage unavailable.** Both read (in `useState` init) and write (in `useEffect`) are wrapped in `try/catch`. Failure degrades silently to in-memory fold state — equivalent to today's behavior, no loss of functionality.
- **Lookup of `liveSession` fails despite `liveSessionNames.has(name)`.** Treated as "no conflict" and the restore proceeds without a prompt. This case is theoretically impossible (the Set is built from the same array we look up in) but the guard prevents a hard crash.
- **`data.snapshot` is null when computing dead-row sourceLabel.** Defensive fallback to `"the latest snapshot"`. The dead-row `Restore --force` button only renders when `sessionState !== "alive"` and a snapshot exists, so this code path is unreachable in practice.

## Verification

This codebase has no test framework. Verification is manual + type/build gates.

**Gates (must pass):**
- `npx tsc -p . --noEmit` — zero errors
- `npm run build:web` — clean Vite build

**Manual checks:**
1. Pin a session via `📌 Save for later` (saved section appears with `📌 Saved for Later` header).
2. Click the section caret: section collapses to a single header line, refresh page, section stays collapsed.
3. Unfold section, click a saved-entry caret: pane grid for that entry hides, refresh page, entry stays collapsed.
4. `Fold all`: section + every saved entry + every live session collapse together.
5. `Unfold all`: everything expands.
6. With a session named `X` currently alive, click `Restore --force` on a saved entry named `X`:
   - Modal appears, listing windows/panes/cwds/Claude convos for the running session
   - Press `Escape` → modal closes, no restore happens, live session intact
   - Click outside the modal box → same behavior as Escape (cancel, no action)
   - Click `Replace` → modal closes, live session is killed and recreated from saved data
7. With no live session named `Y`, click `Restore --force` on a saved entry named `Y` → no modal, restore happens silently.
8. Same checks (6+7) on dead-row `Restore --force` in the main live tree.

## Open trade-offs (acknowledged, not blocking)

**Smart confirmation creates inconsistent UX.** Sometimes `Restore --force` prompts, sometimes it doesn't. A user who has seen the prompt once and dismissed it might be surprised the next time it doesn't appear. Mitigation: the existing tooltip on the button ("Kill any existing session with this name first") accurately describes both branches; the modal is purely a guardrail when a real kill is imminent. The trade-off favors confirmation fatigue avoidance over absolute consistency.

**localStorage namespace collision risk.** The keys `tmuxMap:collapsed` and the namespace prefixes (`section:`, `saved:`, `live:`) are arbitrary; nothing in the rest of the codebase claims them today. If future features add their own localStorage keys they should pick non-overlapping prefixes.
