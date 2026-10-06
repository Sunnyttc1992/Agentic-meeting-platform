# Per-computer local prototype distribution

This is the supported way to evaluate Meeting Ledger on several Windows computers before Microsoft Entra is available. Each installation is a separate, loopback-only system. It must not be treated as a shared deployment, a central service, or a production rollout.

## What the operator distributes

From a reviewed source checkout, create a clean archive:

```powershell
.\scripts\export-local-prototype.ps1 -Label 2026-10-06
```

The archive contains source, pinned dependency metadata, setup scripts, and documentation. It deliberately excludes all machine-specific or sensitive material: `.env`, `.data`, audio keys, database credentials, model caches, build output, `node_modules`, and Git history. Send the ZIP and its adjacent `.sha256` file through the organization-approved internal channel.

## What every recipient needs

- Windows 10/11 or an approved Windows Server workstation.
- A supported Node.js LTS installation with npm.
- PostgreSQL 15+ and its client tools installed locally. PostgreSQL must use TLS and remain local to that machine for this prototype.
- Git for Windows or WSL, solely to run the interactive PostgreSQL setup wizard.
- A Windows account permitted to keep its own protected local database credentials and recording-audio key.

Do not reuse another computer's `.env`, PostgreSQL passwords, database files, audio key, `.data`, Hugging Face token, API key, or recordings. Each computer needs independently generated `ledger_owner` and `meeting_app` passwords and its own 32-byte audio key.

## Install one isolated instance

1. Extract the ZIP into a directory owned by the local user, for example `C:\MeetingLedger`.
2. In PowerShell from that directory, run:

   ```powershell
   .\scripts\install-local-prototype.ps1
   ```

   The installer runs `npm ci`, then opens the already-reviewed PostgreSQL wizard when database settings are absent. That wizard requires a local PostgreSQL bootstrap administrator once and guides the operator through creating the least-privilege roles/database and protected audio key. It writes only `DATABASE_URL` and `MEETING_AUDIO_KEY_FILE` to the Git-ignored `.env`; migrations use the owner credential only in process memory.
3. After the build succeeds, run:

   ```powershell
   .\scripts\start-local-prototype.ps1
   ```

   It starts the app at `http://localhost:4173`; the server code binds to `127.0.0.1`, regardless of the browser address used. Close the PowerShell process or press `Ctrl+C` to stop it.

## Prototype boundary

- Development identity headers are local-only placeholders, not authentication. Do not share an installation or point it at a LAN address.
- Microsoft Teams remains disconnected.
- Local Whisper transcription and local pyannote diarization stay on the computer. Their model caches are separate per installation.
- Without the signed provider approval, use transcript-only processing or synthetic recordings. Do not enable external summaries for real meeting content.
- A local database backup and the matching audio-key backup must remain on the same computer's approved protected storage; neither is a way to sync meetings to another prototype computer.

Moving from these separate installations to one shared service requires the production-launch gates, including Entra identity and external-network approval. See [production-launch-gate.md](production-launch-gate.md).

## Simulated clean install (2026-10-06)

Run on the development computer in a temporary folder, without touching its PostgreSQL instance. It is not a substitute for the clean second-computer test.

- `npm run prototype:export` produced a 146-file archive whose SHA-256 sidecar matched. It contained no `.env`, `.data`, keys, certificates, SQLite files, caches, `node_modules`, `dist`, Git history, or local-only agent folders; the only credential-shaped strings were the commented `CHANGE_ME` placeholders in `.env.example`.
- The archive stored entry paths with backslashes (a `Compress-Archive` behaviour that non-Windows extractors reject). The exporter now writes forward-slash entry names; `unzip -t` and `Expand-Archive` both accept the new archive.
- The unpacked installer, run with `-SkipPostgresWizard` and a placeholder `.env`, completed `npm ci` from the lockfile and the production build in 34 seconds.
- The unpacked server (SQLite, no `.env`) listened only on `127.0.0.1`, returned `403 LOCAL_ONLY` for a rebinding `Host` header on reads and writes, refused connections on the computer's LAN address, created a meeting over loopback, and generated its own master and per-recording key material, different from the existing installation's.

Still required on a clean second computer: the PostgreSQL wizard end to end, Whisper model download, and the optional diarization provisioning.
