import { createHash, randomUUID } from 'node:crypto'
import { NEVER_RECORD_CATEGORIES, consentEvidence, isBoundedKnowledgeCitationList, knowledgeAssertion, MAX_KNOWLEDGE_ASSERTION_CITATIONS, MAX_KNOWLEDGE_ASSERTION_CITATION_ID_LENGTH, meeting, principal, transcriptSegment } from './domain.js'
import { DomainError, invariant } from './errors.js'
import { normalizeIngestMimeType, RECORDING_MIME_TYPES, SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'
import { parseSpeechWav } from './wav.js'
import { MicrosoftTeamsIntegrationAdapter } from './teams.js'
import { assertMeetingStorageContract } from './storage.js'
import { verifyAuditChain } from './audit.js'
import { exportFilename, renderMeetingRecordMarkdown } from './meeting-export.js'
import { InMemoryCommitmentRegistry } from './adapters/in-memory.js'

const PROCESSOR_FAILED = 'PROCESSOR_FAILED'
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
])
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
])
// The retention scheduler acts under this tenant-scoped service identity. It is
// never accepted from a request, and it can only expire content that current
// policy says is past its retention date.
const RETENTION_SERVICE_ID = 'service:retention'
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
  'meeting.create', 'consent.record', 'recording.preflight', 'recording.create', 'recording.upload',
  'recording.process', 'recording.process.retry', 'recording.process.complete', 'recording.status', 'recording.delete',
  'transcript.append', 'knowledge.assertions.add', 'knowledge.read', 'knowledge.search',
  'ai.retrieve', 'privacy-access.read', 'meeting.export', 'retention.expire',
  'commitment.query',
  'management-briefing.read',
  'teams.readiness', 'teams.import.prepare',
])

// A briefing is deliberately a small derived view. It may carry source links
// that an already-authorized reader can open, but never processor provenance,
// participant/meeting metadata, or unbounded provider output.
const BRIEFING_ITEM_LIMIT = 8
const BRIEFING_TEXT_LIMIT = 1_000
const BRIEFING_ASSERTION_KINDS = new Set(['decision', 'risk'])
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

// A platform supplied with a durable storage bundle must not retain the
// bundle's global repositories.  These adapters preserve the legacy domain
// repository call shape while each operation enters through a tenant-bound
// storage facade.  The raw adapter remains only in these closures and is
// never attached to the platform instance.
function scopedStorageRepositories(storage) {
  const read = (tenantId) => storage.scope({ tenantId })
  const write = (tenantId, operation) => storage.transaction({ tenantId }, operation)
  const tenantFromRows = (rows, label) => {
    if (!Array.isArray(rows) || rows.length === 0) return null
    const tenantId = rows[0]?.tenantId
    invariant(typeof tenantId === 'string' && tenantId.length > 0 && rows.every((row) => row?.tenantId === tenantId),
      'TENANT_SCOPE_VIOLATION', `${label} must remain inside one tenant scope`, 403)
    return tenantId
  }
  return Object.freeze({
    meetings: Object.freeze({
      get: (tenantId, meetingId) => read(tenantId).meetings.get(meetingId),
      list: (tenantId) => read(tenantId).meetings.list(),
      save: (record) => write(record.tenantId, (transaction) => transaction.meetings.save(record)),
    }),
    knowledge: Object.freeze({
      forMeeting: (tenantId, meetingId) => read(tenantId).knowledge.forMeeting(meetingId),
      meetingIdsMatching: (tenantId, query) => read(tenantId).knowledge.meetingIdsMatching(query),
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
      get: (tenantId, recordingId) => read(tenantId).recordings.get(recordingId),
      listForMeeting: (tenantId, meetingId) => read(tenantId).recordings.listForMeeting(meetingId),
      save: (record) => write(record.tenantId, (transaction) => transaction.recordings.save(record)),
      putBytes: (tenantId, recordingId, bytes) => write(tenantId, (transaction) => transaction.recordings.putBytes(recordingId, bytes)),
      getBytes: (tenantId, recordingId) => write(tenantId, (transaction) => transaction.recordings.getBytes(recordingId)),
      clearContent: (tenantId, recordingId) => write(tenantId, (transaction) => transaction.recordings.clearContent(recordingId)),
    }),
    audit: Object.freeze({
      append: (event) => write(event.tenantId, (transaction) => transaction.audit.append(event)),
      forMeeting: (tenantId, meetingId) => read(tenantId).audit.forMeeting(meetingId),
      chain: (tenantId) => read(tenantId).audit.chain(),
    }),
    commitments: Object.freeze({
      query: (tenantId, query) => read(tenantId).commitments.query(query),
      replaceMeeting: (tenantId, meetingId, knowledge) => write(tenantId, (transaction) => transaction.commitments.replaceMeeting(meetingId, knowledge)),
      clearMeeting: (tenantId, meetingId) => write(tenantId, (transaction) => transaction.commitments.clearMeeting(meetingId)),
    }),
    outbox: Object.freeze({
      enqueue: (event) => write(event.tenantId, (transaction) => transaction.outbox.enqueue(event)),
      list: (tenantId) => read(tenantId).outbox.list(),
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

  constructor({ storage = null, meetings, knowledge, recordings, audit, policy, speechProcessor, commitments, teamsIntegration = new MicrosoftTeamsIntegrationAdapter(), clock = { now: () => new Date() }, authorizationTtlMs = 300000, maxRecordingBytes = 10485760, acceptedMimeTypes = RECORDING_MIME_TYPES, schedule = queueMicrotask }) {
    // The `storage` bundle is the production persistence seam. Keeping the
    // individual repositories supported preserves existing local tests and
    // transports during the incremental migration, while a real deployment
    // can pass a validated tenant-scoped transactional adapter as one unit.
    let scopedOutbox = null
    if (storage) {
      assertMeetingStorageContract(storage)
      const storageFacade = storage
      const scoped = scopedStorageRepositories(storageFacade)
      meetings ??= scoped.meetings
      knowledge ??= scoped.knowledge
      recordings ??= scoped.recordings
      audit ??= scoped.audit
      commitments ??= scoped.commitments
      scopedOutbox = scoped.outbox
      // This is a private, tenant-first execution capability. It is used only
      // to make state transitions and their outbox rows one transaction when
      // a storage bundle is present; callers can never obtain the bundle or a
      // raw repository from the platform.
      this.#tenantTransaction = (tenantId, operation) => storageFacade.transaction({ tenantId }, operation)
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
    invariant(meetings && knowledge && audit && commitments, 'INVALID_STORAGE_ADAPTER', 'Canonical meeting, knowledge, audit, and commitment repositories are required')
    const outbox = scopedOutbox
    Object.assign(this, { meetings, knowledge, recordings, audit, policy, speechProcessor, commitments, outbox, teamsIntegration, clock, authorizationTtlMs, maxRecordingBytes, acceptedMimeTypes: Object.freeze([...acceptedMimeTypes]), schedule })
  }

  #outboxKey(type, aggregateId, revision) {
    invariant(OUTBOX_EVENT_TYPES.has(type), 'INVALID_OUTBOX_EVENT', 'Outbox event type is not allowlisted')
    return `meeting-ledger:v1:${type}:${aggregateId}:${revision}`
  }

  #emitOutbox({ tenantId, type, aggregateType, aggregateId, revision, payload }, transaction = null) {
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
    if (transaction) return transaction.outbox.enqueue(event)
    // A storage-backed platform does not call a global repository. It enters
    // a fresh tenant transaction facade even for an event-only transition.
    if (this.#tenantTransaction) return this.#tenantTransaction(tenantId, (facade) => facade.outbox.enqueue(event))
    return repository.enqueue(event)
  }

  #commitmentCount(tenantId, meetingId, commitments = this.commitments) {
    const rows = commitments === this.commitments ? commitments.query(tenantId, '') : commitments.query('')
    return rows.filter((item) => item.meetingId === meetingId).length
  }

  #emitKnowledgeChange(meetingRecord, revision, { commitmentsChanged = false, transaction = null, knowledge = this.knowledge, commitments = this.commitments } = {}) {
    // Once a meeting is outside active retention, downstream consumers must
    // not be told that knowledge exists or changed. Deletion gets its own
    // content-free disposition event below.
    if (!OUTBOX_RETENTION_VISIBLE_STATES.has(meetingRecord.retentionState)) return
    const snapshot = knowledge === this.knowledge
      ? knowledge.forMeeting(meetingRecord.tenantId, meetingRecord.id)
      : knowledge.forMeeting(meetingRecord.id)
    const payload = Object.freeze({
      state: 'available',
      segmentCount: snapshot.segments.length,
      assertionCount: snapshot.assertions.length,
    })
    this.#emitOutbox({
      tenantId: meetingRecord.tenantId,
      type: 'knowledge.changed', aggregateType: 'meeting', aggregateId: meetingRecord.id,
      revision, payload,
    }, transaction)
    if (commitmentsChanged) {
      this.#emitOutbox({
        tenantId: meetingRecord.tenantId,
        type: 'commitments.changed', aggregateType: 'meeting', aggregateId: meetingRecord.id,
        revision, payload: Object.freeze({ state: 'available', commitmentCount: this.#commitmentCount(meetingRecord.tenantId, meetingRecord.id, commitments) }),
      }, transaction)
    }
  }

  #audit({ correlationId, principal: actor, action, meetingId = null, recordingId = null, outcome, reason = null }) {
    this.audit.append({
      id: randomUUID(), correlationId, tenantId: actor.tenantId, principalId: actor.userId,
      actorId: actor.userId, resourceType: recordingId ? 'recording' : 'meeting',
      resourceId: recordingId ?? meetingId, meetingId, recordingId, action, outcome, reason,
      occurredAt: this.clock.now().toISOString(),
    })
  }

  #audited(actor, correlationId, action, meetingId, operation, recordingId = null) {
    try {
      const result = operation()
      this.#audit({ correlationId, principal: actor, action, meetingId, recordingId, outcome: 'allowed' })
      return result
    } catch (error) {
      this.#audit({ correlationId, principal: actor, action, meetingId, recordingId, outcome: 'denied', reason: error?.auditReason ?? error?.code ?? 'UNEXPECTED_ERROR' })
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

  #meeting(tenantId, meetingId) {
    // The platform never retains a storage bundle. Its narrowed meeting
    // adapter is tenant-first whether it came from a bundle or legacy test
    // repositories, so callers cannot reach an alternate storage scope.
    const record = this.meetings.get(tenantId, meetingId)
    if (!record) throw new DomainError('MEETING_NOT_FOUND', 'Meeting not found', 404)
    return record
  }

  #recording(actor, meetingId, recordingId, organizerOnly = false) {
    const record = this.recordings?.get(actor.tenantId, recordingId)
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

  #syncCommitments(tenantId, meetingId, { knowledge = this.knowledge, commitments = this.commitments } = {}) {
    // The registry may consume only the already canonicalized knowledge
    // repository. It never receives a processor response or request body.
    if (knowledge === this.knowledge) commitments.replaceMeeting(tenantId, meetingId, knowledge.forMeeting(tenantId, meetingId))
    else commitments.replaceMeeting(meetingId, knowledge.forMeeting(meetingId))
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

  #redactedAuditTimeline(tenantId, meetingId) {
    const events = this.audit.forMeeting(tenantId, meetingId)
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

  #revokeLease(meetingRecord, reason = 'RECORDING_POLICY_CHANGED') {
    const lease = meetingRecord.recording
    if (!lease?.leaseId || lease.status === 'revoked') return
    lease.status = 'revoked'
    lease.revokedAt = this.clock.now().toISOString()
    lease.revocationReason = this.#safePolicyReason(reason)
    this.meetings.save(meetingRecord)
  }

  #revokeLeaseIfStale(meetingRecord) {
    if (meetingRecord.recording?.leaseId && !this.#leaseMatchesCurrentPolicy(meetingRecord, meetingRecord.recording)) {
      this.#revokeLease(meetingRecord)
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

  #canonicalProcessorAssertionProvenance(descriptor, recording) {
    return Object.freeze({
      ...this.#canonicalProcessorProvenance(descriptor, recording),
      canonicalOrigin: CANONICAL_PROCESSOR_ASSERTION_ORIGIN,
    })
  }

  #canonicalConfidence(value) {
    // A bounded scalar is the only processor-supplied confidence retained. It is
    // informational only; authorization is derived exclusively from roster evidence.
    if (!Number.isFinite(value) || value < 0 || value > 1) return null
    return Math.round(value * 10000) / 10000
  }

  // Action owners are kept only when they are participants of this meeting;
  // deadlines only when they are real calendar dates. Anything else stays
  // unknown rather than being guessed.
  #canonicalProcessorCommitment(input, participantIds) {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const commitment = { status: 'open' }
    if (typeof value.ownerId === 'string' && participantIds.includes(value.ownerId)) commitment.ownerId = value.ownerId
    if (typeof value.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.deadline)) {
      const parsed = new Date(`${value.deadline}T00:00:00.000Z`)
      if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.deadline) commitment.deadline = parsed.toISOString()
    }
    return commitment
  }

  #normalizeProcessorResult(result, recording, rosterEvidence, participantIds = []) {
    invariant(result && Array.isArray(result.segments) && Array.isArray(result.assertions), 'INVALID_PROCESSOR_RESULT', 'Processor result is invalid')
    invariant(result.segments.length <= MAX_PROCESSOR_SEGMENTS && result.assertions.length <= MAX_PROCESSOR_ASSERTIONS, 'INVALID_PROCESSOR_RESULT', 'Processor result exceeds its size limits')
    const bindings = this.#rosterBindings(rosterEvidence)
    const descriptor = this.#processorDescriptor(result.processor)
    const rawSegmentIds = new Map()
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
        id: `${recording.id}-assertion-${assertions.length + 1}`, tenantId: recording.tenantId, meetingId: recording.meetingId,
        kind,
        text: item.text.trim(),
        citations: [...new Set(item.citations.map((id) => rawSegmentIds.get(id)))],
        provenance: this.#canonicalProcessorAssertionProvenance(descriptor, recording),
        ...(kind === 'action' ? { commitment: this.#canonicalProcessorCommitment(item.commitment, participantIds) } : {}),
      }))
    }
    return {
      segments,
      assertions,
      withheldAssertions,
      processor: descriptor.label,
    }
  }

  #quarantineRecording(meetingRecord, recordingId, reason) {
    if (this.#tenantTransaction) {
      return this.#tenantTransaction(meetingRecord.tenantId, (transaction) => {
        const record = transaction.recordings.get(recordingId)
        let transitioned = false
        if (record && !['deleted', 'completed'].includes(record.state)) {
          transitioned = record.state !== 'quarantined'
          record.state = 'quarantined'
          record.progress = 100
          record.error = POLICY_REVOKED
          record.processor = null
          record.dispositionReason = this.#safePolicyReason(reason)
          transaction.recordings.save(record)
          if (DELETE_BYTES_ON_REVOKE.has(meetingRecord.retentionState)) transaction.recordings.clearContent(record.id)
        }
        transaction.knowledge.clearMeeting(meetingRecord.id)
        transaction.commitments.clearMeeting(meetingRecord.id)
        if (transitioned && record && meetingRecord.retentionState !== 'deleted') {
          this.#emitOutbox({
            tenantId: meetingRecord.tenantId,
            type: 'recording.quarantined', aggregateType: 'recording', aggregateId: record.id,
            revision: 'quarantined',
            payload: Object.freeze({ state: 'quarantined', reason: this.#safePolicyReason(reason) }),
          }, transaction)
        }
      })
    }
    const record = this.recordings?.get(meetingRecord.tenantId, recordingId)
    let transitioned = false
    if (record && !['deleted', 'completed'].includes(record.state)) {
      transitioned = record.state !== 'quarantined'
      record.state = 'quarantined'
      record.progress = 100
      record.error = POLICY_REVOKED
      record.processor = null
      record.dispositionReason = this.#safePolicyReason(reason)
      this.recordings.save(record)
      if (DELETE_BYTES_ON_REVOKE.has(meetingRecord.retentionState)) this.recordings.clearContent(meetingRecord.tenantId, record.id)
    }
    this.knowledge.clearMeeting(meetingRecord.tenantId, meetingRecord.id)
    this.commitments.clearMeeting(meetingRecord.tenantId, meetingRecord.id)
    if (transitioned && record && meetingRecord.retentionState !== 'deleted') {
      this.#emitOutbox({
        tenantId: meetingRecord.tenantId,
        type: 'recording.quarantined', aggregateType: 'recording', aggregateId: record.id,
        revision: 'quarantined',
        payload: Object.freeze({ state: 'quarantined', reason: this.#safePolicyReason(reason) }),
      })
    }
  }

  #quarantine(meetingRecord, reason) {
    for (const record of this.recordings?.listForMeeting(meetingRecord.tenantId, meetingRecord.id) ?? []) {
      this.#quarantineRecording(meetingRecord, record.id, reason)
    }
  }

  #auditProcessingDenial(correlationId, actor, recording, reason) {
    this.#audit({
      correlationId, principal: actor, action: 'recording.process.complete',
      meetingId: recording?.meetingId ?? null, recordingId: recording?.id ?? null,
      outcome: 'denied', reason: this.#safePolicyReason(reason),
    })
  }

  #processorFailure(recordingId, correlationId, actor) {
    const record = this.recordings.get(actor.tenantId, recordingId)
    if (record && !['quarantined', 'deleted'].includes(record.state)) {
      record.state = 'failed'
      record.progress = 100
      record.error = PROCESSOR_FAILED
      record.processor = null
      this.recordings.save(record)
      this.knowledge.clearMeeting(record.tenantId, record.meetingId)
      this.commitments.clearMeeting(record.tenantId, record.meetingId)
    }
    // Processor failures are deliberately not outbox events. The processor is
    // untrusted and a failed payload must never become a downstream signal or
    // metadata channel; audit remains the separate, redacted evidence trail.
    this.#audit({
      correlationId, principal: actor, action: 'recording.process.complete',
      meetingId: record?.meetingId ?? null, recordingId, outcome: 'denied', reason: PROCESSOR_FAILED,
    })
  }

  createMeeting(input, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'meeting.create', body?.id, () => {
      invariant(actor.tenantId === body.tenantId && actor.userId === body.organizerId, 'CREATE_FORBIDDEN', 'Organizer must create the meeting in their tenant', 403)
      return this.meetings.save(meeting(body))
    })
  }

  recordConsent(input, meetingId, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'consent.record', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      invariant(actor.userId === body.participantId && meetingRecord.participantIds.includes(actor.userId), 'CONSENT_FORBIDDEN', 'Participants may record only their own consent', 403)
      meetingRecord.consentEvidence = meetingRecord.consentEvidence.filter((item) => item.participantId !== actor.userId)
      meetingRecord.consentEvidence.push(consentEvidence(body))
      this.meetings.save(meetingRecord)
      this.#revokeLeaseIfStale(meetingRecord)
      if (body.decision !== 'granted') this.#quarantine(meetingRecord, 'CONSENT_NOT_GRANTED')
    })
  }

  // Re-derives the caller tenant's audit hash chain. The response contains only
  // sequence numbers, the head hash, and an allowlisted failure reason. The
  // verification is itself audited after the check, so it extends the chain
  // one event beyond the head it reports.
  verifyAuditIntegrity(input, { anchor = null } = {}, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'audit.verify', null, () => {
      this.policy.require(this.policy.auditIntegrity({ principal: actor, now: this.clock.now() }))
      invariant(typeof this.audit.chain === 'function', 'AUDIT_INTEGRITY_UNAVAILABLE', 'Audit store does not expose a verifiable chain', 503)
      return verifyAuditChain(this.audit.chain(actor.tenantId), { tenantId: actor.tenantId, anchor })
    })
  }

  getTeamsReadiness(input, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'teams.readiness', null, () => this.teamsIntegration.readiness())
  }

  prepareTeamsImport(input, meetingId, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'teams.import.prepare', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      // Import authorization is intentionally governed by the same policy gate
      // as microphone capture: organizer, classification, retention, and each
      // required participant's explicit current consent are all re-evaluated.
      this.#capturePolicy(actor, meetingRecord)
      return this.teamsIntegration.prepareImport(body)
    })
  }

  authorizeRecording(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.preflight', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
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
      this.meetings.save(meetingRecord)
      return structuredClone(meetingRecord.recording)
    })
  }

  createRecording(input, meetingId, body, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.create', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      const staleLease = meetingRecord.recording?.leaseId && !this.#leaseMatchesCurrentPolicy(meetingRecord, meetingRecord.recording)
      if (staleLease) this.#revokeLease(meetingRecord)
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
      this.meetings.save(meetingRecord)
      const recording = this.recordings.save({
        id: randomUUID(), tenantId: actor.tenantId, meetingId, organizerId: actor.userId,
        policyVersion: lease.policyVersion, classification: lease.classification,
        policyFingerprint: lease.policyFingerprint, leaseId: lease.leaseId,
        contentType, byteLength: body.byteLength, sha256: body.sha256,
        state: 'created', progress: 0, uploadedAt: null, bytes: null, processor: null, error: null,
      })
      return { recordingId: recording.id, uploadRoute: `/meetings/${meetingId}/recordings/${recording.id}/bytes`, state: recording.state }
    })
  }

  uploadRecording(input, meetingId, recordingId, { contentType, contentLength, bytes }, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.upload', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      this.#capturePolicy(actor, meetingRecord)
      const recording = this.#recording(actor, meetingId, recordingId, true)
      invariant(this.#leaseMatchesCurrentPolicy(meetingRecord, recording), 'RECORDING_POLICY_CHANGED', 'Recording authorization no longer matches current policy', 403)
      invariant(recording.state === 'created' && !recording.uploadedAt, 'DUPLICATE_UPLOAD', 'Recording bytes may be uploaded once', 409)
      invariant(normalizeIngestMimeType(contentType) === recording.contentType, 'CONTENT_TYPE_MISMATCH', 'Content-Type does not match declared metadata', 415)
      invariant(Number.isSafeInteger(contentLength), 'CONTENT_LENGTH_REQUIRED', 'Content-Length is required', 411)
      invariant(contentLength <= this.maxRecordingBytes && contentLength === recording.byteLength, 'CONTENT_LENGTH_MISMATCH', 'Content-Length does not match declared size', 400)
      invariant(bytes.length === recording.byteLength, 'ACTUAL_LENGTH_MISMATCH', 'Actual bytes do not match declared size', 400)
      invariant(createHash('sha256').update(bytes).digest('hex') === recording.sha256, 'HASH_MISMATCH', 'Recording hash does not match declared sha256', 400)
      // WAV is the one format the server can verify completely before storing it.
      if (recording.contentType === SPEECH_WAV_MIME_TYPE) parseSpeechWav(bytes)
      this.recordings.putBytes(actor.tenantId, recording.id, bytes)
      recording.state = 'uploaded'; recording.progress = 20; recording.uploadedAt = this.clock.now().toISOString()
      this.recordings.save(recording)
      // Retention counts from the first stored content and never restarts.
      if (!meetingRecord.contentStartedAt) {
        meetingRecord.contentStartedAt = recording.uploadedAt
        this.meetings.save(meetingRecord)
      }
      return view(recording)
    }, recordingId)
  }

  startProcessing(input, meetingId, recordingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.process', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      const recording = this.#recording(actor, meetingId, recordingId, true)
      const decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
      if (!decision.allowed) {
        this.#quarantineRecording(meetingRecord, recording.id, decision.code)
        this.policy.require(decision)
      }
      if (['queued', 'processing', 'completed'].includes(recording.state)) return view(recording)
      invariant(recording.state === 'uploaded', 'RECORDING_NOT_UPLOADED', 'Recording must be uploaded before processing', 409)
      recording.state = 'queued'; recording.progress = 35; recording.processingAttempts = 1
      this.recordings.save(recording)
      this.schedule(() => this.#process(actor.tenantId, recording.id, correlationId))
      return view(recording)
    }, recordingId)
  }

  // Re-queues a failed job for its organizer, a bounded number of times. Policy
  // is evaluated exactly as for a first attempt: if consent, classification,
  // or retention changed since the upload, the recording is quarantined
  // instead of being processed again.
  retryProcessing(input, meetingId, recordingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.process.retry', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      const recording = this.#recording(actor, meetingId, recordingId, true)
      invariant(recording.state === 'failed' && recording.error === PROCESSOR_FAILED, 'RECORDING_NOT_RETRYABLE', 'Only a failed processing job can be retried', 409)
      invariant((recording.processingAttempts ?? 1) < MAX_PROCESSING_ATTEMPTS, 'RETRY_LIMIT_REACHED', 'This recording has reached its processing retry limit', 409)
      const decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
      if (!decision.allowed) {
        this.#quarantineRecording(meetingRecord, recording.id, decision.code)
        this.policy.require(decision)
      }
      invariant(!recording.contentClearedAt && this.recordings.getBytes(actor.tenantId, recording.id), 'RECORDING_CONTENT_UNAVAILABLE', 'Recording audio is no longer available', 409)
      recording.state = 'queued'; recording.progress = 35; recording.error = null
      recording.processingAttempts = (recording.processingAttempts ?? 1) + 1
      this.recordings.save(recording)
      this.schedule(() => this.#process(actor.tenantId, recording.id, correlationId))
      return view(recording)
    }, recordingId)
  }

  async #process(tenantId, recordingId, correlationId) {
    let recording = this.recordings.get(tenantId, recordingId)
    if (!recording) return
    const actor = principal({ tenantId: recording.tenantId, userId: recording.organizerId })
    if (recording.state !== 'queued') {
      if (['quarantined', 'deleted'].includes(recording.state)) {
        this.#auditProcessingDenial(correlationId, actor, recording, recording.dispositionReason ?? PROCESSING_CANCELLED)
      }
      return
    }
    let meetingRecord = this.#meeting(recording.tenantId, recording.meetingId)
    let decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
    if (!decision.allowed) {
      this.#quarantineRecording(meetingRecord, recording.id, decision.code)
      this.#auditProcessingDenial(correlationId, actor, recording, decision.code)
      return
    }

    recording.state = 'processing'; recording.progress = 65
    this.recordings.save(recording)
    const rosterEvidence = this.#authorizedRosterEvidence(meetingRecord)

    let result
    try {
      const rawResult = await this.speechProcessor.process({
        recording: structuredClone(recording), bytes: this.recordings.getBytes(actor.tenantId, recordingId), rosterEvidence,
        participantIds: [...meetingRecord.participantIds],
      })
      result = this.#normalizeProcessorResult(rawResult, recording, rosterEvidence, meetingRecord.participantIds)
    } catch {
      recording = this.recordings.get(actor.tenantId, recordingId)
      meetingRecord = recording ? this.#meeting(recording.tenantId, recording.meetingId) : meetingRecord
      if (recording?.state === 'quarantined') {
        this.#auditProcessingDenial(correlationId, actor, recording, recording.dispositionReason ?? PROCESSING_CANCELLED)
        return
      }
      if (recording) {
        decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
        if (!decision.allowed) {
          this.#quarantineRecording(meetingRecord, recording.id, decision.code)
          this.#auditProcessingDenial(correlationId, actor, recording, decision.code)
          return
        }
      }
      this.#processorFailure(recordingId, correlationId, actor)
      return
    }

    recording = this.recordings.get(actor.tenantId, recordingId)
    if (!recording || recording.state !== 'processing') {
      this.#auditProcessingDenial(correlationId, actor, recording, recording?.dispositionReason ?? PROCESSING_CANCELLED)
      return
    }
    meetingRecord = this.#meeting(recording.tenantId, recording.meetingId)
    decision = this.#recordingPolicyDecision(actor, meetingRecord, recording)
    if (!decision.allowed) {
      this.#quarantineRecording(meetingRecord, recording.id, decision.code)
      this.#auditProcessingDenial(correlationId, actor, recording, decision.code)
      return
    }

    try {
      recording.state = 'completed'; recording.progress = 100; recording.processor = result.processor; recording.error = null
      recording.withheldAssertions = result.withheldAssertions
      const publish = (transaction = null) => {
        const knowledge = transaction?.knowledge ?? this.knowledge
        const commitments = transaction?.commitments ?? this.commitments
        const recordings = transaction?.recordings ?? this.recordings
        if (transaction) {
          knowledge.clearMeeting(recording.meetingId)
          commitments.clearMeeting(recording.meetingId)
          knowledge.addSegments(result.segments)
          knowledge.addAssertions(result.assertions)
          commitments.replaceMeeting(recording.meetingId, knowledge.forMeeting(recording.meetingId))
          recordings.save(recording)
        } else {
          knowledge.clearMeeting(recording.tenantId, recording.meetingId)
          commitments.clearMeeting(recording.tenantId, recording.meetingId)
          knowledge.addSegments(result.segments)
          knowledge.addAssertions(result.assertions)
          this.#syncCommitments(recording.tenantId, recording.meetingId)
          recordings.save(recording)
        }
        this.#emitKnowledgeChange(meetingRecord, `recording:${recording.id}:completed`, { commitmentsChanged: true, transaction, knowledge, commitments })
        this.#emitOutbox({
          tenantId: recording.tenantId,
          type: 'recording.completed', aggregateType: 'recording', aggregateId: recording.id,
          revision: 'completed', payload: Object.freeze({ state: 'completed' }),
        }, transaction)
      }
      if (this.#tenantTransaction) this.#tenantTransaction(recording.tenantId, publish)
      else publish()
      this.#audit({ correlationId, principal: actor, action: 'recording.process.complete', meetingId: recording.meetingId, recordingId, outcome: 'allowed' })
    } catch {
      this.#processorFailure(recordingId, correlationId, actor)
    }
  }

  getRecording(input, meetingId, recordingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.status', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      this.policy.require(this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      const recording = this.#recording(actor, meetingId, recordingId)
      const output = { recording: view(recording) }
      if (recording.state === 'completed') Object.assign(output, this.knowledge.forMeeting(actor.tenantId, meetingId))
      return output
    }, recordingId)
  }

  deleteMeetingContent(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'recording.delete', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      invariant(meetingRecord.organizerId === actor.userId, 'DELETE_FORBIDDEN', 'Only organizer may delete development content', 403)
      invariant(meetingRecord.retentionState !== 'held', 'LEGAL_HOLD', 'Legal hold prevents deletion', 409)
      this.#disposeMeetingContent(meetingRecord)
      return { state: 'deleted' }
    })
  }

  // Deletes one meeting's content in every store it reaches: audio, transcript,
  // knowledge, and derived commitments, then emits the content-free deletion
  // event. Manual deletion and retention expiry share this one path.
  #disposeMeetingContent(meetingRecord) {
    const tenantId = meetingRecord.tenantId
    const meetingId = meetingRecord.id
    const dispose = (transaction = null) => {
        const meetings = transaction?.meetings ?? this.meetings
        const recordings = transaction?.recordings ?? this.recordings
        const knowledge = transaction?.knowledge ?? this.knowledge
        const commitments = transaction?.commitments ?? this.commitments
        meetingRecord.retentionState = 'deleted'
        meetings.save(meetingRecord)
        const records = transaction ? recordings.listForMeeting(meetingId) : recordings.listForMeeting(tenantId, meetingId)
        for (const recording of records) {
          if (transaction) recordings.clearContent(recording.id)
          else recordings.clearContent(tenantId, recording.id)
          recording.state = 'deleted'; recording.progress = 100; recordings.save(recording)
        }
        if (transaction) {
          knowledge.clearMeeting(meetingId)
          commitments.clearMeeting(meetingId)
        } else {
          knowledge.clearMeeting(tenantId, meetingId)
          commitments.clearMeeting(tenantId, meetingId)
        }
        // Deletion is the sole event after disposition. It contains no content
        // counts, recording IDs, source IDs, or classification, so consumers
        // cannot infer deleted/never-record information from the outbox.
        this.#emitOutbox({
          tenantId,
          type: 'meeting.content.deleted', aggregateType: 'meeting', aggregateId: meetingId,
          revision: 'deleted', payload: Object.freeze({ state: 'deleted' }),
        }, transaction)
      }
      if (this.#tenantTransaction) this.#tenantTransaction(tenantId, dispose)
      else dispose()
  }

  // Retention sweep for one tenant, run by the scheduler (never by a request).
  // Expired content is already unreadable through policy; this makes the
  // deletion real. Legal hold prevents it, and re-running is a no-op.
  enforceRetention(tenantId, correlationId = randomUUID()) {
    const actor = principal({ tenantId, userId: RETENTION_SERVICE_ID })
    const now = this.clock.now()
    const summary = { expired: 0, held: 0 }
    for (const meetingRecord of this.meetings.list(tenantId)) {
      if (meetingRecord.retentionState === 'deleted' || !this.policy.retentionExpired({ meeting: meetingRecord, now })) continue
      if (meetingRecord.retentionState === 'held') { summary.held += 1; continue }
      this.#audited(actor, correlationId, 'retention.expire', meetingRecord.id, () => this.#disposeMeetingContent(meetingRecord))
      summary.expired += 1
    }
    return Object.freeze(summary)
  }

  appendTranscript(input, meetingId, authorization, items, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'transcript.append', meetingId, () => {
      const append = (transaction = null) => {
        const meetings = transaction?.meetings ?? this.meetings
        const knowledge = transaction?.knowledge ?? this.knowledge
        const commitments = transaction?.commitments ?? this.commitments
        const meetingRecord = meetings.get(transaction ? meetingId : actor.tenantId, transaction ? undefined : meetingId)
          ?? (() => { throw new DomainError('MEETING_NOT_FOUND', 'Meeting not found', 404) })()
        const staleAuthorization = meetingRecord.recording?.leaseId && !this.#leaseMatchesCurrentPolicy(meetingRecord, meetingRecord.recording)
        if (staleAuthorization) {
          meetingRecord.recording.status = 'revoked'
          meetingRecord.recording.revokedAt = this.clock.now().toISOString()
          meetingRecord.recording.revocationReason = this.#safePolicyReason('RECORDING_POLICY_CHANGED')
          if (transaction) meetings.save(meetingRecord)
          else this.meetings.save(meetingRecord)
        }
        this.#capturePolicy(actor, meetingRecord)
        if (staleAuthorization) throw new DomainError('RECORDING_POLICY_CHANGED', 'Recording authorization no longer matches current policy', 403)
        invariant(authorization?.authorizationId === meetingRecord.recording.authorizationId, 'INVALID_RECORDING_AUTHORIZATION', 'Recording authorization does not match', 403)
        invariant(new Date(authorization.authorizationExpiresAt) > this.clock.now(), 'RECORDING_AUTHORIZATION_EXPIRED', 'Recording authorization expired', 403)
        const rows = items.map((item) => transcriptSegment({ ...item, meetingId, tenantId: actor.tenantId }))
        const snapshot = transaction ? knowledge.forMeeting(meetingId) : knowledge.forMeeting(actor.tenantId, meetingId)
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
        knowledge.addSegments(inserted)
        const revision = `transcript:${createHash('sha256').update(JSON.stringify(canonical(inserted.map((row) => row.id)))).digest('hex')}`
        this.#emitKnowledgeChange(meetingRecord, revision, { transaction, knowledge, commitments })
        return rows
      }
      return this.#tenantTransaction ? this.#tenantTransaction(actor.tenantId, append) : append()
    })
  }

  addAssertions(input, meetingId, items, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'knowledge.assertions.add', meetingId, () => {
      const add = (transaction = null) => {
      const meetings = transaction?.meetings ?? this.meetings
      const knowledge = transaction?.knowledge ?? this.knowledge
      const commitments = transaction?.commitments ?? this.commitments
      const meetingRecord = meetings.get(transaction ? meetingId : actor.tenantId, transaction ? undefined : meetingId)
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
      const snapshot = transaction ? knowledge.forMeeting(meetingId) : knowledge.forMeeting(actor.tenantId, meetingId)
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
        knowledge.addAssertions(inserted)
        this.#syncCommitments(actor.tenantId, meetingId, { knowledge, commitments })
        const revision = `assertions:${createHash('sha256').update(JSON.stringify(canonical(inserted.map((row) => row.id)))).digest('hex')}`
        this.#emitKnowledgeChange(meetingRecord, revision, { commitmentsChanged: true, transaction, knowledge, commitments })
      }
      return rows
      }
      return this.#tenantTransaction ? this.#tenantTransaction(actor.tenantId, add) : add()
    })
  }

  getMeetingKnowledge(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'knowledge.read', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      this.policy.require(this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      return { meeting: meetingRecord, ...this.knowledge.forMeeting(actor.tenantId, meetingId) }
    })
  }

  // Produces a downloadable record of one meeting's authorized knowledge.
  // The audit event carries identifiers only; the document carries the same
  // correlation ID so any copy can be traced back to this decision.
  exportMeetingRecord(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'meeting.export', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      this.policy.require(this.policy.meetingExport({ principal: actor, meeting: meetingRecord, now: this.clock.now() }))
      const { segments, assertions } = this.knowledge.forMeeting(actor.tenantId, meetingId)
      invariant(segments.length > 0 || assertions.length > 0, 'NO_MEETING_RECORD', 'This meeting has no processed record to export yet', 409)
      const completed = (this.recordings?.listForMeeting(actor.tenantId, meetingId) ?? []).filter((item) => item.state === 'completed')
      return Object.freeze({
        filename: exportFilename(meetingId),
        contentType: 'text/markdown; charset=utf-8',
        body: renderMeetingRecordMarkdown({
          meeting: meetingRecord, segments, assertions,
          processor: completed.at(-1)?.processor ?? null,
          exportedBy: actor.userId, exportedAt: this.clock.now().toISOString(), correlationId,
        }),
      })
    })
  }

  getMeetingPrivacyAccess(input, meetingId, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'privacy-access.read', meetingId, () => {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      const access = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
      if (!access.allowed) throw this.#opaquePrivacyAccessDenied(access.code)
      return Object.freeze({
        access: Object.freeze({ posture: access.posture, authorized: true }),
        classification: this.#classificationSummary(meetingRecord),
        retention: this.#retentionSummary(meetingRecord),
        auditTimeline: this.#redactedAuditTimeline(actor.tenantId, meetingId),
      })
    })
  }

  searchKnowledge(input, query, correlationId = randomUUID()) {
    return this.#matches(principal(input), query, correlationId, 'knowledge.search')
  }

  retrieveForAi(input, query, correlationId = randomUUID()) {
    return this.#matches(principal(input), query, correlationId, 'ai.retrieve')
  }

  queryCommitments(input, query = '', correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'commitment.query', null, () => {
      const output = []
      for (const item of this.commitments.query(actor.tenantId, query)) {
        // The registry is a derived index, so treat it as an untrusted read
        // boundary too.  Never turn a malformed or oversized source list into
        // an API response, audit-adjacent record, or agent context payload.
        if (!isBoundedKnowledgeCitationList(item?.citations)) continue
        const meetingRecord = this.#meeting(actor.tenantId, item.meetingId)
        const decision = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
        this.#audit({ correlationId, principal: actor, action: 'commitment.query', meetingId: item.meetingId, outcome: decision.allowed ? 'allowed' : 'denied', reason: decision.allowed ? null : decision.code })
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
    })
  }

  getManagementBriefing(input, correlationId = randomUUID()) {
    const actor = principal(input)
    return this.#audited(actor, correlationId, 'management-briefing.read', null, () => {
      const decisions = []
      const risks = []
      const blockers = []
      const actions = []

      // Iterate only records within the caller's tenant and evaluate the
      // existing meeting policy before touching a knowledge row. Do not emit
      // a per-meeting audit event here: that would itself disclose hidden
      // source existence to an otherwise authorized audit reader.
      for (const meetingRecord of this.meetings.list(actor.tenantId)) {
        const access = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
        if (!access.allowed) continue

        const knowledge = this.knowledge.forMeeting(actor.tenantId, meetingRecord.id)
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
        for (const commitment of this.commitments.query(actor.tenantId)) {
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
    })
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

  #matches(actor, query, correlationId, action) {
    const output = []
    for (const meetingId of this.knowledge.meetingIdsMatching(actor.tenantId, query)) {
      const meetingRecord = this.#meeting(actor.tenantId, meetingId)
      const decision = this.policy.meetingAccess({ principal: actor, meeting: meetingRecord, now: this.clock.now() })
      this.#audit({ correlationId, principal: actor, action, meetingId, outcome: decision.allowed ? 'allowed' : 'denied', reason: decision.allowed ? null : decision.code })
      if (decision.allowed) output.push({ meeting: meetingRecord, ...this.knowledge.forMeeting(actor.tenantId, meetingId) })
    }
    return output
  }
}
