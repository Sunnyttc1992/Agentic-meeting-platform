# Authorization policy semantics

## Decision interface

All enforcement points call one policy decision contract:

```text
authorize(
  principal={tenant_id, subject_id, type, assurance, groups},
  action,
  resource={tenant_id, meeting_id, artifact_type, segment_id?, labels, state},
  context={purpose, delegation_id?, request_time, network/device risk, policy_version}
) -> {allow, reason_code, obligations, decision_id, policy_version}
```

Missing, malformed, stale, or unavailable policy data produces `deny`. Storage-layer row/object filtering is mandatory defense in depth and must use the same tenant/resource labels.

## Evaluation order

1. Verify identity, session assurance, token audience, expiry, tenant binding, and account state.
2. Require exact tenant equality before resource lookup.
3. Deny resources in `quarantined`, `deletion_in_progress`, `deleted`, or `never_record` states, except narrowly scoped disposition workflows.
4. Validate action and artifact scope; transcript permission does not imply raw-audio permission.
5. Evaluate category-specific exclusions before ordinary grants.
6. Evaluate explicit resource grant, participation, management-chain grant, executive grant, or approved administrative workflow.
7. Apply obligations: redaction, watermarking, step-up authentication, purpose restriction, export prohibition, or citation-only access.
8. Log the decision and enforce it again at the data access boundary.

## Grant semantics

| Grant | Scope | Does not imply |
|---|---|---|
| Participant | Meeting explicitly joined/accepted and participant identity verified | Other meetings, participant history, raw audio, export, or sensitive-category access |
| Explicit resource grant | Named subject/group, meeting/artifact/actions, expiry, issuer, reason | Organization-wide access or onward sharing |
| Management chain | Explicit policy grant over an effective-dated org subtree; may be constrained by level, purpose, artifact, and time | Automatic access from manager status; bypass of sensitive-category exclusions |
| Executive | Explicit policy assignment with defined organizational scope and exclusions | Universal access; title-based access; privileged/legal or employee-relations access |
| Owner/organizer | Operational controls defined by policy | Unilateral override of never-record, legal hold, or participant rights |
| Compliance/disposition | Case-specific workflow role with purpose and expiry | General browsing or use for performance management |

Policy-derived management and executive access must include: grantor, grantee, tenant, effective org subtree, allowed actions/artifacts, purpose, exclusions, effective/expiry time, policy version, and revocation state.

## Derived data and search

- Every artifact stores `tenant_id`, `meeting_id`, source segment lineage, sensitivity labels, policy version, retention state, and authorization-relevant principals/groups.
- Summaries, decisions, actions, analytics, embeddings, and graph edges inherit the most restrictive label of their sources.
- Search performs authorization-aware candidate filtering; every returned item is re-authorized. Counts, facets, autocomplete, and “related meetings” must not reveal unauthorized existence.
- A knowledge-graph traversal authorizes every node and edge. An authorized node does not make adjacent nodes authorized.
- Caches are keyed by tenant, principal/policy fingerprint, resource, action, and policy version; denial is preferred when invalidation is uncertain.

## Delegated agents

A delegated agent token must include `tenant_id`, `delegator_subject_id`, `delegation_id`, allowed tools/actions/resource set, purpose, issued/expiry times, and maximum chain depth. Its authority is the intersection of the user's current authority and the delegation scopes. Re-authorization occurs on every retrieval and tool call; changes to user access revoke agent access immediately. Agents cannot impersonate another user, mint broader delegations, use executive service identities, or retain content beyond the task.

Consequential writes (sharing, changing permissions, deleting, placing holds, creating external communications) require explicit tool scopes and human confirmation unless a separately approved policy says otherwise.

## Emergency policy stop

An authorized privacy/compliance policy operator may activate a tenant-, category-, integration-, or platform-wide stop. The stop is evaluated at capture authorization and continuously by active capture sessions. Activation revokes recording leases, rejects new audio frames, cancels pending transcription/indexing jobs, and emits a critical audit event. It does not delete evidence automatically; disposition follows the retention/deletion policy.
