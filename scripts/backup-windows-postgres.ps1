[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$DatabaseHost,

  [ValidateRange(1, 65535)]
  [int]$Port = 5432,

  [ValidateNotNullOrEmpty()]
  [string]$Database = 'meeting_ledger',

  [ValidateNotNullOrEmpty()]
  [string]$DatabaseUser = 'ledger_owner',

  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$BackupDirectory,

  [ValidateSet('verify-full', 'verify-ca', 'require')]
  [string]$SslMode = 'verify-full',

  [string]$SslRootCertificate,

  [string]$PostgresBinDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PostgresTool([string]$name) {
  if ($PostgresBinDirectory) {
    $candidate = Join-Path $PostgresBinDirectory "$name.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  $command = Get-Command "$name.exe" -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "Could not find $name.exe. Install PostgreSQL client tools or provide -PostgresBinDirectory."
}

if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
}

$pgDump = Get-PostgresTool 'pg_dump'
$pgRestore = Get-PostgresTool 'pg_restore'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $BackupDirectory "$Database-$timestamp.dump"
$checksumPath = "$backupPath.sha256"

$previousSslMode = $env:PGSSLMODE
$previousRootCertificate = $env:PGSSLROOTCERT
try {
  $env:PGSSLMODE = $SslMode
  if ($SslRootCertificate) { $env:PGSSLROOTCERT = $SslRootCertificate }

  # Authentication comes from the task account's protected pgpass.conf. Do not
  # pass a password on the command line or persist an owner URL in this script.
  & $pgDump --format=custom --no-owner --no-privileges --host=$DatabaseHost --port=$Port --username=$DatabaseUser --file=$backupPath $Database
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }

  # A readable archive is not a full restore drill, but catches corrupt or
  # incomplete backup files before the scheduled task reports success.
  & $pgRestore --list $backupPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pg_restore could not read the backup archive (exit code $LASTEXITCODE)." }

  $hash = Get-FileHash -LiteralPath $backupPath -Algorithm SHA256
  Set-Content -LiteralPath $checksumPath -Value "$($hash.Hash) *$([IO.Path]::GetFileName($backupPath))" -NoNewline -Encoding ascii
  Write-Output "Verified PostgreSQL backup: $backupPath"
  Write-Output "SHA-256 manifest: $checksumPath"
} finally {
  $env:PGSSLMODE = $previousSslMode
  $env:PGSSLROOTCERT = $previousRootCertificate
}
