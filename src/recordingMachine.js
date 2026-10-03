export const initialRecordingState = {
  phase: "idle",
  consents: { alex: "pending", sam: "pending" },
  authorizationExpiresAt: null,
  leaseId: null,
  allowedMimeTypes: [],
  recordingId: null,
  progress: 0,
  result: null,
  error: null,
  stopReason: null,
}

export function recordingReducer(state, action) {
  switch (action.type) {
    case "OPEN": return { ...initialRecordingState, phase: "preflighting" }
    case "PREFLIGHT_NEEDS_CONSENT": return { ...state, phase: "awaiting-consent", error: null }
    case "CONSENT_UPDATED": return { ...state, consents: { ...state.consents, [action.participantId]: action.decision } }
    case "PREFLIGHT_AUTHORIZED": return { ...state, phase: "requesting-microphone", leaseId: action.leaseId, authorizationExpiresAt: action.authorizationExpiresAt, allowedMimeTypes: action.allowedMimeTypes ?? [], error: null }
    // A renewal re-runs consent and policy checks without interrupting capture.
    case "LEASE_RENEWED": return ["ready", "recording", "stopped"].includes(state.phase) ? { ...state, leaseId: action.leaseId, authorizationExpiresAt: action.authorizationExpiresAt } : state
    case "MICROPHONE_READY": return { ...state, phase: "ready", error: null }
    case "START": return { ...state, phase: "recording", stopReason: null }
    case "STOP": return { ...state, phase: "stopped", stopReason: "user" }
    case "PROCESS_CONFIRM": return { ...state, phase: "hashing", progress: 5, error: null }
    case "UPLOAD_CREATED": return { ...state, phase: "uploading", recordingId: action.recordingId, progress: 15 }
    case "UPLOAD_COMPLETE": return { ...state, phase: "queued", progress: 25 }
    case "PROCESS_STATUS": return { ...state, phase: action.state, progress: action.progress ?? state.progress, result: action.result ?? state.result, error: action.error ?? null }
    case "DISCARD": return { ...initialRecordingState, phase: "discarded", stopReason: "discarded" }
    case "POLICY_STOP": return { ...state, phase: "policy-stopped", stopReason: action.reason ?? "policy" }
    case "BLOCKED": return { ...state, phase: "blocked", error: action.error }
    case "ERROR": return { ...state, phase: "error", error: action.error }
    case "RESET": return initialRecordingState
    default: return state
  }
}

export function revokeRecordingUrl(url, revoke = URL.revokeObjectURL) {
  if (url) revoke(url)
}
