import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createInMemoryMeetingStorage, createMeetingStorageBundle, createTenantStorageFacade, assertMeetingStorageContract, MEETING_LEDGER_DATA_MODEL_VERSION } from './storage.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { FakeSpeechProcessor } from './speech.js'

test('the prototype storage bundle satisfies the durable adapter contract and scopes transactions', () => {
  const storage = createInMemoryMeetingStorage()
  assert.equal(assertMeetingStorageContract(storage), storage)
  assert.equal(storage.dataModelVersion, MEETING_LEDGER_DATA_MODEL_VERSION)
  assert.equal(storage.transaction({ tenantId: 'northstar' }, (transaction) => transaction.tenantId), 'northstar')
  assert.equal(storage.scope({ tenantId: 'northstar' }).tenantId, 'northstar')
  assert.throws(() => storage.transaction({}, () => null), { code: 'INVALID_TENANT_SCOPE' })
})

test('outbox idempotency is tenant-local and does not allow a cross-tenant event', () => {
  const storage = createInMemoryMeetingStorage()
  const event = { tenantId: 'northstar', type: 'meeting.changed', idempotencyKey: 'meeting-1:v1', aggregateId: 'meeting-1' }
  const first = storage.transaction({ tenantId: 'northstar' }, (transaction) => transaction.outbox.enqueue(event))
  const replay = storage.transaction({ tenantId: 'northstar' }, (transaction) => transaction.outbox.enqueue({ ...event, type: 'ignored-on-replay' }))
  assert.equal(first.type, 'meeting.changed')
  assert.deepEqual(replay, first)
  assert.deepEqual(storage.scope({ tenantId: 'southstar' }).outbox.list(), [])
  assert.throws(() => storage.transaction({ tenantId: 'southstar' }, (transaction) => transaction.outbox.enqueue(event)), { code: 'TENANT_SCOPE_VIOLATION' })
})

test('transaction callbacks receive only sealed tenant capabilities and cannot escape to another tenant', () => {
  const storage = createInMemoryMeetingStorage()
  storage.transaction({ tenantId: 'northstar' }, (transaction) => transaction.meetings.save({ id: 'north-meeting', tenantId: 'northstar', organizerId: 'alex' }))
  storage.transaction({ tenantId: 'southstar' }, (transaction) => {
    transaction.meetings.save({ id: 'south-meeting', tenantId: 'southstar', organizerId: 'bea' })
    transaction.recordings.save({ id: 'south-recording', tenantId: 'southstar', meetingId: 'south-meeting' })
  })

  storage.transaction({ tenantId: 'northstar' }, (transaction) => {
    assert.equal(Object.getPrototypeOf(transaction), null)
    assert.equal(Object.getPrototypeOf(transaction.meetings), null)
    assert.deepEqual(Object.getOwnPropertySymbols(transaction), [])
    assert.deepEqual(Object.getOwnPropertySymbols(transaction.recordings), [])
    assert.equal(transaction.storage, undefined)
    assert.equal(transaction.scope, undefined)
    assert.equal(transaction.transaction, undefined)
    assert.equal(storage.meetings, undefined)
    assert.equal(storage.outbox, undefined)
    assert.deepEqual(Object.keys(storage), ['kind', 'dataModelVersion', 'scope', 'transaction'])
    assert.deepEqual(Object.getOwnPropertySymbols(storage), [])
    assert.equal(Object.getPrototypeOf(storage), null)
    assert.equal(Object.getOwnPropertyDescriptor(transaction, 'meetings').get, undefined)
    assert.equal(Object.getOwnPropertyDescriptor(transaction.meetings, 'get').get, undefined)
    assert.equal(Object.hasOwn(transaction.meetings.get, 'prototype'), false)
    assert.deepEqual(Object.getOwnPropertySymbols(transaction.meetings.get), [])
    assert.deepEqual(Reflect.ownKeys(transaction), ['tenantId', 'meetings', 'knowledge', 'recordings', 'audit', 'commitments', 'outbox'])
    assert.deepEqual(Reflect.ownKeys(transaction.meetings), ['get', 'list', 'save'])
    assert.equal(Reflect.get(transaction, 'scope'), undefined)
    assert.equal(Object.isExtensible(transaction), false)
    assert.equal(Reflect.defineProperty(transaction, 'escape', { value: storage }), false)
    assert.throws(() => Object.defineProperty(transaction, Symbol('storage-escape'), { value: storage }), TypeError)
    assert.equal(transaction.escape, undefined)
    assert.equal(Object.getOwnPropertyDescriptor(transaction, 'meetings').value.get('south-meeting'), null)
    assert.equal(transaction.meetings.get('southstar', 'south-meeting'), null)
    assert.equal(transaction.recordings.get('south-recording'), null)
    assert.throws(() => transaction.meetings.save({ id: 'south-write', tenantId: 'southstar' }), { code: 'TENANT_SCOPE_VIOLATION' })
    assert.throws(() => transaction.recordings.save({ id: 'south-recording', tenantId: 'northstar', meetingId: 'north-meeting' }), { code: 'TENANT_SCOPE_VIOLATION' })
    assert.throws(() => transaction.outbox.enqueue({ tenantId: 'southstar', type: 'meeting.changed', idempotencyKey: 'escape' }), { code: 'TENANT_SCOPE_VIOLATION' })
    // Pulling methods out by reflection does not change their closed tenant
    // binding, and cannot be used as an indirect cross-tenant write path.
    const reflectedSave = Reflect.getOwnPropertyDescriptor(transaction.meetings, 'save').value
    const reflectedOutbox = Reflect.getOwnPropertyDescriptor(transaction.outbox, 'enqueue').value
    assert.throws(() => reflectedSave.call({ tenantId: 'southstar' }, { id: 'indirect-south-write', tenantId: 'southstar' }), { code: 'TENANT_SCOPE_VIOLATION' })
    assert.throws(() => reflectedOutbox.call({ tenantId: 'southstar' }, { tenantId: 'southstar', type: 'meeting.changed', idempotencyKey: 'indirect-escape' }), { code: 'TENANT_SCOPE_VIOLATION' })

    const saved = transaction.meetings.save({ id: 'north-write', tenantId: 'northstar', organizerId: 'alex' })
    const event = transaction.outbox.enqueue({ tenantId: 'northstar', type: 'meeting.changed', idempotencyKey: 'north-write:v1' })
    assert.equal(saved.id, 'north-write')
    assert.equal(event.tenantId, 'northstar')
  })

  assert.equal(storage.scope({ tenantId: 'northstar' }).meetings.get('north-write').organizerId, 'alex')
  assert.equal(storage.scope({ tenantId: 'southstar' }).meetings.get('south-write'), null)
  assert.equal(storage.scope({ tenantId: 'southstar' }).outbox.list().length, 0)
})

test('transaction callbacks are synchronous and propagate callback errors without exposing storage', () => {
  const storage = createInMemoryMeetingStorage()
  const expected = new Error('expected callback failure')
  assert.throws(() => storage.transaction({ tenantId: 'northstar' }, () => { throw expected }), (error) => error === expected)
  assert.throws(() => storage.transaction({ tenantId: 'northstar' }, () => Promise.resolve('later')), { code: 'ASYNC_STORAGE_TRANSACTION_UNSUPPORTED' })
})

test('storage contract rejects structurally forged and mis-scoped tenant facades', () => {
  const forged = {
    kind: 'in-memory-prototype',
    dataModelVersion: MEETING_LEDGER_DATA_MODEL_VERSION,
    meetings: {}, knowledge: {}, recordings: {}, audit: {}, commitments: {}, outbox: {},
    scope: ({ tenantId }) => Object.freeze({ tenantId, meetings: {}, knowledge: {}, recordings: {}, audit: {}, commitments: {}, outbox: {} }),
    transaction: ({ tenantId }, operation) => operation({ tenantId, meetings: {}, knowledge: {}, recordings: {}, audit: {}, commitments: {}, outbox: {} }),
  }
  assert.throws(() => assertMeetingStorageContract(forged), { code: 'INVALID_STORAGE_ADAPTER' })

  const forgedBundle = createMeetingStorageBundle({
    kind: 'forged',
    scope: ({ tenantId }) => Object.freeze({ tenantId, meetings: {}, knowledge: {}, recordings: {}, audit: {}, commitments: {}, outbox: {} }),
    transaction: ({ tenantId }, operation) => operation(Object.freeze({ tenantId, meetings: {}, knowledge: {}, recordings: {}, audit: {}, commitments: {}, outbox: {} })),
  })
  assert.throws(() => assertMeetingStorageContract(forgedBundle), { code: 'INVALID_STORAGE_ADAPTER' })

  const inertCapabilities = () => ({
    meetings: { get: () => null, list: () => [] },
    knowledge: { forMeeting: () => ({ segments: [], assertions: [] }), meetingIdsMatching: () => [] },
    recordings: { get: () => null, listForMeeting: () => [] },
    audit: { forMeeting: () => [] }, commitments: { query: () => [] }, outbox: { list: () => [] },
  })
  const invalid = createMeetingStorageBundle({
    scope: () => createTenantStorageFacade({ tenantId: 'different-tenant' }, inertCapabilities()),
    transaction: (_scope, operation) => operation(createTenantStorageFacade({ tenantId: 'different-tenant' }, {
      ...inertCapabilities(),
      meetings: { ...inertCapabilities().meetings, save: () => null },
      knowledge: { ...inertCapabilities().knowledge, addSegments: () => null, addAssertions: () => null, clearMeeting: () => null },
      recordings: { ...inertCapabilities().recordings, save: () => null, putBytes: () => null, getBytes: () => null, clearContent: () => null },
      audit: { ...inertCapabilities().audit, append: () => null },
      commitments: { ...inertCapabilities().commitments, replaceMeeting: () => null, clearMeeting: () => null },
      outbox: { ...inertCapabilities().outbox, enqueue: () => null },
    }, { writable: true })),
  })
  assert.throws(() => assertMeetingStorageContract(invalid), { code: 'INVALID_STORAGE_ADAPTER' })

})

test('platform accepts a validated storage bundle without changing its public behavior', () => {
  const storage = createInMemoryMeetingStorage()
  const platform = new MeetingIntelligencePlatform({ storage, policy: new PolicyEngine() })
  const organizer = { tenantId: 'northstar', userId: 'alex' }
  platform.createMeeting(organizer, {
    id: 'meeting-storage-contract', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex'], classification: 'standard',
  })
  assert.equal(platform.storage, undefined)
  assert.equal(storage.scope({ tenantId: 'northstar' }).meetings.get('meeting-storage-contract').organizerId, 'alex')
  assert.equal(storage.scope({ tenantId: 'southstar' }).meetings.get('meeting-storage-contract'), null)
})

test('storage-backed platform emits tenant-scoped canonical lifecycle events without leaking content or processor metadata', async () => {
  const storage = createInMemoryMeetingStorage()
  const jobs = []
  const platform = new MeetingIntelligencePlatform({
    storage,
    policy: new PolicyEngine({ knownClassifications: ['standard'] }),
    speechProcessor: new FakeSpeechProcessor(),
    schedule: (job) => jobs.push(job),
  })
  const alex = { tenantId: 'northstar', userId: 'alex' }
  const sam = { tenantId: 'northstar', userId: 'sam' }
  const bytes = Buffer.from('outbox lifecycle fixture')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  platform.createMeeting(alex, {
    id: 'outbox-meeting', tenantId: 'northstar', organizerId: 'alex',
    participantIds: ['alex', 'sam'], classification: 'standard',
  })
  for (const actor of [alex, sam]) {
    platform.recordConsent(actor, 'outbox-meeting', {
      participantId: actor.userId, decision: 'granted', policyVersion: 'v1',
      capturedAt: '2026-10-03T11:00:00Z', expiresAt: '2026-10-04T11:00:00Z',
    })
  }
  const lease = platform.authorizeRecording(alex, 'outbox-meeting')
  const created = platform.createRecording(alex, 'outbox-meeting', {
    leaseId: lease.leaseId, contentType: 'audio/webm', byteLength: bytes.length, sha256,
  })
  platform.uploadRecording(alex, 'outbox-meeting', created.recordingId, {
    contentType: 'audio/webm', contentLength: bytes.length, bytes,
  })
  platform.startProcessing(alex, 'outbox-meeting', created.recordingId, 'outbox-process')
  await jobs.shift()()

  const events = storage.scope({ tenantId: 'northstar' }).outbox.list()
  assert.deepEqual(events.map((event) => event.type).sort(), [
    'commitments.changed', 'knowledge.changed', 'recording.completed',
  ])
  const expectedEventKeys = ['aggregateId', 'aggregateType', 'id', 'idempotencyKey', 'occurredAt', 'payload', 'tenantId', 'type']
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), expectedEventKeys)
    assert.equal(event.tenantId, 'northstar')
    assert.equal(event.idempotencyKey.startsWith('meeting-ledger:v1:'), true)
  }
  assert.deepEqual(events.find((event) => event.type === 'recording.completed').payload, { state: 'completed' })
  assert.deepEqual(events.find((event) => event.type === 'knowledge.changed').payload, {
    state: 'available', segmentCount: 3, assertionCount: 2,
  })
  assert.deepEqual(events.find((event) => event.type === 'commitments.changed').payload, {
    state: 'available', commitmentCount: 1,
  })
  const serialized = JSON.stringify(events)
  for (const forbidden of [
    'The facilitator opened', 'Complete the security review', 'FakeSpeechProcessor',
    'processor-normalized-v1', 'speech-processor', 'SPEAKER_00', 'sam', sha256,
  ]) assert.equal(serialized.includes(forbidden), false)
  assert.deepEqual(storage.scope({ tenantId: 'southstar' }).outbox.list(), [])

  // Starting an already completed recording is a replay-safe no-op: no new
  // canonical change and no duplicate outbox rows.
  platform.startProcessing(alex, 'outbox-meeting', created.recordingId, 'outbox-replay')
  assert.equal(storage.scope({ tenantId: 'northstar' }).outbox.list().length, events.length)
  assert.throws(() => platform.addAssertions(alex, 'outbox-meeting', [{
    id: 'untrusted-action', kind: 'action', text: 'UNTRUSTED-OUTBOX-CANARY', citations: [`${created.recordingId}-segment-1`],
  }], 'untrusted-outbox'), { code: 'UNTRUSTED_ACTION_ASSERTION' })
  assert.equal(storage.scope({ tenantId: 'northstar' }).outbox.list().length, events.length)

  platform.deleteMeetingContent(alex, 'outbox-meeting', 'outbox-delete')
  const afterDelete = storage.scope({ tenantId: 'northstar' }).outbox.list()
  assert.equal(afterDelete.length, events.length + 1)
  const deletion = afterDelete.find((event) => event.type === 'meeting.content.deleted')
  assert.deepEqual(deletion.payload, { state: 'deleted' })
  assert.equal(JSON.stringify(deletion).includes(created.recordingId), false)
  // Outbox state-change notifications and the immutable audit trail are
  // separate sinks; the audit contains no synthetic outbox action.
  const audit = storage.scope({ tenantId: 'northstar' }).audit.forMeeting('outbox-meeting')
  assert.equal(audit.some((event) => String(event.action).startsWith('outbox.')), false)
})

test('canonical transcript and assertion outbox writes are replay-safe and roll back together on enqueue failure', () => {
  let failingEventType = null
  const storage = createInMemoryMeetingStorage({
    shouldFailOutboxEnqueue: (event) => event.type === failingEventType,
  })
  const platform = new MeetingIntelligencePlatform({ storage, policy: new PolicyEngine() })
  const alex = { tenantId: 'northstar', userId: 'alex' }
  const sam = { tenantId: 'northstar', userId: 'sam' }
  platform.createMeeting(alex, {
    id: 'atomic-ledger', tenantId: 'northstar', organizerId: 'alex',
    participantIds: ['alex', 'sam'], classification: 'standard',
  })
  for (const actor of [alex, sam]) {
    platform.recordConsent(actor, 'atomic-ledger', {
      participantId: actor.userId, decision: 'granted', policyVersion: 'v1',
      capturedAt: '2026-10-03T11:00:00Z', expiresAt: '2026-10-04T11:00:00Z',
    })
  }
  const authorization = platform.authorizeRecording(alex, 'atomic-ledger')
  const segment = {
    id: 'atomic-segment', speakerId: 'sam', startMs: 0, endMs: 500,
    text: 'Atomic evidence survives only with its event', provenance: {},
  }

  failingEventType = 'knowledge.changed'
  assert.throws(() => platform.appendTranscript(alex, 'atomic-ledger', authorization, [segment], 'atomic-transcript-failure'))
  assert.deepEqual(storage.scope({ tenantId: 'northstar' }).knowledge.forMeeting('atomic-ledger'), { segments: [], assertions: [] })
  assert.deepEqual(storage.scope({ tenantId: 'northstar' }).outbox.list(), [])
  assert.deepEqual(storage.scope({ tenantId: 'southstar' }).knowledge.forMeeting('atomic-ledger'), { segments: [], assertions: [] })
  assert.deepEqual(storage.scope({ tenantId: 'southstar' }).outbox.list(), [])

  failingEventType = null
  platform.appendTranscript(alex, 'atomic-ledger', authorization, [segment], 'atomic-transcript-success')
  const afterTranscript = storage.scope({ tenantId: 'northstar' }).outbox.list()
  assert.equal(afterTranscript.filter((event) => event.type === 'knowledge.changed').length, 1)
  platform.appendTranscript(alex, 'atomic-ledger', authorization, [segment], 'atomic-transcript-replay')
  assert.equal(storage.scope({ tenantId: 'northstar' }).knowledge.forMeeting('atomic-ledger').segments.length, 1)
  assert.equal(storage.scope({ tenantId: 'northstar' }).outbox.list().length, afterTranscript.length)

  const assertion = { id: 'atomic-decision', kind: 'decision', text: 'Atomic knowledge change', citations: ['atomic-segment'] }
  // Fail after knowledge.changed has been staged, proving a later outbox
  // failure rolls back canonical assertions, derived commitments, and the
  // first staged event together.
  failingEventType = 'commitments.changed'
  assert.throws(() => platform.addAssertions(alex, 'atomic-ledger', [assertion], 'atomic-assertion-failure'))
  assert.equal(storage.scope({ tenantId: 'northstar' }).knowledge.forMeeting('atomic-ledger').assertions.length, 0)
  assert.deepEqual(storage.scope({ tenantId: 'northstar' }).commitments.query(), [])
  assert.equal(storage.scope({ tenantId: 'northstar' }).outbox.list().length, afterTranscript.length)

  assert.throws(() => platform.addAssertions(alex, 'atomic-ledger', [{ ...assertion, id: 'untrusted-atomic-action', kind: 'action' }], 'atomic-untrusted'), { code: 'UNTRUSTED_ACTION_ASSERTION' })
  assert.equal(storage.scope({ tenantId: 'northstar' }).outbox.list().length, afterTranscript.length)

  failingEventType = null
  platform.addAssertions(alex, 'atomic-ledger', [assertion], 'atomic-assertion-success')
  const afterAssertion = storage.scope({ tenantId: 'northstar' }).outbox.list()
  assert.equal(storage.scope({ tenantId: 'northstar' }).knowledge.forMeeting('atomic-ledger').assertions.length, 1)
  assert.equal(afterAssertion.filter((event) => event.type === 'knowledge.changed').length, 2)
  assert.equal(afterAssertion.filter((event) => event.type === 'commitments.changed').length, 1)
  platform.addAssertions(alex, 'atomic-ledger', [assertion], 'atomic-assertion-replay')
  assert.equal(storage.scope({ tenantId: 'northstar' }).knowledge.forMeeting('atomic-ledger').assertions.length, 1)
  assert.equal(storage.scope({ tenantId: 'northstar' }).outbox.list().length, afterAssertion.length)
})
