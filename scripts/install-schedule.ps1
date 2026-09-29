# Register the hourly catalog refresh with Windows Task Scheduler.
#
# Run this once, from an ordinary (non-elevated) prompt:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
#
# It is not run for you, because registering a scheduled task changes the
# machine rather than the repository, and that is the operator's decision.
#
# Hourly is deliberate even though the fastest source has a 24-hour cadence:
# `bun run refresh` decides for itself what is due and exits in under a second
# when nothing is. The schedule stays fixed while the cadences live with the
# adapters that own them, so adding a source never means editing this file.
#
# ASCII only, on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI, and an
# accented character in a comment is enough to corrupt the parse.

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$taskName = "GrantDesk catalog refresh"
$logDir = Join-Path $repo "logs"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
    Write-Error "bun is not on PATH. Install it, or edit this script to use its full path."
}

# Output is redirected rather than discarded: a refresh that has been failing
# every hour is exactly the thing nobody notices, and the log is where the
# answer lives when someone finally asks.
$logFile = Join-Path $logDir "refresh.log"

# Run through cmd.exe, not PowerShell. PowerShell turned bun's ordinary stderr
# (its "$ bun run" echo) into a NativeCommandError, so every run reported
# result 1 and the task's status could not be used to notice real failures.
# cmd passes bun's own exit code through unchanged.
$action = New-ScheduledTaskAction -Execute "cmd.exe" `
    -Argument "/c `"`"$bun`" run refresh >> `"$logFile`" 2>&1`"" `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Hours 1)

# Limited rather than Highest: nothing here needs administrator rights, and a
# scheduled task that runs elevated for no reason is a standing risk.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

# Registering is not the same as being registered. Confirm it, because a silent
# no-op here means the catalog quietly stops being refreshed.
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $registered) {
    Write-Error "Registration reported success but the task is not there."
}

Write-Host "Registered '$taskName', hourly."
Write-Host "  Log:    $logFile"
Write-Host "  Remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host ""
Write-Host "Check what it is doing at any time with: bun run doctor"
