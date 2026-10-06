import { invariant } from './errors.js'

export const NEVER_RECORD_CATEGORIES = new Set([
  'employee-relations',
  'harassment-investigation',
  'legal-privileged',
  'salary-negotiation',
])

export const RETENTION_STATES = new Set(['active', 'held', 'pending-deletion', 'deletion-in-progress', 'deleted', 'quarantined', 'pending-disposition'])

// Citation lists are carried through canonical knowledge, commitment rows, and
// executive briefings.  Keep them deliberately small: a source link is meant
// to be inspectable evidence, not a provider-sized transcript export.
export const MAX_KNOWLEDGE_ASSERTION_CITATIONS = 16
export const MAX_KNOWLEDGE_ASSERTION_CITATION_ID_LENGTH = 160

export function isBoundedKnowledgeCitationList(citations) {
  return Array.isArray(citations)
    && citations.length > 0
    && citations.length <= MAX_KNOWLEDGE_ASSERTION_CITATIONS
    && citations.every((citation) => typeof citation === 'string'
      && citation.trim().length > 0
      && citation.length <= MAX_KNOWLEDGE_ASSERTION_CITATION_ID_LENGTH)
}

export function principal(input) {
  invariant(input?.tenantId && input?.userId, 'INVALID_PRINCIPAL', 'Authenticated tenant and user are required', 401)
  return Object.freeze({ tenantId: input.tenantId, userId: input.userId, roles: Object.freeze([...(input.roles ?? [])]) })
}

export function meeting(input) {
  invariant(input?.id && input?.tenantId && input?.organizerId, 'INVALID_MEETING', 'Meeting identity, tenant, and organizer are required')
  invariant(Array.isArray(input.participantIds) && input.participantIds.length > 0, 'INVALID_MEETING', 'At least one participant is required')
  return {
    id: input.id,
    tenantId: input.tenantId,
    organizerId: input.organizerId,
    participantIds: [...new Set(input.participantIds)],
    classification: input.classification ?? 'unclassified',
    consentPolicyVersion: input.consentPolicyVersion ?? 'v1',
    requiredParticipantIds: [...new Set(input.requiredParticipantIds ?? input.participantIds)],
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    consentEvidence: [],
    recording: { status: 'not-authorized', authorizationId: null, issuedAt: null, authorizationExpiresAt: null },
    retentionState: 'active',
  }
}

export function consentEvidence(input) {
  invariant(input?.participantId && input?.capturedAt && input?.policyVersion && input?.expiresAt, 'INVALID_CONSENT', 'Consent requires participant, capture time, expiry, and policy version')
  invariant(['granted', 'declined', 'withdrawn'].includes(input.decision), 'INVALID_CONSENT', 'Consent decision must be explicit')
  invariant(Number.isFinite(Date.parse(input.capturedAt)) && Number.isFinite(Date.parse(input.expiresAt)), 'INVALID_CONSENT', 'Consent timestamps must be valid')
  return Object.freeze({
    participantId: input.participantId,
    capturedAt: input.capturedAt,
    expiresAt: input.expiresAt,
    policyVersion: input.policyVersion,
    decision: input.decision,
    method: input.method ?? 'explicit',
  })
}

export function transcriptSegment(input) {
  invariant(input?.id && input?.meetingId && input?.tenantId, 'INVALID_SEGMENT', 'Segment identity, meeting, and tenant are required')
  invariant(input.startMs >= 0 && input.endMs > input.startMs, 'INVALID_SEGMENT', 'Segment timestamps are invalid')
  invariant((input?.diarizationLabel || input?.speakerId) && input?.text, 'INVALID_SEGMENT', 'Segment speaker label and text are required')
  return Object.freeze({ ...input, provenance: Object.freeze({ ...input.provenance }) })
}

export function knowledgeAssertion(input) {
  invariant(input?.id && input?.meetingId && input?.tenantId && input?.kind && input?.text, 'INVALID_ASSERTION', 'Assertion identity, source, kind, and text are required')
  // This is an independent persistence invariant, not just request validation.
  // Any future platform path that bypasses the manual-envelope validator still
  // cannot make object/array values durable or available to retrieval/agents.
  invariant(typeof input.id === 'string' && typeof input.kind === 'string' && typeof input.text === 'string', 'INVALID_ASSERTION', 'Assertion identity, kind, and text must be strings')
  invariant(isBoundedKnowledgeCitationList(input.citations), 'UNCITED_ASSERTION', 'Knowledge assertions require a bounded list of primitive transcript citation IDs')
  const commitment = canonicalCommitment(input.kind, input.commitment)
  // Keep the assertion record deliberately small.  In particular, callers cannot
  // smuggle arbitrary nested metadata into later retrieval or agent workflows.
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    meetingId: input.meetingId,
    kind: input.kind,
    text: input.text,
    citations: Object.freeze([...input.citations]),
    provenance: input.provenance ? Object.freeze({ ...input.provenance }) : Object.freeze({}),
    ...(commitment ? { commitment } : {}),
  })
}

const COMMITMENT_STATUSES = new Set(['open', 'in-progress', 'blocked', 'completed', 'cancelled'])
const COMMITMENT_AGREEMENTS = new Set(['committed', 'proposed'])
const ANONYMOUS_SPEAKER_LABEL = /^SPEAKER_\d{2}$/

function canonicalCommitment(kind, input) {
  if (kind !== 'action') return null
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const ownerId = typeof value.ownerId === 'string' && value.ownerId.trim() ? value.ownerId.trim() : null
  const deadline = typeof value.deadline === 'string' && Number.isFinite(Date.parse(value.deadline))
    ? new Date(value.deadline).toISOString()
    : null
  invariant(value.deadline === undefined || deadline !== null, 'INVALID_COMMITMENT', 'Commitment deadline must be a valid timestamp')
  invariant(value.ownerId === undefined || ownerId !== null, 'INVALID_COMMITMENT', 'Commitment owner must be a non-empty string')
  invariant(value.status === undefined || COMMITMENT_STATUSES.has(value.status), 'INVALID_COMMITMENT', 'Commitment status is invalid')
  invariant(value.agreement === undefined || value.agreement === null || COMMITMENT_AGREEMENTS.has(value.agreement), 'INVALID_COMMITMENT', 'Commitment agreement is invalid')
  invariant(value.speakerLabel === undefined || value.speakerLabel === null || ANONYMOUS_SPEAKER_LABEL.test(value.speakerLabel), 'INVALID_COMMITMENT', 'Commitment speaker label must be an anonymous label')
  // agreement and speakerLabel are optional so earlier records keep their shape.
  // A speaker label is an anonymous voice cluster, never an identity or owner.
  return Object.freeze({
    ownerId, deadline, status: value.status ?? 'open',
    ...(value.agreement ? { agreement: value.agreement } : {}),
    ...(value.speakerLabel ? { speakerLabel: value.speakerLabel } : {}),
  })
}
