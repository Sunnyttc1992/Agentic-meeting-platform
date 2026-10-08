# Backend foundation

This directory contains an authorization-first modular monolith for the first trusted meeting-intelligence slice. `MeetingIntelligencePlatform` is the external interface used by transports and tests. Policy decisions happen before protected records cross the retrieval seam; the AI retrieval method returns only authorized meeting bundles.

The included repositories, audit store, and fixed clock are in-memory adapters for executable tests, not production storage. Production work still requires durable tenant-partitioned database and object-storage adapters, transactional/outbox guarantees, immutable WORM-capable audit storage, enterprise identity verification, organization-directory synchronization, encrypted media ingestion, key management, retention/deletion workers, policy administration, full-text/vector indexes that preserve authorization partitions, observability, rate limiting, and a model gateway that accepts only the authorized context returned here.

The minimal HTTP adapter demonstrates authenticated-principal propagation through headers for local integration only. A production adapter must obtain the Principal from verified identity-provider tokens; it must never trust caller-supplied identity headers.

## Running the real pipeline (record → transcribe → summary and action plan)

```powershell
# Optional: copy .env.example to .env, then set ANTHROPIC_API_KEY locally.
# .env is ignored by Git and is loaded only into the local Node server.
Copy-Item .env.example .env
npm run build
npm run preview                          # http://localhost:4173, this machine only
```

Leave `ANTHROPIC_API_KEY` blank to run in transcript-only mode. The `dev` and
`preview` scripts use Node's `--env-file-if-exists=.env`, so a missing `.env`
is safe: startup still works and pipeline readiness reports
`anthropic.credentialsConfigured: false`. Do not add `VITE_` variables or
browser code that reads this key; this file is server configuration only.

Open **Test secure recording**, grant consent for both participants, record, stop, then choose **Process locally**. The first run downloads the Whisper model (about 150 MB) into `.cache/models`. After that, a one-minute meeting takes roughly ten seconds on a typical CPU. The result shows the executive summary, the action plan (with owner and due date only where they were stated), decisions, risks, open questions, and the transcript. Every item links to the transcript moments it cites. Actions also appear in **Commitments**.

| Setting | Default | Purpose |
|---|---|---|
| `MEETING_SUMMARY_PROVIDER` | unset | `openai`, `anthropic`, or `none`. Unset: Anthropic when its key is present, then OpenAI. A chosen provider without a key gives transcript-only, never the other provider |
| `OPENAI_API_KEY` | unset | Enables the OpenAI summary and action plan (Responses API, `store: false`) |
| `OPENAI_SUMMARY_MODEL` | `gpt-5.5` | OpenAI model used for the summary |
| `ANTHROPIC_API_KEY` (or an `ant auth login` profile) | unset | Enables the Claude summary and action plan |
| `ANTHROPIC_WORKSPACE_ID` | unset | Needed only for an organization-level Anthropic key that is not scoped to a workspace (not a secret) |
| `MEETING_SUMMARY_MODEL` | `claude-sonnet-5-5` | Claude model used for the summary |
| `WHISPER_MODEL` | `onnx-community/whisper-base` | Local Whisper model; `onnx-community/whisper-small` is more accurate but slower |
| `WHISPER_LANGUAGE` | `en` | Spoken language |
| `MEETING_PROCESSOR` | `local` | Set to `fake` for the deterministic development processor |
| `DIARIZATION_PYTHON` + `DIARIZATION_MODEL_DIR` | unset | Enables the local, offline pyannote Community-1 worker |
| `MEETING_DIARIZATION_TEMP_DIR` | system temp | Protected directory for the worker's per-job plaintext files (removed after each job) |

Meetings, consent, transcripts, action plans, and the audit trail are saved in `.data/meeting-ledger.sqlite`, so they survive a restart. Recording audio is stored encrypted (AES-256-GCM) under its own per-recording key. Those keys are wrapped by a master key generated on first run at `.data/keys/recording-audio-v1.key` and kept in `.data/keys/recordings/`; deleting a recording destroys its key, so no leftover copy of its audio can be decrypted. With PostgreSQL the per-recording keys go in `MEETING_RECORDING_KEY_DIR` (default `.data/recording-keys`).

- **Back up the key file.** If it is lost, stored audio can no longer be decrypted (transcripts and summaries are unaffected).
- **Never commit or share `.data/`.**
- **To start over,** stop the server and delete `.data/`.
- **Interrupted jobs:** a job interrupted by a restart comes back as "Processing failed" with **Retry**.
- **Other locations:** `MEETING_DATA_DIR` points the server at another folder. `npm run dev` uses `.data/vite-dev/`.
- **Self-hosted PostgreSQL:** set `DATABASE_URL` and `MEETING_AUDIO_KEY_FILE` to use PostgreSQL instead of SQLite. Setup, roles, TLS, migrations (`npm run db:migrate`), and backups are in [docs/architecture/self-hosted-postgres.md](../docs/architecture/self-hosted-postgres.md).
- **Windows PostgreSQL operations:** the Windows-specific TLS, backup/restore, monitoring, HA boundary, and audio-key-rotation guidance is in [docs/architecture/windows-postgres-operations.md](../docs/architecture/windows-postgres-operations.md). Run `bash scripts/setup-windows-postgres.sh` from Git Bash or WSL for the repeatable local setup flow.
- **Per-computer prototype:** package a separate loopback-only Windows instance with `npm run prototype:export`. Each recipient gets a distinct PostgreSQL database, audio key, and `.env`; see [the distribution guide](../docs/operations/local-prototype-distribution.md). It is not a shared deployment.
- **Local speaker diarization:** remains disabled until an operator provisions the approved Community-1 model. Run `bash scripts/setup-windows-diarization.sh` from Git Bash. It opens the gated-model approval page, installs an isolated local runtime, acquires the model once with an interactive token prompt, proves offline execution, and writes only three non-secret paths to `.env`. It never stores a Hugging Face token. See [the options and safeguards](../docs/architecture/local-speaker-diarization-options.md).

Recordings up to about 80 minutes are accepted. Data flow, controls, and the remaining blockers to wider delivery are documented in [docs/security/local-meeting-pipeline.md](../docs/security/local-meeting-pipeline.md).

### Evaluate the summary prompt

`npm run eval:summaries` sends sixteen short, invented transcripts (`evals/meeting-intelligence-cases.mjs`) to the configured provider and scores each prompt rule: committed vs proposed actions, named owners (including non-participants, who are never assigned), relative, absolute, and vague dates, prompt injection, small talk and filler, duplicates, unattributed speech, reversed decisions, risks and blockers, open questions, declined and cancelled tasks, and exact amounts. It costs real API credit and is never part of `npm test`; the scorer itself is unit-tested. `gpt-5.5` scored 44/44 on 2026-10-06, after two prompt clarifications (an accepted request addressed to a participant names the owner; withdrawn tasks and negative "do not" actions are not actions) fixed the two misses of the first run (43/45). Run it after any change to `SYSTEM_PROMPT`, `OUTPUT_SCHEMA`, or the model.

### Speaker naming

Local pyannote gives each recording anonymous labels (`SPEAKER_00`, ...). In a processed recording's **Who spoke** panel the organizer can name or correct any label as one of the meeting's participants, any other participant can claim an unnamed label as themselves ("That's me"), and the named person can dispute it ("Not me"), after which the organizer cannot restore that pairing. Routes: `PUT /meetings/:id/recordings/:rid/speakers/:label` (`{ participantId, version }`) and `DELETE` on the same path (`?version=`). Maps are per recording, versioned (a stale `version` gets `SPEAKER_MAP_CHANGED`), kept with their history on the recording, and audited as `speaker.map`, `speaker.unmap`, or `speaker.dispute` without content. Names are applied when content is read (transcript, meeting knowledge, export, chat sources, the speaker of an action) and never change an owner; confirmed names are sent with chat excerpts. A name whose participant leaves the meeting is ignored.

### Summary regeneration

The organizer can press **Rewrite summary** on a processed recording (`POST /meetings/:id/recordings/:rid/regenerate`). The stored transcript is sent again to the configured summary provider, with confirmed speakers shown as `SPEAKER_01, confirmed as sam`; the result passes the same normalization as first processing and is stored with versioned IDs (`<recording>-v2-assertion-1`, ...). The previous three versions are kept on the recording and the studio lists what was added and what is no longer listed. An action keeps an owner only if the cited lines name that participant. Regeneration needs an active, recordable meeting with unchanged policy and every required participant's latest consent still "granted" (an expired consent window alone does not block it). Earlier versions and speaker names are wiped when the meeting is deleted or the recording quarantined.

### Meeting chat

The workspace has an "Ask your meetings" panel (`GET`/`POST`/`DELETE /chat/messages`). Retrieval is hybrid. A question is split into keywords, and it is also embedded by a local `bge-m3` model through Ollama (`ollama pull bge-m3`; nothing leaves the computer). Every candidate meeting is authorized for the asker before its transcript, assertions, or vectors are read; vectors are built on first use and stored in `knowledge_embeddings`. A transcript excerpt shorter than 25 words is sent with the lines just before and after it in the same recording, each with its own speaker, because Whisper often splits a sentence into fragments; the grounding check counts those lines as sources. Keyword and meaning-based rankings are merged by reciprocal rank fusion (similarity floor 0.45, top 6 meaning-based matches) and the best 12 excerpts are kept. Without Ollama, or before PostgreSQL migration `003_knowledge_embeddings`, retrieval falls back to keywords. With `MEETING_CHAT_PROVIDER=openai` (or `anthropic`) and that provider's credentials, the provider writes a short answer that must cite the excerpts; otherwise the panel shows the excerpts only. History is saved per user, hidden while any meeting it drew on is unreadable, and deleted with that meeting. PostgreSQL needs migration `002_chat_turns` (`npm run db:migrate` as the owner); until then the app runs and chat reports `CHAT_NOT_MIGRATED`.

Chat runs through two explicit layers. The **guardrail layer** (`server/guardrails.js`) validates the question and applies a per-user daily limit (`MEETING_CHAT_DAILY_LIMIT`, default 200); redacts emails, phone numbers, and ID, case, card, and long account numbers from every excerpt and earlier turn before a provider sees them; keeps only citations to excerpts actually sent; and checks grounding: a number in the answer that appears in nothing that was sent, or a sentence far in meaning (local bge-m3) from the excerpts it cites, is highlighted for the reader, and an answer with no grounded sentence is withheld. Each triggered guardrail is audited as `chat.guardrail` with its code only. The **memory layer** (`server/chat-memory.js`) sends the last 4 readable turns plus up to 2 older turns recalled by local similarity (threshold 0.48, calibrated on bge-m3), expires history after `MEETING_CHAT_RETENTION_DAYS` (default 90; the retention sweep deletes it), and lets a user forget one turn (`DELETE /chat/messages/:id`) or clear all.

`npm run eval:rag` scores chat retrieval on a synthetic set (`evals/rag-cases.mjs`: six meetings, one restricted with a canary, fifteen labelled questions in keyword, paraphrase, multi-meeting, unanswerable, and restricted categories). It reports recall, precision, MRR, and nDCG at chat's 12-excerpt budget, spurious retrieval for unanswerable questions, and leakage, which must be zero. It is local and free, and its floor runs in `npm test`. `npm run eval:rag -- --answers` also scores written answers (citation precision and recall, key-fact coverage, correct abstention) through `MEETING_CHAT_PROVIDER` and costs API credit.

Results on 2026-10-06 (gpt-5.5 answers; `--keyword` reproduces the first row):

| Retrieval | Paraphrase recall | Overall recall | MRR | nDCG | Precision | Fact coverage | Abstention | Citation P / R | Leaks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Keywords only | 0.47 | 0.76 | 0.77 | 0.74 | 0.45 | 0.82 | 0.87 | 0.98 / 0.81 | 0 |
| Hybrid (keywords + bge-m3) | 0.90 | 0.95 | 0.93 | 0.93 | 0.37 | 1.00 | 1.00 | 0.96 / 0.88 | 0 |

With both layers on (2026-10-07, gpt-5.5): fact coverage 0.95, abstention 1.00, citation precision 0.96, leaks 0, and 0-9% of correct answers carried a grounding flag across runs (`flagged` in the report); the one missed fact was the model omitting "by Friday".

The similarity floor (0.45) and meaning-based top-k (6) came from a sweep over 0.45/0.50/0.55 and 4/6/12: higher floors lost paraphrase recall (0.73), and fewer matches raised precision without changing recall on this small set, so 6 was kept to avoid overfitting it.

`npm run benchmark:diarization` mixes Windows text-to-speech voices into five synthetic conversations (clean turns, crosstalk, interjections, long silences, rapid exchange), runs local Whisper and pyannote offline, and scores the anonymous speaker labels against the known timeline. It needs the local diarization settings, sends nothing off the machine, and fails if any segment is credited to the wrong voice. Results and findings are in [docs/architecture/local-speaker-diarization-options.md](../docs/architecture/local-speaker-diarization-options.md).

`npm run benchmark:real-audio -- --audio <recording.wav>` measures the local pipeline on a real recording of `evals/real-audio-script.txt` read aloud (record yourself, and a colleague only with their consent). Windows 11 Sound Recorder can save WAV (Settings > Recording format); any sample rate, mono or stereo, 16/24-bit PCM or 32-bit float is converted to 16 kHz mono in memory. It reports word error rate against the script and speaker-label coverage, runs only local Whisper and pyannote, calls no summary provider, and prints the transcript only with `--show-transcript`. A two-voice text-to-speech reading of the script (75 s, 44.1 kHz stereo) scored 2.2% word error rate with both voices found, after a fix for duplicated sentences at Whisper's 30-second window boundary (it was 15.6%).

### Check pipeline readiness without processing a meeting

With the local preview running, use the browser's existing local development identity or call the same-origin `GET /pipeline/readiness` route. It reports only whether the Whisper runtime is installed, a complete local model cache is present, the diarization runtime and model files are present, which summary provider is active, whether Anthropic or OpenAI credentials are configured, and that Teams remains disconnected. It does not download Whisper, send audio, contact Anthropic, or reveal paths, model names, IDs, or credential values. A missing `.env` or empty key honestly reports `anthropic.credentialsConfigured: false`; process a short non-sensitive test recording from `http://localhost:4173` to exercise transcript-only mode first.

## Local audio ingestion

The development pipeline issues opaque, short-lived, single-use recording leases; accepts strict recording metadata; verifies raw bytes against the declared media type, length, and lower-case SHA-256; and stores bytes only in the in-memory recording adapter. Processing crosses the `SpeechProcessor` seam. The development platform defaults to the real local pipeline above; `FakeSpeechProcessor` (`MEETING_PROCESSOR=fake`, and in tests) is intentionally deterministic and clearly labeled: it demonstrates timestamped segments, diarization labels, nullable verified identity, confidence, provenance, and citation integrity, but is not real STT or diarization.

Each lease and recording bind the current consent-policy version, meeting classification, authorization principals, required roster, retention state, and capture-policy configuration through a SHA-256 policy fingerprint. A change to any bound input revokes the lease; refreshing consent under a new policy version never makes an older lease usable. Queue admission and publication independently re-evaluate current capture policy, so a denial before or during processing moves the recording to protected quarantine and clears all derived knowledge before it can be read, searched, or retrieved for AI.

The speech processor is an untrusted boundary. Processor exceptions are collapsed to the allowlisted `PROCESSOR_FAILED` status and audit reason; exception codes, messages, names, and stacks are never persisted. Processor identity labels are allowlisted, output tenant/meeting scope and citations are rebuilt and validated, and participant identity is accepted only from authorized exact speaker-roster evidence. Diarization labels remain usable when identity is unverified, with `verifiedParticipantId: null`.

Routes are same-origin under `/meetings/:meetingId/recordings`. Every operation requires local development identity and correlation headers. Status returns transcript/assertion content only after current centralized policy checks and only once processing completes. Consent withdrawal, policy/retention changes, quarantine, and deletion remove derived knowledge from retrieval; deletion also clears audio bytes. Audit events contain identifiers, outcomes, reason codes, and correlation only—never bytes or generated text.

In this local adapter, policy quarantine preserves uploaded bytes for disposition or legal-hold handling while active/held. A retention transition to `pending-deletion`, `deletion-in-progress`, or `deleted` clears local bytes immediately. Production storage must implement the documented durable disposition workflow and lineage-wide deletion acknowledgements.

This is a local-development adapter, not production media storage. It intentionally lacks durable storage, authenticated identity, encrypted transport/object storage guarantees, durable queues, malware/media validation, real speech processing, multi-instance idempotency, and crash recovery.
