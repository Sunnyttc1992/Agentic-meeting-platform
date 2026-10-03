# Trust boundaries and threat model

## Protected assets

- Raw audio, live audio buffers, transcript segments, speaker identity mappings, summaries, decisions, action items, deadlines, attachments, and chat/context captured around a meeting.
- Consent evidence, never-record classifications, permissions, organization hierarchy, retention state, encryption keys, audit events, embeddings, search indexes, graph nodes/edges, evaluation traces, model prompts, and tool results.
- The existence of a meeting is sensitive metadata. Unauthorized callers receive a non-enumerable not-found response.

## Trust boundaries

| Boundary | Untrusted side | Trusted side and required control |
|---|---|---|
| Capture device -> ingestion | Browser, microphone, conferencing integration | Mutually authenticated encrypted channel; signed session and consent state; server rejects capture before `RECORDING_AUTHORIZED` |
| API edge -> services | Client tokens and request fields | Strong authentication, tenant-bound identity, input validation, request authorization, rate limiting |
| Service -> data stores | Compromised service or malformed query | Workload identity, least-privilege credentials, tenant partition/RLS, resource policy checks, encryption |
| Processing queue -> workers | Forged/replayed jobs | Signed immutable job envelope containing tenant/resource/policy version; idempotency and expiry |
| Source data -> search/vector/graph | Indexing pipeline | Security labels copied atomically; fail closed when labels are absent/stale; tenant-separated namespaces |
| Retrieval -> model | Prompt construction | Authorize candidate resource and segment before prompt assembly; minimize and redact content |
| Model -> tools | Prompt injection/model error | Capability allowlist, parameter validation, re-authorization per call, human approval for consequential writes |
| Organization directory -> policy engine | Stale or malicious hierarchy | Verified directory source, effective dates, explicit policy grants, revocation propagation |
| Admin plane -> production | Insider or compromised admin | Just-in-time privilege, separation of duties, strong MFA, immutable audit, no content access by default |
| Tenant -> tenant | Identifier guessing or cache/index bleed | Tenant key in every row/object/cache/index/event; cryptographic and logical isolation; isolation tests |

## Principal types

- `human_user`: authenticated workforce identity.
- `service_workload`: narrowly scoped ingestion, transcription, indexing, or policy service identity.
- `delegated_agent`: derives authority from one human user and a specific delegation; never a shared system superuser.
- `break_glass_operator`: time-limited emergency role requiring reason, approval, and enhanced audit; not valid for ordinary executive access.

## Primary abuse cases and mitigations

| Abuse case | Required mitigation |
|---|---|
| User changes a meeting ID to read another record | Object-level authorization on every endpoint and storage query; non-enumerable denial |
| Executive searches all employee meetings | Executive access only through explicit policy grant with subtree, artifact, purpose, time, and exclusion constraints |
| Vector search returns an unauthorized chunk | Pre-filter by tenant and policy-visible resource IDs, then post-authorize every segment before prompt assembly |
| Summary leaks content removed from transcript | Summary and derived artifacts inherit source labels; deletion/reclassification cascades and invalidates derived data |
| Agent chains tools to escalate access | Delegation token attenuation, no token forwarding, authorization per tool call, bounded step/time budgets |
| Prompt injection requests secrets or other meetings | Treat transcript as data, not instructions; isolate system/tool instructions; allowlisted tools and policy checks |
| Recording starts without valid consent | Capture service requires current signed consent/policy decision; visible and audible recording indicator |
| Sensitive topic begins mid-meeting | Participant emergency stop and policy stop; halt capture/streaming and quarantine pending disposition |
| Stale management hierarchy preserves access | Effective-dated grants, revocation events, short cache TTL, policy-version checks, re-evaluation on each request |
| Administrator silently changes retention or access | Dual control for high-risk changes; append-only signed audit with before/after values |
| Deleted text remains in embeddings/model traces | Lineage registry and deletion fan-out across object, DB, index, graph, cache, analytics, and model-provider stores |

## What must never enter an LLM prompt

- Any meeting or segment not authorized for the requesting principal at prompt-construction time.
- Cross-tenant content or identifiers, even as examples, retrieval candidates, hidden metadata, or tool results.
- Raw credentials, session tokens, API keys, encryption keys, consent signatures, or unrestricted directory exports.
- Never-record audio/text, quarantined buffers, deleted content, expired content, or content pending authorization/classification.
- Privileged/legal, employee-relations, harassment/investigation, discipline, compensation, health, or other sensitive-category content unless the meeting is recordable **and** the request has an explicit category-specific grant. A general executive or management grant is insufficient.
- Hidden access-control metadata that is unnecessary to answer the question, or other users' private profile attributes.
- Unredacted high-risk identifiers when a minimized/redacted representation satisfies the approved purpose.

Model providers must be configured for no training, bounded retention approved by policy, regional processing as required, and deletion support. Provider configuration does not replace authorization.
