# Remote access: reaching this machine over SSH while away

How a Windows laptop running sigmapi2sigma in WSL stays reachable over SSH from
another laptop or a phone for days, including after a restart that nobody logs in
after, such as a Windows update or a company-forced reboot.

There are three parts, each covering a different way to lose the connection:

| Way to lose it | What covers it |
|---|---|
| The laptop goes to sleep | Windows power settings ([1](#1-windows-power-keep-it-awake-on-ac)) |
| Tailscale is not connected, so the machine cannot be found | Tailscale inside WSL, checked at startup ([2](#2-tailscale-inside-wsl)) |
| A restart leaves Windows at the login screen and WSL never starts | The "WSL at boot" scheduled task ([3](#3-the-wsl-at-boot-scheduled-task)) |

## 1. Windows power: keep it awake on AC

Plugged in, with the lid open, the laptop must never sleep, hibernate or turn its
screen off. In an admin PowerShell:

```powershell
powercfg /change standby-timeout-ac 0     # sleep after: never
powercfg /change hibernate-timeout-ac 0   # hibernate after: never
powercfg /change monitor-timeout-ac 0     # turn off screen after: never
```

Check with `powercfg /query SCHEME_CURRENT SUB_SLEEP`. On AC, each "Current AC Power
Setting Index" should be `0x00000000`. Battery settings are not changed.

Notes:

- **Modern Standby.** Many recent laptops have no classic sleep, only "Modern
  Standby" (`powercfg /a` lists "Standby (S0 Low Power Idle)"). The event log
  records each entry and exit as Kernel-Power events 506 and 507, so
  `Get-WinEvent -FilterHashtable @{LogName='System'; Id=506,507}` shows when and why
  the machine went into standby.
- **Lid.** Closing the lid usually triggers standby even with "Do nothing" set,
  unless an external monitor is connected. Leave it open.
- **PowerToys Awake is not needed.** It also only runs after a login, so it would not
  help after a restart.
- **Lock screen.** A company policy may lock the screen when idle. Locking does not
  sleep the machine. To check before leaving, press Win+L, wait 10 minutes, then SSH in.

## 2. Tailscale inside WSL

A Windows laptop can end up with **two separate Tailscale installs** that know
nothing about each other:

| | Tailscale inside WSL (Ubuntu) | Tailscale Windows app |
|---|---|---|
| Account / tailnet | your personal one | for example a work tailnet |
| Machine name in that tailnet | the WSL host name | the Windows computer name |
| Starts | with WSL, as a systemd service | with Windows, as a Windows service |

**SSH goes through the WSL one.** `ssh <user>@<wsl-host-name>` from another device on
the personal tailnet reaches Ubuntu directly, where `sshd` runs (also a systemd
service). The Windows Tailscale is on a different tailnet, so it does not matter for
this, and both can run at the same time.

This needs `[boot] systemd = true` in `/etc/wsl.conf`, and both services enabled:

```bash
systemctl is-enabled tailscaled ssh   # both: enabled
tailscale status                      # this machine and your other devices
```

`autostart.sh` checks Tailscale every time it runs (`ensure_tailscale`):

- it waits up to 30 seconds for `tailscaled` to answer,
- if Tailscale was left `tailscale down`, it runs `tailscale up`,
- otherwise it logs what to run: `sudo tailscale up` when logged out, or
  `sudo systemctl restart tailscaled` when the daemon is not responding.

`tailscale up` without `sudo` works only after this one-time step:

```bash
sudo tailscale set --operator=$USER
```

## 3. The "WSL at boot" scheduled task

### The problem it solves

WSL is a small Linux virtual machine that Windows starts on demand and shuts down
once nothing is using it. Without this task, the only thing that starts it is the
login autostart: the `sigmapi2sigma.lnk` Startup shortcut opens Windows Terminal,
which runs `wsl.exe`. After a restart nobody logs in after, none of that happens.
WSL stays off, and so do `tailscaled` and `sshd`. The machine is unreachable until
someone logs in.

### What the task is

A Windows Task Scheduler task named **WSL at boot**:

| Field | Value | Why |
|---|---|---|
| Trigger | At system startup | Runs before any login, while Windows is at the login screen |
| Runs as | your Windows account, "whether user is logged on or not" | WSL distros belong to a user. Running as you starts *your* Ubuntu, the same one your terminals use |
| Program | `wsl.exe -d <distro> --exec <repo>/scripts/autostart.sh boot` | |
| Time limit | none (`ExecutionTimeLimit 0`) | The default 3-day limit would end it, and WSL with it |
| Battery | starts and keeps running on battery | |
| On failure | retried 5 times, 1 minute apart | |
| Window | none | It runs in the background |

To run with nobody logged in, Task Scheduler stores the account's **password** when
the task is registered. See [Password](#password) for the catch with fingerprint and
PIN sign-in.

### What `autostart.sh boot` does

All output goes to `~/.sigmapi2sigma/autostart.log`, with timestamps.

1. **Checks Tailscale** (`ensure_tailscale`, above).
2. **Restores tmux, if tmux is empty**, by running `scripts/restore.sh`. This is the
   same script the Restore button in the web app runs; the button is only a front
   end for it. Sessions are created detached (`tmux new-session -d`), so no terminal
   is needed. Claude conversations resume in their panes.
3. **Starts the app, if it is not already running** (`/api/health` on port 5174):
   `npm run dev` in the background, through `zsh -ic` so nvm's node is on PATH, with
   output to `~/.sigmapi2sigma/app.log`.
4. **`exec sleep infinity`**, so the task never finishes.

Why each step is the way it is:

- **Restore runs before the app, and does not go through it.** Calling the
  web app's Restore button would make the restore depend on node, npm and the port
  all working. The script alone has none of those dependencies, and the sessions are
  what matter most when connecting from elsewhere.
- **The app runs outside tmux.** `snapshot.sh` saves every tmux session. If the app
  ran in one, every snapshot would include it and a restore would bring it back as an
  idle shell. Stop it with `pkill -f "concurrently.*dev:server"`.
- **`sleep infinity` keeps WSL alive.** WSL shuts the VM down a little after the
  last process started through `wsl.exe` exits. `tmux`, `tailscaled` and `sshd`
  do not count, because they were not started that way. The task's `wsl.exe` is
  still running `sleep`, so WSL, and with it Tailscale and SSH, stays up. This also
  means closing Windows Terminal no longer shuts WSL down.

### How the two startups fit together

There is only one Ubuntu. The task and your terminals share it, as the same user.

**Restart, nobody logs in:**

```
Windows starts ─► task runs autostart.sh boot ─► Tailscale ✓  tmux restored ✓  app ✓
                                                └─► sleep infinity (keeps WSL up)
login screen … you SSH in from elsewhere ─► tmux attach
```

**A normal day, you log in:**

```
Windows starts ─► task: same as above, before you reach the login screen
you log in ─► Startup shortcut opens Windows Terminal:
                tab 1  autostart.sh app       app already running → prints that, gives a shell
                                              (app output: tail -f ~/.sigmapi2sigma/app.log)
                tab 2  autostart.sh sessions  tmux has sessions → skips restore, attaches
```

The only visible difference from before the task is that the app's output is in
`app.log` instead of tab 1. Running the task again by hand is also safe: tmux has
sessions and the app is up, so it only logs and sleeps.

### Install, check, remove

From WSL, in the repo:

```bash
npm run install-boot-task               # UAC prompt, then asks for the Windows password
npm run install-boot-task -- -DryRun    # only print what it would register
npm run uninstall-boot-task             # remove the task
```

`install-boot-task` opens an elevated PowerShell running `scripts/boot-task.ps1`.
The script tries the account names Task Scheduler is likely to accept, registers the
task, starts it once, and reports. Re-running it replaces the task, for example
after a password change.

To check it from an admin PowerShell:

```powershell
Get-ScheduledTaskInfo "WSL at boot" | Format-List LastRunTime,LastTaskResult
```

| LastTaskResult | Meaning |
|---|---|
| `267009` (0x41301) | Running. This is the expected state, since the task ends in `sleep infinity` |
| `267011` (0x41303) | Has not run yet |
| `0` | It finished, which it should not. Check the end of `autostart.log` |
| `2147943726` (0x8007052E) | Logon failure: wrong password or account name. See [Password](#password) |

### Test it before relying on it

A run while logged in only shows that the task starts. The case that matters is the
restart:

1. Restart Windows and **do not log in**. Wait about 3 minutes.
2. From another device on the tailnet:
   ```bash
   ssh <user>@<wsl-host-name>
   tmux ls                                    # restored sessions
   curl -s 127.0.0.1:5174/api/health          # {"ok":true}
   tail -5 ~/.sigmapi2sigma/autostart.log     # "boot: started" at the restart time
   ```
3. Log in normally and check that both Windows Terminal tabs behave as described above.

## Password

The task logs on with the password stored when it was registered, so:

- **Use the password this PC's lock screen accepts**, typed with the password
  sign-in option (key icon), not the fingerprint or PIN. Windows checks the task's
  password the same way the lock screen does.
- **With fingerprint or PIN sign-in, that may not be your current password.** Windows
  keeps a local copy of the password for offline sign-in and only updates it when the
  password is *typed* on that PC. With an organization-managed (Entra ID) account,
  one PC can go on accepting an old password while another accepts the new one. If
  the lock screen rejects the current password, use the one it accepts, and ask IT
  about the mismatch.
- **Entra ID accounts** are usually accepted only as `AzureAD\<email>`.
  `boot-task.ps1` tries that first, then `DOMAIN\name`.
- **When the password changes** (or the PC starts accepting the new one), the task
  can no longer log on. `LastTaskResult` shows a logon failure, and SSH does not come
  back after the next restart. Run `npm run install-boot-task` again.

## Not covered

- **BitLocker with a pre-boot PIN.** If the PC asks for a PIN before Windows loads,
  nothing can bring it back remotely after a restart. Check with
  `manage-bde -status C:` (admin). TPM-only protection is fine.
- **The lid closed** without an external monitor (see [1](#1-windows-power-keep-it-awake-on-ac)).
- **Leaving the network,** or a power cut longer than the battery lasts.
- **Scrollback and running programs** are not restored, only the sessions, windows,
  panes, their folders and Claude conversations (see the main README).

## Troubleshooting

| Symptom | Look at |
|---|---|
| SSH times out after a restart | Log in and check `LastTaskResult`. Then `~/.sigmapi2sigma/autostart.log`: no `boot: started` line means the task did not start WSL |
| `boot: started`, but Tailscale not online | The `tailscale:` line names the fix |
| SSH works but tmux is empty | The `restore.sh` output just after `boot: started` in `autostart.log` |
| The app is not answering | `tail -50 ~/.sigmapi2sigma/app.log` |
| The machine went into standby | Kernel-Power events 506 and 507 (section 1) |
