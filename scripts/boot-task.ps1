<#
Register or remove the "WSL at boot" scheduled task. At Windows startup, before
anyone logs in, it runs `autostart.sh boot` in WSL, so a machine restarted with
nobody at it is still reachable over SSH. See docs/remote-access.md.

Normally run through `npm run install-boot-task` / `npm run uninstall-boot-task`,
which open this in an elevated PowerShell. Registering asks for the account's
Windows password: Task Scheduler stores it to run the task with nobody logged in.
Kept to ASCII, since Windows PowerShell 5.1 reads a BOM-less script as ANSI.
#>
param(
  [Parameter(Mandatory)][string]$Distro,
  [Parameter(Mandatory)][string]$Script,
  [string]$TaskName = "WSL at boot",
  [switch]$Uninstall,
  [switch]$DryRun,
  [switch]$Pause
)
$ErrorActionPreference = "Stop"

function Finish([int]$code) {
  if ($Pause) { Read-Host "Press Enter to close" | Out-Null }
  exit $code
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
  Write-Host "This needs an elevated (admin) PowerShell."
  Finish 1
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed task '$TaskName'. WSL keeps running until Windows restarts or 'wsl --shutdown'."
  } else {
    Write-Host "No task '$TaskName' to remove."
  }
  Finish 0
}

# Task Scheduler wants the account in a form it can log on with. Entra ID (Azure AD)
# accounts are usually accepted only as AzureAD\<email>, not as AzureAD\<short name>;
# local and domain accounts as DOMAIN\name. Try the likely forms in order.
$users = @()
$upn = $null
try { $upn = (whoami.exe /upn 2>$null | Out-String).Trim() } catch { }
if ($upn -and $upn -like "*@*") {
  if ($env:USERDOMAIN -eq "AzureAD") { $users += "AzureAD\$upn" } else { $users += $upn }
}
$users += "$env:USERDOMAIN\$env:USERNAME"

$wslArgs = "-d $Distro --exec $Script boot"
if ($DryRun) {
  Write-Host "Task:      $TaskName (at startup, whether or not anyone is logged in)"
  Write-Host "Runs:      $env:WINDIR\System32\wsl.exe $wslArgs"
  Write-Host "Logon as:  $($users -join '  or  ')"
  Finish 0
}

$action   = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument $wslArgs
$trigger  = New-ScheduledTaskTrigger -AtStartup
# ExecutionTimeLimit 0 = no limit: the default (3 days) would end the task and, with
# it, the `sleep infinity` that keeps WSL up.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

Write-Host "Enter the password this PC's lock screen accepts for your account (not the PIN)."
Write-Host "If you sign in with a fingerprint or PIN, that can be an older password than your current one."
$cred = Get-Credential -UserName $users[0] -Message "Windows password (not PIN) for the boot task"
if (-not $cred) { Write-Host "Cancelled."; Finish 1 }
$password = $cred.GetNetworkCredential().Password

$registeredAs = $null
foreach ($u in $users) {
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -User $u -Password $password -RunLevel Limited -Force | Out-Null
    $registeredAs = $u
    break
  } catch {
    Write-Host "Not accepted as ${u}: $($_.Exception.Message)"
  }
}
$password = $null
if (-not $registeredAs) {
  Write-Host "Could not register the task. See 'Troubleshooting' in docs/remote-access.md."
  Finish 1
}
Write-Host "Registered '$TaskName' as $registeredAs."

# Run it now as a check. 267009 (0x41301) means "currently running", which is the
# expected state: the task ends in `sleep infinity` and never finishes on its own.
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
$result = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult
if ($result -eq 267009) {
  Write-Host "Started OK (running). Now test a real restart without logging in."
  Finish 0
}
Write-Host ("Task did not stay running: LastTaskResult {0} (0x{0:X}). See docs/remote-access.md." -f $result)
Finish 1
