# Running on self-hosted PostgreSQL

This runbook sets up the meeting ledger on a PostgreSQL server you operate. Without `DATABASE_URL` the server keeps using the local SQLite file in `.data/`.

> **Delivery is still local-only.** Until Microsoft Entra sign-in replaces the development identity headers, the API accepts requests from the server's own machine only. PostgreSQL makes the data durable and backed up; it does not yet make the app safe to open to colleagues.

## What goes where

| Data | Location | Protection |
| --- | --- | --- |
| Meetings, consent, transcripts, summaries, action plans, commitments, outbox | PostgreSQL tables (`jsonb`) | Row-level security per tenant; TLS in transit |
| Recording audio | PostgreSQL `recording_content` (`bytea`) | AES-256-GCM, bound to tenant and recording |
| Audio encryption key | A 32-byte file you keep **outside** the database | Only the server reads it; never in Git |
| Audit trail | PostgreSQL `audit_events` | Append-only (triggers and grants), hash-chained per tenant |

## One-time setup

You need PostgreSQL 15 or later and an administrator connection to it.

1. **Create the database and two roles.** The owner applies migrations. The application role is what the server uses: it is not a superuser, does not bypass row-level security, and owns nothing.

   ```sql
   CREATE ROLE ledger_owner LOGIN PASSWORD 'choose-a-strong-password';
   CREATE ROLE meeting_app  LOGIN PASSWORD 'choose-another-strong-password' NOSUPERUSER NOBYPASSRLS;
   CREATE DATABASE meeting_ledger OWNER ledger_owner;
   REVOKE ALL ON DATABASE meeting_ledger FROM PUBLIC;
   GRANT CONNECT ON DATABASE meeting_ledger TO meeting_app;
   ```

2. **Require TLS and restrict the network.**
   - In `pg_hba.conf`, allow these roles only with `hostssl` from the application server's address.
   - Keep the database off the public internet.
   - Add `?sslmode=verify-full` (or at least `sslmode=require`) to both connection strings.

3. **Generate the audio key** and store it where only the server's account can read it, for example `/etc/meeting-ledger/` or a protected folder on Windows.

   ```bash
   openssl rand -out recording-audio-v1.key 32
   chmod 600 recording-audio-v1.key
   ```

   On Windows PowerShell:

   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [IO.File]::WriteAllBytes("recording-audio-v1.key", $b)
   ```

   **Back the key up separately from database backups.** Without it, stored audio cannot be decrypted. Transcripts and summaries are unaffected.

4. **Apply the schema** as the owner. This also grants `meeting_app` exactly the privileges it needs: read/write on tenant tables, and only `SELECT`/`INSERT` on the audit trail.

   ```bash
   DATABASE_ADMIN_URL="postgres://ledger_owner:…@db.internal:5432/meeting_ledger?sslmode=require" \
   MEETING_DB_APP_ROLE=meeting_app npm run db:migrate
   ```

   Run it again after every upgrade. It applies only new migrations, takes a lock so two runs cannot race, and refuses a database migrated by a newer version of the server.

5. **Configure and start the server.** Put these in the Git-ignored `.env` file (see `.env.example`), then run `npm run build` and `npm run preview`.

   ```
   DATABASE_URL=postgres://meeting_app:…@db.internal:5432/meeting_ledger?sslmode=require
   MEETING_AUDIO_KEY_FILE=/etc/meeting-ledger/recording-audio-v1.key
   ANTHROPIC_API_KEY=…
   ```

   The startup line reports `storage: PostgreSQL (DATABASE_URL)`.

## What the server checks at startup

It refuses to start, rather than run unsafely, when:

- `MEETING_AUDIO_KEY_FILE` is missing or not a 256-bit key,
- the schema is not migrated, or was migrated by a newer server (`UNSUPPORTED_STORAGE_MODEL`),
- it is connected as a superuser, a role with `BYPASSRLS`, or the owner of the tables (`INSECURE_DATABASE_ROLE`). Row-level security would not protect anything in those cases.

## How tenant isolation works

Every transaction sets `app.tenant_id` (transaction-local, so a pooled connection never carries it into another request). Every table has a forced row-level security policy on it. Every query also filters on `tenant_id` explicitly. A bug in the application's own checks would therefore still meet the database's.

## Backups and restore

- **Backups.** Use `pg_dump` for logical backups, or base backups with WAL archiving for point-in-time recovery, plus the separately stored audio key. Test a restore regularly.
- **Restore into a fresh database.** The audit trail rejects `UPDATE`, `DELETE`, and `TRUNCATE` even for the owner, so restore into a new, empty database rather than over an existing one.
- **After a restore:** run `npm run db:migrate`, then confirm the audit chain with `GET /audit/integrity` (requires an audit-reader grant).

## Known limits

- **Single server.** Recording processing runs inside the server process. Jobs interrupted by a restart come back as failed and retryable.
- **Audio size.** Audio is stored in the database. Recordings are limited to about 80 minutes (160 MB), and each one is read into memory for processing.
- **Key rotation** is not automated yet. Each stored recording records its key version, so a future rotation can re-encrypt audio without guessing.
- **Search** scans one tenant's transcripts in the application. That is fine for hundreds of meetings; add full-text indexes before thousands.
