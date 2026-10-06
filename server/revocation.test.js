import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  FixedClock,
  InMemoryAppendOnlyAudit,
  InMemoryKnowledgeRepository,
  InMemoryMeetingRepository,
  InMemoryRecordingRepository,
} from './adapters/in-memory.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { FakeSpeechProcessor } from './speech.js'

// AUTH-03 / AUTH-06. The documented revocation SLA is zero: no read path
// caches an authorization decision, so a revoked grant, an expired grant, or a
// removed participant is denied on the very next call. These tests revoke in
// every way the current model allows and then sweep every read surface.
const tenantId = 'northstar'
const alex = { tenantId, userId: 'alex' }
const sam = { tenantId, userId: 'sam' }
const ceo = { tenantId, userId: 'ceo' }
const bytes = Buffer.from('deterministic audio fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const QUERY = 'security'

async function setup() {
  const meetings = new InMemoryMeetingRepository()
  const recordings = new InMemoryRecordingRepository()
  const clock = new FixedClock('2026-10-01T12:00:00Z')
  const jobs = []
  const grant = { tenantId, managerId: 'ceo', subordinateIds: ['alex'], expiresAt: '2026-10-01T18:00:00Z' }
  const policy = new PolicyEngine({ managementGrants: [grant] })
  const platform = new MeetingIntelligencePlatform({
    meetings, knowledge: new InMemoryKnowledgeRepository(), recordings, audit: new InMemoryAppendOnlyAudit(), clock, policy,
    speechProcessor: new FakeSpeechProcessor(), authorizationTtlMs: 60_000, maxRecordingBytes: 100, schedule: (job) => jobs.push(job),
  })
  const recordingIds = {}
  for (const [id, participantIds] of [['meeting-a', ['alex', 'sam']], ['meeting-b', ['alex']]]) {
    await platform.createMeeting(alex, { id, title: id, tenantId, organizerId: 'alex', participantIds, classification: 'standard' })
    for (const userId of participantIds) {
      await platform.recordConsent({ tenantId, userId }, id, { participantId: userId, capturedAt: '2026-10-01T11:59:00Z', expiresAt: '2026-10-01T23:00:00Z', policyVersion: 'v1', decision: 'granted' })
    }
    const lease = await platform.authorizeRecording(alex, id)
    const created = await platform.createRecording(alex, id, { leaseId: lease.leaseId, contentType: 'audio/webm', byteLength: bytes.length, sha256 })
    await platform.uploadRecording(alex, id, created.recordingId, { contentType: 'audio/webm', contentLength: bytes.length, bytes })
    await platform.startProcessing(alex, id, created.recordingId)
    await jobs.at(-1)()
    recordingIds[id] = created.recordingId
  }
  return { platform, meetings, clock, policy, grant, recordingIds }
}

// Every read surface, reduced to "what did this principal get for meeting-a".
async function exposure(platform, actor, recordingId) {
  const settle = async (work) => { try { return { ok: true, value: await work() } } catch (error) { return { ok: false, code: error.code } } }
  const knowledge = await settle(() => platform.getMeetingKnowledge(actor, 'meeting-a'))
  const recording = await settle(() => platform.getRecording(actor, 'meeting-a', recordingId))
  const recordingList = await settle(() => platform.listRecordings(actor, 'meeting-a'))
  const exported = await settle(() => platform.exportMeetingRecord(actor, 'meeting-a'))
  const privacy = await settle(() => platform.getMeetingPrivacyAccess(actor, 'meeting-a'))
  const search = await platform.searchKnowledge(actor, QUERY)
  const retrieved = await platform.retrieveMeetingContext(actor, { query: QUERY })
  const commitments = await platform.queryCommitments(actor, '')
  const briefing = await platform.getManagementBriefing(actor)
  const listed = await platform.listMeetings(actor)
  const mentions = (value) => JSON.stringify(value).includes('meeting-a')
  return {
    knowledge: knowledge.ok, recording: recording.ok, recordingList: recordingList.ok, export: exported.ok, privacy: privacy.ok,
    search: mentions(search), retrieval: retrieved.sources.some((source) => source.meetingId === 'meeting-a'),
    commitments: commitments.commitments.some((item) => item.meetingId === 'meeting-a'),
    briefing: mentions(briefing), list: listed.some((item) => item.id === 'meeting-a'),
  }
}

const NOTHING = { knowledge: false, recording: false, recordingList: false, export: false, privacy: false, search: false, retrieval: false, commitments: false, briefing: false, list: false }

test('a management grant that expires is denied on the very next read of every surface', async () => {
  const { platform, clock, recordingIds } = await setup()
  const before = await exposure(platform, ceo, recordingIds['meeting-a'])
  assert.deepEqual(before, { ...NOTHING, knowledge: true, recording: true, recordingList: true, privacy: true, search: true, retrieval: true, commitments: true, briefing: true }, 'a grant reads but never exports or lists')
  clock.advance(6 * 60 * 60 * 1000)
  assert.deepEqual(await exposure(platform, ceo, recordingIds['meeting-a']), NOTHING)
})

test('a management grant withdrawn from policy is denied immediately, with no cached decision', async () => {
  const { platform, policy, grant, recordingIds } = await setup()
  assert.equal((await exposure(platform, ceo, recordingIds['meeting-a'])).knowledge, true)
  policy.managementGrants.splice(policy.managementGrants.indexOf(grant), 1)
  assert.deepEqual(await exposure(platform, ceo, recordingIds['meeting-a']), NOTHING)
})

test('a hierarchy change that moves the organizer out of the grant is denied immediately', async () => {
  const { platform, grant, recordingIds } = await setup()
  grant.subordinateIds = ['someone-else']
  assert.deepEqual(await exposure(platform, ceo, recordingIds['meeting-a']), NOTHING)
})

test('a participant removed from the meeting loses every read path, including export and capture status', async () => {
  const { platform, meetings, recordingIds } = await setup()
  assert.equal((await exposure(platform, sam, recordingIds['meeting-a'])).export, true)
  const meeting = meetings.get(tenantId, 'meeting-a')
  meeting.participantIds = ['alex']
  meetings.save(meeting)
  assert.deepEqual(await exposure(platform, sam, recordingIds['meeting-a']), NOTHING)
  await assert.rejects(platform.getRecordingAuthorizationStatus(sam, 'meeting-a'), { code: 'MEETING_NOT_FOUND' })
})

test('revocation midway through a multi-meeting retrieval applies to every meeting not yet read', async () => {
  // The grant covers both meetings, and each holds one canonical action.
  const { platform, policy } = await setup()
  assert.equal((await platform.queryCommitments(ceo, '')).commitments.length, 2)
  const original = platform.policy.meetingAccess.bind(platform.policy)
  let checks = 0
  platform.policy.meetingAccess = (input) => {
    const decision = original(input)
    // Revoke right after the first meeting is authorized, before its content
    // is fetched and before any later meeting is considered.
    if (++checks === 1) policy.managementGrants.length = 0
    return decision
  }
  const commitments = await platform.queryCommitments(ceo, '')
  // The linearization point is the authorization decision: the one source
  // authorized before revocation is returned, and nothing after it.
  assert.equal(commitments.commitments.length, 1)
  assert.equal(checks, 2, 'the later meeting was re-authorized rather than reusing the first decision')
  platform.policy.meetingAccess = original
  assert.deepEqual((await platform.queryCommitments(ceo, '')).commitments, [])
})

test('a recording ID from another meeting looks nonexistent, even to a participant of the meeting in the path', async () => {
  const { platform, recordingIds } = await setup()
  // sam is a participant of meeting-a only; meeting-b's recording must not be
  // reachable by putting its ID under meeting-a's path.
  await assert.rejects(platform.getRecording(sam, 'meeting-a', recordingIds['meeting-b']), { code: 'RECORDING_NOT_FOUND' })
  await assert.rejects(platform.retryProcessing(sam, 'meeting-a', recordingIds['meeting-b']), { code: 'RECORDING_NOT_FOUND' })
  await assert.rejects(platform.getRecording(sam, 'meeting-b', recordingIds['meeting-b']), { code: 'MEETING_FORBIDDEN' })
  await assert.rejects(platform.getRecording({ tenantId: 'other-tenant', userId: 'sam' }, 'meeting-a', recordingIds['meeting-a']), (error) => ['MEETING_NOT_FOUND', 'RECORDING_NOT_FOUND'].includes(error.code))
})

test('citations returned to an authorized reader never point into a meeting they cannot read', async () => {
  const { platform } = await setup()
  const knowledgeB = await platform.getMeetingKnowledge(alex, 'meeting-b')
  const hidden = new Set([...knowledgeB.segments.map((item) => item.id), ...knowledgeB.assertions.map((item) => item.id)])
  const surfaces = [
    await platform.getMeetingKnowledge(sam, 'meeting-a'),
    await platform.retrieveMeetingContext(sam, { query: QUERY }),
    await platform.queryCommitments(sam, ''),
    await platform.searchKnowledge(sam, QUERY),
  ]
  const serialized = JSON.stringify(surfaces)
  for (const id of hidden) assert.equal(serialized.includes(id), false, `${id} must not reach sam`)
  assert.equal(serialized.includes('meeting-b'), false)
})

test('a regenerated summary is published only through the authorized recording owner path', async () => {
  const { platform, recordingIds } = await setup()
  // A participant who is not the organizer cannot trigger reprocessing, and a
  // management-grant reader cannot either; regenerating is never a read path.
  for (const actor of [sam, ceo]) {
    await assert.rejects(platform.retryProcessing(actor, 'meeting-a', recordingIds['meeting-a']), { code: 'RECORDING_FORBIDDEN' })
    await assert.rejects(platform.startProcessing(actor, 'meeting-a', recordingIds['meeting-a']), { code: 'RECORDING_FORBIDDEN' })
  }
})
