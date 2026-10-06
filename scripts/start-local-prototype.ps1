[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 4173,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-Path {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Message)
  if (-not (Test-Path -LiteralPath $Path)) { throw $Message }
}

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$clientIndex = Join-Path $root 'dist/client/index.html'
Require-Path $envFile 'Missing .env. Run .\scripts\install-local-prototype.ps1 first.'
Require-Path $clientIndex 'Missing browser build. Run .\scripts\install-local-prototype.ps1 first.'

$env:PORT = "$Port"
Set-Location -LiteralPath $root

Write-Host "Starting Meeting Ledger at http://localhost:$Port (this computer only)…" -ForegroundColor Cyan
Write-Host 'Press Ctrl+C in this window to stop it.' -ForegroundColor DarkGray

if (-not $NoBrowser) {
  Start-Job -ScriptBlock {
    param($Uri)
    Start-Sleep -Seconds 2
    Start-Process $Uri
  } -ArgumentList "http://localhost:$Port" | Out-Null
}

& npm.cmd run preview
exit $LASTEXITCODE
