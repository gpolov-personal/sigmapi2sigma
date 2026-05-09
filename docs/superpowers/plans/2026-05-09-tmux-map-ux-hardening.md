# Tmux Map UX Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address four independent UX/correctness issues on the Tmux Map and Projects pages: foldable saved sessions with persistence, smart force-confirm modal, server-side tilde expansion for cwds, and a mismatch warning when re-assigning to an existing tmux session.

**Architecture:** Two frontend components live in `web/src/pages/TmuxMap.tsx` (fold + modal), reusing the existing `collapsed: Set<string>` state with namespaced keys. A new `server/lib/paths.ts` exports `expandHome` used by `POST /api/tmux/sessions` and `POST /api/resume`. The 409 response from `/api/tmux/sessions` is enriched with `existingCwds` and `cwdMismatch`, consumed by `Projects.tsx`'s `smartAssign` to render a multi-line amber warning.

**Tech Stack:** Node 22 + Express 4 + TypeScript via tsx (ESM, `.js` extensions). React 19 + Tailwind. No test framework — verification is `npx tsc -p . --noEmit` + manual UI checks.

**Spec reference:** `docs/superpowers/specs/2026-05-09-tmux-map-fold-and-force-confirm-design.md`

**Implementation order:** Tasks are independent except T2 must follow T1 (same file, additive) and T4 must follow T3 (D imports `expandHome`). Tasks within the same worktree must be sequential. Suggested order: T1 → T2 → T3 → T4.

**File structure:**
- `web/src/pages/TmuxMap.tsx` — Tasks T1, T2 (modify; ~150 lines added)
- `server/lib/paths.ts` — Task T3 (new file; ~12 lines)
- `server/routes/tmux.ts` — Tasks T3, T4 (modify; ~25 lines)
- `server/routes/snapshots.ts` — Task T3 (modify; ~3 lines)
- `web/src/pages/Projects.tsx` — Task T4 (modify; ~30 lines)

**Codebase notes for the implementer:**
- ESM project; TS imports use `.js` extensions even for local TS files.
- Atomic JSON writes via `writeJsonAtomic` from `server/lib/dataStore.ts` (not used in this plan but standard convention).
- No test framework — verification is `npx tsc -p . --noEmit` plus, for backend-touching tasks, manual `curl` against the running dev server.
- The dev server at `127.0.0.1:5174` may already be running; `npm run dev` restarts it.
- Existing handlers `restoreOnly` and `restoreSaved` in TmuxMap.tsx are unchanged by this plan; T2 only adds a wrapper around them.
- All git commits use a HEREDOC with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Folding + localStorage persistence (Component A)

**Files:**
- Modify: `web/src/pages/TmuxMap.tsx`

**Rationale:** Reuse the existing `collapsed: Set<string>` state with namespaced keys. Add a `useEffect` that persists the Set to localStorage on every change. Add carets to the saved section header and to each saved entry.

- [ ] **Step 1: Add namespace constants and helpers near the top of the component file**

In `web/src/pages/TmuxMap.tsx`, immediately after the existing imports at the top of the file (before `export function TmuxMap()`), add:

```typescript
// Persisted fold state — keys are namespaced so section/saved/live can coexist.
const COLLAPSE_LS = "tmuxMap:collapsed";
const KEY_SAVED_SECTION = "section:saved";
const keyForSavedEntry  = (name: string) => `saved:${name}`;
const keyForLiveSession = (name: string) => `live:${name}`;
```

- [ ] **Step 2: Replace the `collapsed` useState initialization to read from localStorage**

In `TmuxMap()`, find the existing line:

```typescript
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
```

and replace it with:

```typescript
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_LS);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
```

- [ ] **Step 3: Add a useEffect that persists `collapsed` on every change**

Immediately after the new `useState` line above, add:

```typescript
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_LS, JSON.stringify([...collapsed])); }
    catch { /* full quota / private mode → ignore */ }
  }, [collapsed]);
```

(`useEffect` is already imported in the existing file. No import changes needed.)

- [ ] **Step 4: Migrate live-tree caret references to namespaced keys**

In `TmuxMap.tsx`, find every place that uses `collapsed.has(s.name)` for live sessions and the `toggle(s.name)` calls for live sessions. Replace each with the namespaced form.

Specifically:

Inside the live-session render block (search for `const isCollapsed = collapsed.has(s.name);`), change to:

```typescript
            const isCollapsed = collapsed.has(keyForLiveSession(s.name));
```

In the same block, change the per-session caret `onClick` handler from:

```typescript
              <button onClick={() => toggle(s.name)} ...>
```

to:

```typescript
              <button onClick={() => toggle(keyForLiveSession(s.name))} ...>
```

- [ ] **Step 5: Replace `foldAll` and `unfoldAll` to cover saved section + saved entries + live sessions**

Find the existing `foldAll` function and replace it (and verify `unfoldAll` stays as-is):

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
  function unfoldAll() {
    setCollapsed(new Set());
  }
```

- [ ] **Step 6: Add caret to the saved section header**

In the JSX block that renders the `📌 Saved for Later` panel, find the section header. It currently looks like:

```tsx
          <div className="px-4 py-2 font-semibold border-b border-amber-800/60 flex items-center gap-3">
            <span className="text-amber-300">📌 Saved for Later</span>
            <span className="text-xs text-slate-400">{saved.sessions.length} pinned · survives snapshot rotation</span>
          </div>
```

Replace the `<span className="text-amber-300">` line with a caret button followed by the label:

```tsx
          <div className="px-4 py-2 font-semibold border-b border-amber-800/60 flex items-center gap-3">
            <button
              onClick={() => toggle(KEY_SAVED_SECTION)}
              className="text-slate-400 hover:text-white w-4"
            >{collapsed.has(KEY_SAVED_SECTION) ? "▶" : "▼"}</button>
            <span className="text-amber-300">📌 Saved for Later</span>
            <span className="text-xs text-slate-400">{saved.sessions.length} pinned · survives snapshot rotation</span>
          </div>
```

- [ ] **Step 7: Conditionally render the saved entries grid based on the section caret**

Find the `<div className="divide-y divide-amber-900/40">` block immediately after the section header (it contains the `saved.sessions.map(s => ...)` call). Wrap the entire block in a conditional:

```tsx
          {!collapsed.has(KEY_SAVED_SECTION) && (
            <div className="divide-y divide-amber-900/40">
              {saved.sessions.map(s => {
                ...existing content unchanged...
              })}
            </div>
          )}
```

- [ ] **Step 8: Add caret to each saved entry header and conditionally render its pane grid**

Inside the `saved.sessions.map(s => ...)` body, find the entry header. It currently begins:

```tsx
                <div key={s.name} className="px-4 py-2">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="font-semibold">{s.name}</span>
```

Insert a caret button as the first child of the inner flex row:

```tsx
                <div key={s.name} className="px-4 py-2">
                  <div className="flex items-center gap-3 mb-2">
                    <button
                      onClick={() => toggle(keyForSavedEntry(s.name))}
                      className="text-slate-400 hover:text-white w-4"
                    >{collapsed.has(keyForSavedEntry(s.name)) ? "▶" : "▼"}</button>
                    <span className="font-semibold">{s.name}</span>
```

Then find the pane-card grid that follows — it currently looks like:

```tsx
                  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))" }}>
                    {s.windows.flatMap(w => w.panes.map(p => (
                      <PaneCard ... />
                    )))}
                  </div>
```

Wrap it in a conditional:

```tsx
                  {!collapsed.has(keyForSavedEntry(s.name)) && (
                    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))" }}>
                      {s.windows.flatMap(w => w.panes.map(p => (
                        <PaneCard
                          key={`${w.index}.${p.index}.${p.paneId}`}
                          pane={p}
                          state="unknown"
                          onCommands={() => openCommands(p.paneId)}
                        />
                      )))}
                    </div>
                  )}
```

- [ ] **Step 9: TypeScript build check**

Run: `npx tsc -p . --noEmit`
Expected: zero errors, no output.

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/TmuxMap.tsx
git commit -m "$(cat <<'EOF'
feat(tmux-map): foldable Saved-for-Later section with localStorage persistence

Adds carets on the section header and on each saved entry, plus useEffect
that persists the collapsed Set to localStorage:tmuxMap:collapsed. Existing
live-tree caret keys migrated to a namespaced form (live:NAME) so section,
saved-entry, and live-session keys can coexist without collision.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Smart force-confirm modal (Component B)

**Files:**
- Modify: `web/src/pages/TmuxMap.tsx`

**Rationale:** When a user clicks `Restore --force` and a tmux session with that name is currently alive, show a modal listing what would be destroyed. When there's no conflict, proceed silently — `--force` and plain `Restore` produce the same result.

- [ ] **Step 1: Add the `ForceContext` type and `forceConfirm` state**

In `TmuxMap()`, immediately after the existing `restoreLog` state declaration (it's near the top of the function body), add:

```typescript
  type ForceContext = {
    name: string;
    source: "saved" | "snapshot";
    sourceLabel: string;
    liveSession: TmuxSession;
  };
  const [forceConfirm, setForceConfirm] = useState<ForceContext | null>(null);
```

- [ ] **Step 2: Add the `tryForceRestore` wrapper next to the existing restore handlers**

Immediately after the existing `forget` function inside `TmuxMap()`, add:

```typescript
  function tryForceRestore(source: "saved" | "snapshot", name: string, sourceLabel: string) {
    if (!liveSessionNames.has(name)) {
      // No conflict — proceed without prompt.
      if (source === "saved") restoreSaved(name, true); else restoreOnly(name, true);
      return;
    }
    const liveSession = (data?.source === "live" ? data.tree : []).find(s => s.name === name);
    if (!liveSession) {
      // Defensive: liveSessionNames was true but lookup failed. Proceed without prompt.
      if (source === "saved") restoreSaved(name, true); else restoreOnly(name, true);
      return;
    }
    setForceConfirm({ name, source, sourceLabel, liveSession });
  }

  function confirmForce() {
    const ctx = forceConfirm;
    setForceConfirm(null);
    if (!ctx) return;
    if (ctx.source === "saved") restoreSaved(ctx.name, true); else restoreOnly(ctx.name, true);
  }
```

- [ ] **Step 3: Wire the saved-section "Restore --force" button to use `tryForceRestore`**

In the saved-entry render block (inside `saved.sessions.map(s => ...)`), find the existing `Restore --force` button:

```tsx
                      <button
                        onClick={() => restoreSaved(s.name, true)}
                        className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                        title="Kill any existing session with this name first"
                      >Restore --force</button>
```

Change its `onClick` to:

```tsx
                      <button
                        onClick={() => tryForceRestore(
                          "saved",
                          s.name,
                          m ? `saved-tmux.json (saved ${relativeTime(new Date(m.savedAt).getTime())})` : "saved-tmux.json"
                        )}
                        className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                        title="Kill any existing session with this name first"
                      >Restore --force</button>
```

(Where `m` is the existing `const m = saved.meta[s.name];` already in scope inside the map callback.)

- [ ] **Step 4: Wire the dead-row "Restore --force" button in the live tree**

In the live-tree session header block, find the existing `Restore --force` button (just below `Restore this session`):

```tsx
                    <button
                      onClick={() => restoreOnly(s.name, true)}
                      className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                      title="Kill any existing session with this name first"
                    >
                      Restore --force
                    </button>
```

Change its `onClick` to:

```tsx
                    <button
                      onClick={() => tryForceRestore(
                        "snapshot",
                        s.name,
                        data?.snapshot
                          ? `snapshot ${relativeTime(new Date(data.snapshot.ts).getTime())}`
                          : "the latest snapshot"
                      )}
                      className="text-xs px-2 py-0.5 bg-red-700 rounded hover:bg-red-600"
                      title="Kill any existing session with this name first"
                    >
                      Restore --force
                    </button>
```

- [ ] **Step 5: Render the modal at the end of the JSX**

In `TmuxMap()`, find the existing `<ScrollbackModal>` rendering near the bottom (it's conditional on `scrollback`). Immediately after the `restoreLog` panel render block (search for `restoreLog !== null &&`), at the end of the outer container `<div className="space-y-4">`, add:

```tsx
      {forceConfirm && (
        <ForceConfirmModal
          ctx={forceConfirm}
          onCancel={() => setForceConfirm(null)}
          onConfirm={confirmForce}
        />
      )}
```

(This goes inside the outermost `<div>` returned by `TmuxMap`, alongside the other top-level conditional renderings like `scrollback &&`, `cmdModal &&`, `restoreLog !== null &&`.)

- [ ] **Step 6: Define the `ForceConfirmModal` component at the bottom of the file**

After the existing `ScrollbackModal` function definition (search for `function ScrollbackModal`), add the new component:

```tsx
function ForceConfirmModal({ ctx, onCancel, onConfirm }: {
  ctx: { name: string; source: "saved" | "snapshot"; sourceLabel: string; liveSession: TmuxSession };
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

- [ ] **Step 7: TypeScript build check**

Run: `npx tsc -p . --noEmit`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/TmuxMap.tsx
git commit -m "$(cat <<'EOF'
feat(tmux-map): smart force-confirm modal on Restore --force

Modal renders only when --force would actually kill a live tmux session
(liveSessionNames.has(name)). Lists windows/panes/cwds/Claude convos
from the running session. Cancel / Esc / backdrop dismiss without action.
Replace performs the existing destructive restore. Used by both the
Saved-for-Later section and the dead-row buttons in the live tree.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Server-side tilde expansion (Component C)

**Files:**
- Create: `server/lib/paths.ts`
- Modify: `server/routes/tmux.ts`
- Modify: `server/routes/snapshots.ts`

**Rationale:** `tmux new-session -c "~/foo"` doesn't expand the tilde — `chdir()` treats it literally and tmux falls back to `$HOME`. Expand server-side before passing to tmux. Storage stays literal.

- [ ] **Step 1: Create the helper file**

Create `server/lib/paths.ts`:

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

- [ ] **Step 2: Apply expansion in POST /api/tmux/sessions**

In `server/routes/tmux.ts`, add the import near the top (after existing imports):

```typescript
import { expandHome } from "../lib/paths.js";
```

Find the existing handler for `POST /tmux/sessions`. The current call is:

```typescript
    await createDetachedSession(name, typeof cwd === "string" && cwd.length > 0 ? cwd : undefined);
```

Replace it with:

```typescript
    const expanded = typeof cwd === "string" && cwd.length > 0 ? expandHome(cwd) : undefined;
    await createDetachedSession(name, expanded);
```

- [ ] **Step 3: Apply expansion in POST /api/resume**

In `server/routes/snapshots.ts`, add the import near the top (after existing imports):

```typescript
import { expandHome } from "../lib/paths.js";
```

Find the existing `pexec("tmux", [...])` call inside the `POST /resume` handler. The current call is:

```typescript
    await pexec("tmux", [
      "new-session", "-d",
      "-s", tmuxSessionName,
      "-c", cwd,
      claudeCmd,
    ]);
```

Replace `"-c", cwd,` with the expanded form:

```typescript
    await pexec("tmux", [
      "new-session", "-d",
      "-s", tmuxSessionName,
      "-c", expandHome(cwd),
      claudeCmd,
    ]);
```

- [ ] **Step 4: TypeScript build check**

Run: `npx tsc -p . --noEmit`
Expected: zero errors.

- [ ] **Step 5: Manual API test**

Start the dev server (`npm run stop && npm run dev`) if not already running.

Run a focused integration check from another terminal:

```bash
tmux kill-session -t _tildecheck 2>/dev/null
curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"_tildecheck","cwd":"~/pProjects/sigmapi2sigma"}' \
  http://127.0.0.1:5174/api/tmux/sessions
tmux list-panes -t _tildecheck -F '#{pane_current_path}'
tmux kill-session -t _tildecheck
```

Expected output of `tmux list-panes`:
```
/home/dsu/pProjects/sigmapi2sigma
```
(The HOME-expanded form, not `/home/dsu`.)

If the dev server can't be restarted (parallel work in another worktree), skip Step 5 and rely on Step 4 + the manual UI checks at merge time.

- [ ] **Step 6: Commit**

```bash
git add server/lib/paths.ts server/routes/tmux.ts server/routes/snapshots.ts
git commit -m "$(cat <<'EOF'
feat(server): expand ~ in user-supplied cwds before passing to tmux

tmux new-session -c "~/foo" does not expand the tilde; chdir() treats it
literally and the pane silently falls back to \$HOME. Add server/lib/paths.ts
exporting expandHome(), apply it in POST /api/tmux/sessions and
POST /api/resume. Storage of project.working_dir stays literal so paths
remain portable across machines; expansion happens only at the moment we
hand the value to tmux.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Cwd-mismatch warning on Assign (Component D)

**Files:**
- Modify: `server/routes/tmux.ts`
- Modify: `web/src/pages/Projects.tsx`

**Rationale:** When `Assign` hits an existing tmux session, the new working_dir is silently dropped (tmux can't change an existing session's cwd). Surface a multi-line amber warning explaining the situation and the user's two ways forward (kill+recreate, or add a window).

- [ ] **Step 1: Enrich the 409 response in POST /api/tmux/sessions**

In `server/routes/tmux.ts`, the handler for `POST /tmux/sessions` currently has:

```typescript
    if (String(e?.message ?? "").includes("already exists")) {
      return res.status(409).json({ error: `tmux session "${name}" already exists` });
    }
```

Replace it with the enriched version that probes the existing session's pane cwds and reports `cwdMismatch`:

```typescript
    if (String(e?.message ?? "").includes("already exists")) {
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

(`buildTmuxTree` is already imported at the top of the file. `expandHome` was imported in Task 3.)

- [ ] **Step 2: Update the frontend Assign handler to render the warning**

In `web/src/pages/Projects.tsx`, find the `smartAssign` function. The current "already exists" branch is:

```typescript
      } else {
        const err = (r.body as { error: string }).error ?? "";
        if (err.includes("already exists")) {
          info = `Tmux session "${name}" already exists; reusing it.`;
        } else {
          // Tmux down or other error — still record the assignment by name.
          info = `Note: could not probe/create tmux (${err}). Assignment recorded; will apply when a session named "${name}" exists.`;
        }
      }
```

Replace the `if (err.includes("already exists"))` branch with the structured-response read:

```typescript
      } else {
        const body = r.body as { error: string; existingCwds?: string[]; cwdMismatch?: boolean };
        const err = body.error ?? "";
        if (err.includes("already exists")) {
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
        } else {
          // Tmux down or other error — still record the assignment by name.
          info = `Note: could not probe/create tmux (${err}). Assignment recorded; will apply when a session named "${name}" exists.`;
        }
      }
```

- [ ] **Step 3: Make the error/info panel preserve newlines**

In `Projects.tsx`'s drawer, find the element that renders `error` (search for `{error &&` near the bottom of the drawer return). It will look like:

```tsx
            {error && <div className="text-red-400 text-sm">{error}</div>}
```

Change the className to preserve whitespace and color it amber when the message starts with the warning glyph:

```tsx
            {error && (
              <div className={`text-sm whitespace-pre-wrap font-mono ${
                error.startsWith("⚠") ? "text-amber-300" : "text-red-400"
              }`}>{error}</div>
            )}
```

(If the existing JSX uses different braces or spacing, preserve the surrounding structure but apply the same className changes.)

- [ ] **Step 4: TypeScript build check**

Run: `npx tsc -p . --noEmit`
Expected: zero errors.

- [ ] **Step 5: Manual end-to-end check**

(Skip if a parallel worktree is using the dev server. Otherwise:)

Restart the dev server, then:

```bash
# Create a session at the wrong cwd
tmux kill-session -t _mismatchcheck 2>/dev/null
tmux new-session -d -s _mismatchcheck -c /tmp

# Trigger the route from CLI to confirm the structured response
curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"_mismatchcheck","cwd":"/home/dsu/pProjects/sigmapi2sigma"}' \
  http://127.0.0.1:5174/api/tmux/sessions | jq

# Cleanup
tmux kill-session -t _mismatchcheck
```

Expected response (HTTP 409):
```json
{
  "error": "tmux session \"_mismatchcheck\" already exists",
  "existingCwds": ["/tmp"],
  "cwdMismatch": true
}
```

In the browser: open Projects, find any project, set working_dir to `/home/dsu/pProjects/sigmapi2sigma`, run `tmux new-session -d -s NAME -c /tmp` matching the project's tmux name, then click Assign. Expected: amber multi-line warning naming `/tmp` and listing the kill-then-Assign workflow.

- [ ] **Step 6: Commit**

```bash
git add server/routes/tmux.ts web/src/pages/Projects.tsx
git commit -m "$(cat <<'EOF'
feat(projects): warn when Assign reuses a tmux session with a wrong cwd

Server enriches the 409 response from POST /api/tmux/sessions with
existingCwds[] and cwdMismatch:bool, computed against expandHome(cwd).
Frontend smartAssign reads the structured fields and renders a
multi-line amber warning in the drawer when the existing session's
panes don't sit in the project's working_dir, with both destructive
(kill-session) and non-destructive (new-window) fix instructions.
Failure to probe tmux degrades gracefully to the original "reusing it"
message — warning is best-effort.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Component A (fold + persistence) → Task 1 covers section caret, per-entry caret, foldAll/unfoldAll extension, namespace migration of live-tree keys, localStorage init + persist effect ✓
- Component B (force-confirm modal) → Task 2 covers `tryForceRestore` wrapper, modal state, `ForceConfirmModal` component, both call sites (saved section + dead-row), Esc/backdrop/Cancel dismiss paths ✓
- Component C (tilde expansion) → Task 3 covers new `paths.ts`, `/tmux/sessions` call site, `/resume` call site ✓
- Component D (cwd-mismatch warning) → Task 4 covers server enriching 409, frontend reading structured response, multi-line amber warning, `whitespace-pre-wrap` styling ✓

**Placeholder scan:** All steps include the verbatim code or exact commands. The "If the dev server can't be restarted, skip Step 5" caveats in Tasks 3/4 are explicit graceful-degradation instructions, not placeholders. No "TBD" or "implement later" anywhere.

**Type consistency:**
- `KEY_SAVED_SECTION`, `keyForSavedEntry`, `keyForLiveSession` defined in Task 1 Step 1, used unchanged in Task 1 Steps 4/5/6/7/8 and Task 2 (no new key namespaces introduced in Task 2).
- `ForceContext` type defined in Task 2 Step 1, used unchanged in Steps 2/5/6.
- `expandHome` exported from `server/lib/paths.ts` in Task 3 Step 1, imported and called in Tasks 3/4 with consistent signature `(string) => string`.
- 409 response shape `{ error, existingCwds?, cwdMismatch? }` defined in Task 4 Step 1, consumed with the same shape in Task 4 Step 2.
- `restoreOnly` and `restoreSaved` are pre-existing handlers; not redefined, just wrapped.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-tmux-map-ux-hardening.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Tasks 1 and 2 must run sequentially (same file). Task 3 must run before Task 4 (D imports from C). All four tasks share the same worktree — no parallelism across tasks within this single feature.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.
