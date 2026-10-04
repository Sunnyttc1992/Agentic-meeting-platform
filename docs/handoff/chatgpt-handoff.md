# Handoff prompt for ChatGPT

Paste everything below the line into ChatGPT (or Codex) at the start of the session.

---

You are taking over an in-progress project from another AI coding assistant. Read this whole prompt before changing anything.

## Project

**smart-meeting-platform** (`D:\Data Science Project\smart-meeting-platform`, Windows, Node 24, React 19 + Vite 6, no TypeScript). It's an executive meeting-intelligence app. It records a meeting with consent, transcribes it, and produces a cited summary, decisions, risks, open questions, and an action plan. Every generated item must link back to the transcript segments that support it.

Read these first, in order:
1. `AGENTS.md`: project rules and **durable product decisions**. Follow them unless I explicitly change them.
2. `CONTEXT.md`: domain vocabulary (Tenant, Principal, Recording Lease, Knowledge Assertion, Transcript Citation, and so on). Use these terms.
3. `server/README.md`: how to run the real pipeline and its settings.
4. `docs/security/local-meeting-pipeline.md`: data flow, controls, and what still blocks wider delivery.
5. `docs/acceptance/meeting-intelligence-traceability.md`: the 40-requirement acceptance matrix (CAP / AUTH / PRIV / SEC / AI) we measure progress against.

## Decisions already made (do not reverse without asking me)

- Visual direction is the "Executive Ledger" look: graphite surfaces, warm copper accents, Cormorant Garamond + Manrope.
- Microsoft Teams is the first integration and must stay explicitly *unconnected* until a server-side Entra/OAuth app exists. No Zoom anywhere.
- Speech-to-text is **local Whisper** (`@huggingface/transformers`, ONNX, in the Node server). Meeting audio must never leave the machine.
- Summary and action plan come from **Claude via the Anthropic API** (`@anthropic-ai/sdk`, model `claude-sonnet-5-5`, see `server/intelligence.js`). Only transcript text, participant IDs, and the meeting date are sent. If I ask you to change the summary model or provider, confirm with me first and update `AGENTS.md`.
- Delivery is **local only** for now. The preview server binds to 127.0.0.1, and the API also checks for a loopback socket and Host header (`server/local-only.js`). Do not expose it on a LAN or deploy it until Microsoft Entra sign-in replaces the development `x-tenant-id` / `x-user-id` headers.

## Security rules we agreed (non-negotiable)

- Authorization happens before retrieval. Tenant comes from identity, never from request IDs. Cross-tenant IDs must look like nonexistent IDs.
- Never record without current consent from every required participant and a recordable classification. Never-record categories fail closed.
- Recording leases stay short-lived (5 minutes). The UI renews them, and every renewal re-checks policy.
- Processor and model output is **untrusted**:
  - The platform re-validates citations, withholding and counting unsupported items.
  - It keeps owners only if they are meeting participants, and deadlines only if they are real dates.
  - It enforces size limits.
  - Failures collapse to `PROCESSOR_FAILED` and store nothing.
- Audit events contain identifiers and reason codes only. They never contain transcript text, audio, prompts, or secrets. They are hash-chained per tenant (`server/audit.js`).
- No secrets in the browser, in source, or in audit. Keys are read only on the server from the environment.
- Be honest in the UI: fakes are labeled as fakes, unknown speakers are "Speaker not identified", and missing owners or dates are "Unassigned" / "Not stated".

## Code map

- `server/platform.js`: `MeetingIntelligencePlatform`, the core domain service. Every operation is audited.
- `server/policy.js`: the authorization and capture policy engine.
- `server/storage.js`: the tenant-scoped storage contract. The in-memory adapter is a prototype; production needs Postgres, object storage, and KMS.
- `server/speech.js`, `server/transcription.js`, `server/intelligence.js`, `server/wav.js`: the processing pipeline.
- `server/http.js`, `server/local-preview.js`, `server/development.js`: the HTTP API, the local server, and dev wiring.
- `src/App.jsx`: the Executive Ledger UI. `src/RecordingStudio.jsx` is the capture-to-results flow. `src/styles.css` is dense one-line-per-area CSS; keep that style.
- Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact (Sites handoff).

## How to work

- Run tests with `npm test` (136 tests, all passing at handoff). `npm run test:server` runs only the server tests.
- Build and run locally with `npm run build` then `npm run preview` (http://localhost:4173). The first transcription downloads the Whisper model into `.cache/models`. Copy `.env.example` to an ignored local `.env` and set `ANTHROPIC_API_KEY` for summaries; without it the app runs transcription only. `.env` is loaded only by Node, never the Vite client.
- Before a Sites handoff: `npm run build && npm run test:sites`. The build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
- Add or update a test for every behavior change, especially security behavior. Match the existing test style (`node:test`, `assert/strict`, canary strings to prove nothing leaks).
- Gotchas:
  - Headless Chrome won't render narrower than 500px; use an iframe or the DevTools protocol for phone-width checks.
  - A preview server may already be running on port 4173. Restart it after server changes.
- Create a safe Git checkpoint before work can be interrupted. Never commit `.env`, `.cache/`, `node_modules/`, `.npm-cache/`, `dist/`, or any key. `.env.example` is safe to commit.

## Status and next steps

Done:
- The Executive Ledger UI, with design QA passing.
- Consent-gated recording with lease renewal.
- Local Whisper transcription.
- Claude summary and action plan with citation validation.
- The tenant-scoped storage contract with an outbox.
- The tamper-evident audit chain.
- Management briefing, commitments, and privacy access views.

Rough progress: the UI prototype is about 85–90% done. The secure prototype milestone is about 60% of the acceptance matrix, proven with in-memory stores and fakes. The production-ready product is about 20% done.

Not yet verified live: a real Claude call (no API key was available). The request shape follows the official SDK docs and is tested with a stand-in client. Watch the first real run.

Suggested next work. Ask me which one; items 1–3 need my input:
1. Microsoft Entra sign-in. This is what unblocks colleagues using it. It needs my tenant ID and app registration.
2. Durable storage (PostgreSQL + encrypted object storage + KMS). It needs my choice of driver and hosting.
3. Confirm Anthropic data-retention and processing terms for meeting transcripts.
4. Done (Claude, 2026-10-03): retry for failed processing. `retryProcessing` is organizer-only, audited as `recording.process.retry`, limited to 3 attempts in total, and re-checks consent and policy (it quarantines instead of retrying after a withdrawal). The route is `POST /meetings/:id/recordings/:rid/retry`, and status reports `retryAvailable`. The studio now shows a "Processing failed" panel with Retry.
5. Done (Claude, 2026-10-03): secure export (SEC-06).
   - The route is `GET /meetings/:id/export`. `exportMeetingRecord` and policy `meetingExport` restrict it to participants: managers can view a meeting but not export it.
   - The renderer is `server/meeting-export.js`. It escapes Markdown, HTML, and auto-links, and adds a confidentiality notice and the audit correlation ID.
   - The client helper is `src/meetingExport.js`. It is wired to the ledger's "Download meeting record" button and to the results screen.
   - Tests are in `server/export.test.js`.
6. Done (Claude, 2026-10-03): retention expiry (PRIV-04).
   - Rules are `PolicyEngine({ retentionPolicies })`. Use is blocked at expiry with `RETENTION_EXPIRED`.
   - `enforceRetention(tenantId)` deletes expired content under `service:retention` through the shared `#disposeMeetingContent` path. Legal hold blocks it, and re-running does nothing.
   - The local preview sweeps every minute. Tests are in `server/retention.test.js`. Details are in `docs/security/retention-deletion.md`.
7. Done (Claude, 2026-10-03): API rate limits (AUTH-10).
   - `server/rate-limit.js` defines per-principal, per-class fixed windows: processing and retry 6/min, capture 30, export 10, AI 30, standard 600. They are applied in `createHttpHandler` before platform work.
   - An excess request returns 429 with `Retry-After` and is not audited.
   - The studio's status poll skips a throttled tick instead of failing.
   - Tests are in `server/rate-limit.test.js`.
8. Done (Claude, 2026-10-03; user chose local storage with a generated key file): local durable storage.
   - `server/adapters/sqlite.js` stores data in `.data/` using `node:sqlite`. Audio is encrypted with AES-256-GCM, bound to tenant and recording. The audit table is append-only through database triggers.
   - Both backends share `composeRepositoryStorage` in `storage.js`.
   - `recoverInterruptedProcessing` runs at startup. The demo meeting is seeded only once. The Vite dev server opens `.data/vite-dev/` lazily.
   - Tests are in `server/durable-storage.test.js`.
9. Done (Claude, 2026-10-03; user chose self-hosted PostgreSQL, built and tested now).
   - **Async core.** The platform core is now async; storage transactions may be async and are serialized for in-memory and SQLite.
   - **Adapter.** `server/adapters/postgres.js` and `postgres-schema.js` provide forced per-tenant RLS, a least-privilege role check at startup, an append-only audit trail with an advisory-locked sequence, AES-GCM audio in `bytea`, and versioned migrations (`npm run db:migrate`).
   - **Configuration.** `DATABASE_URL` plus `MEETING_AUDIO_KEY_FILE` select PostgreSQL in `server/storage-config.js`; otherwise SQLite.
   - **Tests.** `server/postgres-storage.test.js` runs on PGlite (real Postgres in WASM) as a non-owner role, and drives the real `pg` driver over the wire through `@electric-sql/pglite-socket`.
   - **Runbook.** `docs/architecture/self-hosted-postgres.md`.
10. Every remaining roadmap item needs a decision from me: Entra sign-in, Anthropic data terms, speaker diarization, or operating the database (backups, monitoring, key rotation). Ask before starting any of them.

Start by reading the files listed above. Run `npm test` to confirm a green baseline, then tell me what you plan to do before making large changes.
