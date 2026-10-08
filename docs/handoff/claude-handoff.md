# Handoff for Claude

Read this file, then `AGENTS.md`, before changing the project. This is the current continuation brief as of 2026-10-06.

## Project and checkpoint

- Repository: `D:\Data Science Project\smart-meeting-platform` on branch `master`.
- Latest functional code checkpoint: `509e921 Add organizer summary regeneration with versions` (before that `2779296 Add local bge-m3 embeddings for hybrid chat retrieval`) (meeting chat began at `cc12c97`; before that `5ea85a0 Show every recording of a meeting in the studio`) (Claude session of 2026-10-06 began after `474d72d`; feature delivery began at `5390d5a`). The commit that updates this handoff follows it.
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
15. The browser no longer starts in a seeded scenario. `LocalMeetingWorkspace` creates and lists durable local meetings through same-origin `POST`/`GET /meetings`, then opens the selected real record in the recording studio. The server derives tenant and organizer from the local development identity, validates the bounded create payload, filters the list to active participant records, and keeps meeting-list audit events content-free. The legacy no-title `meeting-1` record is hidden rather than deleted.
16. Background processing policy revocation now fails closed on an audit outage. A recording quarantine, its derived-content clearing, and its content-free `recording.process.complete` denial audit run in one tenant transaction. If audit append fails, the queued recording and outbox remain unchanged; a later policy recheck still prevents processing.
17. PostgreSQL recording audio now has a live key-file availability boundary. Startup refuses a missing/invalid key; each audio read/write re-verifies the configured file and rejects a missing, malformed, or changed key with `RECORDING_CONTENT_UNAVAILABLE` before writing ciphertext or returning audio. The file is pinned to its startup value, so an in-place replacement is treated as an outage rather than an unsafe pseudo-rotation. This is not a KMS/HSM or automatic rotation implementation.
18. `npm run verify:release -- --preview=4173` now produces a secret-free JSON release-evidence record. It runs `npm test`, the production build, and Sites package tests; verifies the required build artifacts; optionally checks the already-running loopback shell; records the release commit and clean tracked-worktree state; and lists the organization-controlled launch gates separately. It deliberately does not inspect `.env`, credentials, keys, transcripts, or meeting data.
19. `npm run smoke:browser` starts a temporary SQLite-backed loopback preview **without loading `.env`**, drives headless Chrome through the real workspace's create-meeting, consent, preflight, microphone capture, stop, and local-review sequence, then terminates the server and deletes the temporary data. It asserts the local review player is present. `npm run smoke:browser -- -ProcessRecording` additionally confirms the synthetic audio, then asserts completed local Whisper processing with a non-empty transcript. Neither mode may point at an existing server holding real meetings.
20. The local workspace creates a correlation ID per request. A failure now reports only a safe transport/status message and that reference, so a local operator can identify a request without exposing credentials or meeting content.
21. A meeting can hold several recordings (a stopped capture needs a fresh preflight). Completing or failing one recording now replaces only that recording's segments and the assertions citing them; other recordings' knowledge is rewritten unchanged in the same tenant transaction, and commitments are re-derived from the whole meeting. Previously a second recording silently erased the first recording's transcript, decisions, and actions, and `GET /meetings/:id/recordings/:rid` returned the meeting-wide knowledge under the wrong recording. It now returns only that recording's segments and the assertions whose citations all reference them. Policy-revocation quarantine still clears the whole meeting on purpose.
22. **Per-recording audio keys (crypto-shredding).** New audio is key version 2: encrypted under its own random key, wrapped by the master key, and stored as one hashed-name file outside the database (`.data/keys/recordings/` for SQLite; `MEETING_RECORDING_KEY_DIR`, default `.data/recording-keys`, for PostgreSQL). Deleting content destroys the key, so dead tuples and restored backup rows cannot be decrypted. Version 1 audio stays readable. `server/adapters/recording-keys.js`, `server/recording-keys.test.js`.
23. **Revocation sweep** (`server/revocation.test.js`): grant expiry, withdrawal, hierarchy change, and participant removal deny every read surface on the next call. No defect found; AUTH-03 is now done at M.
24. **Whisper silence phrases** are also dropped over intermittent clicks (Chrome's fake microphone: a ~40 ms beep every 500 ms). The processing smoke now expects "No speech was recognized" for that audio; before, it was asserting the hallucination.
25. **Speaker labels:** `npm run benchmark:diarization` (synthetic TTS crosstalk, interjections, silences, rapid exchange). Fewer than two diarization labels now leaves every segment `UNATTRIBUTED`, because pyannote merged two voices in a rapid exchange. Result: 0/26 segments credited to the wrong voice.
26. **Summary evaluation** grew to 16 cases (44 checks). Two prompt clarifications (accepted request to a named participant sets the owner; withdrawn tasks and "do not" actions are not actions) took gpt-5.5 from 43/45 to 44/44.
27. **Real-audio benchmark:** `npm run benchmark:real-audio -- --audio <wav>` scores a reading of `evals/real-audio-script.txt` locally. It found and fixed Whisper repeating neighbouring sentences in a squeezed segment at its 30 s window boundary (WER 15.6% to 2.2% on a TTS reading).
28. **Prototype ZIP** now uses forward-slash entry names; a simulated clean install passed (see `docs/operations/local-prototype-distribution.md`).
29. **Studio lists every recording of a meeting** (status-only `GET /meetings/:id/recordings`) and opens an earlier recording's results in a panel below the capture area.

30. **Meeting chat (RAG)** in the workspace ("Ask your meetings"; `GET`/`POST`/`DELETE /chat/messages`). User decisions: answers by OpenAI or Claude via a separate `MEETING_CHAT_PROVIDER` opt-in, retrieval across every meeting the asker may read, history saved per user. The provider receives only the question, at most 12 excerpts labelled with anonymous meeting letters and dates, and up to 4 earlier readable turns; only citations to excerpts actually sent survive. Saved turns are hidden while any source meeting is unreadable and deleted with it. Retrieval, embedding, and the provider call run outside the database transaction. PostgreSQL migration `002_chat_turns`.
31. **Hybrid retrieval with local embeddings:** `bge-m3` through Ollama on this computer (loopback-only client), vectors in `knowledge_embeddings` (migration `003_knowledge_embeddings`, tenant RLS), built lazily for readable meetings and cleared whenever knowledge is replaced, quarantined, or deleted. Keyword and vector rankings are fused by reciprocal rank fusion (similarity floor 0.45, top 6). Falls back to keywords without Ollama or migration 003.
32. **RAG evaluation:** `npm run eval:rag` (retrieval, local, floor in `npm test`), `-- --keyword` for the baseline, `-- --answers` for answer scoring through the chat provider. Hybrid vs keyword on the synthetic set: paraphrase recall 0.90 vs 0.47, overall recall 0.95 vs 0.76, MRR 0.93 vs 0.77, fact coverage 1.00 vs 0.82, abstention 1.00 vs 0.87, leaks 0.

33. **Ask page** (`#/ask`, user feedback): chat has its own page laid out like the studio; the workspace links to it.
34. **Chat guardrail layer** (`server/guardrails.js`): question validation, per-user daily limit, personal-data redaction of everything sent, valid-citation filter, grounding check (unmatched numbers and statements are highlighted; an answer with no grounded statement is withheld), audited as `chat.guardrail` by code.
35. **Chat memory layer** (`server/chat-memory.js`): 4 recent turns plus up to 2 related older turns recalled by local bge-m3 similarity (0.48, calibrated), 90-day retention enforced by the sweep, per-turn Forget.
36. **Speaker naming** (CAP-05, user decisions 2026-10-07): per-recording, versioned, audited; organizer names or corrects, others self-claim, the named person can dispute; display only (never owners); confirmed names go to the chat provider. "Who spoke" panel in the studio.
37. **Disk incident (2026-10-07):** drive C: reached 0 GB, which surfaced as a PGlite `ErrnoError 51` (WASI ENOSPC) in the on-disk PostgreSQL test. 45 leftover test folders were removed and the browser smoke now deletes its Chrome profile. The user freed space (14 GB free). Ollama's models (27.8 GB) are still on C:; moving them with `OLLAMA_MODELS` is the user's decision.

38. **Neighbouring context for short fragments** (`1462faf`): a transcript excerpt under 25 words is sent with the lines before and after it in the same recording, each with its own speaker. No measurable gain on the small synthetic set (all fragments are retrieved there anyway); expected to help in long real meetings.
39. **Summary regeneration** (`509e921`, CAP-10): organizer-only "Rewrite summary", confirmed names sent to the summary provider (user decision), same normalization, versioned IDs, last three versions kept with a "What changed" list.
40. **Owner rule enforced in code:** an action keeps an owner only when the cited lines name that participant. Found in a live run where the model made a confirmed speaker the owner of "I will send...".

### Decisions Claude made on the night of 2026-10-07, for review

- Regeneration does not require a fresh consent window (consent expires after 4 hours), only that every required participant's latest decision is still "granted", the meeting is active and recordable, and the policy is unchanged. Rationale: it reprocesses audio already captured with consent and records nothing new.
- Owners must be named in the cited transcript lines (applies to first processing too). A participant ID that is never spoken (for example `j.smith`) can therefore never be an owner.
- "What changed" treats two items sharing at least half their words as the same item, so rewording is not reported as a dropped decision.
- No GitHub push: the repository has no remote and the GitHub CLI is not signed in. Verified git bundles of the full history are in `D:\MeetingLedger-backups\` instead.

### State of this computer's installation (2026-10-06)

- PostgreSQL is migrated to `003_knowledge_embeddings` (the user ran `npm run db:migrate` as `ledger_owner`; the owner URL needs `?sslmode=verify-full&sslrootcert=C:/ProgramData/MeetingLedger/certs/root-ca.pem`, because `pg_hba.conf` accepts only encrypted connections).
- `.env` now sets `MEETING_CHAT_PROVIDER=openai` (user decision, accepting that excerpts of the existing meetings go to OpenAI as their summaries already did). Ollama serves `bge-m3` locally.
- The app runs at `http://localhost:4173`; stale Codex previews on other ports were stopped.

### Suggested next work for chat

- Join each matched transcript line with its neighbouring lines before sending it: short Whisper fragments ("case or start for meetings.") give the answer model little context. Re-run `npm run eval:rag -- --answers` before and after.
- A retention rule for chat history itself, and a backup-retention review for vectors.
- pgvector only when meeting volume makes in-process similarity slow.

### Decisions Claude made while the user was offline (2026-10-06), for review

- Per-recording keys live in a server-writable folder outside the DB dump, not beside the read-only master key; that folder is deliberately excluded from database backups.
- A key file is destroyed when deletion runs, not at commit: a rolled-back deletion leaves unreadable audio (fail closed).
- Diarization with fewer than two labels is withheld entirely (conservative; it also drops some correct single-label results).
- No speaker-count hint is passed to pyannote: `min_speakers` from the participant list would split one-speaker meetings.
- CAP-10 rescinded-decision lineage and recomputation versioning were not built: lineage would send earlier knowledge to the summary provider (a new data flow), and completed recordings cannot be reprocessed.
- The summary evaluation was run three times against OpenAI with synthetic transcripts only (small API cost, approved by the user for this task).

## Validation at this checkpoint

- `npm test`: **286/286 passing** after neighbouring context and summary regeneration (278/278 after the guardrail, memory, and speaker-naming layers ; 259/259 after meeting chat and hybrid retrieval; 236/236 before chat). `npm run test:sites` 4/4; `npm run build` passed.
- `npm test`: 208/208 passing at the multi-recording fix (three new regression tests across in-memory, SQLite, and PostgreSQL/PGlite; each failed before the fix).
- `npm run smoke:browser` and `npm run smoke:browser -- -ProcessRecording` passed with zero browser errors after the multi-recording fix.
- `npm run build`: passed.
- `npm run test:sites`: **4/4 passing**.
- Parsed all three new PowerShell scripts and ran `bash -n scripts/setup-windows-postgres.sh`.
- Export smoke test produced a 134-entry ZIP with the installer/run scripts and `.env.example`, while excluding real `.env` files, `.data`, keys, model caches, dependencies, build output, and Git history. A PostgreSQL-backed local preview also returned `200` from authenticated `/pipeline/readiness` on loopback.
- Durable SQLite, PostgreSQL/PGlite, and node-postgres wire-protocol suites passed after the audit-boundary change.
- PostgreSQL key-resilience tests prove missing startup configuration is rejected, a missing configured key is never regenerated, and runtime key-provider loss rejects reads/writes before ciphertext is read or persisted.
- The release-evidence command was exercised on Windows with `--allow-dirty --preview=4173`: all technical checks passed, the loopback shell returned `200` with `Cache-Control: no-store`, and it correctly reported that a dirty worktree cannot be a release candidate.
- The isolated browser smoke completed on Windows with zero browser errors/warnings. It created a synthetic meeting only in its temporary SQLite store, required two explicit consents, reached ready/recording/stopped, and exposed a local audio-review player.
- The isolated browser smoke's optional `-ProcessRecording` run completed local Whisper transcript-only processing with one synthetic transcript segment, zero browser errors/warnings, and automatic cleanup of its temporary server/data.
- After the safe local-request diagnostics change: `npm test` passed **205/205**; `npm run build`, `npm run test:sites` (**4/4**), and the isolated capture smoke also passed.
- `git diff --check`: passed before committing `341808e`.
- Earlier validation also passed `python -m py_compile server/diarize_worker.py` and `bash -n scripts/setup-windows-diarization.sh`.
- A prior synthetic two-voice local run completed Whisper, pyannote, and OpenAI end to end; labels were anonymous and the diarization temp directory was empty afterward.
- The local preview was restarted at `http://localhost:4173`. An exact replay of the browser's `Visa` create request with `Sunny, Anyarin` returned `201 Created`; the first browser error was consistent with submission during the server restart. Refresh once before retrying rather than creating duplicate records.

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

1. Run a real KMS/HSM integration and operational resilience exercise for SEC-08. Per-recording keys are wrapped by the master key file today; a KMS would replace that wrapping key.
2. Test the prototype ZIP on a clean second Windows computer: the simulated install covered packaging, `npm ci`, build, loopback binding, Host rejection, and fresh keys, but not the PostgreSQL wizard, model download, or diarization provisioning.
3. Record a real human reading of `evals/real-audio-script.txt` and run `npm run benchmark:real-audio` (local only; a colleague only with consent).
4. Keep prior-meeting retrieval lexical and citation-sized until an approved local embedding model and a tenant-isolated vector-index lifecycle (creation, deletion, rebuild, backup handling) are implemented. Never send retrieval output to either external summary provider without its approval packet covering that new data flow.

These require a user or organization decision first:

- approval to use a real meeting with an external summary provider;
- Microsoft Entra rollout, then Teams connection;
- a reviewed, reversible, audited speaker-correction/mapping interface;
- whether both LLM providers should remain supported.

## Non-negotiable implementation rules

- Authorize before retrieval; tenant identity comes from identity, never request IDs. Cross-tenant IDs must look nonexistent.
- Never record without current consent from every required participant and a recordable classification. Recheck policy when leases renew.
- Treat model output as untrusted and revalidate citations, owners, dates, labels, and model identifiers before storage.
- Keep audit data content-free and hash-chained. Do not weaken append-only safeguards.
- Preserve `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs`.
- Make small, scoped commits and validate with at least the relevant tests; before any Sites handoff run `npm run build` and `npm run test:sites`.
