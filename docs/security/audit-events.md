# Audit event requirements

Audit logs are append-only, integrity-protected, tenant-isolated, encrypted, and exported to a separately controlled security store. Application administrators cannot alter or suppress them. Clock synchronization and monotonically ordered event identifiers are required.

## Common event envelope

Every event includes:

- `event_id`, `event_type`, `occurred_at`, `received_at`, `tenant_id`, environment, service/workload identity, trace/request IDs.
- Principal type and stable subject ID; for agents, delegator ID, delegation ID, purpose, and tool/action.
- Resource identifiers (`meeting_id`, artifact type, segment ID where applicable) without transcript text or sensitive titles.
- Action, outcome (`allow`, `deny`, `error`), reason code, policy version, policy decision ID, authentication assurance, and risk/step-up result.
- Source IP/device or workload metadata as policy permits; never credentials, tokens, keys, raw audio, transcript text, prompt content, or allegations.
- For mutations: before/after security-relevant fields or hashes, approver, ticket/reason, and effective/expiry times.

## Required event families

- Authentication: sign-in/out, MFA/step-up, session/token issuance/revocation, failures, account disablement.
- Authorization: every sensitive allow and deny across API, storage, search, export, graph traversal, RAG retrieval, and agent tools.
- Recording lifecycle: classification, consent/withdrawal, lease issue/revoke, start/stop, indicator state, sensitive-topic stop, emergency policy stop.
- Data processing: upload, transcription, diarization, summary/decision/action creation, indexing, embedding, graph ingestion, reclassification.
- Access changes: grant/revoke, hierarchy policy changes, executive/management scope changes, group/directory changes, break-glass activation.
- Data lifecycle: retention changes, quarantine, legal hold place/release, deletion request/progress/completion/failure, backup restore/re-delete.
- Agent activity: delegation create/revoke/expire, retrieval IDs, model/provider/policy versions, tool calls, human approvals, outputs stored/shared.
- Administrative/security: key rotation, integration changes, audit export failure, policy deployment/rollback, anomalous bulk access.

## Audit access and alerts

Audit readers require a separate read-only role, tenant scope, purpose, and full auditing. Alert on cross-tenant attempts, repeated object denials, bulk transcript access/export, executive-scope changes, break-glass use, emergency stops, audit pipeline gaps, deletion failures, stale policy versions, and agent tool denials. Audit retention is configured independently from meeting retention and reviewed by counsel/security.

## Untrusted processor failures

Speech/media processors are outside the audit trust boundary. Their exception `code`, `message`, `name`, `stack`, and arbitrary metadata must never become status or audit fields. The platform records only the internal allowlisted `PROCESSOR_FAILED` reason. Current-policy denials discovered while a job is queued or processing use allowlisted policy reason codes and a protected quarantine disposition instead of a processor-failure status.

## Tamper-evident chain (milestone implementation)

[`server/audit.js`](../../server/audit.js) gives every tenant its own SHA-256 hash chain (`audit-chain-v1`). The audit store, not the caller, mints `sequence` (tenant-local, starting at 1), `previousHash` (64 zeros for the first event), and `hash` over the canonical, key-sorted event envelope. An event that arrives with any chain field already set is rejected as a forgery attempt.

`verifyAuditChain(events, { tenantId, anchor })` re-derives the chain independently of the writer and reports only `{ valid, checked, head, failure }`. `failure` holds just a sequence number and one of `MALFORMED_EVENT`, `TENANT_MISMATCH`, `UNSUPPORTED_CHAIN_VERSION`, `SEQUENCE_GAP`, `CHAIN_BROKEN`, `HASH_MISMATCH`, `ANCHOR_MISSING`, or `ANCHOR_MISMATCH`. It never includes event contents.

- Edits, deletions, reordering, splices, and foreign-tenant events are detected from the chain alone.
- Tail truncation, and a wholesale rewrite that recomputes every later hash, are detected only against a retained head anchor (`{ sequence, hash }`). Production must checkpoint heads to a WORM/SIEM sink that the application and service identities cannot rewrite; without that, the chain is tamper-evident, not tamper-proof.
- `MeetingIntelligencePlatform.verifyAuditIntegrity` (HTTP `GET /audit/integrity?anchorSequence=&anchorHash=`) requires an explicit, unexpired, same-tenant `auditReaderGrants` entry. Organizer, participant, and management grants never imply it. Every attempt, allowed or denied, is itself audited as `audit.verify`, after the check, so a successful result's head is one event behind the stored chain.

This is M-level evidence for SEC-05. The in-memory chain does not survive a process restart, so P/O evidence still requires a durable append-only store, an external anchor, and an exercised tamper drill.
