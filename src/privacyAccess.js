export const LOCAL_MEETING_ID = "meeting-1"
export const LOCAL_TENANT_ID = "northstar"
export const LOCAL_USER_ID = "alex"

const POSTURES = new Set(["participant", "management-chain"])
const CONFIDENTIALITIES = new Set(["standard", "confidential", "never-record"])
// This field is display-adjacent. Never reflect an organization-defined or otherwise
// untrusted classifier string from a successful API response into application state.
// The generic value remains useful to the privacy drawer without disclosing a label
// which has not been reviewed as safe for this client surface.
const SAFE_CLASSIFICATIONS = new Set([
  "standard", "internal", "unclassified", "employee-relations",
  "harassment-investigation", "legal-privileged", "salary-negotiation",
  "board-confidential",
])
const REDACTED_CLASSIFICATION = "redacted"
const RETENTION_STATES = new Set(["active", "pending-deletion", "deletion-in-progress", "deleted"])
const DELETION_STATES = new Set(["not-requested", "scheduled", "in-progress", "completed"])
const AUDIT_ACTIONS = new Set([
  "meeting.create", "consent.record", "recording.preflight", "recording.create", "recording.upload",
  "recording.process", "recording.process.retry", "recording.process.complete", "meeting.export", "recording.status", "recording.delete",
  "transcript.append", "knowledge.assertions.add", "knowledge.read", "knowledge.search",
  "ai.retrieve", "privacy-access.read",
])
const AUDIT_REASONS = new Set([
  "TENANT_MISMATCH", "NOT_ORGANIZER", "NEVER_RECORD", "RETENTION_RESTRICTED",
  "CLASSIFICATION_REQUIRED", "SENSITIVE_RECORDING_DENIED", "CONSENT_REQUIRED",
  "CONSENT_NOT_GRANTED", "CONSENT_POLICY_MISMATCH", "CONSENT_MALFORMED", "CONSENT_EXPIRED",
  "RECORDING_POLICY_CHANGED", "PROCESSING_CANCELLED", "MEETING_FORBIDDEN", "MEETING_NOT_FOUND",
  "RECORDING_NOT_FOUND", "PROCESSOR_FAILED", "INVALID_RECORDING_LEASE", "LEASE_BINDING_MISMATCH",
  "RECORDING_LEASE_REVOKED", "RECORDING_LEASE_EXPIRED", "RECORDING_LEASE_REPLAYED",
  "RECORDING_AUTHORIZATION_EXPIRED", "LEGAL_HOLD", "DELETE_FORBIDDEN", "REDACTED",
])

export const privacyAccessHeaders = (correlationId = globalThis.crypto?.randomUUID?.() ?? "privacy-access-local") => ({
  "x-tenant-id": LOCAL_TENANT_ID,
  "x-user-id": LOCAL_USER_ID,
  "x-correlation-id": correlationId,
})

export function sanitizePrivacyAccess(payload) {
  const access = payload?.access
  const classification = payload?.classification
  const retention = payload?.retention
  if (
    access?.authorized !== true || !POSTURES.has(access.posture) ||
    typeof classification?.classification !== "string" || !CONFIDENTIALITIES.has(classification.confidentiality) ||
    typeof classification.recordingProhibited !== "boolean" ||
    !RETENTION_STATES.has(retention?.state) || !DELETION_STATES.has(retention?.deletion)
  ) return null

  const auditTimeline = Array.isArray(payload.auditTimeline) ? payload.auditTimeline.map((event) => ({
    occurredAt: Number.isFinite(Date.parse(event?.occurredAt)) ? event.occurredAt : null,
    action: AUDIT_ACTIONS.has(event?.action) ? event.action : "redacted-event",
    outcome: ["allowed", "denied"].includes(event?.outcome) ? event.outcome : "redacted",
    reason: event?.reason === null || event?.reason === undefined
      ? null
      : AUDIT_REASONS.has(event.reason) ? event.reason : "REDACTED",
    immutable: event?.immutable === true,
  })) : []

  return Object.freeze({
    access: Object.freeze({ posture: access.posture, authorized: true }),
    classification: Object.freeze({
      classification: SAFE_CLASSIFICATIONS.has(classification.classification)
        ? classification.classification
        : REDACTED_CLASSIFICATION,
      confidentiality: classification.confidentiality,
      recordingProhibited: classification.recordingProhibited,
    }),
    retention: Object.freeze({ state: retention.state, deletion: retention.deletion }),
    auditTimeline: Object.freeze(auditTimeline.map(Object.freeze)),
  })
}

export async function loadPrivacyAccess({ fetchImpl = fetch, correlationId } = {}) {
  let response
  try {
    response = await fetchImpl(`/meetings/${LOCAL_MEETING_ID}/privacy-access`, {
      method: "GET",
      headers: privacyAccessHeaders(correlationId),
    })
  } catch {
    return { status: "demo" }
  }

  if (!response.ok) return { status: response.status >= 500 ? "demo" : "unavailable" }
  try {
    const data = sanitizePrivacyAccess(await response.json())
    return data ? { status: "authorized", data } : { status: "demo" }
  } catch {
    return { status: "demo" }
  }
}
