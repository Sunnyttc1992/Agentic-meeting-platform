# Handoff prompt for Codex

Paste everything below the line into Codex at the start of the session. Codex also reads `AGENTS.md` automatically.

Last updated 2026-10-06 by Claude (Opus 5.5) at commit `2441531`. This replaces the earlier Codex handoff.

---

You are taking over an in-progress project from another AI coding agent. Read this whole prompt, then the files it lists, before changing anything.

## Project

**smart-meeting-platform** (`D:\Data Science Project\smart-meeting-platform`, Windows 11, Node 24, React 19 + Vite 6, plain JavaScript ES modules, no semicolons). It is an executive meeting-intelligence app:

1. It records a meeting in the browser, after consent and a policy check.
2. It transcribes the audio locally with Whisper and labels anonymous speakers locally with pyannote Community-1.
3. An LLM (OpenAI by default now, Claude still supported) writes a cited executive summary, decisions, risks, open questions, and an action plan.

Every generated item links to the transcript segments that support it.

Git: branch `master`; all work is committed. The untracked paths `.copilot/`, `.github/skills/secret-handling/`, `.npmrc`, `.prototype-seed/`, `.squad/`, `.vscode/`, `design-qa.md`, and `implementation-1440x1024.png` are local-only on purpose. Never commit them.

## Read first, in order

1. `AGENTS.md`: rules and **durable product decisions**. Follow them unless the user explicitly changes them.
2. `CONTEXT.md`: domain vocabulary (Tenant, Principal, Recording Lease, Knowledge Assertion, Transcript Citation, and so on).
3. `server/README.md`: how to run the pipeline, every setting, readiness, and the summary eval.
4. `docs/acceptance/meeting-intelligence-traceability.md`: the 40-requirement matrix and its **implementation status table** (assessed 2026-10-06).
5. `docs/security/local-meeting-pipeline.md`, `never-record-policy.md`, `retention-deletion.md` (includes the deletion inventory), and both approval packets: `anthropic-api-processing-approval.md` and `openai-api-processing-approval.md`.
6. `docs/architecture/local-speaker-diarization-options.md` and `windows-postgres-operations.md`.

## Decisions already made (do not reverse without asking)

- **UI:** the Executive Ledger look (graphite surfaces, copper accents, Cormorant Garamond + Manrope).
- **Speech-to-text:** local Whisper. Audio never leaves the machine.
- **Speakers:** a local, offline pyannote Community-1 pilot (approved 2026-10-06).
  - It produces anonymous per-meeting labels only. Never voiceprints, enrollment, or automatic names.
  - The model lives outside the repository in `D:/MeetingLedger/diarization`.
- **Summary provider:** the user chose **OpenAI** (`MEETING_SUMMARY_PROVIDER=openai`, `gpt-5.5`) because the Anthropic account has no credit. Claude remains a supported provider.
  - Only these leave the machine: transcript text with anonymous speaker labels, participant IDs, and the meeting date.
  - OpenAI requests use `store: false`.
- **Real meetings:** the approval packets are drafts. Until the organization completes one, use the API key for synthetic tests only.
- **Storage:**
  - Local SQLite in `.data/` by default.
  - Self-hosted PostgreSQL on Windows when `DATABASE_URL` is set. It connects as a least-privilege role with database row-level security.
  - Audio is AES-256-GCM encrypted.
  - Hosted databases (Supabase and similar) are out of scope.
- **Delivery:** loopback only. Microsoft Entra is deferred until the company decides on rollout. Microsoft Teams stays explicitly unconnected. No Zoom anywhere.

## Security rules (non-negotiable)

- **Authorization:** authorize before retrieving. The tenant comes from identity, never from request IDs. Cross-tenant IDs look like nonexistent ones.
- **Consent:** never record without current consent from every required participant and a recordable classification. Leases are short-lived, and each renewal re-checks policy.
- **Model output is untrusted.** The platform re-validates it (`#normalizeProcessorResult` in `server/platform.js`). It:
  - withholds items whose citations don't match the transcript;
  - keeps owners only if they are participants, deadlines only if they are real dates, and speaker labels only if they label this transcript;
  - keeps the model ID only if it is a plain identifier.

  Any failure becomes `PROCESSOR_FAILED`, and nothing is stored.
- **Audit:** content-free, hash-chained per tenant, and append-only (database triggers).
- **Secrets:** never in the browser, source, `.env.example`, audit records, logs, or chat. Do not print `.env` values. When checking `.env`, print key names only.

## Architecture

- **Core:** `server/platform.js` (`MeetingIntelligencePlatform`). It is asynchronous, and every storage call is awaited.
- **Storage contract:** `server/storage.js`, with backends `server/adapters/in-memory.js`, `sqlite.js`, `postgres.js`, and `postgres-schema.js`.
- **Pipeline:** `server/speech.js` (`LocalMeetingProcessor`):
  1. `transcription.js` runs Whisper.
  2. `diarization.js` runs the pyannote worker `diarize_worker.py` and reconciles labels.
  3. The LLM adapter runs.
- **LLM layer:**
  - `server/intelligence.js`: the shared prompt (`SYSTEM_PROMPT`), strict `OUTPUT_SCHEMA`, transcript rendering (`prepareMeetingPrompt`), normalization (`normalizeMeetingIntelligence`), and the Claude adapter.
  - `server/intelligence-openai.js`: the OpenAI adapter (Responses API).
  - `server/development.js`: `summaryProvider()` chooses the provider.
- **HTTP:** `server/http.js` (API), `server/local-preview.js` (serves the app), `server/pipeline-readiness.js` (`GET /pipeline/readiness`, booleans only).
- **UI:** `src/App.jsx` (ledger dashboard; still static demo content) and `src/RecordingStudio.jsx` (consent, record, sensitive-topic stop, process, results).
- **Sites handoff:** keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact.

## What changed in the latest session (2026-10-06)

1. **Diarization provisioning.**
   - The Windows wizard (`scripts/setup-windows-diarization.sh`):
     - must run in Git Bash; plain `bash` from PowerShell opens WSL, and the wizard now refuses WSL;
     - accepts pasted Windows paths;
     - keeps the Hugging Face prompt in the terminal.
   - The worker decodes the server's PCM WAV in memory, so FFmpeg is not needed.
   - Measured on this CPU: 0.45× real time for inference.
2. **Clear-majority speaker rule:** a transcript segment takes a speaker label only if that label covers at least two-thirds of the speaker time in it (`DOMINANT_SPEAKER_SHARE`). Crosstalk and silence stay `UNATTRIBUTED`.
3. **Speaker-aware action plan.**
   - The model sees anonymous labels, renumbered by first appearance.
   - Each action is `committed` or `proposed` and may carry the unverified `speakerLabel` of whoever took it on.
   - The prompt has explicit rules for vague owners, relative dates, and duplicates.
   - Duplicates are merged in code (citations capped at 16).
4. **Second LLM provider:** OpenAI added. Readiness reports `summaries.provider`. Processing labels and modes name the actual provider. The model ID is recorded on every generated item's provenance and shown in the export and result header.
5. **Organization-level Anthropic keys:** supported via `ANTHROPIC_WORKSPACE_ID`.
6. **Capture stop (PRIV-02, CAP-02):** `POST /meetings/{id}/recording/stop` with `{"reason": "sensitive-topic" | "participant-request"}`.
   - Any participant may call it. It revokes the lease, records a content-free `captureStops` boundary, and quarantines not-yet-published recordings under that lease.
   - It deletes their audio unless the meeting is under legal hold.
   - Consent withdrawal records the same boundary.
   - The studio has a "Stop and discard: sensitive topic" control.
7. **Physical deletion in SQLite (PRIV-05):** `secure_delete` is on, and the WAL is checkpointed and truncated after delete commits. A raw-file canary test proves deleted text is gone while the server runs and after shutdown. The deletion inventory is in `docs/security/retention-deletion.md`.
8. **Append-only consent history (PRIV-03):** `consentHistory`, alongside the current `consentEvidence`.
9. **Summary eval:** `npm run eval:summaries` runs 7 invented cases and 20 checks. It costs API credit and is never part of `npm test`. `gpt-5.5` scored **20/20**.
10. **Live verification (synthetic audio only):** a 35-second two-voice text-to-speech WAV went through Whisper, pyannote, and OpenAI in 38.7 s. The summary was accurate, and the actions had the correct status, speaker label, and dates. Nothing was withheld, and the temp folder was empty afterwards.

## Current state of the local machine

- **`.env`** (key names only): `ANTHROPIC_WORKSPACE_ID`, `MEETING_SUMMARY_PROVIDER=openai`, `OPENAI_API_KEY`, `DIARIZATION_PYTHON`, `DIARIZATION_MODEL_DIR`, `MEETING_DIARIZATION_TEMP_DIR`, `MEETING_AUDIO_KEY_FILE`, `DATABASE_URL`.
  - `DATABASE_URL` was restored on 2026-10-06. It uses `meeting_app` at `localhost:5434/meeting_ledger` with `sslmode=verify-full` and `sslrootcert=C:/ProgramData/MeetingLedger/certs/root-ca.pem`.
  - PostgreSQL 18 runs as the Windows service `postgresql-x64-18`, listening on loopback only, with a certificate for `localhost`.
- **Preview server:** running on `127.0.0.1:4174` with the current code. On 2026-10-06 it reported `storage: PostgreSQL (DATABASE_URL)`, all readiness checks were true, the summary provider was `openai`, and a non-loopback Host header was refused with 403. Restart it with `PORT=4174`, `node --env-file-if-exists=.env server/local-preview.js`.
- **Browser automation:** unavailable in the previous sessions. Use HTTP checks against a temporary instance (for example `PORT=4180`, `MEETING_DATA_DIR=<scratch>`, `MEETING_SUMMARY_PROVIDER=none`).

## Validation baseline

- **`npm test`:** 195 tests, all passing (about 25 s). PostgreSQL tests use PGlite and need no server.
- **`npm run build` and `npm run test:sites`:** passing.
- **`python -m py_compile server/diarize_worker.py` and `bash -n scripts/setup-windows-diarization.sh`:** passing.

## Progress

- **Acceptance matrix, local proof (M):** about 76% (30.5 of 40).
- **Production integration (P):** about 13%.
- **Operational evidence (O):** 0%.

See the status table in the traceability doc. If you change the status of any requirement, update that table.

## Recommended next work (confirm with the user first)

Not blocked on a decision:

1. **SEC-08 / hard-rejection criterion 10.** `#audited` writes the audit event *after* the operation, so if the audit write fails, the change persists unaudited. Options:
   - (a) Write an "attempt" event first. Simple, but 29 tests look up events by correlation ID and would need updating.
   - (b) Run the operation and its audit inside one tenant transaction. This only works for SQLite today, because the PostgreSQL facade uses pooled clients per call.

   Pick one with the user, then add audit-sink-failure tests.
2. **PostgreSQL deletion remnants (PRIV-05):** deleted rows persist as dead tuples until `VACUUM`. Consider per-recording data keys (crypto-shredding) or an operator `VACUUM` schedule with a documented window.
3. **Cross-device stop latency:** a stop raised elsewhere reaches an open studio only at its next lease renewal. A lightweight lease-status poll during capture would close this.
4. **Dashboard:** `src/App.jsx` still shows hard-coded Q4 demo content. Wiring it to real processed meetings is the largest product gap. It needs design direction; follow the `AGENTS.md` design rules.

Needs a user or organization decision:

- the approval packets for real meetings;
- Entra sign-in;
- Teams;
- the reviewed speaker-correction screen (CAP-05);
- whether to keep both LLM providers.

## How to work

- Add or update a test for every behavior change, especially security behavior. Use `node:test` and `assert/strict`, with canary strings to prove nothing leaks.
- **Gotchas:**
  - In semicolon-free code, never start a statement with `(`.
  - Files are CRLF on checkout; normalize before scripted edits.
  - GNU `sed` treats `\|` as alternation, so use Python or the editor for edits containing `|`.
  - In shell heredocs passed through Python, `\n` inside JS template strings can turn into real newlines; check with `node --check`.
  - On Windows, import modules by `pathToFileURL(...).href`, not by drive path.
- **Commits:** small, validated commits on `master`, ending with the attribution line the user's tooling specifies. Never commit secrets, `.data/`, `.cache/`, `node_modules/`, `dist/`, or the local-only paths above.
- **Approach:** start by reading the files above and running `npm test`. Then tell the user your plan before making large changes.
