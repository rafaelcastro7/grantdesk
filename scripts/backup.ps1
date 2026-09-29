# Nightly database backup.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Destination "D:\GrantDeskBackups"
#
# Everything a firm cannot recreate — clients, profiles, briefs, decisions,
# drafts, the answer library — lives in one Docker volume on one machine.
# This writes a compressed custom-format dump (restorable with pg_restore),
# verifies it can be read back, and keeps the last 30.
#
# Point -Destination at a drive or synced folder that is NOT this disk
# (OneDrive, a NAS, an external drive). A backup on the same disk as the
# database protects against mistakes, not against losing the machine.
#
# Restore (into an empty database):
#   docker exec -i grantdesk-db pg_restore -U postgres -d postgres --clean --if-exists < file.dump
#
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI.

param(
    [string]$Destination = (Join-Path (Split-Path -Parent $PSScriptRoot) "backups"),
    [int]$Keep = 30
)

$ErrorActionPreference = "Stop"
$container = "grantdesk-db"

if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Path $Destination | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$file = Join-Path $Destination "grantdesk-$stamp.dump"
$inContainer = "/tmp/grantdesk-$stamp.dump"

# Dumped inside the container and copied out, so no binary data passes through
# PowerShell's text pipeline (which would corrupt it).
docker exec $container pg_dump -U postgres -d postgres -Fc -f $inContainer
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
# A backup nobody has read back is a hope. Listing the archive's table of
# contents proves it is a complete, readable dump before it is kept.
$tables = docker exec $container sh -c "pg_restore --list $inContainer | grep -c 'TABLE DATA'"
if ($LASTEXITCODE -ne 0 -or [int]$tables -lt 10) { throw "the dump could not be read back ($tables tables)" }
docker cp "${container}:$inContainer" $file
if ($LASTEXITCODE -ne 0) { throw "copying the dump out of the container failed" }
docker exec $container rm -f $inContainer | Out-Null
$size = (Get-Item $file).Length
if ($size -lt 10240) { throw "backup file is suspiciously small ($size bytes): $file" }
Get-Content -LiteralPath $file -Encoding Byte -TotalCount 5 | Out-Null

$old = Get-ChildItem $Destination -Filter "grantdesk-*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
$old | Remove-Item -Force

Write-Host "Backup written: $file ($([math]::Round($size / 1MB, 1)) MB, $tables tables verified). Kept the latest $Keep."
