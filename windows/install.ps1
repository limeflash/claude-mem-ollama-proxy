<#
.SYNOPSIS
    Install the claude-mem Ollama proxy as a per-user scheduled task and point
    claude-mem at it.

.DESCRIPTION
    Windows has no launchd, so autostart is a Scheduled Task with an "at logon"
    trigger. The task runs under the current user, needs no admin rights, and
    restarts the proxy if it stops.

.EXAMPLE
    .\windows\install.ps1
    .\windows\install.ps1 -Model "gpt-oss:120b" -Port 11500
#>
[CmdletBinding()]
param(
    [int]$Port = 11435,
    [string]$Model = "deepseek-v4.1-flash"
)

$ErrorActionPreference = "Stop"

$TaskName = "claude-mem-ollama-proxy"
$Dest     = Join-Path $env:USERPROFILE ".claude-mem-proxy"
$Settings = Join-Path $env:USERPROFILE ".claude-mem\settings.json"
$RepoRoot = Split-Path -Parent $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "node not found on PATH. Install Node.js 18+ from https://nodejs.org" }
if (-not (Test-Path $Settings)) { throw "$Settings not found - run 'npx claude-mem install' first" }

Write-Host "==> installing proxy to $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
# Every runtime module, tests excluded — see the note in macos/install.sh.
Get-ChildItem -Path $RepoRoot -Filter *.js -File |
    Where-Object { $_.Name -notlike "test-*" } |
    ForEach-Object { Copy-Item $_.FullName (Join-Path $Dest $_.Name) -Force }

# A small launcher keeps the env vars and the log redirect in one place, so the
# scheduled task itself stays a plain "run this script" entry.
$launcher = Join-Path $Dest "run-proxy.cmd"
@"
@echo off
set CMP_PORT=$Port
set CMP_UPSTREAM=ollama.com
set CMP_REASONING_EFFORT=none
"$($node.Source)" "$Dest\proxy.js" >> "$Dest\proxy.log" 2>&1
"@ | Set-Content -Path $launcher -Encoding ASCII

# Running the .cmd directly gives the task a console window the user can focus
# and Ctrl+C -- which kills the proxy while the claude-mem worker keeps
# reporting healthy, so memory generation fails silently against a closed port.
# This shim starts the same launcher with the window hidden, and refuses to
# start a second instance if the port is already served.
$starter = Join-Path $Dest "start-proxy.ps1"
@"
`$ErrorActionPreference = 'SilentlyContinue'
try { `$null = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop; exit 0 } catch { }
Start-Process -FilePath "`$env:ComSpec" -ArgumentList '/c', '"$launcher"' -WindowStyle Hidden
"@ | Set-Content -Path $starter -Encoding ASCII

Write-Host "==> registering scheduled task '$TaskName'"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
                -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$starter`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskSettings = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -StartWhenAvailable `
                -RestartCount 999 `
                -RestartInterval (New-TimeSpan -Minutes 1) `
                -ExecutionTimeLimit ([TimeSpan]::Zero) `
                -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $taskSettings -Principal $principal | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

Write-Host "==> pointing claude-mem at the proxy"
Copy-Item $Settings "$Settings.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
$json = Get-Content $Settings -Raw | ConvertFrom-Json
$updates = [ordered]@{
    CLAUDE_MEM_PROVIDER            = "openrouter"
    CLAUDE_MEM_OPENROUTER_BASE_URL = "http://127.0.0.1:$Port/v1"
    CLAUDE_MEM_OPENROUTER_MODEL    = $Model
}
foreach ($k in $updates.Keys) { $json | Add-Member -NotePropertyName $k -NotePropertyValue $updates[$k] -Force }
# Set-Content -Encoding UTF8 writes a BOM on Windows PowerShell 5.1, and a BOM
# makes strict JSON parsers reject the file outright. Write it BOM-less.
[System.IO.File]::WriteAllText(
    $Settings,
    ($json | ConvertTo-Json -Depth 10),
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "  base URL = $($json.CLAUDE_MEM_OPENROUTER_BASE_URL)"
Write-Host "  model    = $($json.CLAUDE_MEM_OPENROUTER_MODEL)"

if ([string]::IsNullOrWhiteSpace($json.CLAUDE_MEM_OPENROUTER_API_KEY)) {
    Write-Warning "CLAUDE_MEM_OPENROUTER_API_KEY is empty. Put your Ollama key (https://ollama.com/settings/keys) into $Settings"
}

Write-Host "==> restarting claude-mem worker"
try { npx --yes claude-mem restart | Out-Null }
catch { Write-Host "  (could not restart automatically - run 'npx claude-mem restart')" }

Write-Host ""
Write-Host "Done. Verify with:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName"
Write-Host "  Get-Content `"$Dest\proxy.log`" -Tail 20 -Wait"
