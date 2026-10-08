import { createHash, randomUUID } from 'node:crypto'
import { NEVER_RECORD_CATEGORIES, consentEvidence, isBoundedKnowledgeCitationList, knowledgeAssertion, MAX_KNOWLEDGE_ASSERTION_CITATIONS, MAX_KNOWLEDGE_ASSERTION_CITATION_ID_LENGTH, meeting, principal, transcriptSegment } from './domain.js'
import { DomainError, invariant } from './errors.js'
import { normalizeIngestMimeType, RECORDING_MIME_TYPES, SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'
import { parseSpeechWav } from './wav.js'
import { MicrosoftTeamsIntegrationAdapter } from './teams.js'
import { assertMeetingStorageContract } from './storage.js'
import { verifyAuditChain } from './audit.js'
import { exportFilename, renderMeetingRecordMarkdown } from './meeting-export.js'
import { InMemoryChatRepository, InMemoryCommitmentRegistry, InMemoryEmbeddingRepository } from './adapters/in-memory.js'
import { assertionsFromIntelligence } from './speech.js'
import { chatKeywords, keywordScore, MAX_CHAT_EXCERPT_TEXT, MAX_CHAT_EXCERPTS } from './chat.js'
import { cosineSimilarity, embeddingTextHash } from './embeddings.js'
import { checkGrounding, GUARDRAIL_CODES, keepValidCitations, prepareOutbound, validateQuestion } from './guardrails.js'
import { compactVector, DEFAULT_CHAT_RETENTION_DAYS, isExpired, memoryText, retentionCutoff, selectMemory } from './chat-memory.js'

const PROCESSOR_FAILED = 'PROCESSOR_FAILED'
const MAX_CHAT_CANDIDATE_MEETINGS = 25
// Hybrid retrieval tuning (see npm run eval:rag): reciprocal-rank-fusion
// constant, the similarity floor for a meaning-based match, and how many
// meaning-based matches enter the fusion.
const RRF_K = 60
const CHAT_MIN_SIMILARITY = 0.45
const CHAT_VECTOR_TOP = 6
const MAX_CHAT_DISPLAY_TURNS = 50
const formatChatTime = (ms) => { const seconds = Math.floor(ms / 1000); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` }
// One first attempt plus two retries. Bounded so a persistently failing
// processor cannot be driven into an unbounded loop of model calls.
const MAX_PROCESSING_ATTEMPTS = 3
const POLICY_REVOKED = 'POLICY_REVOKED'
const PROCESSING_CANCELLED = 'PROCESSING_CANCELLED'
// Allowlisted processor labels and the provenance mode each one may claim.
const TRUSTED_PROCESSOR_MODES = new Map([
  ['Local deterministic processor', 'local-deterministic-fake'],
  ['Local Whisper + Claude', 'local-whisper-claude'],
  ['Local Whisper transcription only', 'local-whisper-transcript-only'],
  ['Local Whisper + pyannote + Claude', 'local-whisper-pyannote-claude'],
  ['Local Whisper + pyannote transcription', 'local-whisper-pyannote-transcript-only'],
  ['Local Whisper + OpenAI', 'local-whisper-openai'],
  ['Local Whisper + pyannote + OpenAI', 'local-whisper-pyannote-openai'],
])
const MODEL_BACKED_PROCESSOR_MODES = new Set(['local-whisper-claude', 'local-whisper-pyannote-claude', 'local-whisper-openai', 'local-whisper-pyannote-openai'])
// Whisper cannot separate speakers; this label is kept verbatim so the
// transcript never implies one diarized speaker.
const UNATTRIBUTED_SPEAKER_LABEL = 'UNATTRIBUTED'
const MAX_PROCESSOR_SEGMENTS = 5000
const MAX_PROCESSOR_ASSERTIONS = 80
const MAX_PROCESSOR_SEGMENT_TEXT = 2000
const MAX_PROCESSOR_ASSERTION_TEXT = 1000
const PROCESSOR_ASSERTION_KINDS = new Set(['summary', 'decision', 'action', 'risk', 'question', 'finding'])
const CANONICAL_PROCESSOR_SOURCE = 'speech-processor'
// This marker is minted only as processor output crosses the private
// normalization boundary below.  It is deliberately not accepted by any
// participant-facing write path.  The derived commitment registry treats it
// as the platform-owned capability for turning an action assertion into a
// trackable organizational commitment.
const CANONICAL_PROCESSOR_ASSERTION_ORIGIN = 'processor-normalized-v1'
const UNTRUSTED_PROCESSOR_PROVENANCE = 'UNTRUSTED_PROCESSOR_PROVENANCE'
const MANUAL_ASSERTION_FIELDS = new Set(['id', 'kind', 'text', 'citations'])
const MANUAL_ASSERTION_KINDS = new Set(['summary', 'decision', 'action', 'risk', 'question', 'finding'])
const MAX_MANUAL_ASSERTION_ID_LENGTH = 160
const MAX_MANUAL_ASSERTION_KIND_LENGTH = 32
const MAX_MANUAL_ASSERTION_TEXT_LENGTH = 8_000
const MAX_MANUAL_ASSERTIONS = 128
const MAX_MANUAL_ASSERTION_CITATIONS = MAX_KNOWLEDGE_ASSERTION_CITATIONS
const MAX_MANUAL_ASSERTION_CITATION_ID_LENGTH = MAX_KNOWLEDGE_ASSERTION_CITATION_ID_LENGTH
const POLICY_REASON_CODES = new Set([
  'TENANT_MISMATCH', 'NOT_ORGANIZER', 'NEVER_RECORD', 'RETENTION_RESTRICTED',
  'CLASSIFICATION_REQUIRED', 'SENSITIVE_RECORDING_DENIED', 'CONSENT_REQUIRED',
  'CONSENT_NOT_GRANTED', 'CONSENT_POLICY_MISMATCH', 'CONSENT_MALFORMED',
  'CONSENT_EXPIRED', 'RECORDING_POLICY_CHANGED', PROCESSING_CANCELLED, 'RETENTION_EXPIRED',
  'SENSITIVE_TOPIC_STOP', 'PARTICIPANT_STOP_REQUEST', 'CONSENT_WITHDRAWN',
])
// A participant may stop capture at any time. The request names only one of
// these reasons; the stored boundary carries the matching code, never prose.
const CAPTURE_STOP_REASONS = new Map([['sensitive-topic', 'SENSITIVE_TOPIC_STOP'], ['participant-request', 'PARTICIPANT_STOP_REQUEST']])
const MAX_CAPTURE_STOPS = 50
// The retention scheduler acts under this tenant-scoped service identity. It is
// never accepted from a request, and it can only expire content that current
// policy says is past its retention date.
const RETENTION_SERVICE_ID = 'service:retention'
// Startup recovery of jobs interrupted by a restart, also tenant-scoped.
const RECOVERY_SERVICE_ID = 'service:recovery'
const DELETE_BYTES_ON_REVOKE = new Set(['pending-deletion', 'deletion-in-progress', 'deleted'])
const AUDIT_TIMELINE_LIMIT = 100
const SAFE_AUDIT_REASONS = new Set([
  ...POLICY_REASON_CODES,
  'MEETING_FORBIDDEN', 'MEETING_NOT_FOUND', 'RECORDING_NOT_FOUND', 'PROCESSOR_FAILED',
  'INVALID_RECORDING_LEASE', 'LEASE_BINDING_MISMATCH', 'RECORDING_LEASE_REVOKED',
  'RECORDING_LEASE_EXPIRED', 'RECORDING_LEASE_REPLAYED', 'RECORDING_POLICY_CHANGED',
  'RECORDING_AUTHORIZATION_EXPIRED', 'LEGAL_HOLD', 'DELETE_FORBIDDEN', 'EXPORT_FORBIDDEN', 'NO_MEETING_RECORD',
  'ASSERTION_REPLAY_CONFLICT', 'INVALID_COMMITMENT_OWNER',
  'UNTRUSTED_ACTION_ASSERTION', UNTRUSTED_PROCESSOR_PROVENANCE, 'INVALID_MANUAL_ASSERTION',
  'TEAMS_NOT_CONNECTED', 'INVALID_TEAMS_IMPORT', 'INVALID_TEAMS_MEETING_ID', 'INVALID_TEAMS_IMPORT_SOURCE',
])
const SAFE_AUDIT_ACTIONS = new Set([
  'meeting.create', 'meeting.list', 'consent.record', 'recording.preflight', 'recording.create', 'recording.upload',
  'recording.process', 'recording.process.retry', 'recording.process.complete', 'recording.status', 'recording.delete',
  'recording.authorization.status', 'recording.list',
  'chat.ask', 'chat.history.read', 'chat.history.clear', 'chat.guardrail', 'chat.turn.delete', 'chat.history.expire',
  'speaker.map', 'speaker.unmap', 'speaker.dispute', 'recording.summary.regenerate',
  'transcript.append', 'knowledge.assertions.add', 'knowledge.read', 'knowledge.search',
  'ai.retrieve', 'privacy-access.read', 'meeting.export', 'retention.expire',
  'commitment.query',
  'management-briefing.read',
  'teams.readiness', 'teams.import.prepare', 'recording.stop',
])

// A briefing is deliberately a small derived view. It may carry source links
// that an already-authorized reader can open, but never processor provenance,
// participant/meeting metadata, or unbounded provider output.
const BRIEFING_ITEM_LIMIT = 8
const BRIEFING_TEXT_LIMIT = 1_000
const BRIEFING_ASSERTION_KINDS = new Set(['decision', 'risk'])
const MAX_RETRIEVAL_QUERY_LENGTH = 240
const MAX_RETRIEVAL_MEETINGS = 8
const MAX_RETRIEVAL_EXCERPTS_PER_MEETING = 4
const MAX_RETRIEVAL_EXCERPT_TEXT = 600
const ACTIVE_COMMITMENT_STATUSES = new Set(['open', 'in-progress', 'blocked'])
// Outbox payloads are deliberately summaries, not copies of domain rows. A
// consumer receives enough information to re-check current policy and fetch
// canonical state, but never transcript text, citations, processor fields,
// participant identities, hashes, byte counts, or provider/source IDs.
const OUTBOX_EVENT_TYPES = new Set([
  'recording.completed', 'recording.quarantined', 'meeting.content.deleted',
  'knowledge.changed', 'commitments.changed',
])
const OUTBOX_RETENTION_VISIBLE_STATES = new Set(['active'])

const view = (recording) => ({
  id: recording.id,
  meetingId: recording.meetingId,
  state: recording.state,
  progress: recording.progress,
  contentType: recording.contentType,
  byteLength: recording.byteLength,
  processor: recording.processor ?? null,
  withheldAssertions: recording.withheldAssertions ?? 0,
  retryAvailable: recording.state === 'failed' && recording.error === PROCESSOR_FAILED
    && (recording.processingAttempts ?? 1) < MAX_PROCESSING_ATTEMPTS && !recording.contentClearedAt,
  error: recording.error ?? null,
})

// Speaker naming (CAP-05). A person confirms which meeting participant an
// anonymous diarization label is, separately for each recording (SPEAKER_00 in
// one recording is unrelated to SPEAKER_00 in another). The map is versioned,
// keeps its change history, and is applied whenever content is read, so the
// stored transcript and generated items never change. A name whose
// participant has left the meeting is ignored.
const SPEAKER_MAP_LABEL = /^SPEAKER_\d{2}$/
const MAX_SPEAKER_HISTORY = 200

function speakerMapOf(recording) {
  const map = recording?.speakerMap
  return {
    version: Number.isSafeInteger(map?.version) ? map.version : 0,
    labels: map?.labels && typeof map.labels === 'object' ? structuredClone(map.labels) : {},
    disputed: Array.isArray(map?.disputed) ? structuredClone(map.disputed) : [],
    history: Array.isArray(map?.history) ? structuredClone(map.history) : [],
  }
}

function speakerFor(maps, participantIds, recordingId, label) {
  const entry = maps.get(recordingId)?.labels?.[label]
  return entry && participantIds.includes(entry.participantId) ? Object.freeze({ participantId: entry.participantId, method: entry.method }) : null
}

// Adds the confirmed speaker to transcript segments and to the speaker of an
// action, for display. Owners are never derived from it.
function withSpeakerNames({ segments = [], assertions = [] }, maps, participantIds) {
  return {
    segments: segments.map((segment) => {
      const speaker = speakerFor(maps, participantIds, segment?.provenance?.recordingId, segment?.diarizationLabel)
      return speaker ? { ...segment, speaker } : segment
    }),
    assertions: assertions.map((assertion) => {
      const speaker = assertion?.commitment?.speakerLabel ? speakerFor(maps, participantIds, assertion?.provenance?.recordingId, assertion.commitment.speakerLabel) : null
      return speaker ? { ...assertion, commitment: { ...assertion.commitment, speaker } } : assertion
    }),
  }
}

// Whisper often splits speech into short fragments ("before contacting the
// NVC."), which say little on their own. A short transcript excerpt therefore
// travels with the lines just before and after it in the same recording, each
// labelled with its own speaker so neighbouring words are never credited to
// the matched line's speaker.
const SHORT_EXCERPT_WORDS = 25
const MAX_CONTEXT_TEXT = 240

function transcriptNeighbours(segments) {
  const byRecording = new Map()
  for (const segment of segments) {
    const key = segment?.provenance?.recordingId ?? ''
    if (!byRecording.has(key)) byRecording.set(key, [])
    byRecording.get(key).push(segment)
  }
  const neighbours = new Map()
  for (const list of byRecording.values()) {
    list.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
    list.forEach((segment, index) => neighbours.set(segment.id, { before: list[index - 1] ?? null, after: list[index + 1] ?? null }))
  }
  return neighbours
}

// A meeting may hold several recordings: a stopped capture needs a fresh
// preflight. A recording owns the segments whose canonical provenance names it
// and the assertions citing them; a claim citing a removed segment would be
// uncited, so it goes with that recording.
function knowledgeWithoutRecording(snapshot, recordingId) {
  const removed = new Set(snapshot.segments.filter((item) => item.provenance?.recordingId === recordingId).map((item) => item.id))
  return {
    segments: snapshot.segments.filter((item) => !removed.has(item.id)),
    assertions: snapshot.assertions.filter((item) => !item.citations.some((id) => removed.has(id))),
  }
}

function knowledgeForRecording(snapshot, recordingId) {
  const owned = new Set(snapshot.segments.filter((item) => item.provenance?.recordingId === recordingId).map((item) => item.id))
  return {
    segments: snapshot.segments.filter((item) => owned.has(item.id)),
    assertions: snapshot.assertions.filter((item) => item.citations.length > 0 && item.citations.every((id) => owned.has(id))),
  }
}

// A platform supplied with a durable storage bundle must not retain the
// bundle's global repositories.  These adapters preserve the legacy domain
// repository call shape while each operation enters through a tenant-bound
// storage facade.  The raw adapter remains only in these closures and is
// never attached to the platform instance.
function scopedStorageRepositories(storage, ready) {
  // Every read and write first waits for the storage contract check, whose
  // final transaction-isolation step may be asynchronous.
  const read = async (tenantId) => { await ready; return storage.scope({ tenantId }) }
  const write = async (tenantId, operation) => { await ready; return storage.transaction({ tenantId }, operation) }
  const tenantFromRows = (rows, label) => {
    if (!Array.isArray(rows) || rows.length === 0) return null
    const tenantId = rows[0]?.tenantId
    invariant(typeof tenantId === 'string' && tenantId.length > 0 && rows.every((row) => row?.tenantId === tenantId),
      'TENANT_SCOPE_VIOLATION', `${label} must remain inside one tenant scope`, 403)
    return tenantId
  }
  return Object.freeze({
    meetings: Object.freeze({
      get: async (tenantId, meetingId) => (await read(tenantId)).meetings.get(meetingId),
      list: async (tenantId) => (await read(tenantId)).meetings.list(),
      save: (record) => write(record.tenantId, (transaction) => transaction.meetings.save(record)),
    }),
    knowledge: Object.freeze({
      forMeeting: async (tenantId, meetingId) => (await read(tenantId)).knowledge.forMeeting(meetingId),
      meetingIdsMatching: async (tenantId, query) => (await read(tenantId)).knowledge.meetingIdsMatching(query),
      clearMeeting: (tenantId, meetingId) => write(tenantId, (transaction) => transaction.knowledge.clearMeeting(meetingId)),
      addSegments: (rows) => {
        const tenantId = tenantFromRows(rows, 'Transcript segments')
        return tenantId === null ? undefined : write(tenantId, (transaction) => transaction.knowledge.addSegments(rows))
      },
      addAssertions: (rows) => {
        const tenantId = tenantFromRows(rows, 'Knowledge assertions')
        return tenantId === null ? undefined : write(tenantId, (transaction) => transaction.knowledge.addAssertions(rows))
      },
    }),
    recordings: Object.freeze({
      get: async (tenantId, recordingId) => (await read(tenantId)).recordings.get(recordingId),
      listForMeeting: async (tenantId, meetingId) => (await read(tenantId)).recordings.listForMeeting(meetingId),
      save: (record) => write(record.tenantId, (transaction) => transaction.recordings.save(record)),
      putBytes: (tenantId, recordingId, bytes) => write(tenantId, (transaction) => transaction.recordings.putBytes(recordingId, bytes)),
      getBytes: (tenantId, recordingId) => write(tenantId, (transaction) => transaction.recordings.getBytes(recordingId)),
      clearContent: (tenantId, recordingId) => write(tenantId, (transaction) => transaction.recordings.clearContent(recordingId)),
    }),
    audit: Object.freeze({
      append: (event) => write(event.tenantId, (transaction) => transaction.audit.append(event)),
      forMeeting: async (tenantId, meetingId) => (await read(tenantId)).audit.forMeeting(meetingId),
      chain: async (tenantId) => (await read(tenantId)).audit.chain(),
    }),
    commitments: Object.freeze({
      query: async (tenantId, query) => (await read(tenantId)).commitments.query(query),
      replaceMeeting: (tenantId, meetingId, knowledge) => write(tenantId, (transaction) => transaction.commitments.replaceMeeting(meetingId, knowledge)),
      clearMeeting: (tenantId, meetingId) => write(tenantId, (transaction) => transaction.commitments.clearMeeting(meetingId)),
    }),
    outbox: Object.freeze({
      enqueue: (event) => write(event.tenantId, (transaction) => transaction.outbox.enqueue(event)),
      list: async (tenantId) => (await read(tenantId)).outbox.list(),
    }),
    embeddings: Object.freeze({
      forMeeting: async (tenantId, meetingId) => (await read(tenantId)).embeddings.forMeeting(meetingId),
      replaceMeeting: (tenantId, meetingId, rows) => write(tenantId, (transaction) => transaction.embeddings.replaceMeeting(meetingId, rows)),
      clearMeeting: (tenantId, meetingId) => write(tenantId, (transaction) => transaction.embeddings.clearMeeting(meetingId)),
    }),
    chat: Object.freeze({
      forUser: async (tenantId, userId) => (await read(tenantId)).chat.forUser(userId),
      appendTurn: (turn) => write(turn.tenantId, (transaction) => transaction.chat.appendTurn(turn)),
      clearForUser: (tenantId, userId) => write(tenantId, (transaction) => transaction.chat.clearForUser(userId)),
      clearMeeting: (tenantId, meetingId) => write(tenantId, (transaction) => transaction.chat.clearMeeting(meetingId)),
      deleteTurn: (tenantId, userId, turnId) => write(tenantId, (transaction) => transaction.chat.deleteTurn(userId, turnId)),
      purgeBefore: (tenantId, cutoff) => write(tenantId, (transaction) => transaction.chat.purgeBefore(cutoff)),
    }),
  })
}

function canonical(value) {
  if (value instanceof Set) return [...value].sort()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

// A participant-facing assertion has no processor metadata channel at all.  We
// still inspect omitted fields recursively before dropping them so that an
// attempted processor capability forgery cannot be silently normalized into an
// apparently trustworthy write.  Deliberately do not inspect `text` or
// `citations`: they are user content and evidence links, not metadata.
function containsReservedProcessorClaim(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    const keys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of keys) {
      if (typeof key !== 'string') continue
      const descriptor = descriptors[key]
      // Never execute an accessor while deciding whether to reject an
      // untrusted envelope. The schema validator will reject it separately.
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue
      const child = descriptor.value
      if (MANUAL_ASSERTION_FIELDS.has(key)) continue
      const normalizedKey = key.toLocaleLowerCase()
      if (normalizedKey === 'provenance' || normalizedKey === 'canonicalorigin' || normalizedKey.includes('processor')) return true
      if (typeof child === 'string') {
        const normalizedValue = child.trim().toLocaleLowerCase()
        if (normalizedValue === CANONICAL_PROCESSOR_SOURCE || child.trim() === CANONICAL_PROCESSOR_ASSERTION_ORIGIN) return true
      }
      if (containsReservedProcessorClaim(child, seen)) return true
    }
  } catch {
    // A hostile proxy must not turn validation into a capability probe. The
    // caller rejects its schema with the same content-free error.
    return false
  }
  return false
}

function invalidManualAssertion() {
  // Do not reflect a malformed field, property name, or provider-shaped value.
  // This error is safe to expose through the ordinary validation channel and
  // safe to retain in the audit log.
  return new DomainError('INVALID_MANUAL_ASSERTION', 'Manual assertion has an invalid schema', 400)
}

function isPlainDataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isBoundedString(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function ownDataProperties(value) {
  const keys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (keys.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) return null
  return { keys, descriptors }
}

function isSafeCitationArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
    const properties = ownDataProperties(value)
    if (!properties || properties.keys.length !== value.length + 1 || !Object.hasOwn(properties.descriptors, 'length')) return false
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index)
      const descriptor = properties.descriptors[key]
      if (!descriptor?.enumerable || !isBoundedString(descriptor.value, MAX_MANUAL_ASSERTION_CITATION_ID_LENGTH)) return false
    }
    return properties.keys.every((key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)))
  } catch {
    return false
  }
}

// The outer request collection is an input boundary in its own right.  In
// particular, Array.isArray(new Proxy([], ...)) is true, so an Array check
// followed by items.map(...) would hand control to an attacker-provided `map`
// implementation before each assertion is validated.  Read only own data
// descriptors, never collection methods or indexed property reads, and reject
// anything that is not a dense, ordinary Array shape.  A final structured
// clone, performed only after the element envelopes have been proven safe,
// rejects otherwise-indistinguishable Array proxies without evaluating a
// hostile nested accessor.
function validatedManualAssertionCollection(items) {
  try {
    if (!Array.isArray(items) || Object.getPrototypeOf(items) !== Array.prototype) throw invalidManualAssertion()
    const properties = ownDataProperties(items)
    if (!properties) throw invalidManualAssertion()

    const { keys, descriptors } = properties
    const lengthDescriptor = descriptors.length
    if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || lengthDescriptor.enumerable
      || lengthDescriptor.configurable
      || !lengthDescriptor.writable
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > MAX_MANUAL_ASSERTIONS
      || keys.length !== lengthDescriptor.value + 1) {
      throw invalidManualAssertion()
    }

    const values = []
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index)
      const descriptor = descriptors[key]
      if (!descriptor
        || !Object.hasOwn(descriptor, 'value')
        || !descriptor.enumerable
        || !descriptor.configurable
        || !descriptor.writable) {
        throw invalidManualAssertion()
      }
      values.push(descriptor.value)
    }

    if (!keys.every((key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)))) {
      throw invalidManualAssertion()
    }
    return Object.freeze(values)
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw invalidManualAssertion()
  }
}

function requireCloneableManualAssertionCollection(items) {
  try {
    // All elements have already passed validatedManualAssertionEnvelope when
    // this runs. This clone therefore cannot evaluate untrusted element
    // accessors; its only remaining purpose is the non-observable Proxy gate.
    structuredClone(items)
  } catch {
    throw invalidManualAssertion()
  }
}

function validatedManualAssertionEnvelope(value) {
  // Reject accessors before structuredClone: cloning an enumerable accessor
  // can invoke it. Then clone the already primitive-only envelope because
  // structuredClone rejects proxies. This makes the final record independent
  // of caller-owned objects without evaluating request code.
  let source
  try {
    if (!isPlainDataObject(value)) throw invalidManualAssertion()
    source = ownDataProperties(value)
    if (!source) throw invalidManualAssertion()
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw invalidManualAssertion()
  }

  const { keys: ownKeys, descriptors } = source

  // Keep the processor-only action boundary dominant for every direct action
  // attempt, even if it also carries forged provenance or malformed fields.
  // We return only a locally minted primitive marker; none of the request
  // payload can reach a mapper, repository, audit body, or commitment sink.
  const requestedKind = descriptors.kind
  if (requestedKind && Object.hasOwn(requestedKind, 'value') && requestedKind.value === 'action') {
    return Object.freeze({ kind: 'action' })
  }

  // Manual records are an exact, data-only envelope.  In particular, unknown
  // enumerable fields cannot become an accidental retrieval or provenance
  // channel. Preserve the established provenance-specific denial when an
  // extra field is explicitly attempting to forge that capability.
  const hasOnlyExpectedKeys = ownKeys.length === MANUAL_ASSERTION_FIELDS.size
    && ownKeys.every((key) => typeof key === 'string' && MANUAL_ASSERTION_FIELDS.has(key))
    && [...MANUAL_ASSERTION_FIELDS].every((key) => Object.hasOwn(descriptors, key))
  if (!hasOnlyExpectedKeys) {
    if (containsReservedProcessorClaim(value)) {
      throw new DomainError(UNTRUSTED_PROCESSOR_PROVENANCE, 'Processor provenance is reserved for canonical processing', 403)
    }
    throw invalidManualAssertion()
  }
  for (const key of MANUAL_ASSERTION_FIELDS) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidManualAssertion()
  }

  const { id, kind, text, citations } = Object.fromEntries([...MANUAL_ASSERTION_FIELDS].map((key) => [key, descriptors[key].value]))
  if (!isBoundedString(id, MAX_MANUAL_ASSERTION_ID_LENGTH)
    || !isBoundedString(kind, MAX_MANUAL_ASSERTION_KIND_LENGTH)
    || !MANUAL_ASSERTION_KINDS.has(kind)
    || !isBoundedString(text, MAX_MANUAL_ASSERTION_TEXT_LENGTH)
    || !isSafeCitationArray(citations)
    || citations.length === 0
    || citations.length > MAX_MANUAL_ASSERTION_CITATIONS) {
    throw invalidManualAssertion()
  }

  let envelope
  try {
    // Clone the original too, rather than only a reconstructed object: this
    // is the final proxy check after all accessor checks above.
    envelope = structuredClone(value)
  } catch {
    throw invalidManualAssertion()
  }

  // Return only primitives plus a fresh array. The private processor boundary
  // deliberately bypasses this participant-facing validator.
  return Object.freeze({
    id: envelope.id,
    kind: envelope.kind,
    text: envelope.text,
    citations: Object.freeze(envelope.citations),
  })
}

export class MeetingIntelligencePlatform {
  #tenantTransaction = null

  constructor({ storage = null, meetings, knowledge, recordings, audit, policy, speechProcessor, commitments, chat, chatAnswerer = null, embeddings, embedder = null, summarizer = null, chatQuota = null, chatRetentionDays = DEFAULT_CHAT_RETENTION_DAYS, teamsIntegration = new MicrosoftTeamsIntegrationAdapter(), clock = { now: () => new Date() }, authorizationTtlMs = 300000, maxRecordingBytes = 10485760, acceptedMimeTypes = RECORDING_MIME_TYPES, schedule = queueMicrotask }) {
    // The `storage` bundle is the production persistence seam. Keeping the
    // individual repositories supported preserves existing local tests and
    // transports during the incremental migration, while a real deployment
    // can pass a validated tenant-scoped transactional adapter as one unit.
    let scopedOutbox = null
    if (storage) {
      // Structural contract failures throw here, synchronously. The final
      // transaction-isolation check may be asynchronous; it is awaited before
      // the first read or write instead (a failure surfaces on first use).
      const storageReady = Promise.resolve(assertMeetingStorageContract(storage))
      storageReady.catch(() => {})
      const storageFacade = storage
      const scoped = scopedStorageRepositories(storageFacade, storageReady)
      meetings ??= scoped.meetings
      knowledge ??= scoped.knowledge
      recordings ??= scoped.recordings
      audit ??= scoped.audit
      commitments ??= scoped.commitments
      chat ??= scoped.chat
      embeddings ??= scoped.embeddings
      scopedOutbox = scoped.outbox
      // This is a private, tenant-first execution capability. It is used only
      // to make state transitions and their outbox rows one transaction when
      // a storage bundle is present; callers can never obtain the bundle or a
      // raw repository from the platform.
      this.#tenantTransaction = async (tenantId, operation) => {
        await storageReady
        return storageFacade.transaction({ tenantId }, operation)
      }
      // Do not retain even the bundle's scope entrypoint on the runtime. The
      // only platform fields are the narrowed repository adapters above;
      // every one closes over a single tenant-bound facade operation.
      storage = null
    } else if (recordings) {
      // The original in-memory recording adapter predates the tenant-first
      // storage seam and accepts only a recording ID for byte operations.
      // Normalize it behind the same tenant-first shape used by storage
      // bundles; the raw repository is not stored on the platform.
      const legacyRecordings = recordings
      const recordInTenant = (tenantId, recordingId) => {
        const record = legacyRecordings.get(recordingId)
        return record?.tenantId === tenantId ? record : null
      }
      recordings = Object.freeze({
        get: recordInTenant,
        listForMeeting: (tenantId, meetingId) => legacyRecordings.listForMeeting(tenantId, meetingId),
        save: (record) => legacyRecordings.save(record),
        putBytes: (tenantId, recordingId, bytes) => {
          invariant(recordInTenant(tenantId, recordingId), 'TENANT_SCOPE_VIOLATION', 'Recording must remain inside the active tenant scope', 403)
          return legacyRecordings.putBytes(recordingId, bytes)
        },
        getBytes: (tenantId, recordingId) => {
          invariant(recordInTenant(tenantId, recordingId), 'TENANT_SCOPE_VIOLATION', 'Recording must remain inside the active tenant scope', 403)
          return legacyRecordings.getBytes(recordingId)
        },
        clearContent: (tenantId, recordingId) => {
          invariant(recordInTenant(tenantId, recordingId), 'TENANT_SCOPE_VIOLATION', 'Recording must remain inside the active tenant scope', 403)
          return legacyRecordings.clearContent(recordingId)
        },
      })
    }
    commitments ??= new InMemoryCommitmentRegistry()
    chat ??= new InMemoryChatRepository()
    embeddings ??= new InMemoryEmbeddingRepository()
    invariant(meetings && knowledge && audit && commitments, 'INVALID_STORAGE_ADAPTER', 'Canonical meeting, knowledge, audit, and commitment repositories are required')
    const outbox = scopedOutbox
    Object.assign(this, { meetings, knowledge, recordings, audit, policy, speechProcessor, commitments, chat, chatAnswerer, embeddings, embedder, summarizer, chatQuota, chatRetentionDays, outbox, teamsIntegration, clock, authorizationTtlMs, maxRecordingBytes, acceptedMimeTypes: Object.freeze([...acceptedMimeTypes]), schedule })
  }

  #outboxKey(type, aggregateId, revision) {
    invariant(OUTBOX_EVENT_TYPES.has(type), 'INVALID_OUTBOX_EVENT', 'Outbox event type is not allowlisted')
    return `meeting-ledger:v1:${type}:${aggregateId}:${revision}`
  }

  async #emitOutbox({ tenantId, type, aggregateType, aggregateId, revision, payload }, transaction = null) {
    // Legacy repository construction intentionally has no outbox. This keeps
    // backwards-compatible tests operating while every storage-bundle-backed
    // platform obtains the transaction-scoped capability above.
    const repository = transaction?.outbox ?? this.outbox
    if (!repository) return null
    invariant(typeof tenantId === 'string' && tenantId.length > 0, 'TENANT_SCOPE_VIOLATION', 'Outbox events require a tenant scope', 403)
    invariant(typeof aggregateId === 'string' && aggregateId.length > 0, 'INVALID_OUTBOX_EVENT', 'Outbox events require a canonical aggregate')
    // The literal object construction below is intentional: do not spread a
    // processor result, a request body, or canonical record into an event.
    const event = {
      tenantId,
      type,
      aggregateType,
      aggregateId,
      idempotencyKey: this.#outboxKey(type, aggregateId, revision),
      payload: Object.freeze({ ...payload }),
      occurredAt: this.clock.now().toISOString(),
    }
    if (transaction) return (await transaction.outbox.enqueue(event))
    // A storage-backed platform does not call a global repository. It enters
    // a fresh tenant transaction facade even for an event-only transition.
    if (this.#tenantTransaction) return (await this.#tenantTransaction(tenantId, async (facade) => (await facade.outbox.enqueue(event))))
    return (await repository.enqueue(event))
  }

  async #commitmentCount(tenantId, meetingId, commitments = this.commitments) {
    const rows = commitments === this.commitments ? (await commitments.query(tenantId, '')) : (await commitments.query(''))
    return rows.filter((item) => item.meetingId === meetingId).length
  }

  async #emitKnowledgeChange(meetingRecord, revision, { commitmentsChanged = false, transaction = null, knowledge = this.knowledge, commitments = this.commitments } = {}) {
    // Once a meeting is outside active retention, downstream consumers must
    // not be told that knowledge exists or changed. Deletion gets its own
    // content-free disposition event below.
    if (!OUTBOX_RETENTION_VISIBLE_STATES.has(meetingRecord.retentionState)) return
    const snapshot = knowledge === this.knowledge
      ? (await knowledge.forMeeting(meetingRecord.tenantId, meetingRecord.id))
      : (await knowledge.forMeeting(meetingRecord.id))
    const payload = Object.freeze({
      state: 'available',
      segmentCount: snapshot.segments.length,
      assertionCount: snapshot.assertions.length,
    })
    await this.#emitOutbox({
      tenantId: meetingRecord.tenantId,
      type: 'knowledge.changed', aggregateType: 'meeting', aggregateId: meetingRecord.id,
      revision, payload,
    }, transaction)
    if (commitmentsChanged) {
      await this.#emitOutbox({
        tenantId: meetingRecord.tenantId,
        type: 'commitments.changed', aggregateType: 'meeting', aggregateId: meetingRecord.id,
        revision, payload: Object.freeze({ state: 'available', commitmentCount: (await this.#commitmentCount(meetingRecord.tenantId, meetingRecord.id, commitments)) }),
      }, transaction)
    }
  }

  async #audit({ correlationId, principal: actor, action, meetingId = null, recordingId = null, outcome, reason = null }, transaction = null) {
    await (transaction?.audit ?? this.audit).append({
      id: randomUUID(), correlationId, tenantId: actor.tenantId, principalId: actor.userId,
      actorId: actor.userId, resourceType: recordingId ? 'recording' : 'meeting',
      resourceId: recordingId ?? meetingId, meetingId, recordingId, action, outcome, reason,
      occurredAt: this.clock.now().toISOString(),
    })
  }

  async #audited(actor, correlationId, action, meetingId, operation, recordingId = null, allowedReason = null) {
    try {
      const execute = async (transaction = null) => {
        const result = (await operation())
        // A durable storage bundle supplies one tenant-bound transaction here.
        // The audit append is deliberately in that transaction, so an audit
        // outage rolls back the protected state transition instead of leaving
        // an allowed action without its required evidence.
        await this.#audit({ correlationId, principal: actor, action, meetingId, recordingId, outcome: 'allowed', reason: allowedReason }, transaction)
        return result
      }
      return this.#tenantTransaction ? (await this.#tenantTransaction(actor.tenantId, execute)) : (await execute())
    } catch (error) {
      await this.#audit({ correlationId, principal: actor, action, meetingId, recordingId, outcome: 'denied', reason: error?.auditReason ?? error?.code ?? 'UNEXPECTED_ERROR' })
      throw error
    }
  }

  #opaquePrivacyAccessDenied(auditReason) {
    const error = new DomainError('MEETING_NOT_FOUND', 'Meeting not found', 404)
    // Keep the policy decision inside the audit boundary. HTTP serialization only sees
    // the deliberately non-enumerable public error above.
    Object.defineProperty(error, 'auditReason', { value: auditReason, enumerable: false })
    return error
  }

  async #meeting(tenantId, meetingId) {
    // The platform never retains a storage bundle. Its narrowed meeting
    // adapter is tenant-first whether it came from a bundle or legacy test
    // repositories, so callers cannot reach an alternate storage scope.
    const record = (await this.meetings.get(tenantId, meetingId))
    if (!record) throw new DomainError('MEETING_NOT_FOUND', 'Meeting not found', 404)
    return record
  }

  async #recording(actor, meetingId, recordingId, organizerOnly = false) {
    const record = (await this.recordings?.get(actor.tenantId, recordingId))
    if (!record || record.tenantId !== actor.tenantId || record.meetingId !== meetingId) {
      throw new DomainError('RECORDING_NOT_FOUND', 'Recording not found', 404)
    }
    if (organizerOnly && record.organizerId !== actor.userId) {
      throw new DomainError('RECORDING_FORBIDDEN', 'Recording operation is bound to its organizer', 403)
    }
    return record
  }

  #capturePolicy(actor, meetingRecord) {
    return this.policy.require(this.policy.recordingPreflight({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
  }

  #safePolicyReason(code) {
    return POLICY_REASON_CODES.has(code) ? code : POLICY_REVOKED
  }

  async #syncCommitments(tenantId, meetingId, { knowledge = this.knowledge, commitments = this.commitments } = {}) {
    // The registry may consume only the already canonicalized knowledge
    // repository. It never receives a processor response or request body.
    if (knowledge === this.knowledge) await commitments.replaceMeeting(tenantId, meetingId, (await knowledge.forMeeting(tenantId, meetingId)))
    else await commitments.replaceMeeting(meetingId, (await knowledge.forMeeting(meetingId)))
  }

  // Publishing or failing one recording replaces only that recording's
  // knowledge. The rest of the meeting is rewritten unchanged in the same
  // tenant transaction, and the commitment registry is re-derived from it.
  async #replaceRecordingKnowledge(recording, published, { transaction = null, knowledge, commitments }) {
    const { tenantId, meetingId } = recording
    const snapshot = transaction ? (await knowledge.forMeeting(meetingId)) : (await knowledge.forMeeting(tenantId, meetingId))
    const retained = knowledgeWithoutRecording(snapshot, recording.id)
    if (transaction) { await knowledge.clearMeeting(meetingId); await transaction.embeddings.clearMeeting(meetingId) }
    else { await knowledge.clearMeeting(tenantId, meetingId); await this.embeddings.clearMeeting(tenantId, meetingId) }
    await knowledge.addSegments([...retained.segments, ...published.segments])
    await knowledge.addAssertions([...retained.assertions, ...published.assertions])
    await this.#syncCommitments(tenantId, meetingId, { knowledge, commitments })
  }

  #classificationSummary(meetingRecord) {
    const neverRecord = NEVER_RECORD_CATEGORIES.has(meetingRecord.classification)
    const confidential = neverRecord || (this.policy.sensitiveCategories?.has?.(meetingRecord.classification) ?? false)
    return Object.freeze({
      classification: meetingRecord.classification,
      confidentiality: neverRecord ? 'never-record' : confidential ? 'confidential' : 'standard',
      recordingProhibited: neverRecord,
    })
  }

  #retentionSummary(meetingRecord) {
    const state = meetingRecord.retentionState
    return Object.freeze({
      state,
      deletion: state === 'deleted' ? 'completed'
        : state === 'deletion-in-progress' ? 'in-progress'
          : state === 'pending-deletion' ? 'scheduled'
            : 'not-requested',
    })
  }

  async #redactedAuditTimeline(tenantId, meetingId) {
    const events = (await this.audit.forMeeting(tenantId, meetingId))
    return Object.freeze(events
      .slice(-AUDIT_TIMELINE_LIMIT)
      .map((event) => Object.freeze({
        occurredAt: event.occurredAt,
        action: SAFE_AUDIT_ACTIONS.has(event.action) ? event.action : 'redacted-event',
        outcome: ['allowed', 'denied'].includes(event.outcome) ? event.outcome : 'redacted',
        reason: event.reason === null || event.reason === undefined
          ? null
          : SAFE_AUDIT_REASONS.has(event.reason) ? event.reason : 'REDACTED',
        immutable: true,
      })))
  }

  #leasePolicyFingerprint(meetingRecord) {
    const relevantAllows = Array.isArray(this.policy.sensitiveRecordingAllows)
      ? this.policy.sensitiveRecordingAllows.filter((candidate) => candidate?.tenantId === meetingRecord.tenantId && candidate?.meetingId === meetingRecord.id)
      : []
    const policyState = {
      meeting: {
        tenantId: meetingRecord.tenantId,
        meetingId: meetingRecord.id,
        organizerId: meetingRecord.organizerId,
        participantIds: [...(meetingRecord.participantIds ?? [])].sort(),
        requiredParticipantIds: [...(meetingRecord.requiredParticipantIds ?? meetingRecord.participantIds ?? [])].sort(),
        classification: meetingRecord.classification,
        consentPolicyVersion: meetingRecord.consentPolicyVersion,
        retentionState: meetingRecord.retentionState,
      },
      recordingPolicy: {
        sensitiveCategories: this.policy.sensitiveCategories instanceof Set ? [...this.policy.sensitiveCategories].sort() : [],
        knownClassifications: this.policy.knownClassifications instanceof Set ? [...this.policy.knownClassifications].sort() : [],
        sensitiveRecordingAllows: relevantAllows,
      },
    }
    return createHash('sha256').update(JSON.stringify(canonical(policyState))).digest('hex')
  }

  #leaseMatchesCurrentPolicy(meetingRecord, lease) {
    return lease?.policyVersion === meetingRecord.consentPolicyVersion
      && lease?.classification === meetingRecord.classification
      && lease?.policyFingerprint === this.#leasePolicyFingerprint(meetingRecord)
  }

  async #revokeLease(meetingRecord, reason = 'RECORDING_POLICY_CHANGED') {
    const lease = meetingRecord.recording
    if (!lease?.leaseId || lease.status === 'revoked') return
    lease.status = 'revoked'
    lease.revokedAt = this.clock.now().toISOString()
    lease.revocationReason = this.#safePolicyReason(reason)
    await this.meetings.save(meetingRecord)
  }

  async #revokeLeaseIfStale(meetingRecord) {
    if (meetingRecord.recording?.leaseId && !this.#leaseMatchesCurrentPolicy(meetingRecord, meetingRecord.recording)) {
      await this.#revokeLease(meetingRecord)
      return true
    }
    return false
  }

  #recordingPolicyDecision(actor, meetingRecord, recording) {
    const decision = this.policy.recordingPreflight({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
    if (!decision.allowed) return decision
    if (!this.#leaseMatchesCurrentPolicy(meetingRecord, recording)) {
      return { allowed: false, code: 'RECORDING_POLICY_CHANGED', reason: 'Recording authorization no longer matches current policy' }
    }
    return decision
  }

  #authorizedRosterEvidence(meetingRecord) {
    const evidence = Array.isArray(meetingRecord.speakerRosterEvidence) ? meetingRecord.speakerRosterEvidence : []
    return evidence
      .filter((item) => item?.authorized === true && item?.binding === 'exact')
      .filter((item) => typeof item.diarizationLabel === 'string' && typeof item.participantId === 'string')
      .filter((item) => meetingRecord.participantIds.includes(item.participantId))
      .map((item) => Object.freeze({
        diarizationLabel: item.diarizationLabel, participantId: item.participantId,
        authorized: true, binding: 'exact',
      }))
  }

  #rosterBindings(rosterEvidence) {
    const candidates = new Map()
    for (const item of rosterEvidence) {
      const ids = candidates.get(item.diarizationLabel) ?? new Set()
      ids.add(item.participantId)
      candidates.set(item.diarizationLabel, ids)
    }
    return new Map([...candidates].map(([label, ids]) => [label, ids.size === 1 ? [...ids][0] : null]))
  }

  // Processor responses are an untrusted boundary even when the job completes.
  // Do not retain arbitrary processor provenance, IDs, labels, or result metadata:
  // those values would otherwise become an exfiltration channel through status,
  // stored knowledge, search, AI retrieval, and audit-adjacent views.
  #processorDescriptor(rawLabel) {
    const label = TRUSTED_PROCESSOR_MODES.has(rawLabel) ? rawLabel : 'Speech processor'
    return Object.freeze({
      label,
      mode: TRUSTED_PROCESSOR_MODES.get(label) ?? 'redacted',
    })
  }

  #canonicalProcessorProvenance(descriptor, recording, identityBinding = null) {
    const provenance = {
      source: CANONICAL_PROCESSOR_SOURCE,
      processor: descriptor.label,
      mode: descriptor.mode,
      recordingId: recording.id,
    }
    if (identityBinding) provenance.identityBinding = identityBinding
    return Object.freeze(provenance)
  }

  #canonicalProcessorAssertionProvenance(descriptor, recording, model = null) {
    return Object.freeze({
      ...this.#canonicalProcessorProvenance(descriptor, recording),
      ...(model ? { model } : {}),
      canonicalOrigin: CANONICAL_PROCESSOR_ASSERTION_ORIGIN,
    })
  }

  // The model that wrote generated items is kept only for a trusted
  // model-backed processor mode and only as a plain model identifier.
  #canonicalModel(descriptor, rawModel) {
    if (!MODEL_BACKED_PROCESSOR_MODES.has(descriptor.mode)) return null
    return typeof rawModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(rawModel) ? rawModel : null
  }

  #canonicalConfidence(value) {
    // A bounded scalar is the only processor-supplied confidence retained. It is
    // informational only; authorization is derived exclusively from roster evidence.
    if (!Number.isFinite(value) || value < 0 || value > 1) return null
    return Math.round(value * 10000) / 10000
  }

  // Action owners are kept only when they are participants of this meeting;
  // deadlines only when they are real calendar dates; speaker labels only when
  // they label this transcript. Anything else stays unknown rather than guessed.
  #canonicalProcessorCommitment(input, participantIds, speakerLabelFor = () => null) {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const commitment = { status: 'open' }
    if (typeof value.ownerId === 'string' && participantIds.includes(value.ownerId)) commitment.ownerId = value.ownerId
    if (value.agreement === 'committed' || value.agreement === 'proposed') commitment.agreement = value.agreement
    // Only a label that appears on this transcript's segments is kept.
    const speakerLabel = typeof value.speakerLabel === 'string' ? speakerLabelFor(value.speakerLabel) : null
    if (speakerLabel) commitment.speakerLabel = speakerLabel
    if (typeof value.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.deadline)) {
      const parsed = new Date(`${value.deadline}T00:00:00.000Z`)
      if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.deadline) commitment.deadline = parsed.toISOString()
    }
    return commitment
  }

  #normalizeProcessorResult(result, recording, rosterEvidence, participantIds = [], { assertionPrefix = `${recording.id}-assertion-` } = {}) {
    invariant(result && Array.isArray(result.segments) && Array.isArray(result.assertions), 'INVALID_PROCESSOR_RESULT', 'Processor result is invalid')
    invariant(result.segments.length <= MAX_PROCESSOR_SEGMENTS && result.assertions.length <= MAX_PROCESSOR_ASSERTIONS, 'INVALID_PROCESSOR_RESULT', 'Processor result exceeds its size limits')
    const bindings = this.#rosterBindings(rosterEvidence)
    const descriptor = this.#processorDescriptor(result.processor)
    const model = this.#canonicalModel(descriptor, result.model)
    const rawSegmentIds = new Map()
    const rawSegmentText = new Map(result.segments.map((item) => [item?.id, String(item?.text ?? '')]))
    // An action's owner must be named in the transcript lines it cites ("Sam,
    // can you..."). Who spoke a line, even a confirmed speaker, never makes them
    // the owner (user decision 2026-10-07); this is enforced here, not only by
    // the summarizer's instructions.
    const namedIn = (citations) => {
      const cited = citations.map((id) => rawSegmentText.get(id) ?? '').join(' ').toLowerCase()
      return participantIds.filter((id) => new RegExp(`(^|[^a-z0-9])${id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(cited))
    }
    const diarizationLabels = new Map()
    const canonicalDiarizationLabel = (rawLabel) => {
      if (rawLabel === UNATTRIBUTED_SPEAKER_LABEL) return UNATTRIBUTED_SPEAKER_LABEL
      if (!diarizationLabels.has(rawLabel)) diarizationLabels.set(rawLabel, `SPEAKER_${String(diarizationLabels.size).padStart(2, '0')}`)
      return diarizationLabels.get(rawLabel)
    }
    const segments = result.segments.map((item, index) => {
      invariant(item && typeof item === 'object', 'INVALID_PROCESSOR_RESULT', 'Processor segment is invalid')
      invariant(typeof item.diarizationLabel === 'string' && item.diarizationLabel.length > 0, 'INVALID_PROCESSOR_RESULT', 'Processor segment requires a diarization label')
      invariant(typeof item.id === 'string' && item.id.length > 0 && !rawSegmentIds.has(item.id), 'INVALID_PROCESSOR_RESULT', 'Processor segment IDs must be unique')
      invariant(typeof item.text === 'string' && item.text.length <= MAX_PROCESSOR_SEGMENT_TEXT, 'INVALID_PROCESSOR_RESULT', 'Processor segment text is invalid')
      const id = `${recording.id}-segment-${index + 1}`
      rawSegmentIds.set(item.id, id)
      const verifiedParticipantId = bindings.get(item.diarizationLabel) ?? null
      return transcriptSegment({
        id, tenantId: recording.tenantId, meetingId: recording.meetingId,
        startMs: item.startMs, endMs: item.endMs, text: item.text,
        diarizationLabel: canonicalDiarizationLabel(item.diarizationLabel),
        verifiedParticipantId,
        identityConfidence: this.#canonicalConfidence(item.identityConfidence),
        provenance: this.#canonicalProcessorProvenance(
          descriptor,
          recording,
          verifiedParticipantId ? 'authorized-exact-roster' : 'unverified-diarization-only',
        ),
      })
    })
    const rawAssertionIds = new Set()
    const assertions = []
    let withheldAssertions = 0
    for (const item of result.assertions) {
      invariant(item && typeof item === 'object', 'INVALID_PROCESSOR_RESULT', 'Processor assertion is invalid')
      invariant(typeof item.id === 'string' && item.id.length > 0 && !rawAssertionIds.has(item.id), 'INVALID_PROCESSOR_RESULT', 'Processor assertion IDs must be unique')
      invariant(isBoundedKnowledgeCitationList(item.citations), 'INVALID_CITATION', 'Every processor assertion requires a bounded citation list')
      rawAssertionIds.add(item.id)
      // A claim citing evidence that is not in this transcript is unsupported:
      // it is withheld (and counted) rather than published or repaired.
      if (!item.citations.every((id) => rawSegmentIds.has(id)) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_PROCESSOR_ASSERTION_TEXT) {
        withheldAssertions += 1
        continue
      }
      const kind = PROCESSOR_ASSERTION_KINDS.has(item.kind) ? item.kind : 'finding'
      assertions.push(knowledgeAssertion({
        id: `${assertionPrefix}${assertions.length + 1}`, tenantId: recording.tenantId, meetingId: recording.meetingId,
        kind,
        text: item.text.trim(),
        citations: [...new Set(item.citations.map((id) => rawSegmentIds.get(id)))],
        provenance: this.#canonicalProcessorAssertionProvenance(descriptor, recording, model),
        ...(kind === 'action' ? { commitment: this.#canonicalProcessorCommitment(item.commitment, namedIn(item.citations), (raw) => diarizationLabels.get(raw) ?? null) } : {}),
      }))
    }
    return {
      segments,
      assertions,
      withheldAssertions,
      processor: descriptor.label,
    }
  }

  async #quarantineRecording(meetingRecord, recordingId, reason, suppliedTransaction = null) {
    const quarantine = async (transaction = null) => {
      const recordings = transaction?.recordings ?? this.recordings
      const knowledge = transaction?.knowledge ?? this.knowledge
      const commitments = transaction?.commitments ?? this.commitments
      const record = transaction
        ? (await recordings.get(recordingId))
        : (await recordings.get(meetingRecord.tenantId, recordingId))
      let transitioned = false
      if (record && !['deleted', 'completed'].includes(record.state)) {
        transitioned = record.state !== 'quarantined'
        record.state = 'quarantined'
        record.progress = 100
        record.error = POLICY_REVOKED
        record.processor = null
        record.dispositionReason = this.#safePolicyReason(reason)
        record.summaryHistory = []
        await recordings.save(record)
        if (DELETE_BYTES_ON_REVOKE.has(meetingRecord.retentionState)) {
          if (transaction) await recordings.clearContent(record.id)
          else await recordings.clearContent(meetingRecord.tenantId, record.id)
        }
      }
      if (transaction) {
        await knowledge.clearMeeting(meetingRecord.id)
        await commitments.clearMeeting(meetingRecord.id)
        await transaction.embeddings.clearMeeting(meetingRecord.id)
      } else {
        await knowledge.clearMeeting(meetingRecord.tenantId, meetingRecord.id)
        await commitments.clearMeeting(meetingRecord.tenantId, meetingRecord.id)
        await this.embeddings.clearMeeting(meetingRecord.tenantId, meetingRecord.id)
      }
      if (transitioned && record && meetingRecord.retentionState !== 'deleted') {
        await this.#emitOutbox({
          tenantId: meetingRecord.tenantId,
          type: 'recording.quarantined', aggregateType: 'recording', aggregateId: record.id,
          revision: 'quarantined',
          payload: Object.freeze({ state: 'quarantined', reason: this.#safePolicyReason(reason) }),
        }, transaction)
      }
    }
    if (suppliedTransaction) return quarantine(suppliedTransaction)
    if (this.#tenantTransaction) return this.#tenantTransaction(meetingRecord.tenantId, quarantine)
    return quarantine()
  }

  async #quarantine(meetingRecord, reason) {
    for (const record of (await this.recordings?.listForMeeting(meetingRecord.tenantId, meetingRecord.id)) ?? []) {
      await this.#quarantineRecording(meetingRecord, record.id, reason)
    }
  }

  async #auditProcessingDenial(correlationId, actor, recording, reason) {
    await this.#audit({
      correlationId, principal: actor, action: 'recording.process.complete',
      meetingId: recording?.meetingId ?? null, recordingId: recording?.id ?? null,
      outcome: 'denied', reason: this.#safePolicyReason(reason),
    })
  }

  // Background processing is not wrapped in a request's #audited boundary.
  // A policy-revocation quarantine therefore commits its required denial audit
  // in the same tenant transaction; otherwise an audit outage could leave an
  // unaudited content-disposition transition behind.
  async #quarantineAndAuditProcessingDenial(meetingRecord, recordingId, correlationId, actor, reason) {
    const quarantine = async (transaction = null) => {
      await this.#quarantineRecording(meetingRecord, recordingId, reason, transaction)
      await this.#audit({
        correlationId, principal: actor, action: 'recording.process.complete',
        meetingId: meetingRecord.id, recordingId, outcome: 'denied', reason: this.#safePolicyReason(reason),
      }, transaction)
    }
    if (this.#tenantTransaction) return this.#tenantTransaction(meetingRecord.tenantId, quarantine)
    return quarantine()
  }

  async #processorFailure(recordingId, correlationId, actor) {
    const fail = async (transaction = null) => {
      const recordings = transaction?.recordings ?? this.recordings
      const knowledge = transaction?.knowledge ?? this.knowledge
      const commitments = transaction?.commitments ?? this.commitments
      const record = transaction
        ? (await recordings.get(recordingId))
        : (await recordings.get(actor.tenantId, recordingId))
      if (record && !['quarantined', 'deleted'].includes(record.state)) {
        record.state = 'failed'
        record.progress = 100
        record.error = PROCESSOR_FAILED
        record.processor = null
        await recordings.save(record)
        await this.#replaceRecordingKnowledge(record, { segments: [], assertions: [] }, { transaction, knowledge, commitments })
      }
      // Processor failures are deliberately not outbox events. The processor
      // is untrusted and a failed payload must never become a downstream
      // signal or metadata channel; the state and this redacted audit event
      // still commit together for durable storage.
      await this.#audit({
        correlationId, principal: actor, action: 'recording.process.complete',
        meetingId: record?.meetingId ?? null, recordingId, outcome: 'denied', reason: PROCESSOR_FAILED,
      }, transaction)
    }
    if (this.#tenantTransaction) return this.#tenantTransaction(actor.tenantId, fail)
    return fail()
  }

  async createMeeting(input, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'meeting.create', body?.id, async () => {
      invariant(actor.tenantId === body.tenantId && actor.userId === body.organizerId, 'CREATE_FORBIDDEN', 'Organizer must create the meeting in their tenant', 403)
      return (await this.meetings.save(meeting(body)))
    }))
  }

  async listMeetings(input, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'meeting.list', null, async () => {
      const records = await this.meetings.list(actor.tenantId)
      return records.filter((record) => (record.organizerId === actor.userId || record.participantIds.includes(actor.userId)) && record.retentionState === 'active')
        // Retire the exact historical no-title local demo record. New meetings
        // require a title at the HTTP boundary, so this cannot hide real data.
        .filter((record) => record.id !== 'meeting-1' || typeof record.title === 'string')
        .map((record) => Object.freeze({ id: record.id, title: typeof record.title === 'string' && record.title.trim() ? record.title : 'Untitled meeting', organizerId: record.organizerId, participantIds: Object.freeze([...record.participantIds]), classification: record.classification, createdAt: record.createdAt ?? null, recordingStatus: record.recording?.status ?? 'not-authorized' }))
    }))
  }

  async recordConsent(input, meetingId, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'consent.record', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      invariant(actor.userId === body.participantId && meetingRecord.participantIds.includes(actor.userId), 'CONSENT_FORBIDDEN', 'Participants may record only their own consent', 403)
      const evidence = consentEvidence(body)
      // consentEvidence holds each participant's current decision for policy;
      // consentHistory is append-only, so a later withdrawal never erases the
      // grant it replaced. Both are content-free.
      meetingRecord.consentHistory = [...(Array.isArray(meetingRecord.consentHistory) ? meetingRecord.consentHistory : []), Object.freeze({ ...evidence, recordedAt: this.clock.now().toISOString() })]
      meetingRecord.consentEvidence = meetingRecord.consentEvidence.filter((item) => item.participantId !== actor.userId)
      meetingRecord.consentEvidence.push(evidence)
      await this.meetings.save(meetingRecord)
      await this.#revokeLeaseIfStale(meetingRecord)
      if (body.decision !== 'granted') {
        // Withdrawal ends any active capture authorization at a recorded boundary.
        await this.#endCapture(meetingRecord, 'CONSENT_WITHDRAWN')
        await this.#quarantine(meetingRecord, 'CONSENT_NOT_GRANTED')
      }
    }))
  }

  // Re-derives the caller tenant's audit hash chain. The response contains only
  // sequence numbers, the head hash, and an allowlisted failure reason. The
  // verification is itself audited after the check, so it extends the chain
  // one event beyond the head it reports.
  async verifyAuditIntegrity(input, { anchor = null } = {}, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'audit.verify', null, async () => {
      this.policy.require(this.policy.auditIntegrity({ principal: actor, now: this.clock.now() }))
      invariant(typeof this.audit.chain === 'function', 'AUDIT_INTEGRITY_UNAVAILABLE', 'Audit store does not expose a verifiable chain', 503)
      return verifyAuditChain((await this.audit.chain(actor.tenantId)), { tenantId: actor.tenantId, anchor })
    }))
  }

  async getTeamsReadiness(input, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'teams.readiness', null, () => this.teamsIntegration.readiness()))
  }

  async prepareTeamsImport(input, meetingId, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'teams.import.prepare', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      // Import authorization is intentionally governed by the same policy gate
      // as microphone capture: organizer, classification, retention, and each
      // required participant's explicit current consent are all re-evaluated.
      this.#capturePolicy(actor, meetingRecord)
      return this.teamsIntegration.prepareImport(body)
    }))
  }

  // Records a capture boundary and revokes the active authorization, so audio
  // captured under it can never be uploaded. Returns whether a lease was live.
  async #endCapture(meetingRecord, reason) {
    const lease = meetingRecord.recording
    const live = Boolean(lease?.leaseId) && lease.status === 'authorized'
    if (live) await this.#revokeLease(meetingRecord, reason)
    meetingRecord.captureStops = [
      ...(Array.isArray(meetingRecord.captureStops) ? meetingRecord.captureStops : []),
      Object.freeze({ at: this.clock.now().toISOString(), reason: this.#safePolicyReason(reason), authorizationRevoked: live }),
    ].slice(-MAX_CAPTURE_STOPS)
    await this.meetings.save(meetingRecord)
    return live
  }

  // Quarantines a recording that has not finished processing and deletes its
  // audio, unless the meeting is under legal hold: a hold blocks destruction
  // (the quarantine still removes it from every ordinary read and job). Other
  // recordings' published knowledge is untouched: the stop applies only to the
  // capture it names.
  async #quarantineStoppedRecording(meetingRecord, record, reason) {
    if (['completed', 'deleted', 'quarantined'].includes(record.state)) return false
    record.state = 'quarantined'
    record.progress = 100
    record.error = POLICY_REVOKED
    record.processor = null
    record.dispositionReason = this.#safePolicyReason(reason)
    await this.recordings.save(record)
    if (meetingRecord.retentionState !== 'held') await this.recordings.clearContent(record.tenantId, record.id)
    await this.#emitOutbox({
      tenantId: record.tenantId,
      type: 'recording.quarantined', aggregateType: 'recording', aggregateId: record.id,
      revision: 'quarantined',
      payload: Object.freeze({ state: 'quarantined', reason: record.dispositionReason }),
    })
    return true
  }

  // Any participant can stop capture immediately, for example when the
  // discussion turns to a sensitive topic. The active authorization is revoked
  // (later upload or processing of that capture is refused), the boundary time
  // is recorded, and anything already uploaded under it and not yet published
  // is quarantined with its audio deleted. A new capture needs a fresh preflight.
  async stopCapture(input, meetingId, body, correlationId = randomUUID()) {
    const actor = principal(input)
    const reason = CAPTURE_STOP_REASONS.get(body?.reason)
    return (await this.#audited(actor, correlationId, 'recording.stop', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      invariant(meetingRecord.participantIds.includes(actor.userId) || meetingRecord.organizerId === actor.userId, 'MEETING_NOT_FOUND', 'Meeting not found', 404)
      invariant(reason, 'INVALID_STOP_REASON', 'Stop reason must be sensitive-topic or participant-request', 400)
      const leaseId = meetingRecord.recording?.leaseId ?? null
      const authorizationRevoked = await this.#endCapture(meetingRecord, reason)
      let quarantinedRecordings = 0
      if (leaseId) {
        for (const record of (await this.recordings.listForMeeting(actor.tenantId, meetingId)) ?? []) {
          if (record.leaseId === leaseId && (await this.#quarantineStoppedRecording(meetingRecord, record, reason))) quarantinedRecordings += 1
        }
      }
      return { stoppedAt: meetingRecord.captureStops.at(-1).at, reason: body.reason, authorizationRevoked, quarantinedRecordings }
    }, null, reason))
  }

  async authorizeRecording(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'recording.preflight', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      this.#capturePolicy(actor, meetingRecord)
      const now = this.clock.now()
      meetingRecord.recording = {
        status: 'authorized', leaseId: randomUUID(), authorizationId: null,
        tenantId: meetingRecord.tenantId, meetingId: meetingRecord.id, organizerId: actor.userId,
        policyVersion: meetingRecord.consentPolicyVersion, classification: meetingRecord.classification,
        policyFingerprint: this.#leasePolicyFingerprint(meetingRecord), allowedMimeTypes: [...this.acceptedMimeTypes],
        maxBytes: this.maxRecordingBytes, singleRecording: true, usedAt: null,
        issuedAt: now.toISOString(),
        authorizationExpiresAt: new Date(now.getTime() + this.authorizationTtlMs).toISOString(),
      }
      meetingRecord.recording.authorizationId = meetingRecord.recording.leaseId
      await this.meetings.save(meetingRecord)
      return structuredClone(meetingRecord.recording)
    }))
  }

  // Participants poll this minimal capability while capture is open. It does
  // not mint, refresh, or disclose a lease; it only tells an authorized
  // participant whether their local microphone must stop now.
  async getRecordingAuthorizationStatus(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.authorization.status', meetingId, async () => {
      const meetingRecord = await this.#meeting(actor.tenantId, meetingId)
      invariant(meetingRecord.participantIds.includes(actor.userId), 'MEETING_NOT_FOUND', 'Meeting not found', 404)
      const lease = meetingRecord.recording
      const organizer = { tenantId: meetingRecord.tenantId, userId: meetingRecord.organizerId }
      const policy = this.policy.recordingPreflight({ principal: organizer, meeting: meetingRecord, now: this.clock.now() })
      const active = lease?.status === 'authorized'
        && new Date(lease.authorizationExpiresAt) > this.clock.now()
        && this.#leaseMatchesCurrentPolicy(meetingRecord, lease)
        && policy.allowed
      return Object.freeze({ active: Boolean(active), authorizationExpiresAt: active ? lease.authorizationExpiresAt : null })
    })
  }

  async createRecording(input, meetingId, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'recording.create', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      const staleLease = meetingRecord.recording?.leaseId && !this.#leaseMatchesCurrentPolicy(meetingRecord, meetingRecord.recording)
      if (staleLease) await this.#revokeLease(meetingRecord)
      this.#capturePolicy(actor, meetingRecord)
      const lease = meetingRecord.recording
      invariant(lease?.leaseId === body.leaseId, 'INVALID_RECORDING_LEASE', 'Recording lease does not match', 403)
      invariant(lease.tenantId === actor.tenantId && lease.meetingId === meetingId && lease.organizerId === actor.userId, 'LEASE_BINDING_MISMATCH', 'Recording lease binding does not match', 403)
      if (staleLease) {
        throw new DomainError('RECORDING_POLICY_CHANGED', 'Recording lease is stale for current policy', 403)
      }
      invariant(lease.status === 'authorized', 'RECORDING_LEASE_REVOKED', 'Recording lease was revoked', 403)
      invariant(new Date(lease.authorizationExpiresAt) > this.clock.now(), 'RECORDING_LEASE_EXPIRED', 'Recording lease expired', 403)
      invariant(!lease.usedAt, 'RECORDING_LEASE_REPLAYED', 'Recording lease is single-use', 409)
      const contentType = normalizeIngestMimeType(body.contentType)
      invariant(contentType && lease.allowedMimeTypes.includes(contentType), 'INVALID_CONTENT_TYPE', 'Recording content type is not allowed', 415)
      invariant(Number.isSafeInteger(body.byteLength) && body.byteLength > 0 && body.byteLength <= lease.maxBytes, 'INVALID_BYTE_LENGTH', 'Recording size is invalid', 413)
      invariant(typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/.test(body.sha256), 'INVALID_SHA256', 'sha256 must be exact lower-case hexadecimal', 400)
      lease.usedAt = this.clock.now().toISOString()
      await this.meetings.save(meetingRecord)
      const recording = (await this.recordings.save({
        id: randomUUID(), tenantId: actor.tenantId, meetingId, organizerId: actor.userId,
        policyVersion: lease.policyVersion, classification: lease.classification,
        policyFingerprint: lease.policyFingerprint, leaseId: lease.leaseId,
        contentType, byteLength: body.byteLength, sha256: body.sha256,
        state: 'created', progress: 0, uploadedAt: null, bytes: null, processor: null, error: null,
      }))
      return { recordingId: recording.id, uploadRoute: `/meetings/${meetingId}/recordings/${recording.id}/bytes`, state: recording.state }
    }))
  }

  async uploadRecording(input, meetingId, recordingId, { contentType, contentLength, bytes }, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'recording.upload', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      this.#capturePolicy(actor, meetingRecord)
      const recording = (await this.#recording(actor, meetingId, recordingId, true))
      invariant(this.#leaseMatchesCurrentPolicy(meetingRecord, recording), 'RECORDING_POLICY_CHANGED', 'Recording authorization no longer matches current policy', 403)
      invariant(recording.state === 'created' && !recording.uploadedAt, 'DUPLICATE_UPLOAD', 'Recording bytes may be uploaded once', 409)
      invariant(normalizeIngestMimeType(contentType) === recording.contentType, 'CONTENT_TYPE_MISMATCH', 'Content-Type does not match declared metadata', 415)
      invariant(Number.isSafeInteger(contentLength), 'CONTENT_LENGTH_REQUIRED', 'Content-Length is required', 411)
      invariant(contentLength <= this.maxRecordingBytes && contentLength === recording.byteLength, 'CONTENT_LENGTH_MISMATCH', 'Content-Length does not match declared size', 400)
      invariant(bytes.length === recording.byteLength, 'ACTUAL_LENGTH_MISMATCH', 'Actual bytes do not match declared size', 400)
      invariant(createHash('sha256').update(bytes).digest('hex') === recording.sha256, 'HASH_MISMATCH', 'Recording hash does not match declared sha256', 400)
      // WAV is the one format the server can verify completely before storing it.
      if (recording.contentType === SPEECH_WAV_MIME_TYPE) parseSpeechWav(bytes)
      await this.recordings.putBytes(actor.tenantId, recording.id, bytes)
      recording.state = 'uploaded'; recording.progress = 20; recording.uploadedAt = this.clock.now().toISOString()
      await this.recordings.save(recording)
      // Retention counts from the first stored content and never restarts.
      if (!meetingRecord.contentStartedAt) {
        meetingRecord.contentStartedAt = recording.uploadedAt
        await this.meetings.save(meetingRecord)
      }
      return view(recording)
    }, recordingId))
  }

  async startProcessing(input, meetingId, recordingId, correlationId = randomUUID()) {
    const actor = principal(input)
    let queuedRecordingId = null
    const result = (await this.#audited(actor, correlationId, 'recording.process', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      const recording = (await this.#recording(actor, meetingId, recordingId, true))
      const decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
      if (!decision.allowed) {
        await this.#quarantineRecording(meetingRecord, recording.id, decision.code)
        this.policy.require(decision)
      }
      if (['queued', 'processing', 'completed'].includes(recording.state)) return view(recording)
      invariant(recording.state === 'uploaded', 'RECORDING_NOT_UPLOADED', 'Recording must be uploaded before processing', 409)
      recording.state = 'queued'; recording.progress = 35; recording.processingAttempts = 1
      await this.recordings.save(recording)
      queuedRecordingId = recording.id
      return view(recording)
    }, recordingId))
    // Queue only after both the state transition and its required allowed
    // audit event commit. This avoids leaking a completed transaction context
    // into asynchronous work and prevents an audit outage from launching a
    // job for rolled-back state.
    if (queuedRecordingId) this.schedule(async () => (await this.#process(actor.tenantId, queuedRecordingId, correlationId)))
    return result
  }

  // Re-queues a failed job for its organizer, a bounded number of times. Policy
  // is evaluated exactly as for a first attempt: if consent, classification,
  // or retention changed since the upload, the recording is quarantined
  // instead of being processed again.
  async retryProcessing(input, meetingId, recordingId, correlationId = randomUUID()) {
    const actor = principal(input)
    let queuedRecordingId = null
    const result = (await this.#audited(actor, correlationId, 'recording.process.retry', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      const recording = (await this.#recording(actor, meetingId, recordingId, true))
      invariant(recording.state === 'failed' && recording.error === PROCESSOR_FAILED, 'RECORDING_NOT_RETRYABLE', 'Only a failed processing job can be retried', 409)
      invariant((recording.processingAttempts ?? 1) < MAX_PROCESSING_ATTEMPTS, 'RETRY_LIMIT_REACHED', 'This recording has reached its processing retry limit', 409)
      const decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
      if (!decision.allowed) {
        await this.#quarantineRecording(meetingRecord, recording.id, decision.code)
        this.policy.require(decision)
      }
      invariant(!recording.contentClearedAt && (await this.recordings.getBytes(actor.tenantId, recording.id)), 'RECORDING_CONTENT_UNAVAILABLE', 'Recording audio is no longer available', 409)
      recording.state = 'queued'; recording.progress = 35; recording.error = null
      recording.processingAttempts = (recording.processingAttempts ?? 1) + 1
      await this.recordings.save(recording)
      queuedRecordingId = recording.id
      return view(recording)
    }, recordingId))
    if (queuedRecordingId) this.schedule(async () => (await this.#process(actor.tenantId, queuedRecordingId, correlationId)))
    return result
  }

  async #process(tenantId, recordingId, correlationId) {
    let recording = (await this.recordings.get(tenantId, recordingId))
    if (!recording) return
    const actor = principal({ tenantId: recording.tenantId, userId: recording.organizerId })
    if (recording.state !== 'queued') {
      if (['quarantined', 'deleted'].includes(recording.state)) {
        await this.#auditProcessingDenial(correlationId, actor, recording, recording.dispositionReason ?? PROCESSING_CANCELLED)
      }
      return
    }
    let meetingRecord = (await this.#meeting(recording.tenantId, recording.meetingId))
    let decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
    if (!decision.allowed) {
      await this.#quarantineAndAuditProcessingDenial(meetingRecord, recording.id, correlationId, actor, decision.code)
      return
    }

    recording.state = 'processing'; recording.progress = 65
    await this.recordings.save(recording)
    const rosterEvidence = this.#authorizedRosterEvidence(meetingRecord)

    let result
    try {
      const rawResult = await this.speechProcessor.process({
        recording: structuredClone(recording), bytes: (await this.recordings.getBytes(actor.tenantId, recordingId)), rosterEvidence,
        participantIds: [...meetingRecord.participantIds],
      })
      result = this.#normalizeProcessorResult(rawResult, recording, rosterEvidence, meetingRecord.participantIds)
    } catch {
      recording = (await this.recordings.get(actor.tenantId, recordingId))
      meetingRecord = recording ? (await this.#meeting(recording.tenantId, recording.meetingId)) : meetingRecord
      if (recording?.state === 'quarantined') {
        await this.#auditProcessingDenial(correlationId, actor, recording, recording.dispositionReason ?? PROCESSING_CANCELLED)
        return
      }
      if (recording) {
        decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
        if (!decision.allowed) {
          await this.#quarantineAndAuditProcessingDenial(meetingRecord, recording.id, correlationId, actor, decision.code)
          return
        }
      }
      await this.#processorFailure(recordingId, correlationId, actor)
      return
    }

    recording = (await this.recordings.get(actor.tenantId, recordingId))
    if (!recording || recording.state !== 'processing') {
      await this.#auditProcessingDenial(correlationId, actor, recording, recording?.dispositionReason ?? PROCESSING_CANCELLED)
      return
    }
    meetingRecord = (await this.#meeting(recording.tenantId, recording.meetingId))
    decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
    if (!decision.allowed) {
      await this.#quarantineAndAuditProcessingDenial(meetingRecord, recording.id, correlationId, actor, decision.code)
      return
    }

    try {
      recording.state = 'completed'; recording.progress = 100; recording.processor = result.processor; recording.error = null
      recording.withheldAssertions = result.withheldAssertions
      const publish = async (transaction = null) => {
        const knowledge = transaction?.knowledge ?? this.knowledge
        const commitments = transaction?.commitments ?? this.commitments
        const recordings = transaction?.recordings ?? this.recordings
        await this.#replaceRecordingKnowledge(recording, result, { transaction, knowledge, commitments })
        await recordings.save(recording)
        await this.#emitKnowledgeChange(meetingRecord, `recording:${recording.id}:completed`, { commitmentsChanged: true, transaction, knowledge, commitments })
        await this.#emitOutbox({
          tenantId: recording.tenantId,
          type: 'recording.completed', aggregateType: 'recording', aggregateId: recording.id,
          revision: 'completed', payload: Object.freeze({ state: 'completed' }),
        }, transaction)
        await this.#audit({
          correlationId, principal: actor, action: 'recording.process.complete',
          meetingId: recording.meetingId, recordingId, outcome: 'allowed',
        }, transaction)
      }
      if (this.#tenantTransaction) await this.#tenantTransaction(recording.tenantId, publish)
      else await publish()
    } catch {
      await this.#processorFailure(recordingId, correlationId, actor)
    }
  }

  // Status-only list of a meeting's recordings, oldest first, for anyone who
  // may read the meeting. It carries no transcript, assertion, or audio data;
  // each recording's results are read separately through getRecording.
  async listRecordings(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'recording.list', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      this.policy.require(this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      const records = (await this.recordings?.listForMeeting(actor.tenantId, meetingId)) ?? []
      return Object.freeze({
        recordings: Object.freeze(records.map((record) => Object.freeze({
          id: record.id, state: record.state, processor: record.processor ?? null,
          uploadedAt: record.uploadedAt ?? null, withheldAssertions: record.withheldAssertions ?? 0,
        }))),
      })
    }))
  }

  async getRecording(input, meetingId, recordingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'recording.status', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      this.policy.require(this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      const recording = (await this.#recording(actor, meetingId, recordingId))
      const output = { recording: view(recording) }
      if (recording.state === 'completed') {
        const own = knowledgeForRecording((await this.knowledge.forMeeting(actor.tenantId, meetingId)), recording.id)
        Object.assign(output, withSpeakerNames(own, new Map([[recording.id, speakerMapOf(recording)]]), meetingRecord.participantIds))
        output.speakers = this.#speakersView(actor, meetingRecord, recording, own.segments)
        output.summaryVersions = Object.freeze({
          current: recording.summaryVersion ?? 1,
          generatedAt: recording.summaryGeneratedAt ?? recording.uploadedAt ?? null,
          canRegenerate: Boolean(this.summarizer) && meetingRecord.organizerId === actor.userId,
          provider: this.summarizer?.providerName ?? null,
          history: Object.freeze((recording.summaryHistory ?? []).slice().reverse()),
        })
      }
      return output
    }, recordingId))
  }

  // Rewrites one recording's summary, decisions, risks, questions, and action
  // plan from its stored transcript (CAP-10 recomputation). Organizer only.
  // Confirmed speaker names are included (user decision 2026-10-07); the
  // result passes the same normalization as first processing, gets new
  // versioned IDs, and the previous version is kept (last three) for
  // comparison. The summarizer call runs before the audited transaction.
  async regenerateSummary(input, meetingId, recordingId, correlationId = randomUUID()) {
    const actor = principal(input)
    let prepared
    try {
      prepared = await this.#prepareRegeneration(actor, meetingId, recordingId)
    } catch (error) {
      return this.#audited(actor, correlationId, 'recording.summary.regenerate', meetingId, async () => { throw error }, recordingId)
    }
    return (await this.#audited(actor, correlationId, 'recording.summary.regenerate', meetingId, async () => {
      const publish = async (transaction = null) => {
        const recordings = transaction?.recordings ?? this.recordings
        const knowledge = transaction?.knowledge ?? this.knowledge
        const commitments = transaction?.commitments ?? this.commitments
        const recording = transaction ? await recordings.get(recordingId) : await recordings.get(actor.tenantId, recordingId)
        invariant(recording?.state === 'completed' && (recording.summaryVersion ?? 1) === prepared.fromVersion, 'SUMMARY_CHANGED', 'The recording changed while its summary was being rewritten; try again', 409)
        recording.summaryHistory = [...(recording.summaryHistory ?? []), prepared.previous].slice(-3)
        recording.summaryVersion = prepared.version
        recording.summaryGeneratedAt = this.clock.now().toISOString()
        recording.withheldAssertions = prepared.result.withheldAssertions
        await this.#replaceRecordingKnowledge(recording, { segments: prepared.segments, assertions: prepared.result.assertions }, { transaction, knowledge, commitments })
        await recordings.save(recording)
        const meetingRecord = transaction ? await transaction.meetings.get(meetingId) : await this.#meeting(actor.tenantId, meetingId)
        await this.#emitKnowledgeChange(meetingRecord, `recording:${recording.id}:summary-v${prepared.version}`, { commitmentsChanged: true, transaction, knowledge, commitments })
        return view(recording)
      }
      const recording = this.#tenantTransaction ? await this.#tenantTransaction(actor.tenantId, publish) : await publish()
      return Object.freeze({ recording, version: prepared.version })
    }, recordingId))
  }

  async #prepareRegeneration(actor, meetingId, recordingId) {
    const meetingRecord = await this.#meeting(actor.tenantId, meetingId)
    const recording = await this.#recording(actor, meetingId, recordingId, true)
    invariant(recording.state === 'completed', 'RECORDING_NOT_COMPLETED', 'Only a processed recording can be summarized again', 409)
    invariant(this.summarizer, 'SUMMARY_NOT_CONFIGURED', 'Summaries are not configured on this server', 409)
    this.policy.require(this.#regenerationPolicyDecision(meetingRecord, recording))
    const own = knowledgeForRecording(await this.knowledge.forMeeting(actor.tenantId, meetingId), recording.id)
    invariant(own.segments.length > 0, 'NO_MEETING_RECORD', 'This recording has no transcript to summarize', 409)
    // The stored transcript must be exactly what first processing produced, so
    // the summarizer's citations map back onto the same segment IDs.
    invariant(own.segments.every((segment, index) => segment.id === `${recording.id}-segment-${index + 1}`), 'REGENERATION_UNAVAILABLE', 'This recording\'s transcript cannot be summarized again', 409)
    const named = withSpeakerNames({ segments: own.segments }, new Map([[recording.id, speakerMapOf(recording)]]), meetingRecord.participantIds).segments
    const raw = named.map((segment, index) => ({
      id: `S${index + 1}`, startMs: segment.startMs, endMs: segment.endMs, text: segment.text,
      diarizationLabel: segment.diarizationLabel, identityConfidence: segment.identityConfidence ?? null,
      confirmedParticipantId: segment.speaker?.participantId ?? null,
    }))
    let intelligence
    try {
      intelligence = await this.summarizer.extract({ segments: raw, participantIds: [...meetingRecord.participantIds], meetingDate: String(recording.uploadedAt ?? this.clock.now().toISOString()).slice(0, 10) })
    } catch {
      throw new DomainError('SUMMARY_FAILED', 'The summary could not be rewritten; the current version is unchanged', 502)
    }
    const fromVersion = recording.summaryVersion ?? 1
    const version = fromVersion + 1
    const result = this.#normalizeProcessorResult(
      { segments: raw.map(({ confirmedParticipantId, ...segment }) => segment), assertions: assertionsFromIntelligence(intelligence), processor: recording.processor, model: this.summarizer.model ?? null },
      recording, this.#authorizedRosterEvidence(meetingRecord), meetingRecord.participantIds,
      { assertionPrefix: `${recording.id}-v${version}-assertion-` },
    )
    const previous = {
      version: fromVersion,
      generatedAt: recording.summaryGeneratedAt ?? recording.uploadedAt ?? null,
      model: own.assertions.find((item) => typeof item.provenance?.model === 'string')?.provenance.model ?? null,
      items: own.assertions.map((item) => ({ kind: item.kind, text: item.text })),
    }
    return { fromVersion, version, result, previous, segments: own.segments }
  }

  // Regeneration processes audio already captured with consent and records
  // nothing new, so it does not require a fresh consent window. It still
  // stops when the meeting is no longer active (including legal hold), is
  // not recordable, its policy changed since the recording, or any required
  // participant's latest consent decision is not "granted" (a withdrawal or
  // decline). Decision by Claude, 2026-10-07, logged in the handoff.
  #regenerationPolicyDecision(meetingRecord, recording) {
    const deny = (code, reason) => ({ allowed: false, code, reason })
    if (meetingRecord.retentionState !== 'active') return deny('RETENTION_RESTRICTED', 'Meeting is not active')
    if (this.policy.retentionExpired({ meeting: meetingRecord, now: this.clock.now() })) return deny('RETENTION_EXPIRED', 'Meeting content has reached its retention limit')
    if (NEVER_RECORD_CATEGORIES.has(meetingRecord.classification)) return deny('NEVER_RECORD', 'Meeting classification prohibits recording')
    for (const participantId of meetingRecord.requiredParticipantIds ?? meetingRecord.participantIds) {
      const evidence = (meetingRecord.consentEvidence ?? []).filter((item) => item.participantId === participantId).at(-1)
      if (evidence?.decision !== 'granted') return deny('CONSENT_NOT_GRANTED', 'A required participant has not granted consent, or withdrew it')
    }
    if (!this.#leaseMatchesCurrentPolicy(meetingRecord, recording)) return deny('RECORDING_POLICY_CHANGED', 'Recording authorization no longer matches current policy')
    return { allowed: true, reason: 'Regeneration allowed' }
  }

  // Names a speaker. The organizer may name or correct any label; any other
  // participant may claim only an unnamed label, and only as themselves. A
  // pair the named person disputed can be restored only by that person.
  async setSpeaker(input, meetingId, recordingId, label, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'speaker.map', meetingId, async () => {
      const { meetingRecord, recording, segments } = await this.#speakerContext(actor, meetingId, recordingId, label)
      const participantId = body?.participantId
      invariant(typeof participantId === 'string' && meetingRecord.participantIds.includes(participantId), 'SPEAKER_NOT_PARTICIPANT', 'A speaker can only be named as one of the meeting participants', 400)
      const map = speakerMapOf(recording)
      invariant(body?.version === undefined || body.version === map.version, 'SPEAKER_MAP_CHANGED', 'Someone else changed the speakers; reload and try again', 409)
      const current = map.labels[label] ?? null
      let method
      if (meetingRecord.organizerId === actor.userId) {
        const disputed = map.disputed.some((item) => item.label === label && item.participantId === participantId)
        invariant(!disputed || participantId === actor.userId, 'SPEAKER_DISPUTED', 'This person removed this attribution; only they can claim it again', 409)
        method = 'organizer'
      } else {
        invariant(participantId === actor.userId, 'SPEAKER_CLAIM_FORBIDDEN', 'A participant can only claim a speaker as themselves', 403)
        invariant(!current, 'SPEAKER_ALREADY_NAMED', 'This speaker is already named; ask the organizer to correct it', 409)
        method = 'self-claim'
        map.disputed = map.disputed.filter((item) => !(item.label === label && item.participantId === participantId))
      }
      const at = this.clock.now().toISOString()
      map.labels[label] = { participantId, method, by: actor.userId, at }
      map.version += 1
      map.history = [...map.history, { version: map.version, label, from: current?.participantId ?? null, to: participantId, by: actor.userId, method, at }].slice(-MAX_SPEAKER_HISTORY)
      recording.speakerMap = map
      await this.recordings.save(recording)
      return this.#speakersView(actor, meetingRecord, recording, segments)
    }, recordingId))
  }

  // Removes a name. The organizer's removal is a correction; the named
  // participant's removal is a dispute, which also stops the organizer from
  // assigning that same label to them again.
  async removeSpeaker(input, meetingId, recordingId, label, body = {}, correlationId = randomUUID()) {
    const actor = principal(input)
    const meetingRecord = await this.#meeting(actor.tenantId, meetingId)
    const action = meetingRecord.organizerId === actor.userId ? 'speaker.unmap' : 'speaker.dispute'
    return (await this.#audited(actor, correlationId, action, meetingId, async () => {
      const { meetingRecord: current, recording, segments } = await this.#speakerContext(actor, meetingId, recordingId, label)
      const map = speakerMapOf(recording)
      invariant(body?.version === undefined || body.version === map.version, 'SPEAKER_MAP_CHANGED', 'Someone else changed the speakers; reload and try again', 409)
      const entry = map.labels[label]
      invariant(entry, 'SPEAKER_NOT_NAMED', 'This speaker is not named', 404)
      const organizer = current.organizerId === actor.userId
      invariant(organizer || entry.participantId === actor.userId, 'SPEAKER_CHANGE_FORBIDDEN', 'Only the organizer or the named person can remove this name', 403)
      delete map.labels[label]
      if (!organizer) map.disputed = [...map.disputed.filter((item) => !(item.label === label && item.participantId === actor.userId)), { label, participantId: actor.userId }]
      const at = this.clock.now().toISOString()
      map.version += 1
      map.history = [...map.history, { version: map.version, label, from: entry.participantId, to: null, by: actor.userId, method: organizer ? 'organizer' : 'disputed', at }].slice(-MAX_SPEAKER_HISTORY)
      recording.speakerMap = map
      await this.recordings.save(recording)
      return this.#speakersView(actor, current, recording, segments)
    }, recordingId))
  }

  async #speakerContext(actor, meetingId, recordingId, label) {
    const meetingRecord = await this.#meeting(actor.tenantId, meetingId)
    this.policy.require(this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
    // Readers through a management grant can see names but never set them.
    invariant(meetingRecord.participantIds.includes(actor.userId) || meetingRecord.organizerId === actor.userId, 'SPEAKER_CHANGE_FORBIDDEN', 'Only meeting participants can name speakers', 403)
    const recording = await this.#recording(actor, meetingId, recordingId)
    invariant(recording.state === 'completed', 'RECORDING_NOT_COMPLETED', 'Speakers can be named once the recording is processed', 409)
    const { segments } = knowledgeForRecording(await this.knowledge.forMeeting(actor.tenantId, meetingId), recording.id)
    invariant(typeof label === 'string' && SPEAKER_MAP_LABEL.test(label) && segments.some((segment) => segment.diarizationLabel === label), 'SPEAKER_NOT_FOUND', 'This recording has no such speaker', 404)
    return { meetingRecord, recording, segments }
  }

  #speakersView(actor, meetingRecord, recording, segments) {
    const map = speakerMapOf(recording)
    const counts = new Map()
    for (const segment of segments) if (SPEAKER_MAP_LABEL.test(segment.diarizationLabel ?? '')) counts.set(segment.diarizationLabel, (counts.get(segment.diarizationLabel) ?? 0) + 1)
    return Object.freeze({
      version: map.version,
      viewer: Object.freeze({ userId: actor.userId, isOrganizer: meetingRecord.organizerId === actor.userId, canName: meetingRecord.participantIds.includes(actor.userId) || meetingRecord.organizerId === actor.userId }),
      participants: Object.freeze([...meetingRecord.participantIds]),
      labels: Object.freeze([...counts].sort(([a], [b]) => a.localeCompare(b)).map(([label, lines]) => {
        const entry = map.labels[label]
        const named = entry && meetingRecord.participantIds.includes(entry.participantId) ? entry : null
        return Object.freeze({ label, lines, participantId: named?.participantId ?? null, method: named?.method ?? null, by: named?.by ?? null, at: named?.at ?? null, disputedBy: map.disputed.filter((item) => item.label === label).map((item) => item.participantId) })
      })),
      history: Object.freeze(map.history.slice(-10).reverse()),
    })
  }

  async #speakerMaps(tenantId, meetingId) {
    return new Map(((await this.recordings?.listForMeeting(tenantId, meetingId)) ?? []).map((record) => [record.id, speakerMapOf(record)]))
  }

  async deleteMeetingContent(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'recording.delete', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      invariant(meetingRecord.organizerId === actor.userId, 'DELETE_FORBIDDEN', 'Only organizer may delete development content', 403)
      invariant(meetingRecord.retentionState !== 'held', 'LEGAL_HOLD', 'Legal hold prevents deletion', 409)
      await this.#disposeMeetingContent(meetingRecord)
      return { state: 'deleted' }
    }))
  }

  // Deletes one meeting's content in every store it reaches: audio, transcript,
  // knowledge, and derived commitments, then emits the content-free deletion
  // event. Manual deletion and retention expiry share this one path.
  async #disposeMeetingContent(meetingRecord) {
    const tenantId = meetingRecord.tenantId
    const meetingId = meetingRecord.id
    const dispose = async (transaction = null) => {
        const meetings = transaction?.meetings ?? this.meetings
        const recordings = transaction?.recordings ?? this.recordings
        const knowledge = transaction?.knowledge ?? this.knowledge
        const commitments = transaction?.commitments ?? this.commitments
        meetingRecord.retentionState = 'deleted'
        await meetings.save(meetingRecord)
        const records = transaction ? (await recordings.listForMeeting(meetingId)) : (await recordings.listForMeeting(tenantId, meetingId))
        for (const recording of records) {
          if (transaction) await recordings.clearContent(recording.id)
          else await recordings.clearContent(tenantId, recording.id)
          // The tombstone keeps no earlier summary versions or speaker names.
          recording.state = 'deleted'; recording.progress = 100; recording.summaryHistory = []; delete recording.speakerMap
          await recordings.save(recording)
        }
        if (transaction) {
          await knowledge.clearMeeting(meetingId)
          await commitments.clearMeeting(meetingId)
          // Saved chat turns that drew on this meeting go with its content.
          await transaction.chat.clearMeeting(meetingId)
          await transaction.embeddings.clearMeeting(meetingId)
        } else {
          await knowledge.clearMeeting(tenantId, meetingId)
          await commitments.clearMeeting(tenantId, meetingId)
          await this.chat.clearMeeting(tenantId, meetingId)
          await this.embeddings.clearMeeting(tenantId, meetingId)
        }
        // Deletion is the sole event after disposition. It contains no content
        // counts, recording IDs, source IDs, or classification, so consumers
        // cannot infer deleted/never-record information from the outbox.
        await this.#emitOutbox({
          tenantId,
          type: 'meeting.content.deleted', aggregateType: 'meeting', aggregateId: meetingId,
          revision: 'deleted', payload: Object.freeze({ state: 'deleted' }),
        }, transaction)
      }
      if (this.#tenantTransaction) await this.#tenantTransaction(tenantId, dispose)
      else await dispose()
  }

  // Run once at startup with durable storage. A job that was queued or running
  // when the server stopped can never finish (its in-process task is gone), so
  // it is marked failed through the normal failure path, which leaves it
  // retryable by its organizer instead of stuck in "processing" forever.
  async recoverInterruptedProcessing(tenantId, correlationId = randomUUID()) {
    const actor = principal({ tenantId, userId: RECOVERY_SERVICE_ID })
    let recovered = 0
    for (const meetingRecord of (await this.meetings.list(tenantId))) {
      for (const recording of (await this.recordings?.listForMeeting(tenantId, meetingRecord.id)) ?? []) {
        if (!['queued', 'processing'].includes(recording.state)) continue
        await this.#processorFailure(recording.id, correlationId, actor)
        recovered += 1
      }
    }
    return Object.freeze({ recovered })
  }

  // Retention sweep for one tenant, run by the scheduler (never by a request).
  // Expired content is already unreadable through policy; this makes the
  // deletion real. Legal hold prevents it, and re-running is a no-op.
  async enforceRetention(tenantId, correlationId = randomUUID()) {
    const actor = principal({ tenantId, userId: RETENTION_SERVICE_ID })
    const now = this.clock.now()
    const summary = { expired: 0, held: 0, chatTurnsExpired: 0 }
    summary.chatTurnsExpired = Number(await this.chat.purgeBefore(tenantId, retentionCutoff(now, this.chatRetentionDays).toISOString())) || 0
    if (summary.chatTurnsExpired > 0) await this.#audit({ correlationId, principal: actor, action: 'chat.history.expire', outcome: 'allowed', reason: null })
    for (const meetingRecord of (await this.meetings.list(tenantId))) {
      if (meetingRecord.retentionState === 'deleted' || !this.policy.retentionExpired({ meeting: meetingRecord, now })) continue
      if (meetingRecord.retentionState === 'held') { summary.held += 1; continue }
      await this.#audited(actor, correlationId, 'retention.expire', meetingRecord.id, async () => (await this.#disposeMeetingContent(meetingRecord)))
      summary.expired += 1
    }
    return Object.freeze(summary)
  }

  async appendTranscript(input, meetingId, authorization, items, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'transcript.append', meetingId, async () => {
      const append = async (transaction = null) => {
        const meetings = transaction?.meetings ?? this.meetings
        const knowledge = transaction?.knowledge ?? this.knowledge
        const commitments = transaction?.commitments ?? this.commitments
        const meetingRecord = (await meetings.get(transaction ? meetingId : actor.tenantId, transaction ? undefined : meetingId))
          ?? (() => { throw new DomainError('MEETING_NOT_FOUND', 'Meeting not found', 404) })()
        const staleAuthorization = meetingRecord.recording?.leaseId && !this.#leaseMatchesCurrentPolicy(meetingRecord, meetingRecord.recording)
        if (staleAuthorization) {
          meetingRecord.recording.status = 'revoked'
          meetingRecord.recording.revokedAt = this.clock.now().toISOString()
          meetingRecord.recording.revocationReason = this.#safePolicyReason('RECORDING_POLICY_CHANGED')
          if (transaction) await meetings.save(meetingRecord)
          else await this.meetings.save(meetingRecord)
        }
        this.#capturePolicy(actor, meetingRecord)
        if (staleAuthorization) throw new DomainError('RECORDING_POLICY_CHANGED', 'Recording authorization no longer matches current policy', 403)
        invariant(authorization?.authorizationId === meetingRecord.recording.authorizationId, 'INVALID_RECORDING_AUTHORIZATION', 'Recording authorization does not match', 403)
        invariant(new Date(authorization.authorizationExpiresAt) > this.clock.now(), 'RECORDING_AUTHORIZATION_EXPIRED', 'Recording authorization expired', 403)
        const rows = items.map((item) => transcriptSegment({ ...item, meetingId, tenantId: actor.tenantId }))
        const snapshot = transaction ? (await knowledge.forMeeting(meetingId)) : (await knowledge.forMeeting(actor.tenantId, meetingId))
        const existing = new Map(snapshot.segments.map((row) => [row.id, row]))
        const requested = new Map()
        for (const row of rows) {
          const prior = existing.get(row.id)
          invariant(!prior || JSON.stringify(canonical(prior)) === JSON.stringify(canonical(row)), 'TRANSCRIPT_REPLAY_CONFLICT', 'Transcript segment ID conflicts with canonical knowledge', 409)
          const replay = requested.get(row.id)
          invariant(!replay || JSON.stringify(canonical(replay)) === JSON.stringify(canonical(row)), 'TRANSCRIPT_REPLAY_CONFLICT', 'Transcript segment ID conflicts within request', 409)
          requested.set(row.id, row)
        }
        const inserted = [...requested.values()].filter((row) => !existing.has(row.id))
        if (inserted.length === 0) return rows
        await knowledge.addSegments(inserted)
        const revision = `transcript:${createHash('sha256').update(JSON.stringify(canonical(inserted.map((row) => row.id)))).digest('hex')}`
        await this.#emitKnowledgeChange(meetingRecord, revision, { transaction, knowledge, commitments })
        return rows
      }
      return this.#tenantTransaction ? (await this.#tenantTransaction(actor.tenantId, append)) : (await append())
    }))
  }

  async addAssertions(input, meetingId, items, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'knowledge.assertions.add', meetingId, async () => {
      const add = async (transaction = null) => {
      const meetings = transaction?.meetings ?? this.meetings
      const knowledge = transaction?.knowledge ?? this.knowledge
      const commitments = transaction?.commitments ?? this.commitments
      const meetingRecord = (await meetings.get(transaction ? meetingId : actor.tenantId, transaction ? undefined : meetingId))
        ?? (() => { throw new DomainError('MEETING_NOT_FOUND', 'Meeting not found', 404) })()
      this.policy.require(this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      // Participant writes may add cited notes/findings, but they cannot mint
      // a commitment.  Action assertions are a processor-only product of the
      // private canonicalization boundary, so caller-supplied provenance,
      // owner, deadline, or status can never influence the derived registry.
      const collection = validatedManualAssertionCollection(items)
      const envelopes = []
      for (const item of collection) envelopes.push(validatedManualAssertionEnvelope(item))
      invariant(!envelopes.some((item) => item.kind === 'action'), 'UNTRUSTED_ACTION_ASSERTION', 'Action commitments require canonical processor output', 403)
      requireCloneableManualAssertionCollection(items)
      const snapshot = transaction ? (await knowledge.forMeeting(meetingId)) : (await knowledge.forMeeting(actor.tenantId, meetingId))
      const ids = new Set(snapshot.segments.map((item) => item.id))
      const rows = []
      for (const item of envelopes) rows.push(knowledgeAssertion({ ...item, meetingId, tenantId: actor.tenantId }))
      invariant(rows.every((item) => item.citations.every((id) => ids.has(id))), 'INVALID_CITATION', 'Every citation must reference a source segment')
      invariant(rows.every((item) => (item.commitment?.ownerId ?? null) === null || meetingRecord.participantIds.includes(item.commitment.ownerId)), 'INVALID_COMMITMENT_OWNER', 'Commitment owner must be a meeting participant', 403)
      const existing = new Map(snapshot.assertions.map((item) => [item.id, item]))
      const requested = new Map()
      for (const row of rows) {
        const prior = existing.get(row.id)
        invariant(!prior || JSON.stringify(canonical(prior)) === JSON.stringify(canonical(row)), 'ASSERTION_REPLAY_CONFLICT', 'Assertion ID conflicts with canonical knowledge', 409)
        const replay = requested.get(row.id)
        invariant(!replay || JSON.stringify(canonical(replay)) === JSON.stringify(canonical(row)), 'ASSERTION_REPLAY_CONFLICT', 'Assertion ID conflicts within request', 409)
        requested.set(row.id, row)
      }
      const inserted = [...requested.values()].filter((row) => !existing.has(row.id))
      if (inserted.length > 0) {
        await knowledge.addAssertions(inserted)
        await this.#syncCommitments(actor.tenantId, meetingId, { knowledge, commitments })
        const revision = `assertions:${createHash('sha256').update(JSON.stringify(canonical(inserted.map((row) => row.id)))).digest('hex')}`
        await this.#emitKnowledgeChange(meetingRecord, revision, { commitmentsChanged: true, transaction, knowledge, commitments })
      }
      return rows
      }
      return this.#tenantTransaction ? (await this.#tenantTransaction(actor.tenantId, add)) : (await add())
    }))
  }

  async getMeetingKnowledge(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'knowledge.read', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      this.policy.require(this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      return { meeting: meetingRecord, ...withSpeakerNames(await this.knowledge.forMeeting(actor.tenantId, meetingId), await this.#speakerMaps(actor.tenantId, meetingId), meetingRecord.participantIds) }
    }))
  }

  // Produces a downloadable record of one meeting's authorized knowledge.
  // The audit event carries identifiers only; the document carries the same
  // correlation ID so any copy can be traced back to this decision.
  async exportMeetingRecord(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'meeting.export', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      this.policy.require(this.policy.meetingExport({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      const { segments, assertions } = withSpeakerNames(await this.knowledge.forMeeting(actor.tenantId, meetingId), await this.#speakerMaps(actor.tenantId, meetingId), meetingRecord.participantIds)
      invariant(segments.length > 0 || assertions.length > 0, 'NO_MEETING_RECORD', 'This meeting has no processed record to export yet', 409)
      const completed = ((await this.recordings?.listForMeeting(actor.tenantId, meetingId)) ?? []).filter((item) => item.state === 'completed')
      return Object.freeze({
        filename: exportFilename(meetingId),
        contentType: 'text/markdown; charset=utf-8',
        body: renderMeetingRecordMarkdown({
          meeting: meetingRecord, segments, assertions,
          processor: completed.at(-1)?.processor ?? null,
          exportedBy: actor.userId, exportedAt: this.clock.now().toISOString(), correlationId,
        }),
      })
    }))
  }

  async getMeetingPrivacyAccess(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'privacy-access.read', meetingId, async () => {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      const access = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
      if (!access.allowed) throw this.#opaquePrivacyAccessDenied(access.code)
      return Object.freeze({
        access: Object.freeze({ posture: access.posture, authorized: true }),
        classification: this.#classificationSummary(meetingRecord),
        retention: this.#retentionSummary(meetingRecord),
        auditTimeline: (await this.#redactedAuditTimeline(actor.tenantId, meetingId)),
      })
    }))
  }

  async searchKnowledge(input, query, correlationId = randomUUID()) {
    return (await this.#matches(principal(input), query, correlationId, 'knowledge.search'))
  }

  async retrieveForAi(input, query, correlationId = randomUUID()) {
    return (await this.#matches(principal(input), query, correlationId, 'ai.retrieve'))
  }

  // The bounded retrieval contract is the safe first stage of RAG. It is
  // lexical today: embeddings and a vector index require their own local-model
  // and deletion-lifecycle approval. Each candidate is authorized before its
  // contents are read, and callers receive only citation-sized evidence.
  async retrieveMeetingContext(input, { query, limit = MAX_RETRIEVAL_MEETINGS } = {}, correlationId = randomUUID()) {
    const actor = principal(input)
    invariant(typeof query === 'string' && query.trim().length > 0 && query.trim().length <= MAX_RETRIEVAL_QUERY_LENGTH,
      'INVALID_RETRIEVAL_QUERY', 'Retrieval query must be a non-empty bounded string', 400)
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_RETRIEVAL_MEETINGS,
      'INVALID_RETRIEVAL_LIMIT', 'Retrieval limit is invalid', 400)
    const term = query.trim().toLocaleLowerCase()
    const sources = []
    for (const meetingId of (await this.knowledge.meetingIdsMatching(actor.tenantId, term))) {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      const decision = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
      await this.#audit({ correlationId, principal: actor, action: 'ai.retrieve', meetingId, outcome: decision.allowed ? 'allowed' : 'denied', reason: decision.allowed ? null : decision.code })
      if (!decision.allowed) continue
      const knowledge = (await this.knowledge.forMeeting(actor.tenantId, meetingId))
      const excerpts = [
        ...(knowledge.segments ?? []).filter((item) => String(item?.text ?? '').toLocaleLowerCase().includes(term)).map((item) => ({
          type: 'transcript', id: item.id, text: item.text.slice(0, MAX_RETRIEVAL_EXCERPT_TEXT), citations: [item.id],
        })),
        ...(knowledge.assertions ?? []).filter((item) => String(item?.text ?? '').toLocaleLowerCase().includes(term) && isBoundedKnowledgeCitationList(item?.citations)).map((item) => ({
          type: 'assertion', id: item.id, text: item.text.slice(0, MAX_RETRIEVAL_EXCERPT_TEXT), citations: [...item.citations],
        })),
      ].slice(0, MAX_RETRIEVAL_EXCERPTS_PER_MEETING)
      if (excerpts.length > 0) sources.push(Object.freeze({ meetingId, excerpts: Object.freeze(excerpts.map((item) => Object.freeze({ ...item, citations: Object.freeze(item.citations) }))) }))
      if (sources.length === limit) break
    }
    return Object.freeze({ query: query.trim(), sources: Object.freeze(sources) })
  }

  // Meeting chat (RAG). Retrieval is lexical: every candidate meeting is
  // authorized before its knowledge is read, and each decision is audited
  // without content, exactly like retrieveMeetingContext. Only the selected
  // excerpts, the question, and a few earlier readable turns reach the
  // configured answer provider; its reply is untrusted, so only citations
  // that point at excerpts actually sent are kept.
  // Meeting chat runs through two explicit layers (see server/guardrails.js
  // and server/chat-memory.js):
  //   guardrails  input validation and a daily quota, personal-data redaction
  //               of everything sent, citation and grounding checks on output
  //   memory      recent turns, related older turns recalled locally, and
  //               retention; every turn is usable only while all of its
  //               meetings are readable
  // Retrieval, embedding, and the provider call run before the audited
  // transaction, so a slow model never holds a database transaction open; a
  // failure there is still recorded as a denied chat.ask.
  async askChat(input, body, correlationId = randomUUID()) {
    const actor = principal(input)
    let prepared
    try {
      const question = validateQuestion(body?.question)
      this.chatQuota?.check(actor.tenantId, actor.userId)
      prepared = await this.#prepareChatTurn(actor, question, correlationId)
    } catch (error) {
      return this.#audited(actor, correlationId, 'chat.ask', null, async () => { throw error })
    }
    const result = await this.#audited(actor, correlationId, 'chat.ask', null, async () => {
      await this.chat.appendTurn(prepared.turn)
      return Object.freeze({ turn: this.#chatTurnView(prepared.turn, prepared.sources) })
    })
    this.chatQuota?.record(actor.tenantId, actor.userId)
    // Each guardrail that acted is recorded by its code only, never content.
    for (const code of prepared.guardrails) await this.#audit({ correlationId, principal: actor, action: 'chat.guardrail', outcome: 'allowed', reason: code })
    return result
  }

  async #prepareChatTurn(actor, question, correlationId) {
    // Reading history first also surfaces CHAT_NOT_MIGRATED before any
    // excerpt could be sent to a provider.
    const { turns: history } = await this.#readableChatTurns(actor)
    let questionVector = null
    if (this.embedder) {
      try { [questionVector] = await this.embedder.embed([question]) } catch { questionVector = null }
    }
    const memory = selectMemory({ turns: history, questionVector, model: this.embedder?.model ?? null })
    const { excerpts, retrieval } = await this.#chatExcerpts(actor, question, correlationId, questionVector)
    const guardrails = new Set()
    let status = 'no-sources'
    let answer = null
    let cited = []
    let model = null
    let grounding = null
    let memorySent = false
    if (excerpts.length > 0 && !this.chatAnswerer) {
      status = 'sources-only'
      cited = excerpts
    } else if (excerpts.length > 0) {
      const outbound = prepareOutbound({
        question,
        history: memory.working.map((turn) => ({ question: turn.question, answer: turn.answer ?? '' })),
        recalled: memory.recalled.map((turn) => ({ question: turn.question, answer: turn.answer ?? '' })),
        excerpts: excerpts.map((item) => item.prompt),
      })
      if (outbound.redacted > 0) guardrails.add(GUARDRAIL_CODES.personalDataRedacted)
      memorySent = memory.working.length + memory.recalled.length > 0
      let result
      try {
        result = await this.chatAnswerer.answer(outbound.request)
      } catch {
        throw new DomainError('CHAT_ANSWER_FAILED', 'The answer could not be generated, and nothing was saved', 502)
      }
      const sentByLabel = new Map(outbound.request.excerpts.map((item) => [item.label, item]))
      const kept = keepValidCitations(result?.citations, new Map(excerpts.map((item) => [item.label, item])))
      if (kept.dropped > 0) guardrails.add(GUARDRAIL_CODES.citationDropped)
      cited = kept.cited
      const text = typeof result?.answer === 'string' ? result.answer.trim() : ''
      if (result?.answered !== true) { status = 'not-covered'; answer = text || null; cited = [] }
      else if (cited.length === 0 || !text) { status = 'unsupported' }
      else {
        grounding = await checkGrounding({
          answer: text,
          citedTexts: cited.map((item) => { const sent = sentByLabel.get(item.label); return [sent?.context?.before?.text, sent?.text, sent?.context?.after?.text].filter(Boolean).join(' ') }),
          citedVectors: cited.every((item) => Array.isArray(item.vector) && !item.context) ? cited.map((item) => item.vector) : null,
          sentTexts: [
            ...outbound.request.excerpts.flatMap((item) => [item.text, item.meetingDate, item.at ?? '', item.context?.before?.text ?? '', item.context?.after?.text ?? '']),
            ...[...outbound.request.history, ...outbound.request.recalled].flatMap((turn) => [turn.question, turn.answer]),
            question,
          ],
          embedder: this.embedder,
        })
        if (grounding.unsupportedNumbers.length > 0) guardrails.add(GUARDRAIL_CODES.ungroundedNumber)
        if (grounding.unsupportedSentences.length > 0) guardrails.add(GUARDRAIL_CODES.ungroundedStatement)
        // An answer with no statement close to its sources is withheld.
        if (grounding.allUnsupported) { status = 'unsupported'; cited = [] }
        else { status = 'answered'; answer = text }
      }
      model = typeof result?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(result.model) ? result.model : null
    }
    const turn = {
      id: randomUUID(), tenantId: actor.tenantId, userId: actor.userId, createdAt: this.clock.now().toISOString(),
      question, answer, status, retrieval, provider: status === 'sources-only' || status === 'no-sources' ? null : (this.chatAnswerer?.providerName ?? null), model,
      sources: cited.map((item) => ({ label: item.label, meetingId: item.meetingId, sourceId: item.sourceId })),
      // Every meeting whose excerpts informed the turn, or whose earlier turns
      // were recalled into it: losing access to any of them hides the turn,
      // and deleting any deletes it.
      meetingIds: [...new Set([...excerpts.map((item) => item.meetingId), ...(memorySent ? [...memory.working, ...memory.recalled].flatMap((item) => item.meetingIds) : [])])],
      memory: memorySent ? { working: memory.working.length, recalled: memory.recalled.length } : { working: 0, recalled: 0 },
      ...(grounding ? { grounding: { method: grounding.method, unsupportedSentences: grounding.unsupportedSentences, unsupportedNumbers: grounding.unsupportedNumbers } } : {}),
      guardrails: [...guardrails],
    }
    if (this.embedder && answer !== null) {
      try {
        const [vector] = await this.embedder.embed([memoryText(turn)])
        Object.assign(turn, { memoryModel: this.embedder.model, memoryVector: compactVector(vector) })
      } catch { /* the turn is still saved; it just cannot be recalled later */ }
    }
    return { turn, guardrails: [...guardrails], sources: new Map(excerpts.map((item) => [`${item.meetingId}:${item.sourceId}`, item])) }
  }

  // The asker removes one saved question and its answer. Nothing else in the
  // history changes.
  async deleteChatTurn(input, turnId, correlationId = randomUUID()) {
    const actor = principal(input)
    invariant(typeof turnId === 'string' && /^[0-9a-f-]{36}$/.test(turnId), 'INVALID_CHAT_TURN', 'Chat turn ID is invalid', 400)
    return (await this.#audited(actor, correlationId, 'chat.turn.delete', null, async () => {
      invariant(await this.chat.deleteTurn(actor.tenantId, actor.userId, turnId), 'CHAT_TURN_NOT_FOUND', 'Chat turn not found', 404)
      return Object.freeze({ deleted: true })
    }))
  }

  async getChatHistory(input, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'chat.history.read', null, async () => {
      const { turns, meetings } = await this.#readableChatTurns(actor)
      const recent = turns.slice(-MAX_CHAT_DISPLAY_TURNS)
      const sources = new Map()
      for (const meetingId of new Set(recent.flatMap((turn) => turn.sources.map((source) => source.meetingId)))) {
        const knowledge = withSpeakerNames(await this.knowledge.forMeeting(actor.tenantId, meetingId), await this.#speakerMaps(actor.tenantId, meetingId), meetings.get(meetingId)?.participantIds ?? [])
        const neighbours = transcriptNeighbours(knowledge.segments ?? [])
        for (const item of [...(knowledge.segments ?? []), ...(knowledge.assertions ?? [])]) {
          const source = this.#chatSource(meetings.get(meetingId), item)
          const around = source.kind === 'transcript' && source.text.split(/\s+/).length < SHORT_EXCERPT_WORDS ? neighbours.get(item.id) : null
          sources.set(`${meetingId}:${item.id}`, around ? { ...source, context: { before: around.before ? { text: around.before.text } : null, after: around.after ? { text: around.after.text } : null } } : source)
        }
      }
      return Object.freeze({
        provider: this.chatAnswerer?.providerName ?? null,
        embeddingModel: this.embedder?.model ?? null,
        retentionDays: this.chatRetentionDays,
        turns: Object.freeze(recent.map((turn) => this.#chatTurnView(turn, sources))),
      })
    }))
  }

  async clearChatHistory(input, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'chat.history.clear', null, async () => {
      await this.chat.clearForUser(actor.tenantId, actor.userId)
      return Object.freeze({ cleared: true })
    }))
  }

  // Saved turns are shown, and offered to a provider as context, only while
  // the asker can still read every meeting the turn drew on.
  async #readableChatTurns(actor) {
    const meetings = new Map()
    const readable = async (meetingId) => {
      if (!meetings.has(meetingId)) {
        const record = await this.meetings.get(actor.tenantId, meetingId)
        meetings.set(meetingId, record && this.policy.meetingAccess({ principal: actor, meeting: record, now: this.clock.now() }).allowed ? record : null)
      }
      return meetings.get(meetingId) !== null
    }
    const turns = []
    for (const turn of (await this.chat.forUser(actor.tenantId, actor.userId)) ?? []) {
      if (turn?.tenantId !== actor.tenantId || turn.userId !== actor.userId || !Array.isArray(turn.meetingIds) || !Array.isArray(turn.sources)) continue
      if (isExpired(turn, this.clock.now(), this.chatRetentionDays)) continue
      let visible = true
      for (const meetingId of turn.meetingIds) if (!(await readable(meetingId))) { visible = false; break }
      if (visible) turns.push(turn)
    }
    return { turns, meetings }
  }

  // Hybrid retrieval. Keyword matches come from the knowledge index; with a
  // local embedder, every readable meeting is also ranked by meaning. Each
  // meeting is authorized before its knowledge or vectors are read. The two
  // rankings are merged by reciprocal rank fusion. If embedding fails or the
  // database is not migrated, retrieval falls back to keywords only.
  async #chatExcerpts(actor, question, correlationId, questionVector = null) {
    const keywords = chatKeywords(question)
    const keywordCandidates = new Set()
    for (const keyword of keywords) for (const meetingId of (await this.knowledge.meetingIdsMatching(actor.tenantId, keyword))) keywordCandidates.add(meetingId)
    const candidates = [...keywordCandidates]
    if (questionVector) {
      const recent = (await this.meetings.list(actor.tenantId)).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      for (const record of recent) if (!keywordCandidates.has(record.id)) candidates.push(record.id)
    }
    const entries = []
    let read = 0
    let vectorsAvailable = Boolean(questionVector)
    for (const meetingId of candidates) {
      if (read === MAX_CHAT_CANDIDATE_MEETINGS) break
      const meetingRecord = await this.meetings.get(actor.tenantId, meetingId)
      if (!meetingRecord) continue
      const decision = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
      // A keyword hit is a disclosed candidate, so its denial is audited; a
      // meeting merely listed for meaning-based search is skipped unread.
      if (!decision.allowed) {
        if (keywordCandidates.has(meetingId)) await this.#audit({ correlationId, principal: actor, action: 'ai.retrieve', meetingId, outcome: 'denied', reason: decision.code })
        continue
      }
      await this.#audit({ correlationId, principal: actor, action: 'ai.retrieve', meetingId, outcome: 'allowed', reason: null })
      read += 1
      const knowledge = withSpeakerNames(await this.knowledge.forMeeting(actor.tenantId, meetingId), await this.#speakerMaps(actor.tenantId, meetingId), meetingRecord.participantIds)
      const neighbours = transcriptNeighbours(knowledge.segments ?? [])
      const items = [...(knowledge.segments ?? []), ...(knowledge.assertions ?? []).filter((item) => isBoundedKnowledgeCitationList(item?.citations))]
        .filter((item) => typeof item?.id === 'string' && typeof item?.text === 'string' && item.text.trim())
      let vectors = null
      if (vectorsAvailable) {
        try { vectors = await this.#meetingVectors(actor.tenantId, meetingRecord, items) } catch { vectorsAvailable = false }
      }
      for (const item of items) {
        entries.push({
          meetingRecord, item, neighbours: neighbours.get(item.id) ?? null,
          keyword: keywordScore(item.text, keywords) + (Object.hasOwn(item, 'kind') ? 0.5 : 0),
          keywordHit: keywordScore(item.text, keywords) > 0,
          similarity: vectors?.get(item.id) ? cosineSimilarity(questionVector, vectors.get(item.id)) : null,
          vector: vectors?.get(item.id) ?? null,
        })
      }
    }
    const fused = new Map()
    const addRanks = (ranked) => ranked.forEach((entry, rank) => fused.set(entry, (fused.get(entry) ?? 0) + 1 / (RRF_K + rank + 1)))
    addRanks(entries.filter((entry) => entry.keywordHit).sort((a, b) => b.keyword - a.keyword))
    if (vectorsAvailable) {
      addRanks(entries.filter((entry) => entry.similarity !== null && entry.similarity >= CHAT_MIN_SIMILARITY)
        .sort((a, b) => b.similarity - a.similarity).slice(0, CHAT_VECTOR_TOP))
    }
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([entry]) => entry)
    const letters = new Map()
    const speakerOf = (segment) => (segment.speaker ? `${segment.speaker.participantId} (confirmed)` : /^SPEAKER_\d{2}$/.test(segment.diarizationLabel ?? '') ? segment.diarizationLabel : 'unattributed')
    const contextLine = (segment) => (segment ? { speaker: speakerOf(segment), text: String(segment.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT_TEXT) } : null)
    const excerpts = ranked.slice(0, MAX_CHAT_EXCERPTS).map(({ meetingRecord, item, vector, neighbours }, index) => {
      if (!letters.has(meetingRecord.id)) letters.set(meetingRecord.id, String.fromCharCode(65 + (letters.size % 26)))
      const source = this.#chatSource(meetingRecord, item)
      const label = `E${index + 1}`
      const context = source.kind === 'transcript' && neighbours && source.text.split(/\s+/).length < SHORT_EXCERPT_WORDS
        ? { before: contextLine(neighbours.before), after: contextLine(neighbours.after) }
        : null
      return {
        ...source, label, vector, context,
        prompt: {
          label, meetingLetter: letters.get(meetingRecord.id), meetingDate: source.meetingDate ?? 'date unknown', kind: source.kind,
          at: Number.isFinite(source.startMs) ? formatChatTime(source.startMs) : null,
          // A confirmed speaker is sent by participant ID (user decision
          // 2026-10-07); an unconfirmed label stays anonymous.
          speaker: source.kind === 'transcript' ? speakerOf(item) : null,
          text: source.text,
          ...(context ? { context } : {}),
        },
      }
    })
    return { excerpts, retrieval: vectorsAvailable ? 'hybrid' : 'keyword' }
  }

  // Vectors for one readable meeting's knowledge, embedded on first use and
  // kept until that knowledge changes. Missing or changed items are embedded;
  // rows for items that no longer exist are dropped. The write re-checks the
  // meeting afterwards, so vectors never outlive content deleted meanwhile.
  async #meetingVectors(tenantId, meetingRecord, items) {
    const model = this.embedder.model
    const texts = new Map(items.map((item) => [item.id, Object.hasOwn(item, 'kind') ? `${item.kind}: ${item.text}` : item.text]))
    const hashes = new Map([...texts].map(([id, text]) => [id, embeddingTextHash(text)]))
    const stored = new Map((await this.embeddings.forMeeting(tenantId, meetingRecord.id)).filter((row) => row.model === model).map((row) => [row.sourceId, row]))
    const missing = items.filter((item) => stored.get(item.id)?.textHash !== hashes.get(item.id))
    const stale = [...stored.keys()].some((id) => !texts.has(id))
    if (missing.length === 0 && !stale) return new Map([...stored].map(([id, row]) => [id, row.vector]))
    const fresh = missing.length ? await this.embedder.embed(missing.map((item) => texts.get(item.id))) : []
    const vectors = new Map([...stored].filter(([id]) => texts.has(id)).map(([id, row]) => [id, row.vector]))
    missing.forEach((item, index) => vectors.set(item.id, fresh[index]))
    const rows = items.map((item) => ({ tenantId, meetingId: meetingRecord.id, sourceId: item.id, model, textHash: hashes.get(item.id), vector: vectors.get(item.id) }))
    await this.embeddings.replaceMeeting(tenantId, meetingRecord.id, rows)
    const current = await this.meetings.get(tenantId, meetingRecord.id)
    const currentIds = new Set(Object.values(await this.knowledge.forMeeting(tenantId, meetingRecord.id)).flat().map((item) => item?.id))
    if (!current || current.retentionState !== 'active') await this.embeddings.clearMeeting(tenantId, meetingRecord.id)
    else if (rows.some((row) => !currentIds.has(row.sourceId))) await this.embeddings.replaceMeeting(tenantId, meetingRecord.id, rows.filter((row) => currentIds.has(row.sourceId)))
    return vectors
  }

  // A display-safe source: meeting title for the asker's own screen, never
  // provenance, citations, or identity metadata.
  #chatSource(meetingRecord, item) {
    const isSegment = !Object.hasOwn(item ?? {}, 'kind')
    const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim()
    return {
      meetingId: meetingRecord.id, sourceId: item.id,
      meetingTitle: typeof meetingRecord.title === 'string' && meetingRecord.title.trim() ? meetingRecord.title : 'Untitled meeting',
      meetingDate: typeof meetingRecord.createdAt === 'string' ? meetingRecord.createdAt.slice(0, 10) : null,
      meetingCreatedAt: typeof meetingRecord.createdAt === 'string' ? meetingRecord.createdAt : null,
      kind: isSegment ? 'transcript' : item.kind,
      startMs: isSegment && Number.isFinite(item.startMs) ? item.startMs : null,
      speaker: isSegment ? (item.speaker?.participantId ?? null) : null,
      text: text.length > MAX_CHAT_EXCERPT_TEXT ? `${text.slice(0, MAX_CHAT_EXCERPT_TEXT - 1)}…` : text,
    }
  }

  #chatTurnView(turn, sources) {
    return Object.freeze({
      id: turn.id, createdAt: turn.createdAt, question: turn.question, answer: turn.answer ?? null, status: turn.status, retrieval: turn.retrieval ?? 'keyword',
      provider: turn.provider ?? null, model: turn.model ?? null,
      memory: turn.memory ?? { working: 0, recalled: 0 },
      grounding: turn.grounding ?? null,
      // A source whose content was replaced or removed is simply not shown.
      sources: Object.freeze(turn.sources.map((source) => {
        const resolved = sources.get(`${source.meetingId}:${source.sourceId}`)
        return resolved ? Object.freeze({ label: source.label, context: resolved.context ? Object.freeze({ before: resolved.context.before?.text ?? null, after: resolved.context.after?.text ?? null }) : null, meetingId: resolved.meetingId, sourceId: resolved.sourceId, meetingTitle: resolved.meetingTitle, meetingCreatedAt: resolved.meetingCreatedAt, speaker: resolved.speaker ?? null, kind: resolved.kind, startMs: resolved.startMs, text: resolved.text }) : null
      }).filter(Boolean)),
    })
  }

  async queryCommitments(input, query = '', correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'commitment.query', null, async () => {
      const output = []
      for (const item of (await this.commitments.query(actor.tenantId, query))) {
        // The registry is a derived index, so treat it as an untrusted read
        // boundary too.  Never turn a malformed or oversized source list into
        // an API response, audit-adjacent record, or agent context payload.
        if (!isBoundedKnowledgeCitationList(item?.citations)) continue
        const meetingRecord = (await this.#meeting(actor.tenantId, item.meetingId))
        const decision = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
        await this.#audit({ correlationId, principal: actor, action: 'commitment.query', meetingId: item.meetingId, outcome: decision.allowed ? 'allowed' : 'denied', reason: decision.allowed ? null : decision.code })
        if (!decision.allowed) continue
        // Return source linkage, not processor provenance or a meeting bundle.
        output.push(Object.freeze({
          id: item.id,
          meetingId: item.meetingId,
          text: item.text,
          ownerId: item.ownerId,
          deadline: item.deadline,
          status: item.status,
          source: Object.freeze({ assertionId: item.assertionId, citations: Object.freeze([...item.citations]) }),
        }))
      }
      return Object.freeze({ commitments: Object.freeze(output) })
    }))
  }

  async getManagementBriefing(input, correlationId = randomUUID()) {
    const actor = principal(input)
    return (await this.#audited(actor, correlationId, 'management-briefing.read', null, async () => {
      const decisions = []
      const risks = []
      const blockers = []
      const actions = []

      // Iterate only records within the caller's tenant and evaluate the
      // existing meeting policy before touching a knowledge row. Do not emit
      // a per-meeting audit event here: that would itself disclose hidden
      // source existence to an otherwise authorized audit reader.
      for (const meetingRecord of (await this.meetings.list(actor.tenantId))) {
        const access = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
        if (!access.allowed) continue

        const knowledge = (await this.knowledge.forMeeting(actor.tenantId, meetingRecord.id))
        const segmentIds = new Set((knowledge.segments ?? [])
          .filter((segment) => typeof segment?.id === 'string')
          .map((segment) => segment.id))

        for (const assertion of knowledge.assertions ?? []) {
          const item = this.#briefingAssertion(assertion, meetingRecord.id, segmentIds)
          if (!item) continue
          if (assertion.kind === 'decision') decisions.push(item)
          if (assertion.kind === 'risk') {
            risks.push(item)
            if (this.#isBlockerText(item.text)) blockers.push(item)
          }
        }

        // The commitment registry is a derived, canonical-only action index.
        // Recheck every citation against the canonical transcript source to
        // keep stale or malformed derived rows out of future agent context.
        for (const commitment of (await this.commitments.query(actor.tenantId))) {
          if (commitment.meetingId !== meetingRecord.id || !ACTIVE_COMMITMENT_STATUSES.has(commitment.status)) continue
          const item = this.#briefingCommitment(commitment, meetingRecord.id, segmentIds)
          if (!item) continue
          actions.push(item)
          if (item.status === 'blocked') blockers.push(item)
        }
      }

      return Object.freeze({
        briefing: Object.freeze({
          counts: Object.freeze({
            decisions: decisions.length,
            risks: risks.length,
            blockers: blockers.length,
            openActions: actions.length,
          }),
          decisions: Object.freeze(decisions.slice(0, BRIEFING_ITEM_LIMIT)),
          risks: Object.freeze(risks.slice(0, BRIEFING_ITEM_LIMIT)),
          blockers: Object.freeze(blockers.slice(0, BRIEFING_ITEM_LIMIT)),
          actions: Object.freeze(actions.slice(0, BRIEFING_ITEM_LIMIT)),
        }),
      })
    }))
  }

  #briefingAssertion(assertion, meetingId, segmentIds) {
    if (!assertion || !BRIEFING_ASSERTION_KINDS.has(assertion.kind)) return null
    if (typeof assertion.id !== 'string' || typeof assertion.text !== 'string' || assertion.text.trim().length === 0) return null
    const citations = this.#briefingCitations(assertion.citations, segmentIds)
    if (!citations) return null
    return Object.freeze({
      id: assertion.id,
      text: assertion.text.slice(0, BRIEFING_TEXT_LIMIT),
      source: Object.freeze({ meetingId, assertionId: assertion.id, citations }),
    })
  }

  #briefingCommitment(commitment, meetingId, segmentIds) {
    if (!commitment || typeof commitment.id !== 'string' || typeof commitment.assertionId !== 'string' || typeof commitment.text !== 'string') return null
    if (typeof commitment.status !== 'string' || !ACTIVE_COMMITMENT_STATUSES.has(commitment.status)) return null
    const citations = this.#briefingCitations(commitment.citations, segmentIds)
    if (!citations) return null
    return Object.freeze({
      id: commitment.id,
      text: commitment.text.slice(0, BRIEFING_TEXT_LIMIT),
      ownerId: typeof commitment.ownerId === 'string' ? commitment.ownerId : null,
      deadline: typeof commitment.deadline === 'string' && Number.isFinite(Date.parse(commitment.deadline)) ? commitment.deadline : null,
      status: commitment.status,
      source: Object.freeze({ meetingId, assertionId: commitment.assertionId, citations }),
    })
  }

  #briefingCitations(citations, segmentIds) {
    if (!isBoundedKnowledgeCitationList(citations)) return null
    if (!citations.every((citation) => segmentIds.has(citation))) return null
    return Object.freeze([...citations])
  }

  #isBlockerText(text) {
    return /\b(blocker|blocked|blocking)\b/i.test(text)
  }

  async #matches(actor, query, correlationId, action) {
    const output = []
    for (const meetingId of (await this.knowledge.meetingIdsMatching(actor.tenantId, query))) {
      const meetingRecord = (await this.#meeting(actor.tenantId, meetingId))
      const decision = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
      await this.#audit({ correlationId, principal: actor, action, meetingId, outcome: decision.allowed ? 'allowed' : 'denied', reason: decision.allowed ? null : decision.code })
      if (decision.allowed) output.push({ meeting: meetingRecord, ...(await this.knowledge.forMeeting(actor.tenantId, meetingId)) })
    }
    return output
  }
}
