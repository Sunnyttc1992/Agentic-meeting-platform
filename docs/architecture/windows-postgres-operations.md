# Operating PostgreSQL on Windows

This guide operates the self-hosted PostgreSQL backend on Windows. It complements [self-hosted-postgres.md](self-hosted-postgres.md), which remains the authoritative description of the application schema, roles, and storage guarantees.

> The application remains **loopback-only** until Microsoft Entra sign-in replaces development identity headers. A durable database, a TLS certificate, or a successful backup does not authorize access from other machines.

## Scope and responsibilities

The current server supports PostgreSQL 15+ as a durable single-server backend. It has tenant RLS, a least-privilege application role, encrypted recording audio, and a database-enforced append-only audit table. It does not provide multi-server processing, automated audio-key rotation, a durable outbox worker, Entra identity, or a production deletion reconciliation service.

An operator owns the database host, Windows service accounts, TLS certificates, secret storage, encrypted backup destination, restore drills, monitoring, and access reviews. Do not place any password, connection URL, raw audio key, or backup archive in Git, source code, browser storage, audit records, or chat.

## 1. Windows and PostgreSQL preflight

- Install PostgreSQL 15 or later and its matching client tools (`psql.exe`, `pg_dump.exe`, and `pg_restore.exe`) from the approved organization source.
- Run PostgreSQL and the Meeting Ledger preview under separate non-administrator Windows service accounts. Give the application account no access to the PostgreSQL data directory or backup destination.
- Keep the database host off the public internet. While the app is loopback-only, restrict PostgreSQL to the host itself (`127.0.0.1` and `::1`) unless a documented, approved service-host separation is required.
- Use a hostname that matches the database TLS certificate. `sslmode=verify-full` is the required application posture; `require` is only a temporary diagnostic setting and must not be saved in the application configuration.

Configure `postgresql.conf` with `ssl = on`. Configure `pg_hba.conf` with `hostssl` and `scram-sha-256`, never `trust`, for the explicit app source addresses and roles. The exact Windows service paths differ by installer and organization policy, so follow the installed PostgreSQL documentation for reloading the service after configuration changes.

## 2. Roles and database

Connect as a database bootstrap administrator, not the app account, and create the fixed roles below with separately generated passwords. Replace the placeholders through your secret manager or password prompt; do not save this SQL with real values.

```sql
CREATE ROLE ledger_owner LOGIN PASSWORD 'set-a-unique-secret' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE meeting_app LOGIN PASSWORD 'set-a-different-unique-secret' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE meeting_ledger OWNER ledger_owner;
REVOKE ALL ON DATABASE meeting_ledger FROM PUBLIC;
GRANT CONNECT ON DATABASE meeting_ledger TO meeting_app;
```

Use the owner only for `npm run db:migrate`, backups, and restore drills. The running server must use `meeting_app`. It deliberately refuses a superuser, table owner, or `BYPASSRLS` database connection because those roles bypass the intended tenant isolation.

Apply migrations from a shell that holds the owner URL only for that command:

```powershell
$env:DATABASE_ADMIN_URL = 'postgres://ledger_owner:...@db.example.internal:5432/meeting_ledger?sslmode=verify-full'
$env:MEETING_DB_APP_ROLE = 'meeting_app'
npm.cmd run db:migrate
Remove-Item Env:DATABASE_ADMIN_URL
Remove-Item Env:MEETING_DB_APP_ROLE
```

The migration command grants exactly the needed application permissions. Do not run migrations from the preview server or give the app account schema-owner permissions.

## 3. Recording-audio key and application configuration

Create a 32-byte key outside the repository and database. Replace `MEETING-LEDGER-SERVICE` with the Windows account that runs the server, and retain a separately protected escrow copy.

```powershell
$keyDirectory = 'C:\ProgramData\MeetingLedger\keys'
$keyPath = Join-Path $keyDirectory 'recording-audio-v1.key'
$serviceAccount = 'MEETING-LEDGER-SERVICE'
$operatorAccount = "$env:USERDOMAIN\$env:USERNAME"
New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
$key = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($key)
[IO.File]::WriteAllBytes($keyPath, $key)
icacls $keyDirectory /inheritance:r /grant:r "${serviceAccount}:(OI)(CI)R" "${operatorAccount}:(OI)(CI)R" | Out-Null
icacls $keyPath /inheritance:r /grant:r "${serviceAccount}:R" "${operatorAccount}:R" | Out-Null
```

The example retains read access for the operator who generated the file and for the server service account. Verify the final ACL with `icacls`; never grant `Users` or `Everyone` access.

Store only these application values in the Git-ignored `.env` of the local server account:

```text
DATABASE_URL=postgres://meeting_app:...@db.example.internal:5432/meeting_ledger?sslmode=verify-full
MEETING_AUDIO_KEY_FILE=C:\ProgramData\MeetingLedger\keys\recording-audio-v1.key
DATABASE_POOL_MAX=10
```

Keep `DATABASE_ADMIN_URL` out of `.env`; it is an owner credential needed only for migrations and controlled recovery work. After configuration, start the preview and confirm it reports `storage: PostgreSQL (DATABASE_URL)`. A startup refusal for an unsafe role or unmigrated schema is expected fail-closed behavior and must be fixed, not bypassed.

## 4. Backups and restore drills

Use a dedicated Windows backup account with a protected `%APPDATA%\postgresql\pgpass.conf` file. Its one-line form is `host:port:database:user:password`; restrict the file ACL to that backup account. Put backup archives on a BitLocker-protected volume or a separately approved encrypted destination. The audio key must be backed up independently with access controls at least as restrictive as the database backup.

Run the included logical backup script from a PowerShell session or a Task Scheduler job under the backup account:

```powershell
.\scripts\backup-windows-postgres.ps1 `
  -DatabaseHost db.example.internal `
  -BackupDirectory 'E:\MeetingLedgerBackups' `
  -SslMode verify-full `
  -SslRootCertificate 'C:\ProgramData\MeetingLedger\certs\root-ca.pem'
```

The script creates a custom-format dump, verifies it can be listed by `pg_restore`, and writes a SHA-256 manifest. That archive check is not a restore drill. At the cadence approved by the organization, restore the archive to a **fresh** empty database, never over an existing one: the audit triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` even for the owner.

Do not attach a restored database to a serving application until all of the following are complete:

1. Run `npm.cmd run db:migrate` with the temporary owner URL and confirm the schema is current.
2. Verify the tenant audit chains with an authorized audit-reader grant.
3. Run retention/deletion reconciliation before serving it; expired or deleted content must not reappear after disaster recovery.
4. Record the restore time, archive hash, audit result, deletion-reconciliation result, and approver as operational evidence.

For point-in-time recovery, add a separately tested base-backup/WAL-archiving design. Do not describe a nightly logical dump as point-in-time recovery.

## 5. Monitoring, capacity, and high availability

Alert on these events before enabling real meeting capture:

- failed backup, failed archive verification, missed restore drill, or unexpected backup retention expiry;
- TLS/authentication failure, database unavailable, connection-pool exhaustion, low disk space, or PostgreSQL service restart;
- audit-integrity verification failure, unexpected role attributes, RLS policy failure, or migration-version mismatch;
- retention/deletion worker failure and key-file read failure.

Track database and backup size, active connections, lock waits, transaction age, disk free space, and—if replication is later introduced—replication lag and replica replay health. The server stores recordings in PostgreSQL and reads them into memory for processing, so preserve the current roughly 80-minute/160-MB recording bound and capacity-test before changing it.

This codebase runs processing in one server process and has no durable queue or cross-instance coordination. PostgreSQL replication by itself does not make the application highly available. A future HA design needs a tested primary/standby plan, client failover, a durable queue/outbox publisher, job idempotency across server instances, backup/deletion reconciliation, and operational approval. Do not add a load balancer or expose the service before Entra identity is implemented.

## 6. Audio-key rotation boundary

Every stored recording records its key version, but the current server accepts one `MEETING_AUDIO_KEY_FILE` and has no re-encryption migration or multi-key keyring. Therefore:

- Never overwrite or replace the active key file in place; doing so makes existing audio fail closed as unavailable.
- Keep the current key and escrow copy until every recording encrypted with it has expired, been deleted, or been re-encrypted by a future tested migration.
- Treat suspected key compromise as an incident: restrict access, preserve evidence, assess affected recordings, and obtain security approval before any recovery or rotation action.
- Implement and test a multi-key read / new-key write / transactional re-encryption / rollback / disposal workflow before claiming automated key rotation.

## 7. Deletion reconciliation and vacuum

PostgreSQL `DELETE` makes application rows inaccessible immediately, but leaves dead tuples until vacuum reclaims them. The recording payload is AES-256-GCM ciphertext, yet the current server uses one active audio key; vacuum is therefore an operational deletion control, not a cryptographic erasure guarantee.

- Run the application retention sweep before database maintenance. It creates the content-free tombstone and removes recording content, transcripts, assertions, and derived commitments through the normal audited path.
- Run `VACUUM (ANALYZE)` at least daily under the PostgreSQL maintenance/owner account, during the organization-approved low-traffic window. Use `VACUUM (VERBOSE, ANALYZE)` only when the operator needs a protected diagnostic log; its output must not be copied into application logs.
- Use `VACUUM FULL` only after a reviewed incident or a measured bloat assessment. It requires an exclusive table lock and must be scheduled as a maintenance window; do not run it from the application process or while recording/processing is active.
- Keep logical backup retention time-bounded and encrypted. A restored backup is never served until the retention/deletion reconciliation in section 4 completes and an operator records its result.
- Record the sweep completion time, vacuum command result, database size before/after where available, backup-rotation state, and approving operator in the protected operations record. Do not put meeting IDs, transcript text, audio identifiers, database URLs, or credentials in that record.

This procedure reduces normal PostgreSQL dead-tuple exposure. Per-recording data keys with tested crypto-shredding remain the stronger future control for rapid selective erasure.

## Repeatable setup

Run `bash scripts/setup-windows-postgres.sh` from Git Bash or WSL to walk through the manual stages. It writes only `DATABASE_URL` and `MEETING_AUDIO_KEY_FILE` to the Git-ignored `.env`; it never persists the owner URL or key bytes.
