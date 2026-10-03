import { LOCAL_MEETING_ID } from "./privacyAccess.js"
import { copyOrdinaryDenseArray } from "./safeArrays.js"

// This is the locally rendered transcript record.  It mirrors the only
// segment identifiers the deterministic processor may produce for the record
// represented by App.jsx.  Identifiers received in a commitment are never
// authority on their own.
export const CURRENT_RECORD_AUTHORIZED_SEGMENT_IDS = new Set([
  "recording-1-s1",
  "recording-1-s2",
  "recording-1-s3",
])

export function currentRecordEvidence(meetingId, citations) {
  if (meetingId !== LOCAL_MEETING_ID) return null

  const safeCitations = copyOrdinaryDenseArray(citations, {
    maxLength: 12,
    isAllowed: (citation) => typeof citation === "string" && CURRENT_RECORD_AUTHORIZED_SEGMENT_IDS.has(citation),
  })
  if (!safeCitations?.length) return null

  return Object.freeze(safeCitations)
}
