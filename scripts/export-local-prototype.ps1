[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),
  [string]$Label = 'local-prototype'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
$resolvedRoot = [IO.Path]::GetFullPath($root)
if ($resolvedOutput.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -and $resolvedOutput -eq $resolvedRoot) {
  throw 'OutputDirectory must not be the repository root.'
}

$safeLabel = $Label -replace '[^A-Za-z0-9._-]', '-'
if ([string]::IsNullOrWhiteSpace($safeLabel)) { throw 'Label must contain at least one letter or number.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required to export the reviewed source files.' }
& git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Tracked working-tree changes are present. Commit or stash the reviewed release before exporting it.' }
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'Staged changes are present. Commit the reviewed release before exporting it.' }

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("meeting-ledger-export-" + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $temporaryRoot 'meeting-ledger'
$archive = Join-Path $resolvedOutput ("meeting-ledger-" + $safeLabel + '.zip')

try {
  New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
  $trackedFiles = & git -C $root ls-files --cached
  if ($LASTEXITCODE -ne 0 -or $trackedFiles.Count -eq 0) { throw 'Could not enumerate the reviewed source files.' }
  foreach ($relativePath in $trackedFiles) {
    $source = Join-Path $root $relativePath
    $destination = Join-Path $packageRoot $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
  New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $archive -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $([IO.Path]::GetFileName($archive))" -NoNewline

  Write-Host "Created $archive" -ForegroundColor Green
  Write-Host "SHA-256: $hash"
  Write-Host 'The archive intentionally excludes .env, .data, audio keys, model caches, node_modules, dist, and Git history.' -ForegroundColor DarkGray
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
