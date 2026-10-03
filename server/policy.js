import { DomainError } from './errors.js'
import { NEVER_RECORD_CATEGORIES } from './domain.js'

const deny = (code, reason) => ({ allowed: false, code, reason })
const allow = (reason) => ({ allowed: true, reason })

export class PolicyEngine {
  constructor({ managementGrants = [], auditReaderGrants = [], sensitiveCategories = [], organizationSensitiveCategories = [], sensitiveRecordingAllows = [], knownClassifications = ['standard'] } = {}) {
    this.managementGrants = managementGrants
    this.auditReaderGrants = auditReaderGrants
    this.sensitiveCategories = new Set([...sensitiveCategories, ...organizationSensitiveCategories])
    this.sensitiveRecordingAllows = sensitiveRecordingAllows
    this.knownClassifications = new Set(knownClassifications)
  }

  recordingPreflight({ principal, meeting, now }) {
    if (principal.tenantId !== meeting.tenantId) return deny('TENANT_MISMATCH', 'Meeting belongs to another tenant')
    if (principal.userId !== meeting.organizerId) return deny('NOT_ORGANIZER', 'Only the organizer can authorize recording')
    if (NEVER_RECORD_CATEGORIES.has(meeting.classification)) return deny('NEVER_RECORD', 'Meeting classification prohibits recording')
    if (meeting.retentionState !== 'active') return deny('RETENTION_RESTRICTED', 'Meeting is not active')
    const explicitAllow = this.sensitiveRecordingAllows.find((candidate) =>
      candidate.allowed === true && candidate.tenantId === meeting.tenantId && candidate.meetingId === meeting.id &&
      candidate.classification === meeting.classification && (!candidate.expiresAt || new Date(candidate.expiresAt) > now),
    )
    if ((!meeting.classification || meeting.classification === 'unclassified') && !explicitAllow) return deny('CLASSIFICATION_REQUIRED', 'Meeting must be classified before capture')
    if (this.sensitiveCategories.has(meeting.classification)) {
      if (!explicitAllow) return deny('SENSITIVE_RECORDING_DENIED', 'Sensitive classification requires an explicit policy allow decision')
    } else if (!this.knownClassifications.has(meeting.classification) && !explicitAllow) {
      return deny('CLASSIFICATION_REQUIRED', 'Unknown meeting classification requires an explicit policy decision')
    }
    for (const participantId of meeting.requiredParticipantIds ?? meeting.participantIds) {
      const evidence = meeting.consentEvidence.find((item) => item.participantId === participantId)
      if (!evidence) return deny('CONSENT_REQUIRED', 'Every required participant must provide consent')
      if (evidence.decision !== 'granted') return deny('CONSENT_NOT_GRANTED', 'Every required participant must affirmatively consent')
      if (evidence.policyVersion !== meeting.consentPolicyVersion) return deny('CONSENT_POLICY_MISMATCH', 'Consent evidence is not current for this policy')
      const capturedAt = new Date(evidence.capturedAt)
      const expiresAt = new Date(evidence.expiresAt)
      if (!Number.isFinite(capturedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || capturedAt > now) return deny('CONSENT_MALFORMED', 'Consent evidence is malformed')
      if (expiresAt <= now) return deny('CONSENT_EXPIRED', 'Consent evidence expired')
    }
    return allow(`Recording preflight passed at ${now}`)
  }

  meetingAccess({ principal, meeting, now }) {
    if (principal.tenantId !== meeting.tenantId) return { ...deny('TENANT_MISMATCH', 'Meeting belongs to another tenant'), posture: 'denied' }
    if (meeting.retentionState !== 'active') return { ...deny('RETENTION_RESTRICTED', 'Meeting is not active'), posture: 'denied' }
    if (meeting.participantIds.includes(principal.userId)) return { ...allow('Principal participated in the meeting'), posture: 'participant' }
    const grant = this.managementGrants.find((candidate) =>
      candidate.tenantId === principal.tenantId &&
      candidate.managerId === principal.userId &&
      candidate.subordinateIds.includes(meeting.organizerId) &&
      (!candidate.expiresAt || new Date(candidate.expiresAt) > now),
    )
    return grant
      ? { ...allow('Explicit management grant covers the meeting organizer'), posture: 'management-chain' }
      : { ...deny('MEETING_FORBIDDEN', 'Principal has no meeting access relationship'), posture: 'denied' }
  }

  // Export is authorized separately from viewing: a participant may take a
  // copy of a meeting record, but a management grant that allows reading the
  // meeting does not extend to carrying it out of the system.
  meetingExport({ principal, meeting, now }) {
    const access = this.meetingAccess({ principal, meeting, now })
    if (!access.allowed) return access
    return access.posture === 'participant'
      ? allow('Participant export')
      : deny('EXPORT_FORBIDDEN', 'Exporting a meeting record requires participation in the meeting')
  }

  // Audit integrity is a separate, explicitly granted read-only duty. Meeting
  // participation, management grants, and organizer status never imply it.
  auditIntegrity({ principal, now }) {
    const grant = this.auditReaderGrants.find((candidate) =>
      candidate.tenantId === principal.tenantId &&
      candidate.principalId === principal.userId &&
      (!candidate.expiresAt || new Date(candidate.expiresAt) > now),
    )
    return grant ? allow('Explicit audit-reader grant') : deny('AUDIT_READER_REQUIRED', 'Principal has no audit-reader grant')
  }

  require(decision) {
    if (!decision.allowed) throw new DomainError(decision.code, decision.reason, 403)
    return decision
  }
}
