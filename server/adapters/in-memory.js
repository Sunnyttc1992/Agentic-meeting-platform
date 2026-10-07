import { isBoundedKnowledgeCitationList } from '../domain.js'
import { sealAuditEvent } from '../audit.js'

export class InMemoryMeetingRepository {
  #meetings = new Map()
  save(record) { this.#meetings.set(`${record.tenantId}:${record.id}`, structuredClone(record)); return structuredClone(record) }
  get(tenantId, meetingId) { const value = this.#meetings.get(`${tenantId}:${meetingId}`); return value ? structuredClone(value) : null }
  list(tenantId) { return [...this.#meetings.values()].filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)) }
  // Used only by createInMemoryMeetingStorage's synchronous transaction
  // composition root. These repositories are never exposed to domain code.
  snapshot() { return structuredClone(this.#meetings) }
  restore(snapshot) { this.#meetings = structuredClone(snapshot) }
}

export class InMemoryKnowledgeRepository {
  #segments = []
  #assertions = []
  addSegments(records) { this.#segments.push(...records.map((item) => structuredClone(item))) }
  addAssertions(records) { this.#assertions.push(...records.map((item) => structuredClone(item))) }
  forMeeting(tenantId, meetingId) {
    return {
      segments: this.#segments.filter((item) => item.tenantId === tenantId && item.meetingId === meetingId).map((item) => structuredClone(item)),
      assertions: this.#assertions.filter((item) => item.tenantId === tenantId && item.meetingId === meetingId).map((item) => structuredClone(item)),
    }
  }
  meetingIdsMatching(tenantId, query) {
    const term = query.toLocaleLowerCase()
    return [...new Set([
      ...this.#segments.filter((item) => item.tenantId === tenantId && item.text.toLocaleLowerCase().includes(term)).map((item) => item.meetingId),
      ...this.#assertions.filter((item) => item.tenantId === tenantId && item.text.toLocaleLowerCase().includes(term)).map((item) => item.meetingId),
    ])]
  }
  clearMeeting(tenantId, meetingId) {
    this.#segments = this.#segments.filter((item) => item.tenantId !== tenantId || item.meetingId !== meetingId)
    this.#assertions = this.#assertions.filter((item) => item.tenantId !== tenantId || item.meetingId !== meetingId)
  }
  snapshot() { return structuredClone({ segments: this.#segments, assertions: this.#assertions }) }
  restore(snapshot) {
    this.#segments = structuredClone(snapshot.segments)
    this.#assertions = structuredClone(snapshot.assertions)
  }
}

const CANONICAL_PROCESSOR_ASSERTION_ORIGIN = 'processor-normalized-v1'
const CANONICAL_PROCESSOR_SOURCE = 'speech-processor'

// Commitments are a derived read model, never an independent source of meeting
// facts. Every storage backend derives its rows with this one function, so the
// canonical-processor-only rule cannot drift between backends.
export function deriveCommitmentRows(tenantId, meetingId, knowledge) {
  const rows = []
  const segmentIds = new Set((knowledge?.segments ?? []).map((segment) => segment.id))
  for (const assertion of knowledge?.assertions ?? []) {
    if (assertion?.tenantId !== tenantId || assertion?.meetingId !== meetingId || assertion?.kind !== 'action') continue
    // `canonicalOrigin` is minted by MeetingIntelligencePlatform's private
    // processor normalization boundary.  Direct/manual writes are forbidden
    // from creating actions, and stale or externally injected rows without
    // this marker remain non-indexable as defense in depth.
    if (assertion.provenance?.source !== CANONICAL_PROCESSOR_SOURCE || assertion.provenance?.canonicalOrigin !== CANONICAL_PROCESSOR_ASSERTION_ORIGIN) continue
    if (!isBoundedKnowledgeCitationList(assertion.citations) || !assertion.citations.every((id) => segmentIds.has(id))) continue
    const commitment = assertion.commitment ?? { ownerId: null, deadline: null, status: 'open' }
    rows.push(Object.freeze({
      id: `commitment:${assertion.id}`,
      tenantId,
      meetingId,
      assertionId: assertion.id,
      text: assertion.text,
      ownerId: commitment.ownerId ?? null,
      deadline: commitment.deadline ?? null,
      status: commitment.status ?? 'open',
      ...(commitment.agreement ? { agreement: commitment.agreement } : {}),
      ...(commitment.speakerLabel ? { speakerLabel: commitment.speakerLabel } : {}),
      citations: Object.freeze([...assertion.citations]),
    }))
  }
  return rows
}

export function commitmentMatchesQuery(row, query = '') {
  const term = String(query ?? '').trim().toLocaleLowerCase()
  return !term || [row.text, row.ownerId ?? '', row.status, row.deadline ?? ''].some((field) => field.toLocaleLowerCase().includes(term))
}

// Saved chat turns, one record per question and answer. A turn names every
// meeting it drew on, so deleting a meeting's content deletes those turns.
export class InMemoryChatRepository {
  #turns = []
  appendTurn(turn) { this.#turns.push(structuredClone(turn)); return structuredClone(turn) }
  forUser(tenantId, userId) { return this.#turns.filter((turn) => turn.tenantId === tenantId && turn.userId === userId).map((turn) => structuredClone(turn)) }
  clearForUser(tenantId, userId) { this.#turns = this.#turns.filter((turn) => turn.tenantId !== tenantId || turn.userId !== userId) }
  clearMeeting(tenantId, meetingId) { this.#turns = this.#turns.filter((turn) => turn.tenantId !== tenantId || !turn.meetingIds.includes(meetingId)) }
  deleteTurn(tenantId, userId, turnId) {
    const before = this.#turns.length
    this.#turns = this.#turns.filter((turn) => turn.tenantId !== tenantId || turn.userId !== userId || turn.id !== turnId)
    return this.#turns.length < before
  }
  purgeBefore(tenantId, cutoff) {
    const before = this.#turns.length
    this.#turns = this.#turns.filter((turn) => turn.tenantId !== tenantId || String(turn.createdAt) >= cutoff)
    return before - this.#turns.length
  }
  snapshot() { return structuredClone(this.#turns) }
  restore(snapshot) { this.#turns = structuredClone(snapshot) }
}

// Retrieval vectors, one row per knowledge item and embedding model.
export class InMemoryEmbeddingRepository {
  #rows = new Map()
  replaceMeeting(tenantId, meetingId, rows) { this.#rows.set(`${tenantId}:${meetingId}`, structuredClone(rows)) }
  forMeeting(tenantId, meetingId) { return structuredClone(this.#rows.get(`${tenantId}:${meetingId}`) ?? []) }
  clearMeeting(tenantId, meetingId) { this.#rows.delete(`${tenantId}:${meetingId}`) }
  snapshot() { return structuredClone([...this.#rows.entries()]) }
  restore(snapshot) { this.#rows = new Map(structuredClone(snapshot)) }
}

// The platform replaces a meeting's rows from canonical knowledge after every
// publication, so replaying a job cannot create a second commitment.
export class InMemoryCommitmentRegistry {
  #commitments = new Map()

  replaceMeeting(tenantId, meetingId, knowledge) {
    this.clearMeeting(tenantId, meetingId)
    for (const row of deriveCommitmentRows(tenantId, meetingId, knowledge)) this.#commitments.set(`${tenantId}:${meetingId}:${row.assertionId}`, row)
  }

  clearMeeting(tenantId, meetingId) {
    const prefix = `${tenantId}:${meetingId}:`
    for (const key of this.#commitments.keys()) if (key.startsWith(prefix)) this.#commitments.delete(key)
  }

  query(tenantId, query = '') {
    return [...this.#commitments.values()]
      .filter((item) => item.tenantId === tenantId && commitmentMatchesQuery(item, query))
      .map((item) => structuredClone(item))
  }
  snapshot() { return structuredClone(this.#commitments) }
  restore(snapshot) { this.#commitments = structuredClone(snapshot) }
}

export class InMemoryRecordingRepository {
  #recordings = new Map()
  #bytes = new Map()
  save(record) { this.#recordings.set(record.id, structuredClone(record)); return structuredClone(record) }
  get(id) { const value = this.#recordings.get(id); return value ? structuredClone(value) : null }
  putBytes(id, bytes) { if (!this.#recordings.has(id)) return false; this.#bytes.set(id, Buffer.from(bytes)); return true }
  getBytes(id) { const bytes = this.#bytes.get(id); return bytes ? Buffer.from(bytes) : null }
  clearContent(id) { this.#bytes.delete(id); const record = this.#recordings.get(id); if (record) record.contentClearedAt = new Date().toISOString() }
  listForMeeting(tenantId, meetingId) { return [...this.#recordings.values()].filter((item) => item.tenantId === tenantId && item.meetingId === meetingId).map((item) => structuredClone(item)) }
  snapshot() { return structuredClone({ recordings: this.#recordings, bytes: this.#bytes }) }
  restore(snapshot) {
    this.#recordings = structuredClone(snapshot.recordings)
    this.#bytes = structuredClone(snapshot.bytes)
  }
}

// Each tenant has its own hash chain (see ../audit.js). In-memory storage is
// still not immutable across a process restart; the chain makes in-process
// tampering detectable, and production anchors chain heads in a WORM sink.
export class InMemoryAppendOnlyAudit {
  #events = []
  #heads = new Map()
  append(event) {
    const stored = sealAuditEvent(event, this.#heads.get(event?.tenantId) ?? null)
    this.#heads.set(stored.tenantId, stored)
    this.#events.push(stored)
    return structuredClone(stored)
  }
  all() { return this.#events.map((item) => structuredClone(item)) }
  chain(tenantId) { return this.#events.filter((item) => item.tenantId === tenantId).map((item) => structuredClone(item)) }
  forMeeting(tenantId, meetingId) {
    return this.#events
      .filter((item) => item.tenantId === tenantId && item.meetingId === meetingId)
      .map((item) => structuredClone(item))
  }
  snapshot() { return structuredClone({ events: this.#events, heads: this.#heads }) }
  restore(snapshot) {
    this.#events = structuredClone(snapshot.events)
    this.#heads = structuredClone(snapshot.heads)
  }
}

export class FixedClock {
  constructor(instant) { this.instant = new Date(instant) }
  now() { return new Date(this.instant) }
  advance(milliseconds) { this.instant = new Date(this.instant.getTime() + milliseconds) }
}
