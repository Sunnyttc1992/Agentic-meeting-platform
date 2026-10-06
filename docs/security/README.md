# Security contract

This directory defines implementation-facing controls for meeting data. These rules apply to the application, APIs, search indexes, analytics, retrieval-augmented generation (RAG), knowledge graphs, and delegated agents. A feature is incomplete if it enforces a rule only in the UI.

## Non-negotiable invariants

1. Deny by default. Every read, write, search result, transcript citation, embedding retrieval, and agent tool call requires an authorization decision for the authenticated principal, tenant, resource, action, and current policy version.
2. Tenant isolation precedes all other policy evaluation. Cross-tenant identifiers are treated as not found.
3. Participation grants access only to that meeting's permitted artifacts; it does not grant access to related meetings, participants' other meetings, or team history.
4. Executive and management access is policy-derived and scoped, never universal or inferred solely from a title such as CEO.
5. Agents do not receive ambient authority. A delegated agent acts as the user, with an explicit purpose, narrow scopes, short lifetime, and a complete audit trail.
6. Authorization occurs before retrieval. Unauthorized text, metadata, embeddings, summaries, and graph edges must never enter an LLM prompt or tool context.
7. Never-record policy is evaluated before capture whenever possible and can issue an emergency stop during capture.
8. Legal hold prevents destructive deletion, but does not expand read access.

## Documents

- [Threat model](./threat-model.md)
- [Authorization semantics](./authorization-policy.md)
- [Never-record preflight](./never-record-policy.md)
- [Retention and deletion state machine](./retention-deletion.md)
- [Anthropic API processing approval packet](./anthropic-api-processing-approval.md)
- [Audit event requirements](./audit-events.md)
- [Adversarial retrieval and agent tests](./adversarial-test-catalog.md)

Consent, recording, employment, privacy, and legal privilege requirements vary by jurisdiction. Counsel must approve configurable policy profiles; this documentation does not state legal conclusions.
