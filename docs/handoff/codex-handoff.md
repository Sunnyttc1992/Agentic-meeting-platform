# Handoff prompt for Codex

Paste everything below the line into Codex at the start of the session. Codex also reads `AGENTS.md` automatically.

---

You are taking over an in-progress project from another AI coding agent. Read this whole prompt, then the files it lists, before changing anything.

## Project

**smart-meeting-platform** (`D:\Data Science Project\smart-meeting-platform`, Windows, Node 24, React 19 + Vite 6, plain JavaScript ES modules, no semicolons). It's an executive meeting-intelligence app. It records a meeting with consent, transcribes it locally with Whisper, and has Claude write a cited executive summary, decisions, risks, open questions, and an action plan. Every generated item links to the transcript segments that support it.

Git: branch `master`. All work is committed (latest: `68af610`). The untracked files (`.squad/`, `.vscode/`, `.copilot/`, `.npmrc`, `.prototype-seed/`, `design-qa.md`, `implementation-1440x1024.png`, `.github/skills/secret-handling/`) are local-only on purpose; never commit them.

## Read first, in order

1. `AGENTS.md`: rules and **durable product decisions**. Follow them unless I explicitly change them.
2. `CONTEXT.md`: domain vocabulary (Tenant, Principal, Recording Lease, Knowledge Assertion, Transcript Citation, and so on). Use these terms.
3. `server/README.md`: how to run the pipeline, settings, and storage.
4. `docs/security/local-meeting-pipeline.md`: data flow, controls, and what still blocks wider delivery.
5. `docs/architecture/self-hosted-postgres.md`: production database runbook.
6. `docs/acceptance/meeting-intelligence-traceability.md`: the 40-requirement acceptance matrix (CAP / AUTH / PRIV / SEC / AI).

## Decisions already made (do not reverse without asking me)

- **UI:** the "Executive Ledger" look (graphite surfaces, copper accents, Cormorant Garamond + Manrope).
- **Teams:** Microsoft Teams is the first integration and stays *unconnected* until a server-side Entra app exists. No Zoom anywhere.
- **Speech-to-text:** local Whisper (`@huggingface/transformers`) in the Node server. Audio never leaves the machine.
- **Summary and action plan:** Claude via the Anthropic API (`claude-sonnet-5-5`, `server/intelligence.js`). Only transcript text, participant IDs, and the meeting date are sent. Keys stay server-side.
- **Storage:**
  - Local SQLite in Git-ignored `.data/` by default.
  - **Self-hosted PostgreSQL** when `DATABASE_URL` is set. It connects as a least-privilege role, with row-level security per tenant enforced by the database.
  - Recording audio is AES-256-GCM encrypted with a key file. Never commit `.data/`, keys, or `.env`.
- **Delivery:** local only. The API accepts only loopback requests (`server/local-only.js`) until Microsoft Entra sign-in replaces the development `x-tenant-id` / `x-user-id` headers. Do not expose it on a LAN or deploy it before Entra exists.

## Security rules (non-negotiable)

- **Authorization:** authorize before retrieving. The tenant comes from identity, never from request IDs. Cross-tenant IDs must look like nonexistent ones.
- **Consent:** never record without current consent from every required participant and a recordable classification. Leases stay short-lived (5 minutes). The UI renews them, and every renewal re-checks policy.
- **Untrusted output:** processor and model output is re-validated by the platform.
  - Unsupported items are withheld and counted.
  - Owners must be meeting participants; deadlines must be real dates.
  - Failures become `PROCESSOR_FAILED`, and nothing is stored.
- **Audit:** events are content-free (identifiers and reason codes only), hash-chained per tenant, and append-only (database triggers in SQLite and PostgreSQL).
- **Export:** only participants can export (`EXPORT_FORBIDDEN` for managers); exported text is Markdown-escaped. Retention expiry blocks use immediately and is then deleted by a sweep, unless a legal hold applies.
- **Limits and secrets:** rate limits are enforced per principal (`server/rate-limit.js`). No secrets in the browser, source, or audit.
- **Honest UI:** fakes are labeled as fakes, unknown speakers are "Speaker not identified", and a missing owner or date shows "Unassigned" / "Not stated".

## Architecture you must respect

- **Core.** `server/platform.js` (`MeetingIntelligencePlatform`) is **asynchronous**. Every storage call is awaited, and every public method returns a promise.
- **Storage contract.** `server/storage.js`:
  - `composeRepositoryStorage` wraps any backend in the one shared, sealed tenant facade.
  - `createSerializedTransactionRunner` gives in-memory and SQLite one-at-a-time transactions, with nested calls joining the outer one.
  - Backends: `server/adapters/in-memory.js`, `sqlite.js`, and `postgres.js` (+ `postgres-schema.js` migrations), with `audio-encryption.js` shared. `server/storage-config.js` picks the backend.
- **Pipeline.** `server/speech.js`, `transcription.js`, `intelligence.js`, `wav.js`. The browser converts audio to 16 kHz mono WAV (`src/audioTranscode.js`), and the server validates it.
- **HTTP.** `server/http.js` is the API, `server/local-preview.js` serves the app, and `server/development.js` seeds the demo meeting and recovers interrupted jobs.
- **UI.** `src/App.jsx` (ledger) and `src/RecordingStudio.jsx` (consent → record → results, retry, download). `src/styles.css` is dense one-line-per-area CSS; keep that style.
- **Sites handoff.** Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact.

## How to work

- **Tests.** `npm test` runs 175 tests (about 25 seconds), all green at handoff. PostgreSQL tests run on PGlite (real Postgres in WASM) as a non-owner role and need no server.
- **Running.** `npm run build`, then `npm run preview` (http://localhost:4173). Run it yourself and check in a browser. Set `ANTHROPIC_API_KEY` in `.env` for summaries; without it the app runs transcription only. `npm run db:migrate` applies PostgreSQL migrations (see the runbook).
- **Before a Sites handoff:** `npm run build && npm run test:sites`.
- **Tests per change.** Add or update a test for every behavior change, especially security behavior. Match the existing style (`node:test`, `assert/strict`, canary strings to prove nothing leaks).
- **Gotchas:**
  - In semicolon-free code, never start a statement with `(`; use `await x` rather than `(await x)` at statement level.
  - `git checkout` rewrites files with CRLF line endings on this machine. Normalize them before scripted edits.
  - Headless Chrome won't render narrower than 500px; use an iframe or DevTools-protocol emulation for phone widths.
  - A preview server may already be running on port 4173. Restart it after server changes.
- **Commits.** Commit validated work in small commits on `master` (the `AGENTS.md` checkpoint rule). Never commit secrets, `.data/`, `.cache/`, `node_modules/`, or `dist/`.

## Status

**Done:**
- the Executive Ledger UI (design QA passing),
- consent-gated recording with lease renewal,
- local Whisper transcription,
- the Claude summary and action plan with citation validation,
- retry for failed jobs,
- secure participant-only export,
- retention expiry with scheduled deletion,
- per-principal rate limits,
- the tamper-evident audit chain,
- durable SQLite storage with encrypted audio,
- the async core,
- self-hosted PostgreSQL with database-enforced tenant isolation.

**Progress estimate:**
- UI prototype: about 85–90%.
- Secure prototype milestone: about 62% of the acceptance matrix.
- Production readiness: about 30%. Storage is real now; identity, operations, and broader controls are not.

**Not verified live:** a real Claude call (no API key was available). The request shape follows the official SDK docs and is tested with a stand-in client.

## Next steps (ask me first; each needs my input)

1. **Microsoft Entra sign-in.** This is what unblocks colleagues. It needs my tenant ID and an app registration.
2. **Anthropic data terms.** Confirm data retention and processing terms for meeting transcripts.
3. **Speaker identification** (a diarization model plus roster confirmation).
4. **Operating PostgreSQL:** backups, monitoring, high availability, and audio-key rotation.

Start by reading the files above and running `npm test` to confirm a green baseline. Then tell me your plan before making large changes.
