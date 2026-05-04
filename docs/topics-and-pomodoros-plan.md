# Topics & Pomodoros — Implementation Plan

**Scope:** Add a Topics system (project / study / experiment / idea entities), bind each to at most one tmux session bijectively, track focused work via Pomodoros, derive Work Units (WU) for display, surface what-happened-during-a-pomodoro by slicing existing data, and visualize with a calendar (yearly heatmap + monthly grid).

**Audience:** A future Claude Code session (Sonnet or otherwise) that has not seen the design conversation. Read this top-to-bottom before touching code.

---

## 0 Glossary

| Term | Meaning |
|---|---|
| **Topic** | A named thing the user works on. Covers projects, studies, experiments, ideas — one entity for all. |
| **Active topic** | Topic with a tmux session currently assigned. |
| **Parked topic** | Topic that exists but has no tmux session right now. |
| **Completed topic** | Topic explicitly marked finished (`completed_at` set). Hidden by default; revealable via toggle. |
| **Free tmux session** | Tmux session with no topic assigned. Cannot generate pomodoros. |
| **Work Unit (WU)** | Display unit of focused time. `1 WU = settings.wuMinutes` minutes (default 10). Computed at render — never stored. |
| **Pomodoro** | A single timed focus session. Stores raw start/end timestamps; minutes are derived. |
| **LWD** | "Launch Working Dir": the cwd where `claude` was started. For a claude pane, equal to `tmux pane_current_path` (because claude doesn't `chdir`). For a zsh pane, this concept doesn't apply — its `pane_current_path` is the real CWD. |
| **CWD** | "Current Working Dir": for a claude conversation, the most recent `cwd` field in its JSONL tail (claude tracks it logically as it `cd`s in Bash tool calls). |
| **JSONL** | Claude Code stores each conversation as one append-only JSONL file at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. |
| **Path encoding** | A cwd like `/home/dsu/Projects/Foo_Bar` becomes the project dir name `-home-dsu-Projects-Foo-Bar` (replace `/`, `.`, `_` with `-`). |
| **Snapshot** | A JSON file capturing tmux's session/window/pane tree + each claude pane's resolved session id, at a moment in time. Used for restore. |
| **Diff guard** | The mechanism that makes snapshots only rotate when state actually changed (so we keep history of *real* transitions instead of clock ticks). |

---

## 1 Project context (what already exists)

This project is `claude-session-viewer` at `~/Projects/claude-session-viewer/`. Tech stack:

- **Backend**: Node.js + Express + TypeScript, run via `tsx`. Listens on `127.0.0.1:5174`. Entry: `server/index.ts`.
- **Frontend**: Vite + React 19 + TypeScript + Tailwind. Listens on `127.0.0.1:5173`, proxies `/api` to backend. Entry: `web/src/main.tsx` → `web/src/App.tsx`.
- **Scripts**: bash. Run via `npm run snapshot`, `npm run restore`, `npm run install-cron`, `npm run install-shell-hook`, etc.
- **Runtime data**: lives outside the repo at `~/.claude-session-viewer/`. Code lives at `~/Projects/claude-session-viewer/`.
- **Single-user, local-only**: server binds to `127.0.0.1`. No auth, no cloud.

### 1.1 Existing data on disk

```
~/.claude-session-viewer/
├── snapshots/              latest.json + prev.json + prev2..prev6.json (rotated by snapshot.sh)
└── shell-history/          YYYY-MM-DD.jsonl (one line per command run inside tmux; opt-in)
```

### 1.2 Existing tabs in the UI

- **Sessions** — table of Claude conversations (one row per JSONL), filterable by hours, with last user prompt, LWD/CWD, git branch, version, permission mode. Click → drawer with detail + "Resume in new tmux" button.
- **Tmux Map** — tree of tmux sessions/windows/panes. Color-coded: green = alive, red = dead (in snapshot but not live tmux), grey/dashed = unknown (tmux not running). Per-pane "Commands" (path B from shell hook) and "Screen buffer" (path A from `tmux capture-pane`).
- **Shell History** — global timeline of commands captured by the preexec hook.
- **Snapshots** — list of recent snapshots with restore controls.

### 1.3 Existing backend routes (do not break)

```
GET  /api/health
GET  /api/sessions?hours=N           list of JSONL-derived SessionMeta
GET  /api/sessions/:id               one SessionMeta + first/last messages
GET  /api/tmux                       { source:"live"|"snapshot", tree, snapshot, snapshots[], livePaneIds[] }
GET  /api/panes/:paneId/scrollback   text from tmux capture-pane
GET  /api/shell-history?...          filtered command log
GET  /api/snapshots                  list of all rotated snapshot files
POST /api/snapshot                   trigger snapshot.sh
POST /api/restore                    invoke restore.sh; returns { ok, exitCode, stdout, stderr, error }
POST /api/resume                     spawn detached tmux session running `claude --resume <id>`
```

`/api/restore` always returns HTTP 200; success/failure is conveyed by `ok` and `exitCode`.

### 1.4 Existing scripts and their behaviors

- **`scripts/snapshot.sh`** — captures tmux tree + claude session ids per pane + (for claude panes) `claudeLastCwd` and `claudePermissionMode`. Runs a *diff guard*: normalizes new vs `latest.json` (strips `ts`, `tmuxVersion`, `pid`, and the auto-renaming `window.name`); if equal, exits 0 with no rotation. Otherwise rotates `latest → prev → prev2 → ... → prev6` (max 7 keeps).
- **`scripts/restore.sh`** — rebuilds tmux from a snapshot. Per-session error isolation: each session restores in a subshell with `set -e`; failure of one session does not abort the rest. Final summary printed in a structured form (`restored: N / skipped: N / failed: N` with reasons). Exits 1 only on total failure. Flags: `--dry-run`, `--force`, `--only NAME`.
- **`scripts/install-cron.sh`** — adds `*/5 * * * * snapshot.sh` and weekly shell-history prune. Idempotent via marker comments.
- **`scripts/install-shell-hook.sh`** — appends a zsh `preexec` hook to `~/.zshrc` that logs each command to the daily file when inside tmux (`$TMUX` set). Idempotent via marker comments.

### 1.5 Critical invariants the new feature must respect

1. **`claude --resume <uuid>` is dir-scoped.** It only finds the JSONL in the project dir corresponding to the *current shell's cwd* (after path encoding). Therefore, when launching `claude --resume`, we MUST start the shell in the LWD. `restore.sh` already does this; do not change it.
2. **Tmux session names are the stable identity** across restarts. `pane_id` (`%4`) and pid change on each tmux server restart. Use names whenever the data must survive across crashes.
3. **Snapshot diff guard depends on a stable schema.** Adding fields to a pane (e.g., topic id) in the snapshot will cause the very next snapshot after this change to rotate. That's expected and harmless. Don't add fields whose value flickers (process pids, auto-rename window names) without normalizing them out in `snapshot.sh`'s `NORMALIZE` jq filter.
4. **At most one active Claude conversation per LWD.** This is a user-enforced invariant: don't run two distinct conversations from the same launch directory at the same time. The mtime-based session resolver in `tmux.ts > resolveClaudeSessionId` is correct under this invariant. Same conversation running in two tmux panes (e.g., `claude --resume <same-id>` in two places) is **allowed** and not a violation — only two *distinct* conversations in the same LWD are. The Tmux Map shows a yellow ⚠ warning banner + per-pane chip if a violation is detected; do not silently work around violations.
5. **Backend reads JSONLs read-only.** Never write to `~/.claude/projects/`.

---

## 2 Final design (the answer key)

### 2.1 Topic — bijective with tmux session

```
Topic (0..1) ─── (0..1) Tmux session
              when both present, they are paired one-to-one
              identified by tmux session NAME (not pane id, not uuid)
```

- A topic can exist with **no** assigned tmux session — that's a *parked* topic.
- A tmux session can exist with **no** topic — that's a *free* tmux session.
- When both present, they're 1:1: one tmux session belongs to exactly one topic, and vice versa.

This is enforced in the API (assignment endpoint rejects double-claim) and in the UI (the dropdown shows only currently-free tmux sessions when assigning).

Multiple Claude conversations per topic are allowed by virtue of being inside the topic's tmux session (different panes/windows).

### 2.2 Topic states (derived, not stored)

```
status     condition
─────────  ──────────────────────────────────────────────────
active     completed_at == null  AND  has tmux assignment
parked     completed_at == null  AND  no tmux assignment
completed  completed_at != null
```

`completed_at` is the only stored status field. The UI computes the rest from current assignments.

When a topic is marked **completed**, its tmux session (if any) is **automatically released** (assignment removed). The tmux session becomes free; any further work in it will not count toward the now-completed topic. Reopening the topic does NOT restore the assignment — the user must re-assign explicitly.

### 2.3 Pomodoro

Stores raw timestamps; everything else (minutes, WU) is derived at render time.

```
{
  id:           string                  uuid
  started_at:   string (ISO 8601)
  ended_at:     string (ISO 8601)       set when stopped (auto or manual)
  target_duration_minutes: number       what user picked at start (e.g. 25)
  topic_ids:    string[]                multi-select; ≥1 required to start
  notes:        string                  free text, set after completion (optional)
  source:       "live-timer" | "manual" "manual" = post-hoc entry; "live-timer" = via UI timer
  context: {
    tmux_session_names: string[]        captured at start (snapshot of assigned tmuxes)
    claude_session_ids: string[]        captured at start (claude JSONLs in those tmuxes)
  }
}
```

- **Multi-topic pomodoro**: time is split equally across the selected topics. WU per topic = `(actual_minutes / topic_count) / wuMinutes`. Total WU summed across topics = `actual_minutes / wuMinutes` (preserved exactly).
- **Auto-stop**: when `now ≥ started_at + target_duration_minutes`, the timer fires a notification + audio beep. Pomodoro auto-saves with `ended_at = now`. User can still extend by clicking "Keep going" before auto-stop, which moves the target by N minutes.
- **Manual stop**: user clicks "Stop". `ended_at = now`. If user stopped before target, that's their actual time — no penalty.
- **Notes**: prompted after stop in a small modal. User can dismiss with Esc; notes can be edited later from the pomodoro detail drawer.
- **Live state survival**: persisted to `localStorage` (key `csv:active-pomodoro`) on every state change. On app load, if a value exists, the timer is restored running. On stop or user cancel, the localStorage entry is cleared.
- **Tab title**: while running, `document.title = "⏱ MM:SS — name1, name2"` so you can see remaining time in the tab.

### 2.4 Work Units — derivation only

```
1 WU = settings.wuMinutes minutes               default 10
total_WU(pomodoro)   = duration_minutes / wuMinutes
per_topic_WU(p, t)   = (duration_minutes / p.topic_ids.length) / wuMinutes
```

- Stored: `started_at`, `ended_at`. Period.
- Computed: minutes, total WU, per-topic WU.
- Changing `wuMinutes` later instantly rescales every display; no data migration.
- **Display**: rounded to 1 decimal; whole numbers shown without decimal. Always accompanied by a small caption "1 WU = N min" near any aggregate so the unit is self-explaining.

### 2.5 Settings — gear icon + modal

Place: gear icon at top-right of the app header. Click → modal drawer (right-side slide-in, max-width 28rem). Reachable from any tab.

```
~/.claude-session-viewer/settings.json
{
  "schemaVersion": 1,
  "wuMinutes": 10,
  "defaultPomodoroDuration": 25,
  "audioEnabled": true,
  "notificationsEnabled": true
}
```

Fields exposed in v1: `wuMinutes` (1–60), `defaultPomodoroDuration` (5–180), `audioEnabled`, `notificationsEnabled`. Form uses controlled inputs; "Save" persists; "Cancel" reverts.

Future fields land in the same modal; promote to a Settings tab only if it grows past ~6 fields.

### 2.6 Activity slice — post-hoc, on-demand

Key insight: we already have time-stamped logs of everything (Claude JSONLs, shell-history JSONLs). A pomodoro stores the *time range* and the *tmux sessions/JSONLs in scope at start*. The "what happened" view is a query:

```
For a pomodoro p with started_at = T_start, ended_at = T_end:

  commands = read shell-history files for date range [T_start_date, T_end_date]
             where each entry's tmuxSession is in p.context.tmux_session_names
             and entry.ts is in [T_start, T_end]

  conversations = for each sid in p.context.claude_session_ids:
                    open JSONL, filter messages where message.timestamp in [T_start, T_end]
                    aggregate: { sessionId, cwd, userPromptCount, totalMessageCount,
                                 firstUserPrompt, lastUserPrompt, allUserPrompts[] }
```

Implementation notes:
- **Skip events without parseable `timestamp`** — JSONL has some events that lack one (e.g., `file-history-snapshot`). Don't fall back to file mtime; just exclude.
- **Cap `allUserPrompts` at 100** entries per conversation (with `truncated: boolean` flag in response) to bound payload size for very long pomodoros.
- **WU computation guard**: `wu = max(0, (ended_at - started_at)/60000) / wuMinutes`. Defends against clock skew or mis-entered manual pomodoros.
- No new instrumentation. Zero performance cost when not viewing.
- Endpoint `GET /api/pomodoros/:id/activity` returns this slice on-demand.
- UI surfaces it ONLY when the user clicks a pomodoro row → opens detail drawer with two tabs: **Conversations** and **Commands**. Hidden everywhere else.

### 2.7 Restore preserves topic assignments — for free

`assignments.json` is keyed by tmux session name. `restore.sh` rebuilds tmux sessions with their original names. So when a session named `cdplat` is restored, the assignment `cdplat → "Compounding Platform"` already in `assignments.json` applies automatically — nothing to do in the script.

**Edge case**: a brand-new tmux session created with a name that matches an old assignment will inherit that topic. This is the desired behavior 95% of the time (it's how restore works). For the rare case the user wants the new session unassigned: they click "Unassign" in the Tmux Map header. No active warning needed.

### 2.8 Calendar

Two views, in the same tab:

- **Default — Yearly heatmap (Option 1)**: 53×7 grid of squares for the last 365 days. Color intensity = total WU that day. Topic filter chips above the grid let you isolate one topic. Hover a square → tooltip with date + WU breakdown by topic. Click → opens day drawer.
- **Subtab — Monthly grid (Option 2)**: standard month layout. Each day cell shows a small stacked horizontal bar with one segment per topic that had pomodoros that day (segment widths proportional to per-topic WU). Click a day → same drawer.

Day drawer: list of pomodoros that day, sortable by time. Each pomodoro clickable → pomodoro detail drawer (replacing or layering).

---

## 3 Concrete schemas

### 3.1 `topics.json`

```ts
interface Topic {
  id: string;                 // crypto.randomUUID() — Node ≥19 has it built-in, no `uuid` package
  name: string;               // 1–100 chars; unique per-user (case-insensitive)
  color: string;              // hex e.g. "#ec4899"; pick from the 16-color palette below OR custom hex
  tags: string[];             // free-form; suggested presets: "project","study","experiment","idea","client"
  notes: string;              // markdown allowed but not parsed
  completed_at: string | null;// ISO 8601 when set
  created_at: string;         // ISO 8601 — server-set on POST
  updated_at: string;         // ISO 8601 — server-set on POST and bumped on every PATCH
}

// File format:
{
  "schemaVersion": 1,
  "topics": [ Topic, ... ]
}
```

**Color palette** (Tailwind 500-shade primaries; pick any, or supply custom hex):
```
#ef4444  #f97316  #f59e0b  #eab308  #84cc16  #22c55e  #10b981  #14b8a6
#06b6d4  #0ea5e9  #3b82f6  #6366f1  #8b5cf6  #a855f7  #d946ef  #ec4899
```

### 3.2 `assignments.json`

```ts
// File format: a flat object keyed by tmux session name.
{
  "schemaVersion": 1,
  "assignments": {
    "cdplat": "topic-id-uuid-1",
    "VCSVTR": "topic-id-uuid-2"
    // tmux sessions not present here are "Free"
  }
}
```

Constraint: **values must be unique** (each topic id appears at most once). Enforced by API on every PUT.

### 3.3 `pomodoros.json`

```ts
interface Pomodoro {
  id: string;
  started_at: string;
  ended_at: string;
  target_duration_minutes: number;
  topic_ids: string[];               // ≥1
  notes: string;
  source: "live-timer" | "manual";
  context: {
    tmux_session_names: string[];
    claude_session_ids: string[];
  };
}

{
  "schemaVersion": 1,
  "pomodoros": [ Pomodoro, ... ]    // append new entries; never delete
}
```

Soft delete only (set `deleted_at`) if needed in the future; v1 has no delete.

### 3.4 `settings.json`

```ts
{
  "schemaVersion": 1,
  "wuMinutes": 10,
  "defaultPomodoroDuration": 25,
  "audioEnabled": true,
  "notificationsEnabled": true
}
```

### 3.5 Storage rules — atomic writes

All four files are written atomically. Concrete pattern (see §9 G12 for signature):

```ts
const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
await fs.rename(tmp, path);  // atomic on POSIX
```

Same pattern `snapshot.sh` uses for `latest.json`. Never partial-write. No cross-file transactions — each of the four files is independently atomic; for any operation that touches two files (e.g., PATCH topic to completed *also* removes assignment), do the assignments-write first then the topic-write, so a crash between them leaves a "lost" assignment that the next UI read can detect and silently re-converge.

---

## 4 Backend API

All endpoints under `/api`, served by Express on `127.0.0.1:5174`.

**Error response shape (every 4xx/5xx)**:
```ts
{ error: string; details?: object }
// example: { error: "topic name already exists", details: { existingId: "..." } }
```

**HTTP status codes used**:
- `200` — success
- `400` — validation error (bad input shape, invalid range, etc.)
- `404` — entity not found
- `409` — uniqueness/bijection conflict
- `500` — uncaught server error (only for true bugs)

**ID generation**: server uses `crypto.randomUUID()` (Node 19+) — no `uuid` package needed.

**Timestamps**: server-set on creation/update; ISO 8601 with timezone offset (`new Date().toISOString()` returns UTC `Z` suffix; that's fine — the frontend converts to local for display).

### 4.1 Topics

```
GET    /api/topics                                  → { topics: Topic[] }
GET    /api/topics/:id                              → Topic | 404
POST   /api/topics       body: Partial<Topic>       → Topic    (id, timestamps server-set)
PATCH  /api/topics/:id   body: Partial<Topic>       → Topic    (allowed: name,color,tags,notes,completed_at)
DELETE /api/topics/:id                              → { ok: true }   (hard delete; pomodoros may orphan)
```

Validation:
- `name`: 1–100 chars, trimmed, unique case-insensitive (excluding self on PATCH). 409 on duplicate.
- `color`: must match `^#[0-9a-fA-F]{6}$`. 400 on mismatch.
- `tags`: array of strings, ≤16 entries, each ≤32 chars.
- `notes`: string, ≤8000 chars.
- `completed_at`: ISO 8601 string or `null`.

Server behavior:
- POST: server generates `id = crypto.randomUUID()`, sets `created_at = updated_at = new Date().toISOString()`. Client-supplied id/timestamps are ignored.
- PATCH: server bumps `updated_at = new Date().toISOString()` on every successful patch. Allowed body fields: `name`, `color`, `tags`, `notes`, `completed_at`. Unknown fields → 400.
- DELETE: hard delete from `topics.json`. Server also removes the topic id from `assignments.json` (idempotent, no error if not assigned). Pomodoros referencing this topic are not modified — UI shows them as "[deleted: <unknown>]" since the name is no longer resolvable.

Business rule on PATCH `completed_at`:
- Setting `completed_at` to a non-null value: server also removes the topic from `assignments.json` (auto-release tmux). **Order**: write `assignments.json` first, then `topics.json` — so a crash between them leaves a still-active topic but free tmux, which is recoverable next click. The reverse order would leave a completed topic still claiming tmux.
- Setting `completed_at` to null: no assignment side-effect. Topic returns to "parked" state until user re-assigns.

### 4.2 Assignments

```
GET  /api/assignments                                  → { assignments: Record<string,string> }
PUT  /api/assignments  body: { tmuxSessionName, topicId | null }
                                                       → { assignments: ... } (full state after change)
```

Validation on PUT:
- If `topicId === null`, removes the assignment for `tmuxSessionName`. 200 always.
- If `topicId` is set:
  - Verify topic exists. 404 if not.
  - Verify topic is not completed. 409 if completed.
  - Verify topic is not already assigned to a different tmux session. 409 with explanation if violated.
  - Verify `tmuxSessionName` is not already assigned to a different topic. Replace silently (the user clicked the new assignment intentionally).
- Optionally verify the tmux session exists right now (`tmux list-sessions`); if not, accept anyway (the assignment is by name, valid for future restore).

### 4.3 Pomodoros

```
GET    /api/pomodoros?from=ISO&to=ISO&topicId=...     → { pomodoros: Pomodoro[] }
                                              filters all optional; all in ISO 8601
                                              `from`/`to` filter by `started_at`
GET    /api/pomodoros/:id                            → Pomodoro
GET    /api/pomodoros/:id/activity                   → ActivitySlice
POST   /api/pomodoros        body: NewPomodoro       → Pomodoro
PATCH  /api/pomodoros/:id    body: { notes?: string } → Pomodoro
```

No pagination — at 10 pomodoros/day × 365 days = 3650 entries × ~600 B = ~2 MB. Acceptable to return full list.

ActivitySlice shape:

```ts
interface ActivitySlice {
  pomodoroId: string;
  range: { from: string; to: string };
  conversations: ConversationActivity[];
  commands: CommandEntry[];
  warnings: string[];   // e.g. "shell-hook not installed; commands list may be empty"
}

interface ConversationActivity {
  sessionId: string;
  cwd: string | null;
  jsonlPath: string;
  userPromptCount: number;
  totalMessageCount: number;
  firstUserPrompt: string | null;       // first user prompt within range
  lastUserPrompt: string | null;
  allUserPrompts: { ts: string; preview: string }[];   // preview = first 200 chars; max 100 entries
  truncated: boolean;                    // true if userPromptCount > 100
  durationMinutes: number;              // wall-clock between first and last in-range message
}

interface CommandEntry {
  ts: string;
  tmuxSession: string;
  tmuxPane: string;
  cwd: string;
  cmd: string;
}
```

POST validation:
- `started_at` and `ended_at` parseable as ISO; `ended_at >= started_at`.
- `target_duration_minutes`: integer ≥1 (matches client min). 400 otherwise.
- `topic_ids`: ≥1; all must exist; none completed at start time (verified by checking topic at `started_at`).
- `notes`: string, ≤8000 chars.
- `source`: `"live-timer"` or `"manual"`.
- For live-timer creates, the API computes `context` itself (don't trust client) by:
  1. Reading current assignments
  2. For each topicId in topic_ids that has an assignment, add the tmux session name
  3. For each tmux session, query live tmux for its claude panes' session ids; collect into `claude_session_ids` (deduped, subagent JSONLs excluded)
  4. If tmux is not running, `context` arrays are empty (still a valid pomodoro; activity slice will be empty)

For `manual` source, the client may submit `context` themselves (or omit, server fills empty).

PATCH limits: only `notes` editable. Unknown fields → 400.

No DELETE on pomodoros in v1.

### 4.4 Settings

```
GET  /api/settings                       → Settings
PUT  /api/settings  body: Partial<Settings>  → Settings
```

Validation:
- `wuMinutes`: integer 1–60.
- `defaultPomodoroDuration`: integer 5–180.
- `audioEnabled`, `notificationsEnabled`: boolean.

If `settings.json` doesn't exist on first GET, the server writes the defaults to disk and returns them in the same call.

---

## 5 Frontend

### 5.1 Header — global state

**New npm dep**: `lucide-react` (~3–5 KB gzipped per icon, tree-shaken). Used for: `Settings` (gear), `Plus`, `X`, `ChevronDown`, `Calendar`, `Clock`, `AlarmClock`, `Edit2`, `Trash2`, `Check`, `RotateCcw`. Install in Stage A:
```bash
npm install lucide-react
```

Add a gear icon (`<Settings />` from `lucide-react`) at the top-right of `App.tsx` header, between the existing tabs and the right edge. Click → opens settings modal.

#### SettingsContext

```tsx
// web/src/SettingsContext.tsx
interface Settings {
  schemaVersion: number;
  wuMinutes: number;
  defaultPomodoroDuration: number;
  audioEnabled: boolean;
  notificationsEnabled: boolean;
}
const DEFAULTS: Settings = { schemaVersion: 1, wuMinutes: 10, defaultPomodoroDuration: 25, audioEnabled: true, notificationsEnabled: true };
const SettingsContext = createContext<{ settings: Settings; refresh: () => Promise<void>; save: (patch: Partial<Settings>) => Promise<void> } | null>(null);
export function useSettings() { /* throws if unwrapped, falls back to DEFAULTS in render via Provider */ }
```

#### TopicsContext

Same pattern: one context owns topics + assignments, fetched once on mount, refetched after every mutation. Sessions tab and Tmux Map both consume it.

```tsx
// web/src/TopicsContext.tsx
const TopicsContext = createContext<{
  topics: Topic[];                          // all topics including completed
  topicById: Map<string, Topic>;            // O(1) lookup
  assignmentsByTmux: Map<string, string>;   // tmuxSessionName → topicId
  refresh: () => Promise<void>;
  // mutations call refresh() internally
  createTopic: (data: NewTopic) => Promise<Topic>;
  updateTopic: (id: string, patch: Partial<Topic>) => Promise<Topic>;
  deleteTopic: (id: string) => Promise<void>;
  setAssignment: (tmuxSessionName: string, topicId: string | null) => Promise<void>;
} | null>(null);
```

Wrap the app (TopicsContext nested inside Settings so settings load first):

```tsx
<SettingsProvider>
  <TopicsProvider>
    <App />
  </TopicsProvider>
</SettingsProvider>
```

#### `api.ts` request helpers — important update

The existing `postJSON` throws on any non-2xx, swallowing structured error bodies. The new endpoints return 400/404/409 with `{error, details}` payloads we want to display. **Add a new helper** that returns the parsed body regardless of status:

```ts
// web/src/api.ts (add alongside getJSON / postJSON)
export interface ApiResult<T> { ok: boolean; status: number; body: T | { error: string; details?: any } }

export async function apiRequest<T>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any; try { parsed = await r.json(); } catch { parsed = null; }
  return { ok: r.ok, status: r.status, body: parsed };
}
```

Existing `getJSON`/`postJSON` keep their current "throw on non-2xx" semantics for endpoints that always return 2xx (snapshots, sessions, tmux, restore — already 200). New CRUD endpoints (topics, assignments, pomodoros, settings) use `apiRequest`. Components display `result.body.error` directly when `!result.ok`.

### 5.2 New tab: **Topics**

Layout:

```
┌────────────────────────────────────────────────────────────────┐
│ [+ New Topic]   [Search...]              [☐ Show completed]    │
├────────────────────────────────────────────────────────────────┤
│ ┌───────┐ ┌───────┐ ┌───────┐                                  │
│ │ active│ │ active│ │parked │     ← cards, color-borderd       │
│ │  ...  │ │  ...  │ │  ...  │                                  │
│ └───────┘ └───────┘ └───────┘                                  │
│                                                                │
│ ▼ Completed (12)                                               │
│ ┌───────┐ ┌───────┐                                            │
│ │  ...  │ │  ...  │                                            │
│ └───────┘ └───────┘                                            │
└────────────────────────────────────────────────────────────────┘
```

Card content (per topic):
- Color stripe on left edge
- Name (bold)
- Tag chips
- State badge: "active in <tmux>" / "parked" / "completed on <date>"
- Two stats: total WU (all-time), this-week WU
- Click card → opens topic detail drawer

Topic detail drawer (right slide-in, ~32rem):
- Editable name, color (palette + custom hex), tags, notes (textarea, no markdown rendering in v1)
- Assignment row: dropdown of currently-free tmux sessions + "Unassign" button if currently assigned
- "Mark complete" / "Reopen" button
- "Delete topic" button (with confirm dialog mentioning that historical pomodoros will show "[deleted: name]")
- Pomodoro timeline: bar-chart of last 30 days, list of last 10 pomodoros
- Linked claude conversations: when topic has tmux assignment, list claude session ids in that tmux + their last user prompt

### 5.3 New tab: **Pomodoro**

Layout:

```
┌──────────────────────────────────────────────────────────────────┐
│  ⏱  25:00                                       [start]         │
│      Topics: [+ Add topic ▼]                                     │
├──────────────────────────────────────────────────────────────────┤
│  Today       3.4 WU    34 minutes                                │
│   ↳  by topic: Foo 2 • Bar 1.4                                   │
├──────────────────────────────────────────────────────────────────┤
│  [+ Log past pomodoro]                                           │
├──────────────────────────────────────────────────────────────────┤
│  Recent                                                          │
│  ─────────────────────────────────────────────                   │
│  10:42  25min   Foo                  → details                   │
│  09:18  17min   Foo, Bar             → details                   │
│  ...                                                              │
└──────────────────────────────────────────────────────────────────┘
```

Live timer block:
- Big mm:ss display, monospace.
- Multi-topic chip-picker (only non-completed topics; suggest active ones first).
- "Start" button — disabled until ≥1 topic picked.
- While running: "Stop" + "Keep going" buttons. The latter extends the target by `defaultPomodoroDuration` more minutes.
- Duration field (number input next to the timer, default = `settings.defaultPomodoroDuration`) — only editable while not running.
- Persists state to `localStorage` key `csv:active-pomodoro` on every change.
- Auto-stop: when `now >= started_at + target_duration_minutes * 60_000`:
  1. Fire browser notification ("Pomodoro complete: <topic names>") if `settings.notificationsEnabled` (request permission lazily on first start).
  2. Play 600 Hz beep × 2 via Web Audio API if `settings.audioEnabled`.
  3. Set `ended_at = now`; POST to `/api/pomodoros`; clear localStorage; show completion modal with notes textarea.
- Tab title while running: `"⏱ 12:34 · topicA, topicB"`. Restored on page-load if active pomodoro found in localStorage.

"Log past pomodoro" button: opens a small modal with manual entry — start time, end time, topics, notes. POST with `source: "manual"`.

Recent table: today's pomodoros + last 50 days. Each row: time, duration, topic chips, link to detail drawer.

### 5.4 New tab: **Calendar**

Two subtabs at top: **Year** (default) | **Month**.

**Year (heatmap)**:
- 53 weekly columns × 7 day rows. Each cell is a small square (≈12×12 px). Cell color = total WU that day, mapped through a 5-step color scale.
- Topic filter row above the grid: chip "All", then one chip per topic. Multi-select. When any are selected, grid recolors using only those topics' WU.
- Tooltip on hover: "Tue Apr 23 — 4.2 WU (Foo: 2.0, Bar: 2.2)".
- Click a day → opens day drawer.

**Month**:
- Standard month grid (Mon-Sun columns, 5–6 rows).
- Each cell shows a small horizontal stacked bar at the bottom; one segment per topic with pomodoros that day; segment widths proportional to per-topic WU; color = topic color. Total bar width capped at cell width; if day exceeds 8 WU (configurable later), bar shows full width and tooltip reveals exact numbers.
- Day cell click → same day drawer.
- Month nav: ← Apr 2026 → ; "Today" button to jump back.

**Day drawer** (shared by both subtabs):
- Title: full date.
- List of pomodoros that day (sorted by start time):
  - `09:18–09:35 (17 min)`
  - topic chips
  - notes preview (line 1 only)
  - "→ details" link → opens pomodoro detail drawer (which can stack on top of day drawer).

### 5.5 Pomodoro detail drawer (used everywhere)

Reused from Pomodoro tab, Topics tab, Calendar drawers.

```
┌──────────────────────────────────────────────────────────────────┐
│ Pomodoro 09:18 → 09:35  (17 min, 1.7 WU)              ✕         │
│ Topics: Foo, Bar                                                  │
│ Notes: [editable textarea]                                        │
│                                                                  │
│ ─── tabs ─────────────────────────────────────────────────       │
│ ( Conversations | Commands )                                     │
│                                                                  │
│ Conversations:                                                   │
│   ▸ session abc123  in /home/dsu/X                               │
│       4 user prompts in this window                              │
│       first: "let's add a button..."                             │
│       last:  "actually, change it back"                          │
│       expand → see all 4 prompts with timestamps                 │
│   ▸ session def456 ...                                           │
│                                                                  │
│ Commands (when on Commands tab):                                 │
│   table: time | tmux pane | cwd | cmd                            │
└──────────────────────────────────────────────────────────────────┘
```

If `context.claude_session_ids` is empty: "No claude sessions captured. This pomodoro had no tmux assignment at the time, or tmux wasn't running." If shell-hook not installed: "Commands list empty — install shell hook (npm run install-shell-hook) to enable."

### 5.6 Updated existing tabs

**Tmux Map** session header:
- Add a colored chip showing topic name, OR a "Free" chip if unassigned.
- Click chip / dropdown → assignment menu: list of parked + active topics + "(Free / unassign)". Only non-completed topics shown.
- After change: refresh data. Chip color updates.

**Sessions** tab row:
- Tiny colored topic chip next to the cwd column. Inherited from the tmux session that holds this claude conversation (if any). For sessions in multiple tmuxes, shows all chips.
- For Claude conversations not currently in any live tmux, no chip.

**Inheritance dataflow** (composition, not new API):
```
Sessions row for JSONL X
  → liveById.get(X.id)            // map built from /api/tmux's live tree
  → returns array of { tmuxSession, paneIndex, ... }
  → for each entry: topicId = assignmentsByTmux.get(tmuxSession)
  → topic = topicById.get(topicId)
  → render colored chip with topic.color and topic.name
```
All three lookups (`liveById`, `assignmentsByTmux`, `topicById`) are pre-built memos at the page level. Renders in O(1) per row.

**Snapshots** tab: no change required, but listing newly-rotated snapshots will continue to capture topic assignments indirectly via tmux session names. Restore will rebuild assignments by name.

---

## 6 Implementation order (staged)

### Stage A — Foundation (build first, test before moving on)

1. **`npm install lucide-react`** — add to `package.json` dependencies.
2. **`server/lib/dataStore.ts`** — generic atomic JSON read/write (concrete signatures in §9 G12). Used by topics, assignments, pomodoros, settings.
3. **`server/routes/topics.ts`** — full CRUD with validation. Tests via curl: create, list, patch, complete, delete.
4. **`server/routes/assignments.ts`** — GET + PUT. Bijection enforcement.
5. **`server/routes/settings.ts`** — GET + PUT.
6. **Mount in `server/index.ts`**.
7. **`web/src/api.ts`** — add `apiRequest` helper, Topic, Assignment, Settings types, and client wrappers.
8. **`web/src/SettingsContext.tsx`** — provider + hook (§5.1).
9. **`web/src/TopicsContext.tsx`** — provider + hook (§5.1). Must come BEFORE Topics page or chip renderers.
10. **`web/src/App.tsx`** — wrap with `<SettingsProvider><TopicsProvider>`; add gear icon header button.
11. **`web/src/components/TopicChip.tsx`** — small reusable chip with color background, optional click handler.
12. **`web/src/components/SettingsModal.tsx`** — modal form.
13. **`web/src/components/TopicAssignmentMenu.tsx`** — dropdown for assigning a tmux session to a topic.
14. **`web/src/pages/Topics.tsx`** — list + cards + drawer + create flow. (No pomodoro stats yet — those come in Stage C.)
15. **`web/src/pages/TmuxMap.tsx`** — add topic chip + assignment dropdown to session header (consumes TopicsContext).
16. **`web/src/pages/Sessions.tsx`** — add inherited topic chip in row (uses dataflow in §5.6).

Smoke test before continuing:
- Create 3 topics. Mark one completed.
- Assign two of them to two real tmux sessions. Try to assign a third topic to one of those tmuxes → expect 409 in console.
- Try to assign one topic to two tmuxes → expect 409.
- Mark assigned topic completed → verify assignment auto-removed in `assignments.json`.
- Reload page → state survives.
- Verify Tmux Map chips and Sessions tab chips update.

### Stage B — Pomodoros

1. **`server/routes/pomodoros.ts`** — CRUD; activity slice endpoint.
2. **`server/lib/activity.ts`** — slice computation: read shell-history files within range, filter; for each captured claude session id, read JSONL with existing tail-reader (extend if needed) to extract messages-in-range.
3. **`web/src/api.ts`** — Pomodoro and ActivitySlice types + clients.
4. **`web/src/pages/Pomodoro.tsx`** — live timer + recent table + manual log modal.
5. **`web/src/components/PomodoroDetailDrawer.tsx`** — shared drawer.
6. **`web/src/lib/liveTimer.ts`** — localStorage-backed timer state + Notification + audio.

Smoke test:
- Start a 1-min pomodoro on one topic. Wait — auto-stop fires notification + saves.
- Refresh page during running pomodoro → timer continues from correct elapsed.
- Open detail drawer → conversations list pulls from JSONL tail; commands list reads shell-history.
- Multi-topic pomodoro records correctly with split WU.

### Stage C — Visualizations

1. **`web/src/pages/Calendar.tsx`** with subtabs.
2. **`web/src/components/HeatmapCalendar.tsx`** — 53×7 grid.
3. **`web/src/components/MonthGrid.tsx`** — month view with stacked bars.
4. **`web/src/components/DayDrawer.tsx`** — shared.
5. **Topics detail drawer** — bar chart of last 30 days + last 10 pomodoros.

Smoke test:
- Backfill via "Log past pomodoro" — add 5 entries on different days/topics.
- Verify heatmap intensity increases with WU; topic filter narrows it.
- Verify monthly bars stack with correct topic colors.

### Stage D — Restore preservation smoke test

1. With ≥2 topics assigned to ≥2 tmux sessions, kill one tmux session: `tmux kill-session -t <name>`.
2. UI should now show that session as "dead" in Tmux Map.
3. Click "Restore this session". After restore completes, verify the same topic chip is shown on the rebuilt session.
4. Inspect `assignments.json` — same as before. Confirm no script changes were needed.

---

## 7 Edge cases (must handle)

| Case | Behavior |
|---|---|
| Topic assigned to a tmux that's then killed | Assignment stays (keyed by name). UI shows topic as "active (waiting for restore)". On restore, automatically rejoined. |
| Topic deleted while assigned | Server removes the assignment as part of DELETE before deleting the topic. Idempotent. |
| Assignment to non-existent tmux session | Allowed (assignments are by name, valid for future). UI marks topic state as "active (no live tmux yet)". |
| Reassignment during a running pomodoro | Pomodoro context was captured at start; no rewrite. The activity slice for that pomodoro reflects the original tmux context. Future pomodoros use the new assignment. |
| Multi-topic pomodoro where one topic gets completed mid-flight | Pomodoro saves normally; references stay. Topic enters completed state with no impact on the running pomodoro's data. |
| Pomodoro across day boundaries (started 23:55, ended 00:18) | Recorded honestly. Calendar attribution uses **`started_at`'s LOCAL date** (`new Date(started_at).toLocaleDateString()`) for all aggregations — UTC ISO strings are converted to the user's browser timezone. Pomodoro list shows full time range. |
| Browser tab refresh during live pomodoro | Restored from localStorage; elapsed = `now - started_at`; auto-stop logic recomputes against target. |
| Notifications denied | Skip the notification; still beep (if audio enabled); still show modal. Show a small one-time hint at the bottom of Pomodoro tab. |
| Audio context blocked by browser policy | First "Start" click is a user gesture; create AudioContext then. If still blocked, swallow silently. |
| New tmux session reuses an old name | Inherits old assignment. Surface in UI as a tooltip on the chip ("inherited from previous session of the same name"). No interrupt. |
| Two claude panes share one JSONL | Already handled in Sessions tab by displaying both locations. For pomodoro context: dedup `claude_session_ids` array. |
| No shell hook installed | `commands` array empty in activity slice; warning in `warnings`. UI shows "Install hook to capture commands." |
| No snapshots, tmux not running | Pomodoro can still be started for parked topics (no live tmux requirement enforced); context arrays empty. Activity slice is empty. |
| Concurrent pomodoros | Disallowed in UI — "Stop current first" message. Single-active-pomodoro invariant enforced client-side via localStorage. |
| pomodoros.json grows over years | At 10/day, ~3650/year, each ~600 bytes → ~2 MB/year. Read fully into memory on every API call (acceptable). If it ever crosses 50 MB, switch to monthly-partitioned files. |
| LWD with two distinct Claude conversations | Violates §1.5 invariant #4. Tmux Map already detects (yellow warning banner + per-pane ⚠ chip). Pomodoro context capture, when this happens, will record both `claude_session_ids` for the topic's tmux session — activity slice shows both, which is correct enumeration of state but indicates the user should clean up. |

---

## 8 File-by-file changes

### 8.1 New files

```
server/lib/dataStore.ts            atomic JSON read/write helpers
server/lib/activity.ts             activity-slice computation
server/routes/topics.ts
server/routes/assignments.ts
server/routes/pomodoros.ts
server/routes/settings.ts

web/src/SettingsContext.tsx
web/src/TopicsContext.tsx          topics + assignments shared state
web/src/lib/liveTimer.ts           localStorage timer + notifications + audio
web/src/components/SettingsModal.tsx
web/src/components/PomodoroDetailDrawer.tsx
web/src/components/DayDrawer.tsx
web/src/components/HeatmapCalendar.tsx
web/src/components/MonthGrid.tsx
web/src/components/TopicChip.tsx
web/src/components/TopicAssignmentMenu.tsx
web/src/pages/Topics.tsx
web/src/pages/Pomodoro.tsx
web/src/pages/Calendar.tsx

docs/topics-and-pomodoros-plan.md  (this file)
```

### 8.2 Modified files

```
server/index.ts                    mount the four new routers
web/src/api.ts                     add apiRequest helper, Topic/Assignment/Pomodoro/Settings types and clients
web/src/App.tsx                    add SettingsProvider + TopicsProvider; add gear icon; add new tabs (Topics, Pomodoro, Calendar)
web/src/pages/Sessions.tsx         add inherited topic chip on rows; consume TopicsContext
web/src/pages/TmuxMap.tsx          add topic chip + assignment dropdown to session header; consume TopicsContext
```

No script changes required. `restore.sh` and `snapshot.sh` are unchanged because assignments survive by virtue of session-name keying.

### 8.3 New npm dependencies

```
lucide-react                        # icon library; ~3-5 KB gzipped per icon, tree-shaken
```

Existing deps (express, react, vite, tailwind, tsx) cover everything else. `crypto.randomUUID()` is a Node ≥19 built-in — no `uuid` package.

---

## 9 Codebase-specific gotchas

1. **`tsx` runner doesn't support `.js` import rewriting.** Don't use `node --experimental-strip-types`. Always run server via `tsx server/index.ts`. Imports between TS files in `server/` must include `.js` extensions (Vite/tsx convention) — match the existing pattern: `import { foo } from "./bar.js";` even though the file is `bar.ts`.

2. **The frontend uses Vite's HMR.** New components are picked up automatically. After edits, no restart needed. Server files require restart (`npm run dev` will not auto-reload server with the simplified `tsx` config; user must Ctrl-C + `npm run dev` again).

3. **Tailwind classes are scanned from `web/index.html` and `web/src/**/*.{ts,tsx}`** (see `tailwind.config.js`). Any new component file in `web/src/` will be picked up.

4. **Existing `tsconfig.json`** has `"strict": true`, `"noEmit": true`, `"jsx": "react-jsx"`. New code must compile cleanly under strict mode.

5. **`npm run stop`** kills both ports (5173/5174) when concurrent dev gets tangled. Useful during iteration.

6. **Cron is per-user crontab via `crontab -e`.** WSL2 with systemd boots cron automatically. If the user's WSL is configured without systemd, cron may not auto-start; out of scope for this work.

7. **Snapshot diff guard normalize filter** lives in `scripts/snapshot.sh` as the `NORMALIZE` jq expression. This work doesn't touch it. If a future change adds fields that flicker, extend that filter — DON'T disable diff guarding.

8. **Two claude panes sharing one JSONL** is allowed (NOT an invariant violation — it's the same conversation in two places). When both panes' tmux sessions are in `context.tmux_session_names`, dedup `claude_session_ids` in the slice. The JSONL is read once. The Sessions tab already lists multiple tmux locations per JSONL row.

9. **Subagent JSONLs** live at `~/.claude/projects/<encoded>/<session-id>/subagents/agent-*.jsonl`. They are EXCLUDED from `listAllSessionFiles` in `server/lib/jsonl.ts`. Activity slice should also exclude them. Do not include subagent jsonls in `context.claude_session_ids`.

10. **Permission mode** of a session is read from the JSONL header (`{"type":"permission-mode",...}` line, or any user message's `permissionMode` field). This is already exposed as `SessionMeta.permissionMode`. No changes here; documenting for completeness.

11. **`pane_current_path` is the LWD for claude panes, but the CWD for zsh panes** (because zsh chdirs itself). Don't conflate them.

12. **`/api/restore` always returns HTTP 200** with `{ok, exitCode, ...}`. Don't add code that throws on non-2xx; check `r.ok` instead.

---

## 9.5 Implementation specifics for new code

### G1 — `apiRequest` helper for endpoints that may return 4xx

The existing `postJSON` throws on non-2xx. New CRUD endpoints (topics, assignments, pomodoros, settings) deliberately return 400/404/409 with `{error, details}` bodies. Use the new `apiRequest` helper from §5.1 for these endpoints:

```ts
const r = await apiRequest<Topic>("POST", "/api/topics", { name: "Foo", color: "#3b82f6", tags: [], notes: "" });
if (!r.ok) {
  showToast(`error: ${(r.body as { error: string }).error}`);
  return;
}
const newTopic = r.body as Topic;
```

Don't call `postJSON` against these endpoints — you'll lose the structured error.

### G2 — JSONL message-range reader

`server/lib/jsonl.ts` currently has `readSessionMeta` (header + tail) and `readSessionDetail` (full file, no filter). Activity slicing needs a third helper:

```ts
// server/lib/jsonl.ts (new export)
export interface JsonlMessage {
  type: "user" | "assistant" | string;
  message?: { role?: string; content?: any };
  timestamp?: string;
  cwd?: string;
  // ... other fields preserved as `any`
}

export async function readMessagesInRange(
  jsonlPath: string,
  fromIso: string,
  toIso: string
): Promise<JsonlMessage[]> {
  // Read entire file (acceptable for v1; most JSONLs <10MB).
  // Parse each line, skip events without parseable timestamp,
  // filter by Date.parse(timestamp) in [Date.parse(from), Date.parse(to)].
  // Cache by (path, mtime, size, fromIso, toIso) — cheap, repeated drawer opens hit cache.
}
```

For very large JSONLs (>50 MB), upgrade later to a streaming line reader. Out of scope for v1.

### G5 — UUID generation

```ts
import { randomUUID } from "node:crypto";
const id = randomUUID();   // "550e8400-e29b-41d4-a716-446655440000"
```

Built into Node 19+. The user runs Node 25 — confirmed available. **Do NOT add `uuid` package.**

### G6 — Activity slice timestamp handling

When iterating JSONL events for an in-range query:
```ts
for (const evt of events) {
  if (typeof evt.timestamp !== "string") continue;       // skip events without ts
  const t = Date.parse(evt.timestamp);
  if (!Number.isFinite(t)) continue;                     // skip unparseable
  if (t < from || t > to) continue;                      // out of range
  // ... process
}
```

### G12 — `dataStore.ts` concrete signatures

```ts
// server/lib/dataStore.ts
import fs from "node:fs/promises";
import path from "node:path";

export async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const txt = await fs.readFile(filePath, "utf8");
    return JSON.parse(txt) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}
```

Use these for all four domain files.

### G15 — Stage A ordering rationale

The dependency chain is:
```
lucide-react install → dataStore.ts → backend routes → api.ts apiRequest helper
                                                     → SettingsContext (no deps on Topics)
                                                     → TopicsContext (depends only on api.ts)
                                                     → App.tsx providers
                                                     → TopicChip (used by 3 places below)
                                                     → SettingsModal, TopicAssignmentMenu
                                                     → Topics page
                                                     → TmuxMap chip integration
                                                     → Sessions chip integration (uses TopicsContext)
```
Building components in this order means every consumer's data sources already exist when it's wired up.

---

## 10 Testing & validation checklist

Before declaring the feature done:

- [ ] Topics CRUD round-trip: create, edit, complete, reopen, delete.
- [ ] Bijection enforced: cannot double-claim a topic; cannot double-assign a tmux.
- [ ] Settings persistence: change `wuMinutes`, all WU displays update without reload.
- [ ] Settings modal accessible from every tab via header gear icon.
- [ ] Assignment chips appear in Tmux Map and (inherited) in Sessions tab.
- [ ] Pomodoro live timer: start, run, auto-stop, restart, manual stop, extend.
- [ ] localStorage survives: refresh during running pomodoro → resumes seamlessly.
- [ ] Notifications + audio fire on auto-stop (with permission granted).
- [ ] Manual pomodoro entry validated and shown in calendar.
- [ ] Activity slice: conversations populated for in-range claude messages; commands populated when shell hook is installed; warnings shown otherwise.
- [ ] Calendar heatmap renders 365 days; topic filter narrows it.
- [ ] Calendar monthly grid shows stacked topic bars with correct colors.
- [ ] Day drawer → pomodoro drawer drilldown works.
- [ ] Restore smoke test: kill an assigned tmux session, restore, assignment intact.
- [ ] Topic deletion removes assignment but keeps pomodoro records.
- [ ] No backend errors on normal flows; 4xx with clear messages on validation failures.
- [ ] No browser console errors on normal flows.

---

## 10.5 Already-built supporting work (post-plan additions)

These were implemented after the plan was written but before topics/pomodoros work began. They support the same invariant model:

- **LWD-violation warning in Tmux Map** (`web/src/pages/TmuxMap.tsx`): a `useMemo` builds a `Map<cwd, sessionIds[]>` of all live claude panes, surfaces any cwd with >1 distinct conversation as a yellow banner at the top + a `⚠ LWD conflict` chip on each offending pane card. The session resolver is unchanged (still mtime-based) — the warning just makes violations visible so the user can clean up.

---

## 11 Out of scope for v1 (record for later)

- Long/short break tracking (classic pomodoro technique).
- Pomodoro pause (interruption is just "stop early").
- Per-topic targets ("I want to do 10 WU on Foo this week").
- Time-of-day weekly grid (Option 3 from earlier brainstorm).
- Fractional pomodoro weights (manual per-topic split — complicated UI for marginal gain).
- Idle detection (the user might step away mid-pomodoro).
- Linking pomodoros to GitHub PRs / Linear tickets.
- Exporting reports (PDF / CSV).
- Multi-machine sync.
- Tag taxonomy / hierarchical topics.

---

## 12 Quick start for a fresh session

If you're a Claude Code session that just opened this project and wants to implement this plan:

1. Read this entire document.
2. Read `~/Projects/claude-session-viewer/README.md` and skim `server/index.ts`, `server/routes/sessions.ts`, `web/src/App.tsx`, `web/src/pages/Sessions.tsx` to understand the existing patterns.
3. Confirm with the user that they want to build this (don't assume).
4. Start at Stage A. Implement, smoke-test, ask for feedback before moving to Stage B.
5. Use existing helpers: `readSessionMeta` in `server/lib/jsonl.ts`, the snapshot file conventions in `server/routes/tmux.ts`, the `getJSON`/`postJSON` helpers in `web/src/api.ts`.
6. Match existing code style: Tailwind classes for styling, no `any` types, `useMemo` for derived data, atomic file writes for everything in `~/.claude-session-viewer/`.

The plan is dense but the work is mostly mechanical: CRUD endpoints, React forms, and one moderately tricky component (the live timer). The hard design choices are already made in §2 — don't relitigate them without asking the user first.
