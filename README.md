<div align="center">

# ΣΠ ∪ ΠΣ

### *sigmapi2sigma*

**Track the way you actually work.**
Parallel streams. AI side-by-side. Local-first.

</div>

---

## The idea

```
                            ┌──────────────────┐
            "what got        │   Σ Π   ∪   Π Σ  │     "what i'm doing
             done today"    │                  │      right now"
                ◀─────────  │ Sum of Products  │  ─────────▶
                            │ ∪ Products of    │
            project totals  │   Sums           │  per-task / per-pane
            calendar view   │                  │  live timer / tmux
                            └──────────────────┘
```

Modern knowledge work is **parallel**. You have three tabs open with different AI conversations. Two tmux sessions for two projects. Five half-finished tasks across them. Time slips through the cracks.

`sigmapi2sigma` is two complementary views of that mess, mathematically inspired:

- **Σ Π** — a *sum of products*: the calendar / project totals. Every project's time is a sum of contributions from tasks (the products). Look back, see where weeks went.
- **Π Σ** — a *product of sums*: any single output (a Pomodoro, a Claude conversation, a shell command) emerges from a combination of project + task + pane + moment. Look forward, plan in chunks.

Same data, two angles. The union is your workspace.

---

## What you can do

| | |
|---|---|
| 🧭 **Projects** | Long-running pursuits with optional task breakdowns. Each project is bijectively bound to a tmux session by name — your tools and your concept of work converge. |
| ✅ **Tasks** | Short units inside projects. Pomodoros can target multiple tasks across multiple projects (real life is multitasking — even with one person, AI tools mean you wait, and pivot). |
| 🍅 **Pomodoros** | Live timer with rest cycle, configurable start/end beep, persisted across browser refresh. Tab title shows remaining time. Notes prompted after stop. |
| 📅 **Calendar** | Year heatmap (GitHub-contribution-style) and month grid. Filter by project. Click any day → all that day's pomodoros, click any pomodoro → its conversations + commands. |
| 🖥️ **Tmux Map** | Live view of every tmux session, window, pane. Panes running an AI assistant are highlighted distinctly. Snapshot the state every 5 minutes; restore after a crash. |
| 🧠 **AI conversation tracking** | When a pane is running an AI CLI that writes session logs (current implementation: [Claude Code](https://github.com/anthropics/claude-code)), the relevant logs are surfaced inline — you see *which conversations* you had during *which pomodoro*. |
| 📜 **Shell history** | Optional per-pane preexec hook captures every command run inside tmux. Joined to pomodoros so you can see "during this pomodoro I ran these 12 commands in this pane". |
| 💾 **Backups** | Local rotated `.tar.gz` backups every 30 minutes (cron), optionally synced to any cloud (Google Drive, Dropbox, S3, …) via [rclone](https://rclone.org). Smart skip when nothing changed. |
| 🎨 **Yours, beautifully** | Custom project colors, abbreviations (`InvPre › prep slides`), tags. Tailwind-themed dark UI. Single-user, local-only, no telemetry. |

---

## Tech

- **Backend** — Node + Express + TypeScript via [`tsx`](https://tsx.is/), serving a tiny REST API (~10 routes). Storage: atomically-written JSON files. No database, no server processes apart from the dev server itself. Listens only on `127.0.0.1`.
- **Frontend** — Vite + React 19 + Tailwind. One SPA, seven tabs.
- **Periodic jobs** — User crontab (snapshot tmux every 5 min, backup every 30 min, weekly history prune). Runs even when the dev server is off.
- **Optional cloud sync** — `rclone sync` after each backup. Same retention policy applied locally and remotely.
- **Conversation reading** — Read-only access to AI CLI session logs (currently Claude Code's `~/.claude/projects/**/*.jsonl`). Never modifies them.

---

## Quick start

```bash
git clone https://github.com/<you>/sigmapi2sigma.git
cd sigmapi2sigma
npm install
npm run dev
```

Open http://127.0.0.1:5173.

To enable cron-driven snapshots + backups (recommended):

```bash
npm run install-cron
```

To enable per-tmux-pane shell history capture:

```bash
npm run install-shell-hook
```

To set up cloud backup mirroring (one-time):

```bash
sudo -v ; curl https://rclone.org/install.sh | sudo bash    # rclone ≥ 1.62 required
rclone config                                                # add a remote, e.g. "gdrive"
mkdir -p ~/.sigmapi2sigma
echo 'BACKUP_REMOTE=gdrive:Backups/sigmapi2sigma' > ~/.sigmapi2sigma/backup-config
```

The full rclone walkthrough — including the WSL2 OAuth gotcha — is in the troubleshooting section below.

---

## Where things live

```
~/.sigmapi2sigma/                    runtime data (NOT in the repo)
├── projects.json                    long-running projects (with optional tmux binding)
├── tasks.json                       short tasks under projects
├── assignments.json                 tmux session name ↔ project id
├── pomodoros.json                   raw timestamped pomodoro records
├── settings.json                    workday hours, beep sounds, durations
├── accounts.json                    optional: which Claude config dir(s) to read (see below)
├── snapshots/{latest,prev*}.json    rotated tmux snapshots (every 5 min)
├── shell-history/YYYY-MM-DD.jsonl   per-day shell command log (60-day retention)
├── backups/sigmapi2sigma-*.tar.gz   periodic backups (rotated)
└── backup-config                    optional: BACKUP_REMOTE=...

~/.claude/projects/-encoded-cwd/     AI CLI conversation logs (read-only)
```

The repo itself contains only code — your data is yours, lives outside the repo, and travels via backup files.

### Multi-account Claude config (`accounts.json`)

Tells sigmapi2sigma which Claude config dir(s) — `CLAUDE_CONFIG_DIR` — to read conversation logs from, and what to badge each one as in the UI.

```json
{
  "accounts": [
    { "name": "P", "path": "~/.claude-personal", "launcher": "claudep" },
    { "name": "W", "path": "~/.claude-work",     "launcher": "claudew" }
  ]
}
```

`~` expands to `$HOME`. `path` is the Claude config dir; conversations live at `path/projects/`.

If the file is absent, sigmapi2sigma falls back to a single `default` account at `~/.claude` — zero-config, works out of the box on a machine with only one Claude account. If the file is present but a listed `path` doesn't exist, the server refuses to start.

A conversation shared across accounts (same UUID logged under multiple config dirs) shows up once in the Sessions list, badged with every account it appears under. Resuming a multi-account session prompts which account to launch under.

#### `launcher` (optional)

The shell command that launches Claude under this account — typically a function from your shell rc:

```sh
claudep() { CLAUDE_CONFIG_DIR="$HOME/.claude-personal" CLAUDE_ACCOUNT=personal command claude "$@"; }
claudew() { CLAUDE_CONFIG_DIR="$HOME/.claude-work"     CLAUDE_ACCOUNT=work     command claude "$@"; }
```

When set, restore and resume invoke it (`claudew --resume <id>`). When unset, they fall back to prefixing the config dir (`CLAUDE_CONFIG_DIR=… claude --resume <id>`).

Both forms select the same account, but they are **not** equivalent in one respect: only the launcher sets `CLAUDE_ACCOUNT`. Anything keyed on that variable — notably a statusline showing which account a pane is on — renders nothing under the fallback, so a correctly-configured pane can look unmarked. Setting `launcher` keeps restored panes identical to hand-launched ones.

Because the value is typed into a live shell, it must be a bare command word (`[A-Za-z_][A-Za-z0-9_.-]*`); anything with whitespace or shell metacharacters is rejected at startup. It must also name something that resolves in an **interactive** shell — a shell function is fine, since restore and resume both send keystrokes to a real pane rather than exec'ing directly.

### Pane bindings (`pane-bindings.jsonl`)

Nothing on disk links a tmux pane to a Claude conversation. Without help, sigmapi2sigma can only guess by taking the most recently modified transcript in the project directory — which returns **the same answer for every pane in that directory**. With one conversation per directory that guess is right; with two (say a checker and an implementer), both panes get labelled with one conversation and a restore silently drops the other.

The fix is a `SessionStart` hook that records the binding from the one place that knows it — Claude reports its own `session_id`, tmux reports `TMUX_PANE`:

```
~/.sigmapi2sigma/pane-bindings.jsonl     append-only, one JSON object per line
  ts, source, sessionId, transcriptPath, paneId,
  tmuxSession, windowIndex, paneIndex, cwd, configDir
```

**sigmapi2sigma only reads this file.** The writer is `sp2s-bind.sh`, installed from the dotfiles repo (`dotfiles/claude/sp2s-bind.sh` + `setup_hooks` in its `install.sh`). Treat the field list above as a contract between the two repos.

Key properties:

- **Joined on `paneId`** (tmux `%N`) — stable for the life of a pane and immune to window renumbering. It only resets when the tmux server restarts, at which point every Claude process has died anyway, so stale bindings are moot.
- **Last line wins**, by file order rather than `ts`. The log is append-only so later lines are newer, and clocks are not reliably monotonic (WSL jumps on suspend/resume).
- **Re-fires on `/clear`, `resume`, `compact` and `fork`**, so the binding follows the pane. This is why an inherited environment variable is not enough: `CLAUDE_CODE_SESSION_ID` is exported to child processes at launch and goes stale the moment `/clear` starts a new conversation in the same process.

Without the hook everything still works — resolution falls back to mtime, and panes report `claudeSessionSource: "mtime"` so the UI can mark the value as a guess rather than present it as fact. Panes running from before the hook was installed bind themselves on their next start, `/clear` or compaction.

---

## Backup retention

```
≤ 24 h        keep all (≈48 backups at 30-min intervals)
1–30 days     keep one per day
30–365 days   keep one per month
> 1 year      delete
```

Same policy applied to the cloud mirror. Manually triggered backups (`npm run backup` or "Backup now" in the UI) always create a fresh bundle; the scheduled cron run skips when no source file has changed.

---

## Restoring from a backup

From the UI: Snapshots tab → Backups → click "Restore" on any bundle. A pre-restore backup of your current state is automatically created first.

From the terminal:

```bash
npm run restore-backup ~/.sigmapi2sigma/backups/sigmapi2sigma-2026-05-04-145922.tar.gz
```

You can pull a backup down from the cloud first if needed:

```bash
rclone copy gdrive:Backups/sigmapi2sigma/<file>.tar.gz ~/.sigmapi2sigma/backups/
```

---

## rclone — full setup notes

`rclone` is used to mirror local backups to any cloud you can name. It's optional. If you skip it, backups stay local-only.

### Version

Need **rclone ≥ 1.62**. Older versions use the OAuth out-of-band flow which Google [blocked in early 2023](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration). Distro packages (Ubuntu/Debian apt) usually ship a much older version. Use the official installer:

```bash
sudo -v ; curl https://rclone.org/install.sh | sudo bash
rclone version       # verify ≥ 1.62
```

### Configure

```bash
rclone config
```

Pick `n` (new remote), name it (e.g. `gdrive`), choose your storage backend, then for Google Drive:

| Prompt | Answer |
|---|---|
| `client_id>` | press Enter (use shared key) |
| `client_secret>` | press Enter |
| `scope>` | `3` (`drive.file` — least privilege; rclone only sees files it created) |
| `root_folder_id>` | press Enter (this is a Drive folder ID, not a path; the path goes in `BACKUP_REMOTE`) |
| `service_account_file>` | press Enter |
| `Edit advanced config?` | `n` |
| `Use auto config?` | `n` if WSL2 / headless |
| `Configure as a Shared Drive?` | `n` (Workspace teams only; personal Gmail accounts don't have any) |

When you pick `n` for auto config, rclone prints a `rclone authorize "drive" "<token>"` command. Run it in a second terminal — rclone starts a local web server on port 53682 and waits. If your default browser doesn't open automatically, manually paste the printed URL into a Windows browser (WSL2 forwards localhost). Sign in, click Allow, copy the JSON token blob it prints, paste it back at the `config_token>` prompt in the first terminal.

### Tell sigmapi2sigma which remote to use

```bash
echo 'BACKUP_REMOTE=gdrive:Backups/sigmapi2sigma' > ~/.sigmapi2sigma/backup-config
```

Format: `<rclone-remote-name>:<path>`. The path is created on first sync; don't pre-create it manually under `drive.file` scope.

### Verify

```bash
npm run backup
rclone ls gdrive:Backups/sigmapi2sigma
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error 400: invalid_request` ("OOB flow has been blocked") | rclone < 1.62 | upgrade with the official installer |
| `didn't find section in config file` | `rclone config` aborted before saving | re-run, complete the wizard, confirm `y` at summary, `q` to quit |
| Files missing in Drive web UI but `rclone ls` shows them | `drive.file` scope hides them from default browse | search by name in Drive UI, or switch to full `drive` scope (re-run `rclone config`) |
| Folder appears twice in Drive | typed a path into `root_folder_id` | re-run `rclone config`, leave `root_folder_id` blank |

---

## Design choices

- **Local-only**. No accounts, no telemetry, no third-party servers. The server binds to `127.0.0.1`.
- **JSON over SQLite**. Data is small (`<10 MB/year` in normal use). Atomic writes via tmp + rename. Easier to inspect, hand-edit if needed, and back up.
- **Names as identities**. tmux session names are stable; pane IDs and pids reset on every tmux restart. Anything that must survive a crash is keyed by name.
- **Time-attribution that adds up**. A pomodoro on `[AI/playlist, AI/build, Math/paper]` is split into 3 equal units. AI's total = sum of its task units. Math's total = its task unit. Project totals always match the sum of their tasks.
- **Cron stays in charge**. Periodic jobs run system-side, independent of whether the UI is open. The UI is for *seeing and steering*, not for keeping the lights on.

---

## Out of scope (for now)

- Multi-user / multi-machine sync (the local-only design is intentional)
- Integrations with issue trackers (Linear, Jira, GitHub Issues) — pomodoros stay loose
- Mobile UI
- Pane-level task assignment (currently a project's whole tmux is treated as one workspace; per-pane→task scoping is a planned `Stage F`)
- Hierarchical projects / project tags as a taxonomy

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

*Σ Π ∪ Π Σ.*
*A workshop for the way modern work actually happens.*

</div>
