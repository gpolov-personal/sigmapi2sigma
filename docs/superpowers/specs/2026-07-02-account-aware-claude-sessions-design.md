# Account-aware Claude session tracking — design

**Date:** 2026-07-02
**Status:** approved (pending spec review)

## Problem

sigmapi2sigma reads Claude Code conversation logs from a single hardcoded
location, `~/.claude/projects/`. The user now runs multiple Claude Code
configurations on the same machine, selected by shell aliases that set
`CLAUDE_CONFIG_DIR`:

```zsh
claudep() { CLAUDE_CONFIG_DIR="$HOME/.claude-personal" CLAUDE_ACCOUNT=personal command claude "$@"; }
claudew() { CLAUDE_CONFIG_DIR="$HOME/.claude-work"     CLAUDE_ACCOUNT=work     command claude "$@"; }
```

Each config dir has its own `projects/` tree and its own `.claude.json`.
Everywhere the **Claude-session concept** surfaces — the Sessions tab, the Tmux
Map, snapshots, pomodoro activity detail, backups, and the resume/restore
launchers — should reflect *which account* a session belongs to. On a different
machine that has only `~/.claude`, the tool must keep working with zero
configuration.

### The complication that shapes the whole design

The account directories are **not disjoint**. They were seeded by copying the
original `~/.claude`, so the same conversations exist in multiple places.
Measured on the user's machine (2026-07-02):

- **24 project dirs (encoded cwds) overlap** between P and W — *every* repo dir
  exists under both accounts. cwd → account is therefore fully ambiguous.
- **24 session UUIDs are shared**; 23 are byte-identical copies, **1 has already
  diverged** (13,356,282 vs 13,008,558 bytes — resumed under one account and
  grown differently).
- **W has zero unique sessions** — it is entirely a seed copy of the origin.

**Consequence:** a session's account cannot be derived from where its `.jsonl`
file lives. A UUID can appear in up to three directories, mostly as identical
copies but sometimes diverged.

## Core principle

**"Account" is a property of a running Claude process — how it was launched
(`CLAUDE_CONFIG_DIR`) — not an intrinsic property of a session file.**

- **Anything live** (a running claude pane: Tmux Map, `snapshot.sh`) → account
  is read from the process environment. **Authoritative.**
- **Anything static** (listing conversation files on disk: Sessions tab,
  pomodoro activity) → account is the *set* of configured accounts whose dirs
  contain that file. Honest about the duplication; never guessed.

This was validated on the machine: live claude processes expose
`CLAUDE_CONFIG_DIR=/home/dsu/.claude-personal` (and `CLAUDE_ACCOUNT=personal`)
in `/proc/<pid>/environ`, and foreign-process environ is readable under WSL2.

## Configuration

### File: `~/.sigmapi2sigma/accounts.json`

```json
{
  "accounts": [
    { "name": "P", "path": "~/.claude-personal" },
    { "name": "W", "path": "~/.claude-work" }
  ]
}
```

- `name` — short label shown in badges and used in snapshots. Must be unique.
- `path` — the **config dir** (`CLAUDE_CONFIG_DIR`). Conversations live at
  `path/projects/`; `path` is exactly what is passed as `CLAUDE_CONFIG_DIR` on
  resume. `~` expands to `$HOME`.

### Resolution and validation (decision A)

Runs once at server startup and inside the bash scripts. Both use the same
logic (TypeScript `accounts.ts` and shared `scripts/lib/accounts.sh`) so they
cannot drift.

1. **No `accounts.json`** → synthesize a single account
   `[{ name: "default", path: "~/.claude" }]`. This is the zero-config
   "other computer" case. Graceful, silent.
2. **File present but invalid** — unparseable JSON, empty `accounts`, duplicate
   names, or **any `path` that does not exist / is not a directory** → **fatal.
   The server refuses to start**, printing which account and path failed. The
   bash scripts exit non-zero with the same message.
3. A valid `path` whose `projects/` subdir does not exist yet → **allowed** (a
   fresh account with no conversations). Validation targets the config dir, not
   `projects/`.

### Consequence for the origin dir

Once `accounts.json` lists only P and W, the stale pre-split `~/.claude` (the
28-file origin) is **not scanned** — it is ignored as the historical origin it
is. The `~/.claude` fallback activates only when no `accounts.json` exists.

## New module — single source of truth

`server/lib/accounts.ts` replaces the single `CLAUDE_PROJECTS_DIR` constant in
`pathEncoding.ts`:

```ts
export interface Account {
  name: string;        // "P"
  configDir: string;   // absolute, e.g. /home/dsu/.claude-personal
  projectsDir: string; // configDir + "/projects"
}

// Reads accounts.json, validates, throws on bad config (fatal at startup).
export function loadAccounts(): Account[];

// Which configured accounts contain a given session file / UUID (0..N).
export function accountsForUuid(uuid: string): string[];

// Map an absolute CLAUDE_CONFIG_DIR (from environ) to an account name, or null.
export function accountForConfigDir(dir: string): string | null;
```

`loadAccounts()` is called at startup so a bad config fails fast. Bash scripts
get `scripts/lib/accounts.sh` parsing the same file with `jq` and applying the
same validation rules.

`encodeCwd` stays in `pathEncoding.ts` (unchanged); only the directory constant
moves into the account model.

## Data-model deltas

- **`SessionMeta`** (`jsonl.ts`): gains **`accounts: string[]`** — the set of
  account names whose dirs contain the UUID. (For live panes the Tmux Map
  carries a single authoritative account; see below.)
- **Snapshot pane object** (`snapshot.sh`): gains
  **`claudeAccount: string | null`** — the authoritative account of the running
  claude, from environ.
- **`TmuxPane`** (`tmux.ts`): gains `claudeAccount: string | null`.
- **Pomodoro records** are unchanged. They already store `claude_session_ids`
  (UUIDs); account is derived at read time via `accountsForUuid`. **No data
  migration.**

## Read side — static listing

`sid → account(s)` is a set lookup across configured dirs.

### Sessions tab

- **Dedup by UUID.** The 24 shared sessions render as **one row each**, not
  three. Identity is the UUID.
- Each row carries `accounts: string[]`; the badge renders the set (e.g.
  `P W`). The account filter means "set includes X".
- **Metadata (last prompt, mtime, header fields) taken from the newest copy**
  across the accounts that hold the UUID — which naturally surfaces the active
  side of a **diverged** session.
- `listAllSessionFiles` iterates every account's `projects/`, groups by UUID,
  and returns the deduped, account-tagged set. `GET /sessions/:id` searches
  across all accounts and returns the newest copy's detail.

### Pomodoro activity detail

`computeActivitySlice` resolves each conversation's `accounts` via
`accountsForUuid` and tags it, so the pomodoro detail drawer shows which
account each conversation belonged to.

## Read side — live panes (Tmux Map, snapshot)

Reading `CLAUDE_CONFIG_DIR` from the running claude's `/proc/<pid>/environ` is
**required**, not a heuristic:

1. From the pane's `pane_pid` (the shell), descend the process tree to the
   `comm == "claude"` process.
2. Read its environ; take `CLAUDE_CONFIG_DIR`. Map to an account via
   `accountForConfigDir`.
3. No `CLAUDE_CONFIG_DIR` in environ → launched with plain `claude` → the
   **default** account (`~/.claude` if configured/fallback), else `null`.
4. Process gone / environ unreadable → `claudeAccount = null` ("unknown").
   **Never guess by mtime** — that would pick blindly among identical copies.

Once the account is fixed this way, the session id is the newest `.jsonl` in
*that account's* cwd project dir — now unambiguous. This applies identically in
`server/lib/tmux.ts:resolveClaudeSessionId` / `buildTmuxTree` (Node reads
`/proc`) and in `snapshot.sh` (bash reads `/proc`).

The Tmux Map badges each claude pane with its account (or "unknown").

## Launch side — resume / restore become account-aware

Every relaunch funnels into two executors; both build a bare
`claude --resume <sid>` today and must learn `CLAUDE_CONFIG_DIR`.

### Executor A — `scripts/restore.sh`

Serves: Tmux Map "Restore this session" / "Restore --force"; Tmux Map
Saved-for-Later "Restore" / "Restore --force"; Snapshots tab "Restore" /
"Dry-run restore".

Reads `claudeAccount` from each snapshot pane, looks up its `configDir` via
`accounts.sh`, and emits:

```
CLAUDE_CONFIG_DIR=<configDir> claude [--permission-mode <mode>] --resume <sid>
```

in the `send-keys`. When `claudeAccount` is null (legacy snapshot or unknown),
falls back to the bare command (current behavior) so old snapshots still work.

### Executor B — `snapshots.ts POST /resume`

Serves: Sessions tab "Resume in tmux".

Accepts an `account` field in the request body, resolves its `configDir`, and
prepends `CLAUDE_CONFIG_DIR` to the `tmux new-session` command.

### Resume ambiguity (Sessions tab)

Because a static session's `accounts` set can have more than one member:

- Set has exactly one account → resume immediately under it, no prompt.
- Set has >1 account → the Sessions tab shows a small **account picker**
  ("Resume under P or W?") and passes the chosen account to `/resume`.

Live captures (snapshot/Tmux Map) already know the authoritative account, so
restore never prompts.

### Cleanup

Delete the dead `resumeClaudeInNewSession` helper in `tmux.ts` (zero callers;
the `/resume` route inlines its own copy), or repurpose it as the single shared
launcher. One place should know how to spell a resume command.

### Displayed copy string

`Sessions.tsx` builds a copy-paste `claude --resume <id>` string for the user.
For a session whose account is non-default it renders
`CLAUDE_CONFIG_DIR="<configDir>" claude --resume <id>` so the copied command
targets the right account.

## Snapshot / backup / restore-backup (decision C)

- **`snapshot.sh`** captures each claude pane's `claudeAccount` from environ
  (as above) and writes it into the pane object. Runs from cron every 5 min.
- **`backup.sh`** stages each account's conversations under
  `claude-conversations/<name>/…` instead of a single flat tree.
- **`restore-backup.sh`** restores each `<name>/` back to that account's
  `projects/`.
- Backup foldering duplicates the ~identical historical copies across P/W
  folders — correct but redundant. In-tarball dedup of byte-identical files is
  noted as an **optional later optimization**, not built now (YAGNI).

## Error handling

- Bad `accounts.json` → fatal at startup (server) / non-zero exit (scripts),
  with the offending account/path named.
- Unreadable `/proc/<pid>/environ` or missing claude process → `claudeAccount`
  is `null`; the pane still renders, badged "unknown"; resume falls back to the
  bare command.
- Legacy snapshots without `claudeAccount` → restore falls back to the bare
  command (no regression).
- A configured account whose `projects/` is absent → treated as an account with
  zero sessions, not an error.

## Testing

The repo currently has no tests. Add a focused first suite around the pure
logic, plus manual end-to-end verification.

- **Unit (`accounts.ts`):** no file → synthesized default; bad path → throws;
  duplicate names → throws; `~` expansion; empty accounts → throws;
  `accountsForUuid` returns the correct set for a shared UUID;
  `accountForConfigDir` maps path → name and returns null for unknown.
- **Manual E2E** against the real P/W dirs: Sessions list shows shared sessions
  once with a `P W` badge; a live claude pane badges with its true account; a
  resume of a W-only session launches under `~/.claude-work`; a restore of a
  snapshot resumes each pane under its captured account; a backup contains
  `claude-conversations/P/` and `claude-conversations/W/`.

## Rollout — two slices

1. **Read / display.** `accounts.ts` + `accounts.sh` + startup validation;
   Sessions dedup + account-set badges + filter; Tmux Map + snapshot environ
   account capture; pomodoro-detail account tags. Observable immediately, no
   launch-path risk.
2. **Launch / persist.** `restore.sh` and `/resume` `CLAUDE_CONFIG_DIR`;
   resume account picker; displayed copy string; backup/restore-backup
   foldering. This slice fixes resume/restore for non-default accounts.

## Out of scope

- One-active-account switching UI (the merged/tagged model is intentional;
  switching can layer on later).
- In-tarball dedup of identical historical copies.
- Reconciling / merging diverged copies of a shared UUID — they are surfaced
  by newest-copy metadata and disambiguated at resume; no automatic merge.
