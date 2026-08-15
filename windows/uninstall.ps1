<#
.SYNOPSIS
    Remove the scheduled task and point claude-mem straight back at Ollama Cloud.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$TaskName = "claude-mem-ollama-proxy"
$Settings = Join-Path $env:USERPROFILE ".claude-mem\settings.json"

Write-Host "==> removing scheduled task"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.CommandLine -like "*claude-mem-proxy*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue

if (Test-Path $Settings) {
    Write-Host "==> restoring direct upstream in claude-mem settings"
    Copy-Item $Settings "$Settings.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
    $json = Get-Content $Settings -Raw | ConvertFrom-Json
    $json.CLAUDE_MEM_OPENROUTER_BASE_URL = "https://ollama.com/v1"
    $json | ConvertTo-Json -Depth 10 | Set-Content $Settings -Encoding UTF8
    Write-Host "  base URL = https://ollama.com/v1"
    try { npx --yes claude-mem restart | Out-Null } catch { }
}

Write-Host "==> done (proxy files left in ~\.claude-mem-proxy - remove manually if you want)"
