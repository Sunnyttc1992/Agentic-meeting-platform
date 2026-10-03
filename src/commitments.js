import { privacyAccessHeaders } from "./privacyAccess.js"
import { copyOrdinaryDenseArray } from "./safeArrays.js"

const STATUSES = new Set(["open", "in-progress", "blocked", "completed", "cancelled"])
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._@ -]{0,119}$/
const MAX_TEXT_LENGTH = 1600
const MAX_CITATIONS = 12

function safeIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null
}

function safeOwner(value) {
  return value === null || (typeof value === "string" && OWNER.test(value)) ? value : null
}

function safeDeadline(value) {
  if (value === null) return null
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function sanitizeCommitment(value) {
  const source = value?.source
  const citations = copyOrdinaryDenseArray(source?.citations, {
    maxLength: MAX_CITATIONS,
    isAllowed: (citation) => safeIdentifier(citation) !== null,
  })
  const id = safeIdentifier(value?.id)
  const meetingId = safeIdentifier(value?.meetingId)
  const assertionId = safeIdentifier(source?.assertionId)
  const text = typeof value?.text === "string" ? value.text.trim() : ""
  const ownerId = safeOwner(value?.ownerId)
  const deadline = safeDeadline(value?.deadline)

  if (
    !id || !meetingId || !assertionId || !text || text.length > MAX_TEXT_LENGTH ||
    value?.ownerId !== null && ownerId === null ||
    value?.deadline !== null && deadline === null ||
    !STATUSES.has(value?.status) || !citations || !citations.length
  ) return null

  const uniqueCitations = []
  const knownCitations = new Set()
  for (const citation of citations) {
    if (!knownCitations.has(citation)) {
      knownCitations.add(citation)
      uniqueCitations.push(citation)
    }
  }

  return Object.freeze({
    id,
    meetingId,
    text,
    ownerId,
    deadline,
    status: value.status,
    source: Object.freeze({ assertionId, citations: Object.freeze(uniqueCitations) }),
  })
}

export function sanitizeCommitmentQuery(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 120)
    : ""
}

export function sanitizeCommitments(payload) {
  const rawRows = copyOrdinaryDenseArray(payload?.commitments, { maxLength: 200 })
  if (!rawRows) return null

  const unique = new Map()
  for (const rawRow of rawRows) {
    const row = sanitizeCommitment(rawRow)
    if (row) unique.set(row.id, row)
  }
  return Object.freeze({ commitments: Object.freeze(Array.from(unique.values())) })
}

export async function loadCommitments({ query = "", fetchImpl = fetch, correlationId } = {}) {
  const safeQuery = sanitizeCommitmentQuery(query)
  try {
    const response = await fetchImpl(`/commitments?query=${encodeURIComponent(safeQuery)}`, {
      method: "GET",
      headers: privacyAccessHeaders(correlationId),
    })
    if (!response.ok) return { status: "unavailable" }
    const data = sanitizeCommitments(await response.json())
    return data ? { status: "authorized", data } : { status: "unavailable" }
  } catch {
    return { status: "unavailable" }
  }
}
