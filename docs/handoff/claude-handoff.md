# Handoff for Claude

Read this file, then `AGENTS.md`, before changing the project. This is the current continuation brief as of 2026-10-06.

## Project and checkpoint

- Repository: `D:\Data Science Project\smart-meeting-platform` on branch `master`.
- Latest checkpoint: `341808e Fail closed when request audit writes fail`.
- The worktree should be clean except for these intentionally untracked local-only paths: `.copilot/`, `.github/skills/secret-handling/`, `.npmrc`, `.prototype-seed/`, `.squad/`, `.vscode/`, `design-qa.md`, and `implementation-1440x1024.png`. Never commit them.
- Never print or commit `.env`, `.data/`, `.cache/`, `dist/`, `node_modules/`, credentials, certificate material, or audio-key material.

## Durable decisions

- The visual direction is **Executive Ledger**: restrained graphite surfaces, warm metallic accents, editorial typography, evidence-linked intelligence, and executive-level density.
- The delivery remains **loopback-only on Windows**. Microsoft Entra is deferred; Microsoft Teams stays explicitly unconnected. Do not expose the API to a LAN or deploy it.
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
9. Request-path audit fail-closed boundary: every `#audited` state transition on a storage-backed platform writes its allowed audit event in the same tenant transaction. If that append fails, the transition rolls back. Capture-stop now uses this boundary too. Processor jobs enqueue only after that transaction commits, so an audit outage cannot run a job for rolled-back recording state.
10. Bounded prior-meeting retrieval: `POST /ai/retrieve` now requires a non-empty bounded query and optional limit (1-8). It applies tenant scope and meeting authorization before reading each candidate, returns only matched transcript/assertion excerpts (each with citations), and records content-free `ai.retrieve` source-selection audit events. It is lexical—not vector RAG—and is not connected to an LLM prompt.

## Validation at this checkpoint

- `npm test`: **198/198 passing**.
- `npm run build`: passed.
- `npm run test:sites`: **4/4 passing**.
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

1. Extend SEC-08 fail-closed behavior to background processing completion/failure and any remaining scheduler-only state paths. The request path is atomic now, but the traceability matrix deliberately remains partial until those paths and broader audit-sink outage behavior are covered.
2. Build a bounded retrieval layer for previous meetings: require a strict query and result limit, retrieve only after authorization, return citation-sized excerpts with meeting/source IDs, and audit each selected source. Keep it lexical until an approved local embedding model and a tenant-isolated vector-index lifecycle (creation, deletion, rebuild, backup handling) are implemented. Never send retrieval output to either external summary provider without its approval packet covering that new data flow.
3. Define a PostgreSQL deletion-remnants strategy for PRIV-05 (for example, documented `VACUUM` scheduling or per-recording crypto-shredding) and update the operator documentation.
4. Reduce cross-device capture-stop latency with a lightweight lease-status poll during capture.

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
