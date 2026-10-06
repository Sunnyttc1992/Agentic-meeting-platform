[CmdletBinding()]
param(
  [switch]$SkipDependencyInstall,
  [switch]$SkipPostgresWizard
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-Command {
  param([Parameter(Mandatory)][string]$Name, [string]$Hint)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Hint"
  }
}

function Read-DotEnvValue {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Name)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -Last 1
  if ($null -eq $line) { return $null }
  return $line.Substring($Name.Length + 1).Trim()
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

Write-Host ''
Write-Host 'Meeting Ledger local-only prototype installer' -ForegroundColor Cyan
Write-Host 'This installer creates one isolated instance for this Windows computer.'
Write-Host 'It never opens a LAN listener, copies meeting data, or writes secrets to source control.' -ForegroundColor DarkGray

Require-Command node 'Install the supported Node.js LTS release, then open a new PowerShell window.'
Require-Command npm.cmd 'Install Node.js with npm, then open a new PowerShell window.'

if (-not $SkipDependencyInstall) {
  Write-Host 'Installing the pinned application dependencies…' -ForegroundColor Cyan
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}

$envFile = Join-Path $root '.env'
$databaseUrl = Read-DotEnvValue -Path $envFile -Name 'DATABASE_URL'
$audioKeyFile = Read-DotEnvValue -Path $envFile -Name 'MEETING_AUDIO_KEY_FILE'

if (-not $SkipPostgresWizard -and ([string]::IsNullOrWhiteSpace($databaseUrl) -or [string]::IsNullOrWhiteSpace($audioKeyFile))) {
  Require-Command bash 'Install Git for Windows (Git Bash) or WSL; it supplies bash for the database setup wizard.'
  Write-Host ''
  Write-Host 'PostgreSQL needs a one-time local setup before this prototype can use it.' -ForegroundColor Yellow
  Write-Host 'The next wizard asks for credentials privately and persists only the least-privilege app URL and protected audio-key path in .env.' -ForegroundColor DarkGray
  & bash (Join-Path $root 'scripts/setup-windows-postgres.sh')
  if ($LASTEXITCODE -ne 0) { throw 'The PostgreSQL setup wizard did not complete.' }
  $databaseUrl = Read-DotEnvValue -Path $envFile -Name 'DATABASE_URL'
  $audioKeyFile = Read-DotEnvValue -Path $envFile -Name 'MEETING_AUDIO_KEY_FILE'
}

if ([string]::IsNullOrWhiteSpace($databaseUrl) -or [string]::IsNullOrWhiteSpace($audioKeyFile)) {
  throw 'PostgreSQL configuration is incomplete. Re-run without -SkipPostgresWizard, or set DATABASE_URL and MEETING_AUDIO_KEY_FILE through the approved setup wizard.'
}

Write-Host 'Building the local browser bundle…' -ForegroundColor Cyan
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'The production build failed.' }

Write-Host ''
Write-Host 'Local prototype installation is ready.' -ForegroundColor Green
Write-Host 'Run .\scripts\start-local-prototype.ps1 to open this computer''s loopback-only instance.'
Write-Host 'Do not copy .env, .data, .cache, or the audio-key file to another computer.' -ForegroundColor Yellow
