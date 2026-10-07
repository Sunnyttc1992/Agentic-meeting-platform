# Retention and deletion state machine

## States

```text
ACTIVE -> EXPIRED -> DELETION_QUEUED -> DELETION_IN_PROGRESS -> DELETED
   |          |             |
   +------> LEGAL_HOLD <-----+
   |
   +------> QUARANTINED_PENDING_DISPOSITION -> DELETION_QUEUED | LEGAL_HOLD | ACTIVE_RESTRICTED
```

| State | Read behavior | Required behavior |
|---|---|---|
| `ACTIVE` | Policy-authorized | Retention deadline and lineage present |
| `ACTIVE_RESTRICTED` | Category-specific grant only | Excluded from general executive/management/search access |
| `EXPIRED` | Deny ordinary reads | Block new processing and enqueue deletion |
| `QUARANTINED_PENDING_DISPOSITION` | Disposition role only | Excluded from search, analytics, RAG, graph, and agents |
| `LEGAL_HOLD` | Original authorization still applies | Suspend deletion; record hold authority/scope; never broaden access |
| `DELETION_QUEUED` | Deny ordinary reads | Immutable deletion job and retry policy |
| `DELETION_IN_PROGRESS` | Deny | Delete all lineage-linked copies and prevent re-indexing |
| `DELETED` | No content; minimal tombstone | Tombstone prevents restoration/re-ingestion and proves completion |

## Deletion fan-out

Deletion must cover raw audio, derived audio, transcripts, speaker mappings, summaries, decisions/actions, attachments, object versions, database rows, caches, queues/dead letters, full-text indexes, embeddings, vector stores, graph nodes/edges, analytics extracts, model prompts/traces where supported, and downstream agent memory. Each artifact is registered in a lineage manifest at creation.

Backups use encrypted, time-bounded expiry; deleted content is not restored into active systems. If selective backup deletion is infeasible, access is cryptographically revoked where supported and the item is re-deleted immediately after a disaster restore.

## Legal hold

- Requires tenant, matter/authority reference, exact resource/category scope, issuer, effective time, review/expiry, and audit reason code.
- Hold placement/release requires designated roles and separation of duties according to tenant policy.
- Hold wins over destructive deletion but not over never-record preflight or authorization.
- Release returns the resource to the state dictated by its original retention deadline; an already-expired resource proceeds to deletion.

## Completion criteria

A deletion is complete only when all registered processors acknowledge deletion or an approved exception is recorded with owner and deadline. User-facing deletion status must not say complete while a searchable embedding, cache entry, agent memory, or provider trace remains.

## Local prototype disposition behavior

The in-memory speech pipeline re-checks current consent, policy version, classification/fingerprint, retention state, and organizer authorization both before processing and before publication. Any denial moves queued or processing work to `quarantined`, removes transcript/assertion candidates, and prevents status, search, and AI retrieval from returning derived content. Uploaded bytes remain only for active quarantine or legal-hold disposition; `pending-deletion`, `deletion-in-progress`, and `deleted` clear local bytes immediately.

## Deletion inventory (PRIV-05, current prototype, 2026-10-06)

Manual deletion and retention expiry both run `#disposeMeetingContent`. Every store this app writes is listed here; a store that is not listed does not exist in the prototype. "Outside the app" rows are what a deletion cannot reach and need an operator or contractual control.

| Store | What it holds | On deletion | Evidence |
| --- | --- | --- | --- |
| Recording audio (SQLite or PostgreSQL `recording_content`) | AES-256-GCM ciphertext under a per-recording key | Row deleted; recording marked `deleted` with `contentClearedAt` | `server/retention.test.js`, `server/durable-storage.test.js` |
| Per-recording audio keys (`.data/keys/recordings/` locally; `MEETING_RECORDING_KEY_DIR` with PostgreSQL) | One wrapped 256-bit key per recording | Key file overwritten and removed, so every surviving copy of that recording's ciphertext is unreadable (crypto-shredding) | `server/recording-keys.test.js`; "deleting a recording destroys its key" in the SQLite and PostgreSQL suites |
| Transcript segments and knowledge assertions | Transcript text, summary, decisions, risks, questions, actions | Rows deleted | same |
| Commitment registry | Derived action rows | Rows deleted | same |
| Chat history (`chat_turns`) | Questions, answers, source references, and a local memory vector per saved chat turn | Every turn that drew on the meeting is deleted, for every user; any turn older than `MEETING_CHAT_RETENTION_DAYS` (default 90) is deleted by the retention sweep; a user can forget one turn or clear all | `server/chat.test.js`, SQLite raw-file check, PostgreSQL test |
| Retrieval vectors (`knowledge_embeddings`) | Local `bge-m3` vectors derived from transcript and assertion text | Deleted with the meeting, and whenever its knowledge is replaced or quarantined; rebuilt lazily only for readable meetings | `server/embeddings.test.js`, SQLite and PostgreSQL tests |
| SQLite file and write-ahead log (local mode) | Free pages and WAL frames that held deleted rows | `secure_delete` zeroes freed rows; the WAL is checkpointed and truncated after each delete commit | "deleted meeting content is not left readable in the SQLite database or its write-ahead log" |
| Meeting record | Policy state, consent evidence, capture-stop boundaries | Kept as the deletion tombstone (`retentionState: deleted`); content-free | blocks later preflight, upload, processing, and retries |
| Audit log and outbox | Content-free events | Kept (append-only by design) | audit tests |
| Diarization temporary directory | Plaintext WAV and turn JSON for one job | Removed in `finally` after every job | `server/diarization.test.js` |
| Browser memory | In-progress capture | Discarded on stop, discard, policy stop, or sensitive-topic stop | studio tests |
| **Outside the app:** PostgreSQL dead tuples | Deleted rows until `VACUUM` | Daily owner-run `VACUUM (ANALYZE)` after retention sweep; `VACUUM FULL` only in an approved maintenance window. See Windows operations guide. | Audio stored since per-recording keys (key version 2) is crypto-shredded: its key is destroyed at deletion, so dead tuples cannot be decrypted. Version-1 audio from before that change still relies on vacuum. |
| **Outside the app:** PostgreSQL backups | Point-in-time copies | Expire with the backup rotation; a restore must run deletion reconciliation before serving (see `docs/architecture/windows-postgres-operations.md`). Version-2 audio in a database backup is unreadable once its key is destroyed, as long as the key directory is not restored from an older copy. | operator procedure; PostgreSQL restore test |
| **Outside the app:** downloaded exports | Markdown files a participant saved | Cannot be recalled; the export is marked confidential and audited | `meeting.export` audit |
| **Outside the app:** summary provider | Transcript sent for summarization | OpenAI: `store: false` (no stored-response retrieval); provider abuse-monitoring retention per contract. Anthropic: default API retention per contract. Both need the approval packets before real meetings | approval packets |

Saved chat turns (agent memory) and retrieval vectors are listed above. There are no other vector stores, search indexes, caches, queues/dead letters, or graph stores in the prototype. Adding any of them must add a row here and a deletion path before it ships.

## Retention expiry (PRIV-04, milestone implementation)

- **Rules.** `PolicyEngine({ retentionPolicies })` takes rules of the form `{ tenantId, classification, retainDays }`.
  - `classification: '*'` is the tenant default; an exact classification rule wins over it.
  - A tenant with no rule has no automatic expiry.
  - A malformed rule (missing tenant or classification, or a non-positive or fractional day count) is rejected at startup with `INVALID_RETENTION_POLICY`. It is never silently treated as "keep forever" or "delete now".
- **Clock.** Retention counts from `contentStartedAt`, the first upload for the meeting, which never restarts. Expiry is recomputed from the *current* rules on every check, so shortening a rule applies to existing content immediately.
- **Expiry blocks use immediately.** From the expiry instant, `meetingAccess` and `recordingPreflight` deny with `RETENTION_EXPIRED`. That covers viewing, export, AI retrieval, commitments, and new capture, before any deletion has run. Queued processing is quarantined by the same check.
- **Deletion.** `enforceRetention(tenantId)` is run by the scheduler under the tenant-scoped service identity `service:retention`, which is never accepted from a request.
  - It deletes expired content through the same `#disposeMeetingContent` path as manual deletion: audio, transcript, knowledge, and derived commitments, followed by the content-free `meeting.content.deleted` outbox event.
  - Each deletion is audited as `retention.expire`. Re-running is a no-op.
  - Legal hold (`held`) prevents deletion and keeps blocking ordinary reads.
- **Local schedule.** The local preview server sweeps its development tenants every minute. Standard meetings are kept 30 days.
- **Still required for production:** a durable scheduler with missed-run catch-up and alerting, deletion acknowledgements from every downstream store (indexes, caches, backups, provider traces), and counsel-approved per-classification periods.
