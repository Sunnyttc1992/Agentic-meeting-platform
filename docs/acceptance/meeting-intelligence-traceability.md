# Meeting Intelligence Acceptance Traceability Matrix

Status: **review plan only — implementation is not approved**  
Owner: Reviewer  
Date: 2026-09-30  
Scope: secure meeting-intelligence milestone following the UI prototype

## Evidence levels

- **M — milestone/in-memory proof:** deterministic policy, domain, API-boundary, and retrieval tests using isolated in-memory stores and fakes. M evidence proves intended behavior, not production enforcement.
- **P — production integration proof:** tests against the selected identity provider, database row/column policies, object store, search/vector store, cache, queue, model gateway, KMS, and audit sink.
- **O — operational evidence:** deployed controls, configuration review, penetration tests, restore/deletion drills, alert exercises, key-rotation evidence, and policy-owner sign-off.

No requirement is considered production-ready on M evidence alone. Every denial test must verify a generic external response, an internal reason code, and an audit event without disclosing the protected resource.

## Core capabilities

| ID | Requirement | Verifiable acceptance criteria | Planned automated tests | Evidence |
|---|---|---|---|---|
| CAP-01 | Consent-gated capture | Capture cannot enter `recording` until every required participant has an affirmative, current consent record for the meeting and policy version. Recording indicator is visible while capture is active. | Unit: state-machine denies zero, missing, declined, expired, and wrong-meeting consent; permits complete consent. API: start is idempotent. UI/E2E: indicator tracks actual server state, not optimistic state. | M; P for conferencing/device integration |
| CAP-02 | Partial/withdrawn consent | A late joiner requiring consent pauses or blocks their capture; withdrawal stops new capture immediately and records the boundary timestamp. | Property tests over participant/consent combinations; event-order tests for join/withdraw during start and active capture. | M; P/O for real media boundary |
| CAP-03 | In-person and virtual capture | Each capture adapter declares supported platforms, channel availability, consent signal, and failure behavior; unsupported modes fail closed. | Adapter contract suite; simulated device/platform disconnect and reconnect; unsupported-platform denial. | M contract; P integration |
| CAP-04 | Speaker diarization | Each transcript segment has meeting ID, stable segment ID, start/end timestamps, diarization label, and confidence. Overlap and unknown speakers are represented without invented identity. | Schema/property tests; overlapping speech, silence, crosstalk, and low-confidence fixtures. | M fixture; P quality benchmark |
| CAP-05 | Identity association | Identity is attached only with authorized roster evidence and confidence above configured threshold; corrections are versioned and propagate to derived artifacts. | Negative: same-name participants, roster mismatch, low confidence, and intentionally swapped voice profiles never silently bind. Correction/recompute tests. | M; P biometric/vendor assessment if used |
| CAP-06 | Timestamped speech-to-text | Transcript segments are ordered, non-overlapping where applicable, preserve source offsets, and retain transcription/model version and provenance. | Boundary, retry, duplicate-event, out-of-order-event, and idempotency tests. | M; P pipeline load/failure tests |
| CAP-07 | Structured persistence | Meeting, participant, organizer, time, speaker, consent, recording, permissions, transcript, and provenance metadata conform to versioned schemas; raw and derived objects share immutable meeting/tenant IDs. | Schema validation, migration compatibility, referential-integrity, tenant-partition, and malformed-event tests. | M schema; P storage constraints |
| CAP-08 | Intelligence extraction | Summary includes executive summary, discussion points, decisions, unresolved questions, risks/blockers, actions, owners, and stated deadlines; absent facts remain unknown. | Golden fixtures; missing-owner/deadline tests; contradiction and empty-transcript tests; structured-output schema validation. | M with fake model; P evaluation set |
| CAP-09 | Evidence links | Every generated factual conclusion carries one or more authorized transcript segment IDs and timestamps, or is visibly marked unsupported/unverified. | Unsupported AI assertion is rejected/quarantined; deleted or inaccessible citation invalidates display and retrieval. | M; P model evaluation |
| CAP-10 | Decisions and actions | Decision/action records are stable, versioned, traceable to meeting and evidence, and preserve owner/deadline confidence. | Duplicate extraction, changed owner, rescinded decision, and recomputation tests. | M; P workflow integration |

## Privacy, authorization, and hierarchy

| ID | Requirement | Verifiable acceptance criteria | Planned automated tests | Evidence |
|---|---|---|---|---|
| AUTH-01 | Participant access | A participant can access only meetings in which they have an effective participation grant and only permitted artifact types. | Allow own meeting; deny unrelated participant; deny guessed meeting/segment/object IDs; enumerate/list count does not reveal denied meetings. | M; P data-layer RLS |
| AUTH-02 | Executive/hierarchy access | Leadership access requires an explicit policy rule plus a current effective hierarchy edge; title alone never grants access. Scope and artifact type are policy constrained. | Allow valid chain; deny peer, skip-level when disallowed, former manager, stale hierarchy, missing policy, and forged title claim. | M; P IdP/HR integration |
| AUTH-03 | Revocation | Revoked grants and hierarchy edges deny subsequent reads, searches, exports, model prompts, and cached responses within the documented revocation SLA. | Revoke between authorization and fetch; cached token/grant; concurrent request; websocket/session continuation. | M race simulation; P/O SLA evidence |
| AUTH-04 | Tenant isolation | Tenant derives from trusted identity context, never user-controlled resource IDs. Cross-tenant IDs are indistinguishable from nonexistent IDs and cannot influence queries. | Cross-tenant meeting, segment, participant, cursor, export, vector, and object-store key tests. | M; P datastore and object-store policies |
| AUTH-05 | Application and data enforcement | Every repository/query requires a security context; data-layer predicates independently constrain tenant and meeting grants. No unscoped query API exists. | Compile/static checks where possible; direct repository tests without context fail closed; bypass attempts through internal endpoints. | M interfaces; P RLS/IAM |
| AUTH-06 | Transcript-level authorization | Segment/snippet access cannot exceed meeting/artifact permission and supports redaction or topic-level restriction policy. | Direct segment ID, timestamp range, citation link, download, diff/history, and regenerated-summary attempts. | M; P datastore |
| AUTH-07 | Search/vector/cache isolation | Search, embeddings, autocomplete, counts, facets, caches, and rerankers apply authorization before content enters results or shared computation. | Unauthorized keyword/snippet, vector-nearest-neighbor, facet/count inference, cache-key collision, shared semantic cache, and pagination side-channel tests. | M adapters; P search/vector/cache integration |
| AUTH-08 | AI prompt boundary | Only already-authorized source segments may enter an LLM prompt. Prompt logs, traces, tool outputs, memory, and citations retain tenant/grant labels and cannot widen access. | Instrument fake model gateway and assert zero unauthorized snippets in prompt; malicious query, tool call, prompt injection, cross-meeting synthesis, and agent delegation tests. | M; P gateway/observability |
| AUTH-09 | Service identities | Workload identities are tenant/scenario scoped, least privilege, short lived, and cannot impersonate users or make policy decisions alone. | Service identity overreach: bulk read, cross-tenant read, direct object fetch, audit deletion, privilege escalation, and confused-deputy tests. | M authorization; P IAM/O review |
| AUTH-10 | API security | Strong authentication, audience/issuer validation, scoped authorization, replay resistance, request limits, and secure defaults apply to UI, API, export, and agent tools. | Expired/wrong-audience token, replay, missing scopes, IDOR, mass assignment, oversized request, and rate-limit tests. | M middleware; P penetration test |

## Never-record and retention policy

| ID | Requirement | Verifiable acceptance criteria | Planned automated tests | Evidence |
|---|---|---|---|---|
| PRIV-01 | Pre-capture classification | Meeting classification is evaluated before any microphone, conferencing bot, buffer, temporary file, or vendor stream starts. A prohibited or indeterminate category fails closed. | Sexual-harassment/investigation, employee-relations/disciplinary, compensation, privileged-legal, custom category, unknown classifier, classifier timeout, and conflicting policy tests assert zero capture-side calls. | M; P adapter/vendor telemetry |
| PRIV-02 | Topic becomes sensitive | An authorized stop signal immediately transitions to stopping/stopped, closes capture adapters, timestamps the boundary, blocks downstream processing, and invokes applicable quarantine/deletion/retention policy. | Mid-session policy stop during streaming, retry, network loss, concurrent chunk upload, and delayed event; verify no post-boundary chunks are accepted. | M state machine; P/O media and deletion drill |
| PRIV-03 | Consent tracking | Consent evidence contains subject, meeting, policy/version, scope, method, timestamp, status, and withdrawal; mutation is append-only. | Tamper/update attempts, wrong subject, reused consent, changed meeting scope, and withdrawal tests. | M; P immutable store |
| PRIV-04 | Retention | Retention is policy-derived per tenant/classification; expiration blocks use immediately and schedules deletion across every replica and derivative. | Clock-boundary, changed policy, retry/idempotency, and derived artifact expiration tests. | M scheduler; P/O lifecycle evidence |
| PRIV-05 | Deletion | Deletion inventory covers audio, transcript, derived intelligence, embeddings, indexes, caches, exports, backups per policy, model traces, and agent memory; tombstones prevent resurrection. | Incomplete deletion injection for each store; replay old pipeline event; restore backup; regenerate embedding; verify inaccessible and reconciliation reports failure. | M orchestration; P/O drill |
| PRIV-06 | Legal hold | A valid, authorized legal hold prevents destructive deletion while immediately removing ordinary user/AI access as policy requires; release resumes retention deterministically. | Hold before/after deletion request, unauthorized hold, overlapping holds, release, expiration, and audit trail tests. | M; P/O counsel-approved process |

## Security and audit

| ID | Requirement | Verifiable acceptance criteria | Planned automated tests | Evidence |
|---|---|---|---|---|
| SEC-01 | Encryption | TLS is required in transit; approved encryption protects databases, objects, backups, indexes, queues, and caches at rest; tenant/key strategy is documented. | Configuration/policy tests reject plaintext endpoints and unencrypted resources. | P/O only |
| SEC-02 | Strong authentication | Human and workload identities use approved IdP, MFA/conditional access where required, short-lived sessions, and explicit reauthentication for sensitive operations. | Auth integration tests and session-revocation exercises. | P/O only |
| SEC-03 | Least privilege | Human, service, pipeline, support, and break-glass roles have minimum actions/resources and separation of duties. | Policy simulation; denied overreach; periodic entitlement diff. | M policy model; P/O IAM review |
| SEC-04 | Immutable audit | Every allow/deny, capture transition, consent event, classification, export, search, AI retrieval, policy/admin change, deletion, hold, and break-glass action emits actor, tenant, resource, purpose, decision, reason, time, correlation ID, and policy version. | Completeness assertions; audit sink unavailable causes defined fail-closed/degraded behavior; retry dedupe. | M; P audit sink |
| SEC-05 | Audit tamper resistance | Application and normal admins cannot alter/delete prior audit records; ordering/integrity is independently verifiable and access is itself audited. | Update/delete/truncate attempts, forged event, removed/reordered event, clock skew, and privileged service identity tampering. | M hash-chain simulation; P/O WORM/SIEM evidence |
| SEC-06 | Secure exports and sharing | Export/share is separately authorized, scoped, watermarked/expiring where policy requires, and audited; exports inherit revocation/deletion controls. | Direct URL, token forwarding, expired link, cross-tenant recipient, and revoked grant tests. | M; P object/CDN integration |
| SEC-07 | Input and prompt safety | Uploaded metadata, transcripts, search queries, and model/tool output are validated and encoded; transcript content cannot instruct the agent to bypass policy or exfiltrate data. | Injection, XSS, SQL/NoSQL injection, path/key manipulation, prompt injection, and tool-argument poisoning tests. | M; P penetration/model red team |
| SEC-08 | Availability/fail-safe | Identity, policy, hierarchy, classification, consent, KMS, or audit dependencies failing cannot default to allow or start recording. | Timeout, stale cache, partial response, dependency outage, and retry-storm tests. | M chaos fakes; P/O resilience exercise |

## Agentic knowledge invariants

| ID | Invariant | Verifiable acceptance criteria | Planned automated tests | Evidence |
|---|---|---|---|---|
| AI-01 | Authorization equivalence | Agent/search/analytics access is never broader than direct access to each underlying source at request time. | Differential/property test compares every agent-retrieved source with direct authorization decision. | M; P end-to-end |
| AI-02 | No inference leakage | Denied data does not leak through answers, citations, snippets, counts, timing, recommendations, follow-up suggestions, or refusal wording. | Canary secrets in denied meetings across Q&A, briefing, blocker detection, commitment tracking, and dependency queries. | M; P red team |
| AI-03 | Provenance | Every answer/briefing claim identifies authorized source meeting/segment and model/pipeline version; unsupported claims are labeled or withheld. | Remove citations, inject fabricated claim, mixed authorized/denied sources, deleted source, and stale index tests. | M; P evaluation |
| AI-04 | Purpose and delegation | Agent purpose, user identity, tenant, policy context, and delegation chain propagate to every tool; agents cannot mint broader credentials. | Nested tool/agent delegation, replayed capability, altered user ID, and service-token substitution tests. | M; P identity broker |
| AI-05 | Memory isolation | Agent memory is tenant/user/purpose scoped, authorized on write and read, retention-aware, and purged on revocation/deletion. | Cross-user memory retrieval, shared cache collision, deleted meeting memory, and poisoned memory tests. | M; P memory store |
| AI-06 | Commitment safety | Tracking and reminders preserve evidence, owner confidence, and authorization; no external action occurs without explicit policy and confirmation. | Misidentified owner, ambiguous deadline, revoked access, and unauthorized notification/action tests. | M; P workflow integration |

## Milestone acceptance test suites

1. **Policy model suite (M):** table-driven and property-based allow/deny tests for tenant, participant, hierarchy, grants, artifact types, purpose, and time.
2. **Capture state-machine suite (M):** consent, classification, never-record, stop boundary, failures, idempotency, and event ordering.
3. **Data and provenance suite (M):** schemas, speaker attribution, citations, structured intelligence, corrections, and unsupported-claim handling.
4. **Retrieval boundary suite (M):** direct reads, lists, search, vector retrieval, caches, exports, prompt assembly, agent tools, and memory use the same authorization oracle.
5. **Lifecycle suite (M):** retention, deletion inventory, tombstones, replay resistance, and legal hold behavior using fake stores.
6. **Audit suite (M):** event completeness, deny events, integrity simulation, sink failure, and sensitive-field redaction.
7. **Production control suite (P/O, later):** IdP/HR hierarchy sync, RLS, object IAM, search filters, model gateway, KMS, immutable audit sink, capture adapters, backup deletion, penetration test, red team, and operational drills.

## Review checklist

- [ ] One authoritative authorization decision point is used by API, repositories, search, exports, AI retrieval, and agent tools.
- [ ] Tenant and subject context comes only from verified identity, never request payloads.
- [ ] Every datastore query and object key is tenant- and grant-scoped independently of UI/API checks.
- [ ] Capture adapters are not invoked before both consent and never-record policy pass.
- [ ] Mid-session stop has a measured media boundary and rejects late chunks.
- [ ] Unknown/low-confidence speakers and unsupported intelligence are represented honestly.
- [ ] Citations are mandatory for factual generated conclusions and reauthorized on access.
- [ ] Revocation, hierarchy change, retention expiry, deletion, and legal hold invalidate all derivative channels.
- [ ] Search/vector/cache/prompt/memory tests include canary data from unauthorized meetings.
- [ ] Audit records cover allows, denies, searches, AI retrieval, admin changes, deletion, hold, and capture transitions.
- [ ] No service identity has broad read access merely for convenience.
- [ ] M, P, and O evidence is reported separately; simulated controls are not described as production security.

## Hard rejection criteria

Reject the milestone if any of the following is true:

1. Any capture path can start before complete required consent and a passing pre-capture sensitive-category decision.
2. Any meeting, segment, citation, search hit, vector result, cache entry, export, prompt, tool call, or agent memory can cross tenant or effective grant boundaries.
3. Authorization relies only on UI filtering, route guards, model instructions, or post-retrieval redaction.
4. Leadership access is implied by title or stale hierarchy rather than explicit current policy.
5. Revocation does not invalidate active sessions and derived retrieval paths within the stated SLA.
6. A generated factual claim can be presented as supported without an authorized transcript citation.
7. Incorrect/low-confidence speaker identity is silently asserted as fact.
8. Stop, deletion, or retention affects only primary records while leaving accessible chunks, embeddings, caches, exports, traces, backups outside documented policy, or agent memory.
9. Legal hold can be created/released without separate authorization and audit, or is used to preserve ordinary user/AI access.
10. Audit events can be changed or deleted by the application/service identity, or critical actions proceed silently when required auditing fails.
11. A service identity can bypass user policy, impersonate a user, or perform cross-tenant bulk reads.
12. Production-readiness is claimed solely from in-memory tests without P and O evidence.

## Implementation status (assessed 2026-10-06)

Assessed by the coding agent from the automated test suite (191 tests), not by the Reviewer. Done means the M-level criteria have passing tests; partial means some criteria are untested or unimplemented. P and O columns list only evidence that exists today. Overall: M about 76% (30.5 of 40 with partial = 0.5), P about 13%, O 0%.

| ID | M | P / O evidence today | Main gap |
|---|---|---|---|
| CAP-01 | done | Isolated headless Chrome consent-to-capture smoke on loopback | Conferencing capture |
| CAP-02 | done | Studio polls minimal authorization status every 5 seconds and discards on revocation | Measured remote-device latency |
| CAP-03 | partial | none | Teams connector intentionally unconnected |
| CAP-04 | partial | `npm run benchmark:diarization`: 26 synthetic segments across clean turns, crosstalk, interjections, silences, and rapid exchange; 0 credited to the wrong voice, all crosstalk abstained | Real-audio quality benchmark |
| CAP-05 | partial | none | Reviewed, versioned human correction flow |
| CAP-06 | done | Real local Whisper runs; `npm run benchmark:real-audio` scores word error rate against a read script (2.2% on a synthetic two-voice reading; window-boundary duplicates removed) | Load and failure tests; a human-voice recording |
| CAP-07 | done | PostgreSQL storage, migrations, RLS tests | none at M |
| CAP-08 | done | One live OpenAI synthetic run | Evaluation set; approval packets |
| CAP-09 | done | none | Model evaluation |
| CAP-10 | partial | Each recording in a meeting keeps its own transcript, decisions, and actions; a later recording or a processor failure cannot replace them (in-memory, SQLite, PostgreSQL tests). Duplicate extractions merge with their citations; assertion and commitment IDs are stable across restarts | Rescinded-decision lineage would send earlier knowledge to the summary provider (a new data flow needing approval); recomputation versioning has no trigger because a completed recording cannot be reprocessed. Both need a product decision |
| AUTH-01 | done | Tenant RLS in PostgreSQL | Per-participant grants in the database |
| AUTH-02 | done | none | IdP/HR hierarchy source |
| AUTH-03 | done | Revocation SLA is zero: no read path caches a decision. `server/revocation.test.js` revokes by grant expiry, grant withdrawal, hierarchy change, and participant removal, then sweeps knowledge, recording status, export, privacy, search, retrieval, commitments, briefing, list, and capture status; mid-retrieval revocation applies to every later source | Measured SLA once an IdP/HR source adds propagation delay |
| AUTH-04 | done | PostgreSQL RLS tenant isolation | Object store, when added |
| AUTH-05 | done | Sealed tenant facades; RLS | Static checks |
| AUTH-06 | partial | Cross-meeting recording IDs look nonexistent; citations never point into an unreadable meeting; regeneration is organizer-only (`server/revocation.test.js`) | Redaction and topic-level restriction (needs a product decision) |
| AUTH-07 | partial | Tenant-isolated, authorization-filtered bounded lexical retrieval | No vector index; deletion/backup lifecycle for future embeddings |
| AUTH-08 | done | none | none at M |
| AUTH-09 | partial | Least-privilege DB role | Workload identities |
| AUTH-10 | partial | Rate limits, strict schemas | Token authentication (Entra deferred) |
| PRIV-01 | done | none | none at M |
| PRIV-02 | done | none | Measured media boundary on remote devices |
| PRIV-03 | done | none | none at M |
| PRIV-04 | done | none | Durable scheduler, downstream acknowledgements |
| PRIV-05 | partial | SQLite secure delete proven on raw files; per-recording audio keys destroyed on deletion make restored SQLite and PostgreSQL audio rows unreadable | Transcript rows in PostgreSQL dead tuples and backups; provider acknowledgements |
| PRIV-06 | done | none | Hold placement/release workflow and roles |
| SEC-01 | partial | AES-256-GCM audio at rest under per-recording keys wrapped by the master key | TLS, KMS |
| SEC-02 | none | none | Entra deferred by decision |
| SEC-03 | partial | Least-privilege DB role | Role model review |
| SEC-04 | done | none | none at M |
| SEC-05 | done | Database rejects audit edits (SQLite, PostgreSQL) | External audit sink |
| SEC-06 | done | none | Watermarking, link expiry |
| SEC-07 | done | none | none at M |
| SEC-08 | partial | Audit-dependent transitions roll back; PostgreSQL audio reads/writes fail closed if the configured key file is absent or changed | KMS/HSM integration and operational resilience exercise |
| AI-01 | done | none | none at M |
| AI-02 | done | none | none at M |
| AI-03 | done | none | Model/pipeline version on every claim |
| AI-04 | none | none | No agent tools exist yet |
| AI-05 | none | none | No agent memory exists yet |
| AI-06 | done | none | none at M |

## Current verdict

**Not approved / not yet reviewed against implementation.** This document defines the evidence required for a later review. Passing the prototype build or UI tests does not demonstrate the privacy, authorization, security, deletion, or agentic invariants above.
