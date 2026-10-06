[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 4199,
  [switch]$ProcessRecording
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use. Choose an unused loopback port." }

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('meeting-ledger-browser-smoke-' + [guid]::NewGuid().ToString('N'))
$previous = @{}
foreach ($name in @('DATABASE_URL', 'MEETING_DATA_DIR', 'MEETING_SUMMARY_PROVIDER', 'PORT')) {
  $entry = Get-Item "Env:$name" -ErrorAction SilentlyContinue
  $previous[$name] = if ($entry) { $entry.Value } else { $null }
}

$server = $null
try {
  New-Item -ItemType Directory -Path $scratch -Force | Out-Null
  # This child intentionally does not use --env-file. A configured production
  # DATABASE_URL must never turn a browser smoke run into a real-data test.
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  $env:MEETING_DATA_DIR = $scratch
  $env:MEETING_SUMMARY_PROVIDER = 'none'
  $env:PORT = "$Port"
  $server = Start-Process -FilePath node.exe -ArgumentList 'server/local-preview.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru

  $url = "http://127.0.0.1:$Port/"
  $ready = $false
  for ($attempt = 0; $attempt -lt 40 -and -not $ready; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    try { $ready = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { }
  }
  if (-not $ready) { throw "Isolated smoke server did not become ready at $url." }

  $arguments = @((Join-Path $root 'scripts/smoke-studio-chrome.mjs'), "http://localhost:$Port/")
  if ($ProcessRecording) { $arguments += '--process' }
  & node.exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "Browser smoke test failed with exit code $LASTEXITCODE." }
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
  foreach ($name in $previous.Keys) {
    if ($null -eq $previous[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$name" -Value $previous[$name] }
  }
  if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
