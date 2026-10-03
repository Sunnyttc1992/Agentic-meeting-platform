import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { FixedClock, InMemoryAppendOnlyAudit, InMemoryKnowledgeRepository, InMemoryMeetingRepository, InMemoryRecordingRepository } from './adapters/in-memory.js'
import { ClaudeMeetingIntelligence } from './intelligence.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { LocalMeetingProcessor } from './speech.js'
import { encodeWavPcm16 } from '../src/audioTranscode.js'
import { SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'

const DAY = 24 * 60 * 60 * 1000
const alex = { tenantId: 'northstar', userId: 'alex' }
const sam = { tenantId: 'northstar', userId: 'sam' }
const REPLY = {
  summary: { text: 'Rollout stays phased.', citations: ['S1'] },
  decisions: [], risks: [], open_questions: [],
  action_plan: [{ action: 'Send the findings.', owner_participant_id: 'sam', due_date: '2026-10-20', citations: ['S1'] }],
}

function setup({ retentionPolicies = [{ tenantId: 'northstar', classification: '*', retainDays: 30 }] } = {}) {
  const meetings = new InMemoryMeetingRepository()
  const knowledge = new InMemoryKnowledgeRepository()
  const recordings = new InMemoryRecordingRepository()
  const audit = new InMemoryAppendOnlyAudit()
  const clock = new FixedClock('2026-10-03T12:00:00Z')
  const jobs = []
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(REPLY) }] }) } } }
  const policy = new PolicyEngine({ retentionPolicies })
  const platform = new MeetingIntelligencePlatform({
    meetings, knowledge, recordings, audit, policy, clock,
    speechProcessor: new LocalMeetingProcessor({ transcriber: { transcribe: async () => [{ startMs: 0, endMs: 3000, text: 'Rollout stays phased; Sam sends the findings.' }] }, intelligence: new ClaudeMeetingIntelligence({ client }) }),
    acceptedMimeTypes: [SPEECH_WAV_MIME_TYPE], schedule: (job) => jobs.push(job),
  })
  const createMeeting = (id, { tenantId = 'northstar', classification = 'standard' } = {}) => {
    const organizer = { tenantId, userId: 'alex' }
    platform.createMeeting(organizer, { id, tenantId, organizerId: 'alex', participantIds: ['alex', 'sam'], classification, consentPolicyVersion: 'v1' })
  }
  // Consent is granted at the moment of recording, relative to the test clock.
  const grantConsent = (id, tenantId) => {
    const now = clock.now().getTime()
    for (const userId of ['alex', 'sam']) platform.recordConsent({ tenantId, userId }, id, { participantId: userId, capturedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(), policyVersion: 'v1', decision: 'granted', method: 'explicit' })
  }
  const recordAndProcess = async (id, tenantId = 'northstar') => {
    const organizer = { tenantId, userId: 'alex' }
    grantConsent(id, tenantId)
    const bytes = Buffer.from(encodeWavPcm16(new Float32Array(16000)))
    const lease = platform.authorizeRecording(organizer, id)
    const created = platform.createRecording(organizer, id, { leaseId: lease.leaseId, contentType: SPEECH_WAV_MIME_TYPE, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    platform.uploadRecording(organizer, id, created.recordingId, { contentType: SPEECH_WAV_MIME_TYPE, contentLength: bytes.length, bytes })
    platform.startProcessing(organizer, id, created.recordingId)
    await jobs.shift()()
    return created.recordingId
  }
  return { platform, meetings, knowledge, recordings, audit, clock, policy, createMeeting, recordAndProcess }
}

test('content becomes unreadable at the exact retention boundary, before any sweep runs', async () => {
  const state = setup()
  state.createMeeting('meeting-1')
  await state.recordAndProcess('meeting-1')
  assert.equal(state.meetings.get('northstar', 'meeting-1').contentStartedAt, '2026-10-03T12:00:00.000Z')

  state.clock.advance(30 * DAY - 1)
  assert.ok(state.platform.getMeetingKnowledge(sam, 'meeting-1').segments.length > 0, 'one millisecond before expiry it is still readable')
  state.clock.advance(1)
  for (const read of [
    () => state.platform.getMeetingKnowledge(sam, 'meeting-1'),
    () => state.platform.exportMeetingRecord(sam, 'meeting-1'),
    () => state.platform.authorizeRecording(alex, 'meeting-1'),
  ]) assert.throws(read, { code: 'RETENTION_EXPIRED' })
  assert.deepEqual(state.platform.retrieveForAi(sam, 'Rollout'), [], 'expired content never reaches AI retrieval')
})

test('the sweep deletes expired content everywhere, is audited under the service identity, and is idempotent', async () => {
  const state = setup()
  state.createMeeting('meeting-1')
  const recordingId = await state.recordAndProcess('meeting-1')
  state.createMeeting('meeting-fresh')
  state.clock.advance(10 * DAY)
  await state.recordAndProcess('meeting-fresh')
  assert.deepEqual(state.platform.enforceRetention('northstar', 'corr-early'), { expired: 0, held: 0 })

  state.clock.advance(20 * DAY)
  assert.deepEqual(state.platform.enforceRetention('northstar', 'corr-sweep'), { expired: 1, held: 0 })
  assert.equal(state.meetings.get('northstar', 'meeting-1').retentionState, 'deleted')
  assert.equal(state.recordings.getBytes(recordingId), null, 'audio is gone')
  assert.deepEqual(state.knowledge.forMeeting('northstar', 'meeting-1'), { segments: [], assertions: [] })
  assert.ok(state.platform.queryCommitments(sam, '').commitments.every((item) => item.meetingId !== 'meeting-1'), 'derived commitments are gone')
  assert.ok(state.platform.getMeetingKnowledge(sam, 'meeting-fresh').segments.length > 0, 'unexpired meetings are untouched')

  const expiry = state.audit.all().filter((event) => event.action === 'retention.expire')
  assert.deepEqual(expiry.map((event) => [event.principalId, event.meetingId, event.outcome, event.correlationId]), [['service:retention', 'meeting-1', 'allowed', 'corr-sweep']])
  assert.deepEqual(state.platform.enforceRetention('northstar'), { expired: 0, held: 0 }, 're-running deletes nothing twice')
  assert.equal(state.audit.all().filter((event) => event.action === 'retention.expire').length, 1)
})

test('legal hold blocks retention deletion while still blocking ordinary reads', async () => {
  const state = setup()
  state.createMeeting('meeting-1')
  const recordingId = await state.recordAndProcess('meeting-1')
  const held = state.meetings.get('northstar', 'meeting-1')
  held.retentionState = 'held'
  state.meetings.save(held)
  state.clock.advance(31 * DAY)
  assert.deepEqual(state.platform.enforceRetention('northstar'), { expired: 0, held: 1 })
  assert.ok(state.recordings.getBytes(recordingId), 'held audio is preserved')
  assert.throws(() => state.platform.getMeetingKnowledge(sam, 'meeting-1'), { code: 'RETENTION_RESTRICTED' })
})

test('retention is per tenant and classification, and a shortened rule applies to existing content immediately', async () => {
  const rules = [
    { tenantId: 'northstar', classification: '*', retainDays: 30 },
    { tenantId: 'northstar', classification: 'board', retainDays: 365 },
  ]
  const state = setup({ retentionPolicies: rules })
  state.createMeeting('meeting-1')
  state.createMeeting('board-1', { classification: 'board' })
  state.createMeeting('south-1', { tenantId: 'southstar' })
  const knownBoard = new PolicyEngine({ retentionPolicies: rules, knownClassifications: ['standard', 'board'] })
  state.platform.policy = knownBoard
  await state.recordAndProcess('meeting-1')
  await state.recordAndProcess('board-1')
  await state.recordAndProcess('south-1', 'southstar')

  state.clock.advance(31 * DAY)
  assert.deepEqual(state.platform.enforceRetention('northstar'), { expired: 1, held: 0 }, 'the board rule keeps board meetings longer')
  assert.equal(state.meetings.get('northstar', 'board-1').retentionState, 'active')
  assert.deepEqual(state.platform.enforceRetention('southstar'), { expired: 0, held: 0 }, 'a tenant without rules keeps its content')
  assert.equal(state.meetings.get('southstar', 'south-1').retentionState, 'active')

  state.platform.policy = new PolicyEngine({ retentionPolicies: [{ tenantId: 'northstar', classification: 'board', retainDays: 7 }], knownClassifications: ['standard', 'board'] })
  assert.throws(() => state.platform.getMeetingKnowledge(sam, 'board-1'), { code: 'RETENTION_EXPIRED' }, 'a shortened rule takes effect at once')
  assert.deepEqual(state.platform.enforceRetention('northstar'), { expired: 1, held: 0 })
})

test('malformed retention rules are rejected at startup rather than silently ignored', () => {
  for (const rule of [
    { tenantId: 'northstar', classification: '*', retainDays: 0 },
    { tenantId: 'northstar', classification: '*', retainDays: 1.5 },
    { tenantId: 'northstar', classification: '*', retainDays: '30' },
    { tenantId: '', classification: '*', retainDays: 30 },
    { tenantId: 'northstar', retainDays: 30 },
  ]) assert.throws(() => new PolicyEngine({ retentionPolicies: [rule] }), { code: 'INVALID_RETENTION_POLICY' })
  assert.equal(new PolicyEngine().retentionExpiresAt({ tenantId: 'northstar', classification: 'standard', contentStartedAt: '2026-10-03T12:00:00Z' }), null, 'no rule means no automatic expiry')
})
