# Register the nightly database backup with Windows Task Scheduler.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-schedule.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-backup-schedule.ps1 -Destination "D:\GrantDeskBackups"
#
# Defaults to a folder inside OneDrive when OneDrive is present, so every dump
# is also copied off this machine by the OneDrive client. Runs daily at 02:30
# and catches up after the machine was asleep or off.
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI.

param([string]$Destination = "")

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$taskName = "GrantDesk nightly backup"

if (-not $Destination) {
    if ($env:OneDrive -and (Test-Path $env:OneDrive)) {
        $Destination = Join-Path $env:OneDrive "GrantDesk backups"
    } else {
        $Destination = Join-Path $repo "backups"
        Write-Warning "OneDrive not found: backups stay on this disk. Pass -Destination to copy them elsewhere."
    }
}
if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Path $Destination | Out-Null }

$logDir = Join-Path $repo "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "backup.log"
$script = Join-Path $PSScriptRoot "backup.ps1"

# cmd.exe wrapper so the task records powershell's real exit code.
$action = New-ScheduledTaskAction -Execute "cmd.exe" `
    -Argument "/c powershell -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Destination `"$Destination`" >> `"$logFile`" 2>&1" `
    -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At "02:30"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Write-Error "Registration reported success but the task is not there."
}
Write-Host "Registered '$taskName', daily at 02:30."
Write-Host "  Backups: $Destination"
Write-Host "  Log:     $logFile"
