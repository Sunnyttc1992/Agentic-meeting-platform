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
