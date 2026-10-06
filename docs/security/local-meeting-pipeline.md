# Local meeting pipeline: data flow and controls

Status: working end to end on one machine. It is not yet deployable to other users; see "What still blocks wider delivery".

## Data flow

| Step | Where it runs | What crosses a boundary |
|---|---|---|
| Consent and policy preflight | Server | Nothing leaves the machine |
| Capture (MediaRecorder) | Browser tab | Nothing; audio stays in tab memory until the organizer confirms processing |
| Conversion to 16 kHz mono WAV | Browser tab | Nothing |
| Upload, hash, and WAV verification | Server (loopback only) | Audio moves from the tab to the local server process |
| Transcription (Whisper, ONNX) | Server process | Nothing. The only network access is the one-time model weight download into `.cache/models` |
| Summary, decisions, risks, questions, action plan | Anthropic API (Claude) | Transcript text, the meeting's participant IDs, and the meeting date. Never audio, names, tenant, meeting, recording, or lease identifiers |
| Validation and storage | Server | Nothing |

## Controls

- **Consent and policy before, during, and after capture.** Preflight requires every required participant's current consent and a recordable classification. The recording lease stays short-lived (5 minutes); the studio renews it while recording, and every renewal re-runs the same checks. A denied renewal stops capture and discards the audio. Processing re-checks policy before and after transcription and quarantines on denial.
- **Media validation.** The real pipeline accepts only `audio/wav` that parses as RIFF/WAVE, PCM, 16-bit, mono, 16 kHz, with consistent chunk lengths. The check runs at upload, before bytes are stored, in addition to the declared length and SHA-256.
- **The model's output is untrusted.** Claude's reply must match a strict JSON schema. The platform then:
  - withholds any item that cites a segment not in this transcript, and counts the withheld items,
  - keeps an action owner only if that ID is a participant of this meeting,
  - keeps a due date only if it is a real calendar date,
  - bounds item counts and text lengths.

  Claude is told to treat transcript content as evidence, not instructions. A refusal, truncation, or malformed reply fails the job as `PROCESSOR_FAILED` and stores nothing.
- **Honest provenance.** Whisper cannot separate speakers, so segments are labeled `UNATTRIBUTED` with no identity confidence. Each result carries its processor mode: `local-whisper-claude`, `local-whisper-transcript-only`, or `local-deterministic-fake`.
- **No secrets in the client.** `ANTHROPIC_API_KEY` (or an `ant auth login` profile) is read only by the server. `.env.example` is a placeholder-only template; a real `.env` is Git-ignored and is loaded only by the local Node `dev`/`preview` commands. It must not use `VITE_` variables. Without credentials the server runs transcription only and says so in the UI.
- **Local only.** The preview server binds to `127.0.0.1`. The API also requires a loopback socket address and a loopback `Host` header, which blocks DNS rebinding. The Vite dev server applies the same guard.
- **Readiness without side effects.** `GET /pipeline/readiness` requires the same local development identity and is independently loopback-guarded. It returns only a loopback scope, Whisper runtime/cache booleans, an Anthropic credential-presence boolean, and the Teams `not-connected` posture. It never initializes Whisper, downloads model files, makes an Anthropic request, reads or returns a credential value, or transmits audio.
- **Retry.** A failed job can be re-queued by its organizer, up to 3 attempts in total. Each retry is audited as `recording.process.retry` and re-runs the consent and policy checks; after a consent withdrawal the recording is quarantined instead.
- **Export (SEC-06).** `GET /meetings/:id/export` returns a Markdown record of the meeting's authorized knowledge: summary, action plan, decisions, risks, questions, and transcript, all with source timestamps.
  - Only *participants* may export. A management grant that allows viewing does not allow export (`EXPORT_FORBIDDEN`).
  - Exporting requires processed content (`NO_MEETING_RECORD`) and an active meeting.
  - The file carries a confidentiality notice and the audit correlation ID.
  - Speech and model text is escaped so it cannot inject links, images, HTML, table cells, headings, or auto-linked URLs.
  - The response is `no-store` and `nosniff`.
  - Every attempt is audited as `meeting.export` with no content.
- **Retention (PRIV-04).** Content expires 30 days after its first upload in development (rules are per tenant and classification). From that instant every read, export, AI retrieval, and new recording is refused with `RETENTION_EXPIRED`. A sweep running every minute then deletes the content, unless a legal hold applies. See `retention-deletion.md`.
- **Rate limits (AUTH-10).** Every API request is throttled per tenant and user before any platform work runs. The limits are per minute: processing and retry 6, capture (preflight, create, upload, delete) 30, export 10, AI retrieval 30, everything else 600, which leaves room for the studio's status polling.
  - An excess request gets `429 RATE_LIMITED` with `Retry-After`.
  - Throttled requests are not audited one by one, so a flood cannot amplify into the audit log.
  - The limiter tracks at most 10,000 keys and refuses new ones when full.
  - Limits are in process memory. Once identity is real (Entra), a multi-instance deployment needs a shared store.
- **Audit.** Every step emits content-free, hash-chained audit events (see `audit-events.md`).

## What still blocks wider delivery

1. **Identity:** Microsoft Entra sign-in must replace the `x-tenant-id` / `x-user-id` development headers. Until then the API must stay loopback-only.
2. **Production storage:** self-hosted PostgreSQL is implemented and tested (see `docs/architecture/self-hosted-postgres.md`): tenant row-level security in the database, a least-privilege role check, an append-only audit table, and encrypted audio. Still open:
   - operating it: backups, monitoring, high availability, and key rotation,
   - a managed key service if the deployment requires one.
3. **Data processing terms:** confirm that the Anthropic organization's data-retention and processing terms are acceptable for meeting transcripts before real meetings are processed. The decision record and review questions are in [anthropic-api-processing-approval.md](anthropic-api-processing-approval.md).
4. **Speaker identification:** owners come only from names stated in the meeting. Diarization and verified speaker binding are not implemented.
5. **Export lifecycle:** a downloaded file cannot be recalled. Revocation and deletion stop future exports but cannot reach copies already saved; expiring share links are not implemented.

## Local durable storage

- **Where:** `.data/meeting-ledger.sqlite` (Git-ignored), written through `server/adapters/sqlite.js` with the built-in `node:sqlite`.
- **Same safeguards as before.** The adapter plugs into the same tenant facade as the in-memory adapter, so tenant binding and record checks are identical. Commitments and outbox rows are produced by the same shared functions.
- **Real transactions.** Writes commit or roll back together; nested calls use savepoints.
- **Audio encryption.** Recording audio is encrypted with AES-256-GCM, a fresh nonce per recording, and additional authenticated data binding each ciphertext to its tenant and recording. A tampered byte, a ciphertext moved onto another recording, or a wrong key fails closed with `RECORDING_CONTENT_UNAVAILABLE`. Decryption never returns partial or altered audio.
- **Key handling.** The 256-bit key is generated on first run at `.data/keys/recording-audio-v1.key`. File permissions are set to owner-only where the OS supports it (on Windows, rely on the user profile's ACLs).
- **Not encrypted:** transcripts, summaries, and audit are stored unencrypted in the database file. Protect the machine with full-disk encryption (BitLocker).
- **Audit.** The audit table is append-only at the database level: triggers reject `UPDATE` and `DELETE`. The per-tenant hash chain continues across restarts.
- **Startup.** On startup, jobs left queued or processing by a restart are marked failed (audited as `service:recovery`) and can be retried. A database written by another data model version is refused.
