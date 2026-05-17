# UI Navigation Regrouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the top navigation in `web/src/App.tsx` from a flat 7-tab row into three labeled groups (WORK / ENVIRONMENT / TOOLS) on a two-row top bar, with TOOLS visually demoted and right-aligned, and change the default tab from Sessions to Pomodoro.

**Architecture:** Single-file change. Replaces the flat `TABS` array with a grouped `NAV_GROUPS` data structure, adds a small in-file `NavGroup` subcomponent, and adjusts the header JSX from one row to two. No data-model, no routing, no other files touched. The dynamic Pomodoro tab label hook (`usePomodoroTabLabel`) is reused unchanged.

**Tech Stack:** React 19 + Tailwind CSS via Vite. TypeScript strict. No test runner — manual visual verification.

**Reference design spec:** `docs/superpowers/specs/2026-05-17-ui-navigation-design.md`

---

## File Structure

```
web/src/
  App.tsx                MODIFY — only file touched (header layout, TABS data, default tab)
```

No new files. One commit.

---

## Task 1: Restructure top-bar navigation into grouped layout

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Open `web/src/App.tsx` and review current state**

Read the file so you have it in context. Today it has (concretely):

- Line 15–25: a `type Tab = …` union and a flat `const TABS: { id: Tab; label: string }[]` array of 7 entries.
- Line 66: `const [tab, setTab] = useState<Tab>("sessions");` — default tab.
- Line 71–98: a single-row `<header>` with logo, `<nav>` that maps `TABS` to buttons, a flex-1 spacer, and the gear button.

Both the data structure and the JSX need to change.

- [ ] **Step 2: Replace the `TABS` definition with grouped `NAV_GROUPS`**

Delete lines 17–25 (the existing `const TABS: ...` array). In its place, paste:

```tsx
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

The `Tab` union (line 15) stays unchanged — the same 7 string literals are still in use; only the shape of the array changes.

- [ ] **Step 3: Change the default tab from `"sessions"` to `"pomodoro"`**

Find this line inside `AppInner` (was line 66):

```tsx
const [tab, setTab] = useState<Tab>("sessions");
```

Replace with:

```tsx
const [tab, setTab] = useState<Tab>("pomodoro");
```

- [ ] **Step 4: Replace the header JSX with the two-row layout**

Find the existing `<header>` block (was lines 71–98) and replace it entirely with:

```tsx
      <header className="flex flex-col border-b border-slate-800 bg-slate-900">
        <div className="flex items-center gap-6 px-6 pt-3 pb-2">
          <h1 className="font-serif text-2xl tracking-tight text-white">
            ΣΠ <span className="text-slate-500">∪</span> ΠΣ
          </h1>
          <div className="flex-1" />
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800"
          >
            <SettingsIcon size={18} />
          </button>
        </div>
        <nav className="flex items-end px-6 pb-2 gap-4">
          {NAV_GROUPS.map((g, i) => (
            <NavGroup
              key={g.label}
              group={g}
              activeTab={tab}
              onSelect={setTab}
              pomodoroLabel={pomodoroLabel}
              showDividerBefore={i > 0}
            />
          ))}
        </nav>
      </header>
```

Two visual changes vs today:
1. Row 1 (logo + gear) shrinks: `py-3` → `pt-3 pb-2`. Gives row 2 visual breathing room.
2. Row 2 is the new `<nav>` that maps over `NAV_GROUPS`.

Note: TOOLS is right-aligned via `ml-auto` applied inside `NavGroup` when `group.demoted` is true (see Step 5).

- [ ] **Step 5: Add the `NavGroup` subcomponent at the bottom of the file**

After the closing brace of `function AppInner()` (last `}` of the file), add this component:

```tsx
function NavGroup({
  group,
  activeTab,
  onSelect,
  pomodoroLabel,
  showDividerBefore,
}: {
  group: Group;
  activeTab: Tab;
  onSelect: (t: Tab) => void;
  pomodoroLabel: string;
  showDividerBefore: boolean;
}) {
  const demoted = !!group.demoted;
  const labelClass = "text-[10px] uppercase tracking-wider text-slate-500 mb-0.5";
  const tabBase = demoted
    ? "px-2 py-1 rounded text-xs"
    : "px-3 py-1.5 rounded text-sm";
  const tabIdle = demoted
    ? "text-slate-600 hover:text-white hover:bg-slate-800"
    : "text-slate-400 hover:text-white hover:bg-slate-800";
  const tabActive = "bg-slate-700 text-white";

  return (
    <div
      className={[
        "flex flex-col",
        showDividerBefore ? "border-l border-slate-800 pl-4" : "",
        demoted ? "ml-auto" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className={labelClass}>{group.label}</div>
      <div className="flex gap-1 flex-wrap">
        {group.tabs.map(t => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`${tabBase} ${activeTab === t.id ? tabActive : tabIdle}`}
          >
            {t.id === "pomodoro" ? pomodoroLabel : t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

Note on `ml-auto`: applied only to the demoted group (TOOLS). This pushes TOOLS to the right edge of the flex row, leaving WORK and ENVIRONMENT left-aligned with their natural widths.

- [ ] **Step 6: Verify TypeScript compiles**

Run from the repo root:

```bash
npx tsc --noEmit -p .
```

Expected: zero errors. If there are errors, fix them inline — the most likely cause is a typo in the JSX or a missing import (none should be needed since `useState`, `useEffect`, `SettingsIcon`, etc. are already imported at the top of the file).

- [ ] **Step 7: Start the dev server and visually verify**

```bash
npm run dev
```

Open http://localhost:5173. Check each of the seven verification points from the spec's testing strategy:

1. **Default tab**: page loads with `Pomodoro` highlighted (not Sessions).
2. **Group layout**: top bar shows two rows. Row 2 has three labels — `WORK`, `ENVIRONMENT`, `TOOLS` — with their tabs underneath.
3. **TOOLS demotion**: `TOOLS` group is right-aligned (far right of the bar). Its label and tab text (`Snapshots`, `Shell History`) are smaller and dimmer than the WORK/ENVIRONMENT tabs.
4. **TOOLS contrast on select**: click `Snapshots` — the tab gets the same dark `bg-slate-700` highlight + white text as any other tab. The button does not look washed out when active.
5. **Pomodoro live label**: start a real pomodoro from the Pomodoro tab. The Pomodoro tab button text inside the WORK group updates to `Pomodoro · Work MM:SS` and counts down. After the timer ends, label changes per existing rules (`Pomodoro · Done`, then `Pomodoro · Break MM:SS` during rest, etc.).
6. **Tab switching**: click each of the 7 tabs in turn. Each renders its existing page content. Nothing crashes; no missing content.
7. **Gear button**: top-right gear icon (row 1) opens the existing Settings modal.

If any point fails, fix in-place before committing.

- [ ] **Step 8: Stop the dev server (Ctrl-C)**

- [ ] **Step 9: Commit**

```bash
git add web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(web): regroup top nav into WORK / ENVIRONMENT / TOOLS

Two-row top bar. The flat 7-tab row becomes three labeled groups:
- WORK (Projects, Pomodoro, Calendar)
- ENVIRONMENT (Sessions, Tmux Map)
- TOOLS (Snapshots, Shell History) — right-aligned, dimmer + smaller

Default tab on load: Pomodoro (was Sessions). Dynamic Pomodoro
countdown label continues to render in place inside WORK.

Single-file change. See
docs/superpowers/specs/2026-05-17-ui-navigation-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the implementing engineer

1. **One file, one commit.** This entire plan modifies only `web/src/App.tsx` and produces a single commit. If you find yourself touching any other file, stop and re-read the spec.

2. **No automated tests.** Verification is `npx tsc --noEmit -p .` plus the 7-point visual checklist in Step 7. Don't skip the visual check — it's the only safety net.

3. **`ml-auto` placement matters.** It must go on the wrapper `<div>` of the demoted group, not on the inner button container, or the right-alignment won't work because flex `ml-auto` pushes a child to the right of its flex parent.

4. **Tailwind classes that may need verification.** The styles use `text-[10px]` (arbitrary value) and color shades `text-slate-600`, `text-slate-700`, `bg-slate-700`, `border-slate-800`. All of these are already in use elsewhere in the project (grep confirms), so the Tailwind JIT will pick them up.

5. **Why two rows, not one.** Single-row layouts with group labels become too tall when the labels stack above the tabs. Splitting logo+gear (row 1) from group nav (row 2) keeps each row at a sensible height and gives the group labels room to breathe.

6. **The `Tab` union is unchanged.** This is deliberate — the page-rendering switch (`{tab === "sessions" && <Sessions />}`, etc.) at the bottom of `AppInner` does not need to change.

7. **If a step fails.** Don't `--no-verify` past it. Diagnose the underlying issue, fix in place, and re-stage.

8. **Plan vs spec.** This plan implements the spec at `docs/superpowers/specs/2026-05-17-ui-navigation-design.md`. If you find a contradiction, the spec wins; flag the inconsistency rather than guessing.
