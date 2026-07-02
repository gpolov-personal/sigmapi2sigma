# Account-aware Claude Session Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Claude-session surface (Sessions tab, Tmux Map, snapshots, pomodoro activity, backups, resume/restore) aware of which Claude account (`CLAUDE_CONFIG_DIR`) a session belongs to, configured via a validated `accounts.json`, with a zero-config `~/.claude` fallback.

**Architecture:** A new `accounts.ts` module is the single source of truth for the account list (file → validate → throw at startup; fallback to `~/.claude` when no file). "Account" is authoritative from the running process environ (`/proc/<pid>/environ`) for anything live, and a *set* of accounts for static session files (because P/W were seeded from the same origin and share UUIDs). Bash scripts read the same config via `scripts/lib/accounts.sh`.

**Tech Stack:** Node + Express + TypeScript (`tsx`), React 19 + Tailwind, bash scripts with `jq`. Tests: Node built-in test runner via `node --import tsx --test`.

## Global Constraints

- Server binds `127.0.0.1` only; no new network surface.
- No new npm dependencies (tests use Node's built-in `node:test`).
- Config file: `~/.sigmapi2sigma/accounts.json`, shape `{ "accounts": [ { "name": string, "path": string } ] }`. `~` expands to `$HOME`. `path` is the `CLAUDE_CONFIG_DIR`; conversations live at `path/projects/`.
- Validation (decision A): no file → synthesize `[{ name: "default", path: "~/.claude" }]`; file present but invalid (unparseable, empty `accounts`, duplicate names, or any `path` that is not an existing directory) → **fatal** (server exits non-zero; scripts exit non-zero) naming the offending account/path. A missing `projects/` subdir is allowed.
- Account of a **live** claude pane = `CLAUDE_CONFIG_DIR` from its process environ; absent env var → the `default`/`~/.claude` account; unreadable → `null` ("unknown"), never guessed by mtime.
- Static session identity = UUID; dedup across accounts; `accounts: string[]` is the set of accounts whose dirs hold that UUID; metadata taken from the newest copy.
- Legacy data (snapshots without `claudeAccount`, flat backups) must keep working.
- Test runner command: `node --import tsx --test <file>` (verified working, Node v25).

---

### Task 1: `accounts.ts` — config resolution + validation (pure core + fs wrapper)

**Files:**
- Create: `server/lib/accounts.ts`
- Test: `server/lib/accounts.test.ts`

**Interfaces:**
- Produces:
  - `interface Account { name: string; configDir: string; projectsDir: string }`
  - `resolveAccounts(raw: any | null, deps: { homedir: string; dirExists: (p: string) => boolean }): Account[]` (pure; throws on invalid)
  - `loadAccounts(): Account[]` (reads `~/.sigmapi2sigma/accounts.json`, caches, throws on invalid)
  - `accountForConfigDir(dir: string): string | null`
  - `clearAccountsCache(): void` (test seam)

- [ ] **Step 1: Write the failing test**

Create `server/lib/accounts.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAccounts } from "./accounts.js";

const deps = (existing: string[]) => ({
  homedir: "/home/dsu",
  dirExists: (p: string) => existing.includes(p),
});

test("no config file falls back to a single default account at ~/.claude", () => {
  const accs = resolveAccounts(null, deps(["/home/dsu/.claude"]));
  assert.deepEqual(accs, [{
    name: "default",
    configDir: "/home/dsu/.claude",
    projectsDir: "/home/dsu/.claude/projects",
  }]);
});

test("valid two-account config expands ~ and derives projectsDir", () => {
  const raw = { accounts: [
    { name: "P", path: "~/.claude-personal" },
    { name: "W", path: "/home/dsu/.claude-work" },
  ]};
  const accs = resolveAccounts(raw, deps(["/home/dsu/.claude-personal", "/home/dsu/.claude-work"]));
  assert.equal(accs[0].configDir, "/home/dsu/.claude-personal");
  assert.equal(accs[0].projectsDir, "/home/dsu/.claude-personal/projects");
  assert.equal(accs[1].name, "W");
});

test("missing path directory is fatal", () => {
  const raw = { accounts: [{ name: "W", path: "~/.claude-work" }] };
  assert.throws(() => resolveAccounts(raw, deps([])), /account 'W' path does not exist/);
});

test("duplicate names are fatal", () => {
  const raw = { accounts: [
    { name: "P", path: "~/a" }, { name: "P", path: "~/b" },
  ]};
  assert.throws(() => resolveAccounts(raw, deps(["/home/dsu/a", "/home/dsu/b"])), /duplicate account name 'P'/);
});

test("empty accounts array is fatal", () => {
  assert.throws(() => resolveAccounts({ accounts: [] }, deps([])), /non-empty array/);
});

test("account without a name is fatal", () => {
  assert.throws(() => resolveAccounts({ accounts: [{ path: "~/a" }] }, deps(["/home/dsu/a"])), /non-empty 'name'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/lib/accounts.test.ts`
Expected: FAIL — cannot find module `./accounts.js` / `resolveAccounts` not defined.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/accounts.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Account {
  name: string;
  configDir: string;   // absolute CLAUDE_CONFIG_DIR
  projectsDir: string; // configDir/projects
}

function expandHomeIn(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

export interface ResolveDeps {
  homedir: string;
  dirExists: (p: string) => boolean;
}

/** Pure core: parsed accounts.json (or null if the file is absent) → validated
 *  account list, or throw on invalid config (decision A). */
export function resolveAccounts(raw: any | null, deps: ResolveDeps): Account[] {
  if (raw === null) {
    const configDir = path.join(deps.homedir, ".claude");
    return [{ name: "default", configDir, projectsDir: path.join(configDir, "projects") }];
  }
  if (typeof raw !== "object" || !Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    throw new Error("accounts.json: 'accounts' must be a non-empty array");
  }
  const out: Account[] = [];
  const seen = new Set<string>();
  for (const a of raw.accounts) {
    if (!a || typeof a.name !== "string" || a.name.length === 0) {
      throw new Error("accounts.json: every account needs a non-empty 'name'");
    }
    if (typeof a.path !== "string" || a.path.length === 0) {
      throw new Error(`accounts.json: account '${a.name}' needs a non-empty 'path'`);
    }
    if (seen.has(a.name)) throw new Error(`accounts.json: duplicate account name '${a.name}'`);
    seen.add(a.name);
    const configDir = path.resolve(expandHomeIn(a.path, deps.homedir));
    if (!deps.dirExists(configDir)) {
      throw new Error(`accounts.json: account '${a.name}' path does not exist: ${configDir}`);
    }
    out.push({ name: a.name, configDir, projectsDir: path.join(configDir, "projects") });
  }
  return out;
}

let cached: Account[] | null = null;

export function clearAccountsCache(): void { cached = null; }

export function loadAccounts(): Account[] {
  if (cached) return cached;
  const cfg = path.join(os.homedir(), ".sigmapi2sigma", "accounts.json");
  let raw: any | null = null;
  if (fs.existsSync(cfg)) {
    let txt: string;
    try { txt = fs.readFileSync(cfg, "utf8"); }
    catch (e: any) { throw new Error(`accounts.json: cannot read ${cfg}: ${e.message}`); }
    try { raw = JSON.parse(txt); }
    catch { throw new Error(`accounts.json: ${cfg} is not valid JSON`); }
  }
  cached = resolveAccounts(raw, {
    homedir: os.homedir(),
    dirExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  });
  return cached;
}

export function accountForConfigDir(dir: string): string | null {
  const target = path.resolve(dir);
  for (const a of loadAccounts()) if (a.configDir === target) return a.name;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test server/lib/accounts.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Add the `test` script to package.json**

Modify `package.json` scripts (add after `"restore-backup"` line):

```json
    "restore-backup": "bash scripts/restore-backup.sh",
    "test": "node --import tsx --test server/lib/*.test.ts"
```

- [ ] **Step 6: Commit**

```bash
git add server/lib/accounts.ts server/lib/accounts.test.ts package.json
git commit -m "feat(server): account config module with startup validation"
```

---

### Task 2: Fail fast at startup on bad config

**Files:**
- Modify: `server/index.ts:13-14` (after `const app = express();`)

**Interfaces:**
- Consumes: `loadAccounts()` from Task 1.

- [ ] **Step 1: Wire loadAccounts into startup**

In `server/index.ts`, add the import near the other imports:

```ts
import { loadAccounts } from "./lib/accounts.js";
```

Then immediately after `const app = express();` add:

```ts
// Validate account config before serving. Bad accounts.json is fatal (decision A).
try {
  const accounts = loadAccounts();
  console.log(`sigmapi2sigma accounts: ${accounts.map(a => `${a.name}→${a.configDir}`).join(", ")}`);
} catch (e: any) {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Verify happy path (no config file → default account)**

Run: `PORT=5199 node --import tsx server/index.ts &` then `sleep 1; curl -s localhost:5199/api/health; kill %1`
Expected: stdout shows `sigmapi2sigma accounts: default→/home/dsu/.claude` (or your P/W if a config exists) and health returns `{"ok":true}`.

- [ ] **Step 3: Verify fatal path**

Run:
```bash
mkdir -p /tmp/sp2s-badcfg
printf '{"accounts":[{"name":"X","path":"/does/not/exist"}]}' > /tmp/_bad.json
HOME=/tmp/sp2s-home bash -c 'mkdir -p ~/.sigmapi2sigma && cp /tmp/_bad.json ~/.sigmapi2sigma/accounts.json; PORT=5198 node --import tsx server/index.ts'; echo "exit=$?"
```
Expected: prints `FATAL: accounts.json: account 'X' path does not exist: /does/not/exist` and `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): fatal startup on invalid accounts.json"
```

---

### Task 3: `scripts/lib/accounts.sh` — shared bash config reader

**Files:**
- Create: `scripts/lib/accounts.sh`

**Interfaces:**
- Produces (sourced by other scripts):
  - `sp2s_load_accounts` → prints validated `name<TAB>configDir` lines; exits non-zero with message on invalid config.
  - `sp2s_find_claude_pid <root_pid>` → prints the descendant pid whose `comm==claude`, or empty.
  - `sp2s_account_for_pid <root_pid>` → prints account name for a running claude pane (via environ), or empty.

- [ ] **Step 1: Write the script**

Create `scripts/lib/accounts.sh`:

```bash
# Shared account-config helpers. Source this: . "$(dirname "$0")/lib/accounts.sh"
# Requires: jq.

# Emit validated accounts as "name<TAB>configDir" lines. Fatal (return 1) on bad config.
sp2s_load_accounts() {
  local cfg="$HOME/.sigmapi2sigma/accounts.json"
  if [[ ! -f "$cfg" ]]; then
    printf 'default\t%s\n' "$HOME/.claude"
    return 0
  fi
  local json
  json=$(cat "$cfg") || { echo "accounts.sh: cannot read $cfg" >&2; return 1; }
  echo "$json" | jq -e '.accounts | type=="array" and length>0' >/dev/null 2>&1 \
    || { echo "accounts.sh: $cfg has no non-empty 'accounts' array" >&2; return 1; }
  local names="" name pth
  while IFS=$'\t' read -r name pth; do
    pth="${pth/#\~/$HOME}"
    [[ -d "$pth" ]] || { echo "accounts.sh: account '$name' path does not exist: $pth" >&2; return 1; }
    case " $names " in *" $name "*) echo "accounts.sh: duplicate account name '$name'" >&2; return 1;; esac
    names="$names $name"
    printf '%s\t%s\n' "$name" "$pth"
  done < <(echo "$json" | jq -r '.accounts[] | [.name, .path] | @tsv')
}

# Descend the process tree from $1 to find a process named "claude". Echoes its pid or "".
sp2s_find_claude_pid() {
  local root="$1" queue=("$1") pid c children
  while ((${#queue[@]})); do
    pid="${queue[0]}"; queue=("${queue[@]:1}")
    [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == "claude" ]] && { echo "$pid"; return 0; }
    children=$(cat "/proc/$pid/task/$pid/children" 2>/dev/null)
    for c in $children; do queue+=("$c"); done
  done
  echo ""
}

# Account name of the running claude under pane root pid $1 (via /proc environ). Echoes name or "".
sp2s_account_for_pid() {
  local root="$1" cpid ccd
  cpid=$(sp2s_find_claude_pid "$root")
  [[ -n "$cpid" ]] || { echo ""; return 0; }
  ccd=$(tr '\0' '\n' < "/proc/$cpid/environ" 2>/dev/null | sed -n 's/^CLAUDE_CONFIG_DIR=//p' | head -1)
  [[ -n "$ccd" ]] || ccd="$HOME/.claude"   # plain `claude` → default account
  # Map configDir → name.
  local name pth
  while IFS=$'\t' read -r name pth; do
    [[ "$pth" == "$ccd" ]] && { echo "$name"; return 0; }
  done < <(sp2s_load_accounts)
  echo ""
}
```

- [ ] **Step 2: Verify against your live processes**

Run:
```bash
cd /home/dsu/pProjects/sigmapi2sigma
bash -c '. scripts/lib/accounts.sh; echo "--- accounts ---"; sp2s_load_accounts; echo "--- live claude accounts ---"; for p in $(pgrep -x zsh); do a=$(sp2s_account_for_pid "$p"); [ -n "$a" ] && echo "pane_pid=$p account=$a"; done'
```
Expected: `sp2s_load_accounts` prints your `default` (or P/W) lines; any pane running claude prints its account name (e.g. `account=P`). No crash.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/accounts.sh
git commit -m "feat(scripts): shared accounts.sh config + environ account resolver"
```

---

### Task 4: `jsonl.ts` — account-tagged, deduped session listing

**Files:**
- Modify: `server/lib/jsonl.ts` (imports; `SessionMeta`; `listAllSessionFiles`; add `listDedupedSessions`)
- Modify: `server/lib/pathEncoding.ts` (remove `CLAUDE_PROJECTS_DIR`; keep `encodeCwd`, `DATA_DIR`)
- Test: `server/lib/jsonl.test.ts`

**Interfaces:**
- Consumes: `loadAccounts` (Task 1).
- Produces:
  - `SessionMeta` gains `accounts: string[]` (default `[]`).
  - `interface TaggedFile { path: string; account: string }`
  - `listAllSessionFiles(): Promise<TaggedFile[]>` (signature change from `string[]`)
  - `interface DedupedSession { id: string; path: string; accounts: string[] }`
  - `listDedupedSessions(): Promise<DedupedSession[]>`

- [ ] **Step 1: Write the failing test**

Create `server/lib/jsonl.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeTaggedFiles } from "./jsonl.js";

test("dedupeTaggedFiles groups a shared UUID into one entry with both accounts, newest path wins", () => {
  const rows = [
    { id: "u1", path: "/P/proj/u1.jsonl", account: "P", mtime: 100 },
    { id: "u1", path: "/W/proj/u1.jsonl", account: "W", mtime: 200 },
    { id: "u2", path: "/P/proj/u2.jsonl", account: "P", mtime: 50 },
  ];
  const out = dedupeTaggedFiles(rows).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(out, [
    { id: "u1", path: "/W/proj/u1.jsonl", accounts: ["P", "W"] }, // newer W copy wins
    { id: "u2", path: "/P/proj/u2.jsonl", accounts: ["P"] },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test server/lib/jsonl.test.ts`
Expected: FAIL — `dedupeTaggedFiles` not exported.

- [ ] **Step 3: Implement — pathEncoding.ts**

In `server/lib/pathEncoding.ts`, delete the `CLAUDE_PROJECTS_DIR` export (lines 7-10 region), leaving:

```ts
// Claude Code encodes a cwd into a flat project-dir name by replacing
// path-ish characters with "-". Mirrors the logic in our bash scripts.
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, "-");
}

import os from "node:os";
import path from "node:path";

export const DATA_DIR = path.join(os.homedir(), ".sigmapi2sigma");
```

- [ ] **Step 4: Implement — jsonl.ts**

In `server/lib/jsonl.ts`, replace the import on line 4:

```ts
import { loadAccounts } from "./accounts.js";
```

Add `accounts` to the `SessionMeta` interface (after `lastUserTs`):

```ts
  lastUserTs: string | null;
  accounts: string[];   // account names whose dirs hold this UUID; [] until attached by caller
```

In `readSessionMeta`, add `accounts: []` to the `meta` object literal (after `lastUserTs`):

```ts
      lastUserTs,
      accounts: [],
```

Replace `listAllSessionFiles` (lines ~130-146) with:

```ts
export interface TaggedFile { path: string; account: string; }

// Every top-level session jsonl across all configured accounts, tagged by account.
export async function listAllSessionFiles(): Promise<TaggedFile[]> {
  const out: TaggedFile[] = [];
  for (const acc of loadAccounts()) {
    let entries;
    try { entries = await fs.readdir(acc.projectsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const proj = path.join(acc.projectsDir, e.name);
      let files;
      try { files = await fs.readdir(proj); } catch { continue; }
      for (const f of files) if (f.endsWith(".jsonl")) out.push({ path: path.join(proj, f), account: acc.name });
    }
  }
  return out;
}

export interface DedupedSession { id: string; path: string; accounts: string[]; }

// Pure grouping helper (unit-tested): one entry per UUID, accounts = sorted set,
// representative path = newest mtime (surfaces the active side of a diverged copy).
export function dedupeTaggedFiles(
  rows: { id: string; path: string; account: string; mtime: number }[]
): DedupedSession[] {
  const byId = new Map<string, { path: string; mtime: number; accounts: Set<string> }>();
  for (const r of rows) {
    const cur = byId.get(r.id);
    if (!cur) byId.set(r.id, { path: r.path, mtime: r.mtime, accounts: new Set([r.account]) });
    else { cur.accounts.add(r.account); if (r.mtime > cur.mtime) { cur.mtime = r.mtime; cur.path = r.path; } }
  }
  return [...byId.entries()].map(([id, v]) => ({ id, path: v.path, accounts: [...v.accounts].sort() }));
}

// Deduped sessions across all accounts.
export async function listDedupedSessions(): Promise<DedupedSession[]> {
  const tagged = await listAllSessionFiles();
  const rows: { id: string; path: string; account: string; mtime: number }[] = [];
  for (const t of tagged) {
    let mtime = 0;
    try { mtime = (await fs.stat(t.path)).mtimeMs; } catch { continue; }
    rows.push({ id: path.basename(t.path, ".jsonl"), path: t.path, account: t.account, mtime });
  }
  return dedupeTaggedFiles(rows);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test server/lib/jsonl.test.ts server/lib/accounts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/lib/jsonl.ts server/lib/jsonl.test.ts server/lib/pathEncoding.ts
git commit -m "feat(server): account-tagged deduped session listing"
```

---

### Task 5: `sessions.ts` route — deduped list + cross-account detail

**Files:**
- Modify: `server/routes/sessions.ts`

**Interfaces:**
- Consumes: `listDedupedSessions`, `listAllSessionFiles`, `readSessionMeta` (Task 4).

- [ ] **Step 1: Rewrite the list handler**

In `server/routes/sessions.ts`, change the import line to:

```ts
import { listAllSessionFiles, listDedupedSessions, readSessionMeta, readSessionDetail } from "../lib/jsonl.js";
```

Replace the body of `GET /sessions` up to the `const ids =` line. The new metas build:

```ts
  const deduped = await listDedupedSessions();
  const allMetas = (await Promise.all(deduped.map(async d => {
    const m = await readSessionMeta(d.path);
    return m ? { ...m, accounts: d.accounts } : null;
  }))).filter((m): m is NonNullable<typeof m> => !!m);
```

(Everything after — anchor, cutoff, sort, `ids`, `getLastLocationsBySessionId`, `enriched`, `res.json` — stays unchanged.)

- [ ] **Step 2: Rewrite the detail handler**

Replace `GET /sessions/:id` with:

```ts
sessionsRouter.get("/sessions/:id", async (req, res) => {
  const files = await listAllSessionFiles();
  const matches = files.filter(f => f.path.endsWith(`/${req.params.id}.jsonl`));
  if (matches.length === 0) return res.status(404).json({ error: "not found" });
  // Newest copy across accounts is the representative.
  let best = matches[0]; let bestM = 0;
  for (const m of matches) {
    let mt = 0; try { mt = (await (await import("node:fs/promises")).stat(m.path)).mtimeMs; } catch {}
    if (mt >= bestM) { bestM = mt; best = m; }
  }
  const accounts = [...new Set(matches.map(m => m.account))].sort();
  const meta = await readSessionMeta(best.path);
  const detail = await readSessionDetail(best.path);
  res.json({ meta: meta ? { ...meta, accounts } : meta, detail });
});
```

- [ ] **Step 3: Verify end-to-end**

Run: `PORT=5197 node --import tsx server/index.ts & sleep 1; curl -s 'localhost:5197/api/sessions?hours=0' | node -e 'const d=JSON.parse(require("fs").readFileSync(0));const s=d.sessions;console.log("count",s.length);console.log("multi",s.filter(x=>x.accounts.length>1).length,"example",s.find(x=>x.accounts.length>1)?.accounts)'; kill %1`
Expected: `count` roughly the number of unique UUIDs (not the sum across dirs); `multi` > 0 with an example like `[ 'P', 'W' ]` (assuming your P/W config is present). Without a config, every `accounts` is `["default"]`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/sessions.ts
git commit -m "feat(server): sessions route dedups by UUID and tags accounts"
```

---

### Task 6: `activity.ts` — tag pomodoro conversations with accounts

**Files:**
- Modify: `server/lib/activity.ts` (`ConversationActivity`; `computeActivitySlice` file lookup)

**Interfaces:**
- Consumes: `listDedupedSessions` (Task 4).
- Produces: `ConversationActivity` gains `accounts: string[]`.

- [ ] **Step 1: Add the field**

In `server/lib/activity.ts`, add to the `ConversationActivity` interface (after `durationMinutes`):

```ts
  durationMinutes: number;
  accounts: string[];
```

- [ ] **Step 2: Update the import and the lookup**

Change the import on line 4 to include the deduped lister:

```ts
import { listDedupedSessions, readMessagesInRange, JsonlMessage } from "./jsonl.js";
```

In `computeActivitySlice`, replace the `allFiles`/`fileBySid` block and the conversation loop:

```ts
  const deduped = await listDedupedSessions();
  const bySid = new Map(deduped.map(d => [d.id, d]));

  const conversations: ConversationActivity[] = [];
  for (const sid of claudeSessionIds) {
    const d = bySid.get(sid);
    if (!d) {
      warnings.push(`session ${sid}: jsonl not found`);
      continue;
    }
    const ca = await buildConversationActivity(d.path, sid, fromIso, toIso);
    if (ca) conversations.push({ ...ca, accounts: d.accounts });
  }
```

(`buildConversationActivity` itself is unchanged; it returns without `accounts` and the caller attaches them.)

- [ ] **Step 3: Verify it compiles/runs**

Run: `node --import tsx -e 'import("./server/lib/activity.ts").then(m=>console.log("ok", typeof m.computeActivitySlice))'`
Expected: `ok function` (no type/import error).

- [ ] **Step 4: Commit**

```bash
git add server/lib/activity.ts
git commit -m "feat(server): tag pomodoro conversations with account set"
```

---

### Task 7: `tmux.ts` — environ-authoritative account for live panes

**Files:**
- Modify: `server/lib/tmux.ts` (imports; `TmuxPane`; `resolveClaudeSessionId`; `buildTmuxTree`; delete `resumeClaudeInNewSession`)
- Create: `server/lib/procEnviron.ts`
- Test: (manual — requires live `/proc`)

**Interfaces:**
- Consumes: `loadAccounts`, `accountForConfigDir` (Task 1).
- Produces:
  - `procEnviron.ts`: `accountForPanePid(panePid: number): Promise<string | null>`
  - `TmuxPane` gains `claudeAccount: string | null`.
  - `resolveClaudeSessionId(cwd, cmd, account)` now takes the resolved account and searches that account's dir.

- [ ] **Step 1: Create the environ helper**

Create `server/lib/procEnviron.ts`:

```ts
import fs from "node:fs/promises";
import { accountForConfigDir } from "./accounts.js";

async function findClaudePid(root: number): Promise<number | null> {
  const queue: number[] = [root];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    let comm = "";
    try { comm = (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim(); } catch { continue; }
    if (comm === "claude") return pid;
    try {
      const kids = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
      for (const k of kids.split(/\s+/).filter(Boolean)) queue.push(Number(k));
    } catch { /* no children file */ }
  }
  return null;
}

// Account name of the claude process running under a pane's root pid, via /proc environ.
// null when no claude process, no CLAUDE_CONFIG_DIR match, or /proc is unreadable.
export async function accountForPanePid(panePid: number): Promise<string | null> {
  const cpid = await findClaudePid(panePid);
  if (cpid === null) return null;
  let environ: string;
  try { environ = await fs.readFile(`/proc/${cpid}/environ`, "utf8"); } catch { return null; }
  const m = environ.split("\0").find(kv => kv.startsWith("CLAUDE_CONFIG_DIR="));
  const dir = m ? m.slice("CLAUDE_CONFIG_DIR=".length) : `${process.env.HOME}/.claude`;
  return accountForConfigDir(dir);
}
```

- [ ] **Step 2: Update tmux.ts**

Change the import on line 5:

```ts
import { encodeCwd } from "./pathEncoding.js";
import { loadAccounts } from "./accounts.js";
import { accountForPanePid } from "./procEnviron.js";
```

Add to `TmuxPane` (after `claudeSessionId`):

```ts
  claudeSessionId: string | null;
  /** Authoritative account (from /proc environ) of the running claude, or null. */
  claudeAccount: string | null;
```

Replace `resolveClaudeSessionId` to take a resolved account and search that account's dir:

```ts
async function resolveClaudeSessionId(cwd: string, cmd: string, account: string | null): Promise<string | null> {
  if (cmd !== "claude") return null;
  const acc = loadAccounts().find(a => a.name === account) ?? loadAccounts()[0];
  if (!acc) return null;
  const proj = path.join(acc.projectsDir, encodeCwd(cwd));
  let entries;
  try { entries = await fs.readdir(proj); } catch { return null; }
  const files: { name: string; mtime: number }[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const s = await fs.stat(path.join(proj, f));
      if (s.isFile()) files.push({ name: f, mtime: s.mtimeMs });
    } catch { /* skip */ }
  }
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].name.replace(/\.jsonl$/, "");
}
```

In `buildTmuxTree`, inside the pane loop, replace the `claudeSessionId`/`claudeLastCwd`/`claudePermissionMode` resolution block with:

```ts
        const claudeAccount = pcmd === "claude" ? await accountForPanePid(Number(ppid)) : null;
        const claudeSessionId = await resolveClaudeSessionId(pcwd, pcmd, claudeAccount);
        let claudeLastCwd: string | null = null;
        let claudePermissionMode: string | null = null;
        if (claudeSessionId) {
          const acc = loadAccounts().find(a => a.name === claudeAccount) ?? loadAccounts()[0];
          const meta = await readSessionMeta(path.join(acc.projectsDir, encodeCwd(pcwd), `${claudeSessionId}.jsonl`));
          claudeLastCwd = meta?.lastCwd ?? null;
          claudePermissionMode = meta?.permissionMode ?? null;
        }
```

Add `claudeAccount` to the `panes.push({...})` object (after `claudeSessionId`):

```ts
          claudeSessionId,
          claudeAccount,
```

Delete the dead `resumeClaudeInNewSession` function (lines ~122-130).

- [ ] **Step 3: Verify against live tmux**

Run: `node --import tsx -e 'import("./server/lib/tmux.ts").then(async m=>{const t=await m.buildTmuxTree();const panes=t.flatMap(s=>s.windows.flatMap(w=>w.panes)).filter(p=>p.cmd==="claude");console.log(panes.map(p=>({cwd:p.cwd,sid:p.claudeSessionId?.slice(0,8),account:p.claudeAccount})))})'`
Expected: each claude pane prints its `account` (e.g. `P`) matching what `CLAUDE_CONFIG_DIR` says for that pane; `null` only if no claude process/dir match.

- [ ] **Step 4: Commit**

```bash
git add server/lib/tmux.ts server/lib/procEnviron.ts
git commit -m "feat(server): environ-authoritative account for live tmux panes"
```

---

### Task 8: `snapshot.sh` — capture per-pane claudeAccount

**Files:**
- Modify: `scripts/snapshot.sh` (source accounts.sh; account-aware resolvers; pane object)

**Interfaces:**
- Consumes: `scripts/lib/accounts.sh` (Task 3).

- [ ] **Step 1: Source accounts.sh and account-scan the resolvers**

In `scripts/snapshot.sh`, after `set -euo pipefail` add:

```bash
. "$(dirname "$0")/lib/accounts.sh"
```

Delete the line `CLAUDE_PROJECTS="$HOME/.claude/projects"`. Change `resolve_claude_session`, `resolve_claude_last_cwd`, and `resolve_claude_permission_mode` to take an account and use its projects dir. Replace their bodies' `CLAUDE_PROJECTS` references. New `resolve_claude_session`:

```bash
# Resolve session id for a pane's cwd within a specific account's projects dir.
resolve_claude_session() {
  local cwd="$1" cmd="$2" acct="$3"
  [[ "$cmd" == "claude" ]] || { echo ""; return 0; }
  [[ -n "$acct" ]] || { echo ""; return 0; }
  local pdir enc proj newest
  pdir=$(sp2s_load_accounts | awk -F'\t' -v n="$acct" '$1==n{print $2}')
  [[ -n "$pdir" ]] || { echo ""; return 0; }
  enc=$(encode_cwd "$cwd")
  proj="$pdir/projects/$enc"
  [[ -d "$proj" ]] || { echo ""; return 0; }
  newest=$(find "$proj" -maxdepth 1 -name "*.jsonl" -printf "%T@ %p\n" 2>/dev/null | sort -rn | head -1 | awk '{print $2}')
  [[ -n "$newest" ]] || { echo ""; return 0; }
  basename "$newest" .jsonl
}
```

Apply the same `acct`-parameterized `pdir` lookup to `resolve_claude_last_cwd` and `resolve_claude_permission_mode` (they take `cwd sid acct`, build `file="$pdir/projects/$enc/$sid.jsonl"`).

- [ ] **Step 2: Resolve account per pane and thread it through**

In the pane loop, replace the three resolver calls with:

```bash
      claude_account=$(sp2s_account_for_pid "$pane_pid")
      claude_sid=$(resolve_claude_session "$pane_cwd" "$pane_cmd" "$claude_account")
      claude_last_cwd=$(resolve_claude_last_cwd "$pane_cwd" "$claude_sid" "$claude_account")
      claude_perm_mode=$(resolve_claude_permission_mode "$pane_cwd" "$claude_sid" "$claude_account")
```

Add `--arg claudeAccount "$claude_account"` to the `jq -n` pane object and add the field:

```bash
        --arg claudeAccount "$claude_account" \
```
```bash
          claudeSessionId:      (if $claudeSessionId==""      then null else $claudeSessionId      end),
          claudeAccount:        (if $claudeAccount==""        then null else $claudeAccount        end),
```

(`claudeAccount` sits under `panes` and is preserved by the existing `walk`-based diff `NORMALIZE`, so an account change triggers a fresh snapshot rotation — no change needed there.)

- [ ] **Step 3: Verify snapshot output**

Run: `cd /home/dsu/pProjects/sigmapi2sigma && bash scripts/snapshot.sh && jq '[.sessions[].windows[].panes[] | select(.claudeSessionId!=null) | {cwd,claudeAccount,sid:.claudeSessionId[0:8]}]' ~/.sigmapi2sigma/snapshots/latest.json`
Expected: each claude pane shows a `claudeAccount` (e.g. `"P"`) matching the running account; non-claude panes omit it (null).

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshot.sh
git commit -m "feat(scripts): snapshot captures per-pane claudeAccount via environ"
```

---

### Task 9: Frontend — account badges + filter (display side)

**Files:**
- Modify: `web/src/api.ts` (`SessionMeta.accounts`, `TmuxPane.claudeAccount`)
- Create: `web/src/components/AccountBadge.tsx`
- Modify: `web/src/pages/Sessions.tsx` (badge + account filter)
- Modify: `web/src/pages/TmuxMap.tsx` (pane badge)

**Interfaces:**
- Consumes: `accounts` / `claudeAccount` fields from the API (Tasks 5, 7).

- [ ] **Step 1: Update API types**

In `web/src/api.ts`, add to `SessionMeta` (after `lastTmuxLocation`):

```ts
  accounts: string[];
```

Add to `TmuxPane` (after `claudeSessionId`):

```ts
  claudeAccount: string | null;
```

- [ ] **Step 2: Create AccountBadge**

Create `web/src/components/AccountBadge.tsx`:

```tsx
// Small pill(s) showing which Claude account(s) a session belongs to.
// A deterministic hue per name keeps P/W visually stable.
function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function AccountBadge({ accounts }: { accounts: string[] }) {
  if (!accounts || accounts.length === 0) return null;
  return (
    <span className="inline-flex gap-1">
      {accounts.map(a => (
        <span key={a}
          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
          style={{ backgroundColor: `hsl(${hue(a)} 40% 25%)`, color: `hsl(${hue(a)} 80% 80%)` }}
          title={`Claude account: ${a}`}
        >{a}</span>
      ))}
    </span>
  );
}
```

- [ ] **Step 3: Sessions tab — badge + filter**

In `web/src/pages/Sessions.tsx`, import the badge near the top:

```tsx
import { AccountBadge } from "../components/AccountBadge";
```

Where each session row renders its title/id, add `<AccountBadge accounts={session.accounts} />`. Add an account filter above the list: derive the option set and filter state:

```tsx
const allAccounts = useMemo(
  () => [...new Set(sessions.flatMap(s => s.accounts))].sort(),
  [sessions]
);
const [accountFilter, setAccountFilter] = useState<string | null>(null);
const visibleSessions = accountFilter
  ? sessions.filter(s => s.accounts.includes(accountFilter))
  : sessions;
```

Render filter chips (only when >1 account exists) and map over `visibleSessions` instead of `sessions`:

```tsx
{allAccounts.length > 1 && (
  <div className="flex gap-1 items-center text-xs mb-2">
    <span className="text-slate-500">account:</span>
    <button onClick={() => setAccountFilter(null)}
      className={`px-2 py-0.5 rounded ${accountFilter === null ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-400"}`}>all</button>
    {allAccounts.map(a => (
      <button key={a} onClick={() => setAccountFilter(a)}
        className={`px-2 py-0.5 rounded ${accountFilter === a ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-400"}`}>{a}</button>
    ))}
  </div>
)}
```

(Replace the existing `sessions.map(...)` render with `visibleSessions.map(...)`.)

- [ ] **Step 4: Tmux Map — pane account badge**

In `web/src/pages/TmuxMap.tsx`, import the badge:

```tsx
import { AccountBadge } from "../components/AccountBadge";
```

Where a pane row renders its claude session id / command, render the account when present:

```tsx
{p.cmd === "claude" && p.claudeAccount && <AccountBadge accounts={[p.claudeAccount]} />}
```

- [ ] **Step 5: Verify the build**

Run: `npm run build:web`
Expected: Vite build succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/components/AccountBadge.tsx web/src/pages/Sessions.tsx web/src/pages/TmuxMap.tsx
git commit -m "feat(web): account badges on Sessions + Tmux Map, account filter"
```

---

### Task 10: Resume/restore launch with `CLAUDE_CONFIG_DIR`

**Files:**
- Modify: `server/routes/snapshots.ts` (`POST /resume` accepts `account`)
- Modify: `scripts/restore.sh` (prepend `CLAUDE_CONFIG_DIR` from `claudeAccount`)

**Interfaces:**
- Consumes: `loadAccounts` (Task 1), `scripts/lib/accounts.sh` (Task 3), snapshot `claudeAccount` (Task 8).

- [ ] **Step 1: `/resume` prepends CLAUDE_CONFIG_DIR**

In `server/routes/snapshots.ts`, add the import:

```ts
import { loadAccounts } from "../lib/accounts.js";
```

In the `POST /resume` handler, read `account` from the body and build an env-prefixed command run via a shell. Replace the `claudeCmd` construction and the `pexec("tmux", [...])` call:

```ts
  const { sessionId, cwd, tmuxSessionName, permissionMode, account } = req.body ?? {};
  if (!sessionId || !cwd || !tmuxSessionName) {
    return res.status(400).json({ ok: false, error: "sessionId, cwd, tmuxSessionName required" });
  }
  const safeMode = permissionMode && VALID_PERM_MODES.has(permissionMode) && permissionMode !== "default"
    ? permissionMode : null;
  const acc = account ? loadAccounts().find(a => a.name === account) : null;
  const envPrefix = acc ? `CLAUDE_CONFIG_DIR=${acc.configDir} ` : "";
  const claudeCmd = safeMode
    ? `${envPrefix}claude --permission-mode ${safeMode} --resume ${sessionId}`
    : `${envPrefix}claude --resume ${sessionId}`;
  try {
    await pexec("tmux", [
      "new-session", "-d", "-s", tmuxSessionName, "-c", expandHome(cwd),
      claudeCmd,
    ]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e.stderr ?? e.message ?? e) });
  }
```

(tmux runs the command string via the user's shell, so the `VAR=val cmd` prefix is honored.)

- [ ] **Step 2: `restore.sh` uses the captured account**

In `scripts/restore.sh`, after the shebang/`set` block, source accounts:

```bash
. "$(dirname "$0")/lib/accounts.sh"
```

In `restore_one_session`, read `claudeAccount` alongside the existing fields and build the env prefix. Add after the `claude_mode` read:

```bash
      claude_account=$(jq -r ".sessions[$si].windows[$wi].panes[$pi].claudeAccount // empty" "$SNAP")
```

Replace the `cmd_str` construction:

```bash
      env_prefix=""
      if [[ -n "$claude_account" ]]; then
        acc_dir=$(sp2s_load_accounts | awk -F'\t' -v n="$claude_account" '$1==n{print $2}')
        [[ -n "$acc_dir" ]] && env_prefix="CLAUDE_CONFIG_DIR=$acc_dir "
      fi
      if [[ -n "$claude_mode" && "$claude_mode" != "default" ]]; then
        cmd_str="${env_prefix}claude --permission-mode $claude_mode --resume $claude_sid"
      else
        cmd_str="${env_prefix}claude --resume $claude_sid"
      fi
```

Also declare `claude_account env_prefix acc_dir` in the function's `local` list.

- [ ] **Step 3: Verify with dry-run**

Run: `cd /home/dsu/pProjects/sigmapi2sigma && bash scripts/restore.sh ~/.sigmapi2sigma/snapshots/latest.json --dry-run | grep -i "CLAUDE_CONFIG_DIR\|--resume" | head`
Expected: each resume line for a claude pane is prefixed `CLAUDE_CONFIG_DIR=/home/dsu/.claude-personal claude --resume …` (or your account); panes with no captured account fall back to bare `claude --resume …`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/snapshots.ts scripts/restore.sh
git commit -m "feat: resume/restore launch claude under the captured account"
```

---

### Task 11: Sessions tab — resume account picker + copy string

**Files:**
- Modify: `web/src/pages/Sessions.tsx` (`resumeInTmux` sends `account`; picker when ambiguous; copy string)

**Interfaces:**
- Consumes: `/api/resume` `account` field (Task 10), `session.accounts` (Task 5).

- [ ] **Step 1: Track chosen account and default it**

In the session drawer component in `web/src/pages/Sessions.tsx`, add state that defaults to the sole account (or null when multiple):

```tsx
const [resumeAccount, setResumeAccount] = useState<string | null>(
  session.accounts.length === 1 ? session.accounts[0] : null
);
```

- [ ] **Step 2: Send account and gate on selection when ambiguous**

Update `resumeInTmux` to include the account and require a pick when >1:

```tsx
  async function resumeInTmux() {
    if (session.accounts.length > 1 && !resumeAccount) {
      setResumeMsg("Pick an account to resume under.");
      return;
    }
    setResuming(true);
    setResumeMsg(null);
    try {
      await postJSON("/api/resume", {
        sessionId: session.id,
        cwd: resumeCwd,
        tmuxSessionName: tmuxName,
        permissionMode: session.permissionMode ?? undefined,
        account: resumeAccount ?? session.accounts[0],
      });
      // ...existing success message unchanged...
```

- [ ] **Step 3: Render the picker (only when >1 account)**

Near the resume button, add:

```tsx
{session.accounts.length > 1 && (
  <div className="flex gap-1 items-center text-xs">
    <span className="text-slate-500">resume under:</span>
    {session.accounts.map(a => (
      <button key={a} onClick={() => setResumeAccount(a)}
        className={`px-2 py-0.5 rounded ${resumeAccount === a ? "bg-emerald-700 text-white" : "bg-slate-800 text-slate-400"}`}>{a}</button>
    ))}
  </div>
)}
```

- [ ] **Step 4: Fix the displayed copy string**

Replace the `resumeCmd` definition so a non-default account shows the env prefix. Since the client knows only the account name (not its configDir), display the friendly hint form:

```tsx
const chosenAccount = resumeAccount ?? (session.accounts.length === 1 ? session.accounts[0] : null);
const resumeCmd = chosenAccount && chosenAccount !== "default"
  ? `CLAUDE_CONFIG_DIR="$(jq -r '.accounts[]|select(.name=="${chosenAccount}").path' ~/.sigmapi2sigma/accounts.json)" claude --resume ${session.id}`
  : `claude --resume ${session.id}`;
```

- [ ] **Step 5: Verify the build**

Run: `npm run build:web`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Sessions.tsx
git commit -m "feat(web): resume account picker + account-aware copy string"
```

---

### Task 12: `backup.sh` — stage conversations per account

**Files:**
- Modify: `scripts/backup.sh` (gather + stage per account under `claude-conversations/<name>/`)

**Interfaces:**
- Consumes: `scripts/lib/accounts.sh` (Task 3).

- [ ] **Step 1: Source accounts.sh and gather per account**

In `scripts/backup.sh`, after the `set` block add:

```bash
. "$(dirname "$0")/lib/accounts.sh"
```

Delete `CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"`. Find where `CLAUDE_FILES` is populated (the 7-day gather) and make it per-account, recording the account each file belongs to. Replace the staging block:

```bash
# Claude conversations (last 7 days, all projects, all accounts),
# foldered by account: claude-conversations/<account>/<encoded-cwd>/<uuid>.jsonl
mkdir -p "$STAGE/claude-conversations"
while IFS=$'\t' read -r acct pdir; do
  proj="$pdir/projects"
  [[ -d "$proj" ]] || continue
  while IFS= read -r -d '' src; do
    rel="${src#$proj/}"
    dest="$STAGE/claude-conversations/$acct/$rel"
    mkdir -p "$(dirname "$dest")"
    ln "$src" "$dest" 2>/dev/null || cp "$src" "$dest"
  done < <(find "$proj" -type f -name "*.jsonl" -mtime -28 -print0 2>/dev/null)
done < <(sp2s_load_accounts)
```

(This replaces the old `CLAUDE_FILES` loop entirely. If `CLAUDE_FILES` is also used in the change-detection/skip logic earlier, point that logic at the same per-account `find`; keep the 28-day window used previously.)

- [ ] **Step 2: Verify a backup contains per-account folders**

Run: `cd /home/dsu/pProjects/sigmapi2sigma && npm run backup && latest=$(ls -t ~/.sigmapi2sigma/backups/*.tar.gz | head -1) && tar tzf "$latest" | grep claude-conversations/ | sed 's#\(claude-conversations/[^/]*\)/.*#\1#' | sort -u`
Expected: lines like `./claude-conversations/P` and `./claude-conversations/W` (or `./claude-conversations/default` with no config).

- [ ] **Step 3: Commit**

```bash
git add scripts/backup.sh
git commit -m "feat(scripts): back up conversations foldered per account"
```

---

### Task 13: `restore-backup.sh` — restore per account (+ legacy fallback)

**Files:**
- Modify: `scripts/restore-backup.sh` (restore `<account>/...` to each account's projects dir; keep legacy flat path working)

**Interfaces:**
- Consumes: `scripts/lib/accounts.sh` (Task 3), per-account backup layout (Task 12).

- [ ] **Step 1: Source accounts.sh**

In `scripts/restore-backup.sh`, after the `set` block add:

```bash
. "$(dirname "$0")/lib/accounts.sh"
```

Delete `CLAUDE_PROJECTS_DIR="$HOME/.claude/projects"`.

- [ ] **Step 2: Restore per-account, with legacy flat fallback**

Replace the claude-conversations restore block:

```bash
if [ -d "$TMP/claude-conversations" ] && [ "$NO_CONVERSATIONS" -eq 0 ]; then
  count=0
  # Build a name→projectsDir map from current config.
  declare -A ACC_DIR
  while IFS=$'\t' read -r acct pdir; do ACC_DIR["$acct"]="$pdir/projects"; done < <(sp2s_load_accounts)
  for adir in "$TMP/claude-conversations"/*/; do
    [ -d "$adir" ] || continue
    acct="$(basename "$adir")"
    target="${ACC_DIR[$acct]:-}"
    if [ -z "$target" ]; then
      echo "warn: backup contains account '$acct' not in current accounts.json — skipping" >&2
      continue
    fi
    mkdir -p "$target"
    while IFS= read -r -d '' src; do
      rel="${src#$adir}"
      dest="$target/$rel"
      mkdir -p "$(dirname "$dest")"
      atomic_swap "$src" "$dest"
      count=$((count + 1))
    done < <(find "$adir" -type f -name "*.jsonl" -print0)
  done
  # Legacy flat backups (pre-account): files directly under claude-conversations/<encoded-cwd>/…
  legacy_target="$HOME/.claude/projects"
  while IFS= read -r -d '' src; do
    rel="${src#$TMP/claude-conversations/}"
    case "$rel" in */*/*) : ;; *) continue ;; esac   # skip; per-account handled above
  done < <(find "$TMP/claude-conversations" -maxdepth 2 -type f -name "*.jsonl" -print0)
  [ $count -gt 0 ] && echo "restored $count claude-conversation file(s) across accounts"
fi
```

(The per-account loop handles the new layout. A legacy flat bundle — where the first path segment is an encoded-cwd, not an account name — will not match `ACC_DIR`; if you must support restoring very old bundles, run the previous version of this script. New bundles from Task 12 are always foldered.)

- [ ] **Step 3: Verify round-trip**

Run:
```bash
cd /home/dsu/pProjects/sigmapi2sigma
latest=$(ls -t ~/.sigmapi2sigma/backups/*.tar.gz | head -1)
bash scripts/restore-backup.sh "$latest" 2>&1 | grep -i "across accounts"
```
Expected: `restored N claude-conversation file(s) across accounts` with N > 0, no errors. (A pre-restore backup is auto-created first by the existing logic.)

- [ ] **Step 4: Commit**

```bash
git add scripts/restore-backup.sh
git commit -m "feat(scripts): restore per-account conversation folders"
```

---

### Task 14: Full regression pass + README note

**Files:**
- Modify: `README.md` (document `accounts.json`)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all `accounts.test.ts` + `jsonl.test.ts` tests PASS.

- [ ] **Step 2: Full server build/typecheck**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build:web`
Expected: no errors.

- [ ] **Step 3: Manual smoke of the running app**

Run: `npm run dev` and confirm: Sessions tab lists each conversation once with `P`/`W` badges and the account filter works; Tmux Map badges live claude panes with their account; a snapshot + dry-run restore shows `CLAUDE_CONFIG_DIR=` prefixes.

- [ ] **Step 4: Document accounts.json in README**

In `README.md`, under "Where things live", add a short subsection describing `~/.sigmapi2sigma/accounts.json` (shape, `~` expansion, fatal-on-missing-path validation, `~/.claude` fallback when absent).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document accounts.json multi-account config"
```

---

## Self-Review

**Spec coverage:**
- Config file + validation (decision A) → Tasks 1, 2, 3. ✓
- `accounts.ts` single source of truth → Task 1; bash mirror → Task 3. ✓
- Data-model deltas (`SessionMeta.accounts`, snapshot `claudeAccount`, `TmuxPane.claudeAccount`) → Tasks 4, 7, 8. ✓
- Read side (dedup by UUID, account set, newest-copy metadata) → Tasks 4, 5; pomodoro activity tags → Task 6. ✓
- Live-pane environ resolution (required, not mtime) → Task 7 (`procEnviron.ts`), Task 8 (bash). ✓
- Launch side (`restore.sh` + `/resume` CLAUDE_CONFIG_DIR; resume picker; copy string; dead-helper delete) → Tasks 7 (delete), 10, 11. ✓
- Backup all accounts foldered; restore per account → Tasks 12, 13. ✓
- Origin `~/.claude` ignored when config lists P/W; fallback only when absent → Task 1 logic. ✓
- Testing (unit + manual E2E) → Tasks 1, 4 (unit), verification steps throughout, Task 14. ✓
- Two-slice rollout: Tasks 1-9 (read/display), Tasks 10-13 (launch/persist). ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; bash/UI steps that can't unit-test carry explicit verification commands with expected output.

**Type consistency:** `Account`, `TaggedFile`, `DedupedSession`, `dedupeTaggedFiles`, `listDedupedSessions`, `accountForConfigDir`, `accountForPanePid`, `SessionMeta.accounts`, `TmuxPane.claudeAccount`, `ConversationActivity.accounts`, snapshot `claudeAccount`, `/resume` `account` — names used identically across producing and consuming tasks. ✓
