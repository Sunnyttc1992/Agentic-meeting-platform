# Durable storage foundation

## Boundary

The application-facing persistence boundary is [`server/storage.js`](../../server/storage.js). `MeetingIntelligencePlatform` receives canonical repositories (or a single validated storage bundle) and does not import a database, object-store, queue, or cloud SDK. The current `createInMemoryMeetingStorage()` bundle is only a deterministic prototype adapter.

Every durable operation has an explicit tenant scope. Meeting IDs, recording IDs, and search terms are not a tenant boundary; production implementations must bind them to the tenant in every query, update, delete, vector search filter, and object key lookup. An adapter must reject a record whose `tenantId` differs from the active scope.

## Canonical data model

`meeting-ledger-v1` has these authoritative sets:

| Set | Canonical contents | Tenant / lifecycle rule |
| --- | --- | --- |
| meetings | roster, organizer, classification, consent evidence, capture authorization, retention state | `tenant_id` is mandatory; row-level policy is evaluated before domain retrieval |
| recording manifests | media type, length, hash, lease binding, state, object-key reference, encryption-key reference | raw bytes live only in object storage; manifests retain idempotency/replay keys |
| transcript segments | timestamped text, diarization label, verified participant binding, provenance | bounded by tenant + meeting and removed from retrieval on disposition |
| knowledge assertions | cited decisions, risks, questions, summaries, canonical actions | citations reference canonical transcript segment IDs only |
| commitment read model | derived action rows | rebuildable from canonical assertions; not an independent source of truth |
| audit events | append-only identifiers, outcome, safe reason, correlation | no transcript text, bytes, provider errors, tokens, or secrets |
| outbox events | canonical-change notification plus idempotency key | written in the same DB transaction as the canonical change |

`retention_state` remains a canonical meeting and recording lifecycle attribute. Legal hold prevents destructive disposition; a deletion worker must make media, transcript, assertions, indexes, derived commitments, caches, and outbox consumers converge on the deletion state and record acknowledgements without restoring content.

## Platform outbox contract

The platform emits a deliberately bounded, tenant-scoped outbox row only after a canonical lifecycle change. The current contract permits `recording.completed`, `recording.quarantined`, `knowledge.changed`, `commitments.changed`, and `meeting.content.deleted`. Event keys are deterministic `meeting-ledger:v1` keys derived from the event type, canonical aggregate, and canonical revision, so a replay of the same state transition does not create a second row. Idempotency is tenant-local: consumers deduplicate on the pair `{ tenant_id, idempotency_key }`.

Outbox rows are not an audit-log substitute and they are not a replication of meeting data. The only permitted payload fields are state and bounded counts (`segmentCount`, `assertionCount`, or `commitmentCount`) where the meeting is still active. They never contain transcript/assertion text, citations, participants, diarization labels, processor/provider labels, error details, media hashes or sizes, consent evidence, object references, credentials, or raw source IDs. Processor failures and rejected/untrusted payloads emit no outbox row. Quarantine carries only an allowlisted policy reason. Deletion suppresses ordinary knowledge/commitment updates and emits only `{ state: 'deleted' }`, allowing downstream workers to dispose local state without learning deleted content or classification.

The prototype validates this shape and tenant-local replay behavior with its sealed transaction facade. A production adapter must insert the canonical row mutation and its corresponding outbox row in the same Postgres transaction; the in-memory adapter is a deterministic contract harness, not a crash-safe transaction implementation.

## Local durable adapter

`openLocalDurableStorage({ directory })` in [`server/adapters/sqlite.js`](../../server/adapters/sqlite.js) is a working durable backend for the local, single-machine delivery. It is SQLite (built-in `node:sqlite`) with encrypted recording audio.

- It is composed through `composeRepositoryStorage`, so it uses the same sealed tenant facade, record checks, commitment derivation (`deriveCommitmentRows`), and outbox canonicalization (`canonicalOutboxEvent`) as the in-memory prototype.
- Its `runAtomically` is a real SQLite transaction (`BEGIN IMMEDIATE`, with savepoints for nested calls).
- It is not the production target. It is one file on one machine, with no RLS, replication, or KMS.

## Production adapter seam

A production `MeetingStorage` implementation is registered with `createMeetingStorageBundle({ scope, transaction })`, with `dataModelVersion: 'meeting-ledger-v1'`. The public bundle has exactly four fields: `kind`, `dataModelVersion`, `scope`, and `transaction`; it never exposes raw `meetings`, `knowledge`, `recordings`, `audit`, `commitments`, or `outbox` repositories. The composition root mints every callback/read capability through `createTenantStorageFacade(scope, capabilities, { writable })`.

`scope({ tenantId })` returns a freshly branded, null-prototype, frozen read facade. `transaction({ tenantId }, operation)` calls `operation` with a distinct freshly branded, null-prototype, frozen write facade. A facade contains only `tenantId` plus the allowlisted repository methods for that tenant; it has no storage/scope/transaction property, symbols, getters, mutable properties, constructable callbacks, or repository that accepts a caller-supplied tenant. The platform retains only narrowed tenant-first adapters and never retains the storage bundle or raw repositories. The transaction must atomically commit authoritative Postgres rows and outbox rows. It must not use the prototype's in-memory transaction behavior.

The module-private bundle/facade brands and per-call contract checks intentionally reject structural look-alikes. This protects against an adapter that returns a correctly shaped object while smuggling a global repository, alternate scope, symbol capability, getter, prototype link, or a forged callback facade. The composition root itself remains trusted code: JavaScript cannot prove what a provider's closed-over database client does, so production adapters still require code review, database RLS, and integration tests.

Recommended implementation:

1. PostgreSQL stores canonical structured rows with `tenant_id` on every table, composite tenant-first primary/foreign keys, tenant-first indexes, and RLS policies keyed to a server-verified tenant context. Application authorization remains required; RLS is defense in depth.
2. Object storage stores encrypted recording bytes under an opaque tenant-prefixed key. The database stores an object reference, SHA-256, byte length, content type, encryption algorithm/key reference, and disposition state--never a cloud credential or plaintext key.
3. KMS/HSM owns encryption material. The platform stores only a key version/reference and supports rotation/disposition evidence. Secrets stay in the deployment secret manager, not UI, source, audit, or row metadata.
4. A transactional outbox publisher delivers work idempotently. Consumers deduplicate on `{tenant_id, idempotency_key}` and re-check current policy before any retrieval or AI processing.
5. Audit storage persists the tenant-local hash chain minted by `server/audit.js` (the `audit.chain()` reader returns a tenant's events in sequence order for independent verification) and is append-only/WORM-capable with restricted write identity, time ordering, retention policy, export integrity checks, and independent access audit. The in-memory audit adapter is not immutable across process restart.

## Configuration still required

This repository intentionally contains no production credentials or cloud calls. A deployment needs a PostgreSQL connection through a secret manager, object-storage bucket/container and KMS key references, an immutable audit sink, worker/outbox transport, Entra identity verification, tenant directory/RLS session binding, retention policy configuration, monitoring, and tested backup/restore plus deletion evidence procedures.
