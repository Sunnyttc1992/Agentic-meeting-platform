# Handoff for Claude

Read this file, then `AGENTS.md`, before changing the project. This is the current continuation brief as of 2026-10-06.

## Project and checkpoint

- Repository: `D:\Data Science Project\smart-meeting-platform` on branch `master`.
- Latest code checkpoint: `9a6a37d Normalize timestamps in prototype export` (feature delivery began at `5390d5a`).
- The worktree should be clean except for these intentionally untracked local-only paths: `.copilot/`, `.github/skills/secret-handling/`, `.npmrc`, `.prototype-seed/`, `.squad/`, `.vscode/`, `design-qa.md`, and `implementation-1440x1024.png`. Never commit them.
- Never print or commit `.env`, `.data/`, `.cache/`, `dist/`, `node_modules/`, credentials, certificate material, or audio-key material.

## Durable decisions

- The visual direction is **Executive Ledger**: restrained graphite surfaces, warm metallic accents, editorial typography, evidence-linked intelligence, and executive-level density.
- The delivery remains **loopback-only on Windows**. Microsoft Entra is deferred; Microsoft Teams stays explicitly unconnected. Do not expose the API to a LAN or deploy it.
- The approved delivery path before Entra is one **separate local prototype per Windows computer**. Each installation gets its own PostgreSQL database/roles, `.env`, encrypted-audio key, durable data, and local model cache. Never copy these between computers or treat the package as a shared service.
- Storage in production is local, self-hosted PostgreSQL on Windows when `DATABASE_URL` is set, using a least-privilege application role and database RLS. SQLite remains the local fallback. Audio is AES-256-GCM encrypted with an operator-supplied key file.
- Speech-to-text is local Whisper. Speaker diarization is local, offline pyannote Community-1. Audio and voice data never leave the machine.
- Diarization creates anonymous, per-meeting labels only. No voiceprints, enrollment, automatic names, attendance, authorization, or action-owner assignment.
- OpenAI is the selected summary provider (`MEETING_SUMMARY_PROVIDER=openai`; Responses API with `store: false`) because the Anthropic account has no credit. Claude remains a supported alternative. Only transcript text with anonymous labels, participant IDs, and meeting date may leave the machine.
- Approval packets are still drafts. The available API credential is for synthetic tests only; do not process a real meeting through an external model until the organization has approved the applicable packet.

## What is complete

1. Consent-gated local recording, encrypted audio storage, local Whisper transcription, local pyannote diarization, cited LLM summaries, decisions, risks, questions, and action plans.
2. PostgreSQL migration/operations path for Windows, least-privilege roles, RLS, encrypted recordings, and loopback-only local delivery.
3. Capture-stop and withdrawal boundaries, SQLite physical-deletion controls, append-only consent history, and content-free hash-chained audit trails.
4. Local diarization provisioning wizard and strict worker boundary. Model files are provisioned outside the repository; the worker runs only from operator-provided local paths.
5. Speaker-aware actions: anonymous labels, clear-majority attribution, committed/proposed status, citations, and no invented owners.
6. OpenAI summary adapter plus an opt-in synthetic summary evaluation (`npm run eval:summaries`; it consumes API credit and is not part of `npm test`).
7. Headless Chrome studio smoke coverage for consent, fake microphone, record, stop, and process.
8. Latest fix: Whisper's exact stock silence phrases (`Thank you.` and `Thanks for watching.`) are suppressed only when their matching audio span is silent or a steady sine tone. Speech-like amplitude or zero-crossing variation preserves the phrase. This deliberately is not a broad voice-activity or content filter.
9. Audit fail-closed boundary: every `#audited` request transition on a storage-backed platform writes its allowed audit event in the same tenant transaction. Capture-stop uses this boundary too. Processor completion and processor-failure terminal transitions now also commit their state and audit evidence together. If the append fails, those transitions roll back. Processor jobs enqueue only after the request transaction commits, so an audit outage cannot run a job for rolled-back recording state.
10. Bounded prior-meeting retrieval: `POST /ai/retrieve` now requires a non-empty bounded query and optional limit (1-8). It applies tenant scope and meeting authorization before reading each candidate, returns only matched transcript/assertion excerpts (each with citations), and records content-free `ai.retrieve` source-selection audit events. It is lexical—not vector RAG—and is not connected to an LLM prompt.
11. PostgreSQL deletion operations: Windows operators now run the audited retention sweep followed by daily `VACUUM (ANALYZE)` in an approved window; `VACUUM FULL` is reserved for reviewed maintenance. This reduces dead-tuple exposure but does not replace future per-recording crypto-shredding.
12. Cross-device capture stop: authenticated participants can poll the minimal `GET /meetings/:id/recording/authorization-status` capability. The studio checks it every 5 seconds while recording and discards local capture when it becomes inactive; no lease is disclosed or refreshed by this endpoint.
13. Production launch is explicitly gated in `docs/operations/production-launch-gate.md`; it lists the Windows, Entra, Teams, provider-approval, and release-evidence conditions that require organization action.
14. Per-computer prototype distribution: `npm run prototype:export` creates a reviewed-source ZIP and SHA-256 sidecar without secrets, data, caches, build output, dependencies, or Git history. Each recipient runs `scripts/install-local-prototype.ps1`, which installs pinned dependencies, invokes the existing PostgreSQL setup wizard only when needed, and builds the bundle. `scripts/start-local-prototype.ps1` starts the resulting instance only at `localhost`/`127.0.0.1`. See `docs/operations/local-prototype-distribution.md`.
    - The exporter packages only tracked files, refuses a dirty tracked release, and normalizes timestamps in its disposable staging directory for Windows `Compress-Archive` compatibility.

## Validation at this checkpoint

- `npm test`: **200/200 passing**.
- `npm run build`: passed.
- `npm run test:sites`: **4/4 passing**.
- Parsed all three new PowerShell scripts and ran `bash -n scripts/setup-windows-postgres.sh`.
- Export smoke test produced a 134-entry ZIP with the installer/run scripts and `.env.example`, while excluding real `.env` files, `.data`, keys, model caches, dependencies, build output, and Git history. A PostgreSQL-backed local preview also returned `200` from authenticated `/pipeline/readiness` on loopback.
- Durable SQLite, PostgreSQL/PGlite, and node-postgres wire-protocol suites passed after the audit-boundary change.
- `git diff --check`: passed before committing `341808e`.
- Earlier validation also passed `python -m py_compile server/diarize_worker.py` and `bash -n scripts/setup-windows-diarization.sh`.
- A prior synthetic two-voice local run completed Whisper, pyannote, and OpenAI end to end; labels were anonymous and the diarization temp directory was empty afterward.

## Current machine facts (do not expose values)

- `.env` is local only. Inspect names, never values. It contains the summary-provider, local diarization, audio-key, and PostgreSQL settings.
- PostgreSQL is local on Windows and configured for loopback-only use. Do not replace it with Supabase or another hosted database.
- The diarization runtime and Community-1 model live outside the repository under the operator-managed `D:/MeetingLedger/diarization` area.
- Use `node --env-file-if-exists=.env server/local-preview.js` with a loopback `PORT` for a preview. Browser automation may be unavailable in some environments; HTTP readiness checks are an acceptable fallback.

## Read next

1. `AGENTS.md` and `CONTEXT.md`.
2. `server/README.md`.
3. `docs/acceptance/meeting-intelligence-traceability.md` (update its implementation-status table if a requirement changes).
4. `docs/security/local-meeting-pipeline.md`, `never-record-policy.md`, `retention-deletion.md`, `anthropic-api-processing-approval.md`, and `openai-api-processing-approval.md`.
5. `docs/architecture/local-speaker-diarization-options.md` and `windows-postgres-operations.md`.

## Recommended next work

These do not require a product decision, but preserve the stated constraints and add tests for every behavioral change:

1. Extend SEC-08 fail-closed behavior to background policy-revocation/quarantine paths and run broader audit-sink/KMS outage exercises. Request and processor terminal transitions are atomic now, but the traceability matrix deliberately remains partial until those remaining paths are covered.
2. Test the prototype ZIP on a clean Windows computer with locally installed Node, Git for Windows/WSL, and PostgreSQL. Verify that it never contains secrets or data, every recipient gets fresh local credentials/key material, and the post-install server rejects a non-loopback Host header.
3. Keep prior-meeting retrieval lexical and citation-sized until an approved local embedding model and a tenant-isolated vector-index lifecycle (creation, deletion, rebuild, backup handling) are implemented. Never send retrieval output to either external summary provider without its approval packet covering that new data flow.

These require a user or organization decision first:

- approval to use a real meeting with an external summary provider;
- Microsoft Entra rollout, then Teams connection;
- a reviewed, reversible, audited speaker-correction/mapping interface;
- dashboard wiring for the current static Q4 demo, because it needs explicit visual/product direction;
- whether both LLM providers should remain supported.

## Non-negotiable implementation rules

- Authorize before retrieval; tenant identity comes from identity, never request IDs. Cross-tenant IDs must look nonexistent.
- Never record without current consent from every required participant and a recordable classification. Recheck policy when leases renew.
- Treat model output as untrusted and revalidate citations, owners, dates, labels, and model identifiers before storage.
- Keep audit data content-free and hash-chained. Do not weaken append-only safeguards.
- Preserve `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs`.
- Make small, scoped commits and validate with at least the relevant tests; before any Sites handoff run `npm run build` and `npm run test:sites`.
