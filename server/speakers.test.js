import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { FixedClock } from './adapters/in-memory.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { FakeSpeechProcessor } from './speech.js'
import { createInMemoryMeetingStorage } from './storage.js'

const tenantId = 'northstar'
const alex = { tenantId, userId: 'alex' }
const sam = { tenantId, userId: 'sam' }
const taylor = { tenantId, userId: 'taylor' }
const ceo = { tenantId, userId: 'ceo' }
const bytes = Buffer.from('deterministic audio fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')

// The fake processor labels its three lines SPEAKER_00, SPEAKER_01, SPEAKER_00
// and writes one action spoken by SPEAKER_01's line.
async function setup({ answerer = null } = {}) {
  const jobs = []
  const storage = createInMemoryMeetingStorage()
  const platform = new MeetingIntelligencePlatform({
    storage, clock: new FixedClock('2026-10-07T12:00:00Z'), schedule: (job) => jobs.push(job), chatAnswerer: answerer,
    policy: new PolicyEngine({ managementGrants: [{ tenantId, managerId: 'ceo', subordinateIds: ['alex'] }] }),
    speechProcessor: new FakeSpeechProcessor(), authorizationTtlMs: 60_000, maxRecordingBytes: 100,
  })
  await platform.createMeeting(alex, { id: 'm1', title: 'Launch review', tenantId, organizerId: 'alex', participantIds: ['alex', 'sam', 'taylor'], classification: 'standard' })
  for (const actor of [alex, sam, taylor]) await platform.recordConsent(actor, 'm1', { participantId: actor.userId, capturedAt: '2026-10-07T11:59:00Z', expiresAt: '2026-10-07T23:00:00Z', policyVersion: 'v1', decision: 'granted' })
  const record = async () => {
    const lease = await platform.authorizeRecording(alex, 'm1')
    const created = await platform.createRecording(alex, 'm1', { leaseId: lease.leaseId, contentType: 'audio/webm', byteLength: bytes.length, sha256 })
    await platform.uploadRecording(alex, 'm1', created.recordingId, { contentType: 'audio/webm', contentLength: bytes.length, bytes })
    await platform.startProcessing(alex, 'm1', created.recordingId)
    await jobs.at(-1)()
    return created.recordingId
  }
  return { platform, storage, record }
}
const labelsOf = (speakers) => Object.fromEntries(speakers.labels.map((item) => [item.label, item.participantId]))

test('the organizer names and corrects speakers; the change shows in the transcript and is versioned', async () => {
  const { platform, record } = await setup()
  const recordingId = await record()
  const before = await platform.getRecording(alex, 'm1', recordingId)
  assert.deepEqual(before.speakers.labels.map((item) => [item.label, item.lines, item.participantId]), [['SPEAKER_00', 2, null], ['SPEAKER_01', 1, null]])
  assert.equal(before.speakers.viewer.isOrganizer, true)

  let speakers = await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'sam', version: 0 })
  assert.deepEqual(labelsOf(speakers), { SPEAKER_00: null, SPEAKER_01: 'sam' })
  speakers = await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'taylor', version: 1 })
  assert.deepEqual(speakers.history.map((item) => [item.version, item.from, item.to, item.method]), [[2, 'sam', 'taylor', 'organizer'], [1, null, 'sam', 'organizer']])

  const after = await platform.getRecording(sam, 'm1', recordingId)
  assert.deepEqual(after.segments.map((segment) => segment.speaker?.participantId ?? null), [null, 'taylor', null])
  const action = after.assertions.find((item) => item.kind === 'action')
  assert.equal(action.commitment.ownerId ?? null, null, 'naming a speaker never assigns an owner')
  await assert.rejects(platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_00', { participantId: 'sam', version: 1 }), { code: 'SPEAKER_MAP_CHANGED' })
})

test('names are checked against the roster, the recording, and the label format', async () => {
  const { platform, record } = await setup()
  const recordingId = await record()
  await assert.rejects(platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_00', { participantId: 'mallory' }), { code: 'SPEAKER_NOT_PARTICIPANT' })
  await assert.rejects(platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_07', { participantId: 'sam' }), { code: 'SPEAKER_NOT_FOUND' })
  await assert.rejects(platform.setSpeaker(alex, 'm1', recordingId, 'UNATTRIBUTED', { participantId: 'sam' }), { code: 'SPEAKER_NOT_FOUND' })
  await assert.rejects(platform.setSpeaker(ceo, 'm1', recordingId, 'SPEAKER_00', { participantId: 'alex' }), { code: 'SPEAKER_CHANGE_FORBIDDEN' }, 'a management reader cannot name')
  await assert.rejects(platform.setSpeaker({ tenantId, userId: 'outsider' }, 'm1', recordingId, 'SPEAKER_00', { participantId: 'alex' }), { code: 'MEETING_FORBIDDEN' })
})

test('a participant may claim only an unnamed speaker, and only as themselves', async () => {
  const { platform, record } = await setup()
  const recordingId = await record()
  await assert.rejects(platform.setSpeaker(sam, 'm1', recordingId, 'SPEAKER_00', { participantId: 'taylor' }), { code: 'SPEAKER_CLAIM_FORBIDDEN' })
  const claimed = await platform.setSpeaker(sam, 'm1', recordingId, 'SPEAKER_00', { participantId: 'sam' })
  assert.equal(claimed.labels.find((item) => item.label === 'SPEAKER_00').method, 'self-claim')
  await assert.rejects(platform.setSpeaker(taylor, 'm1', recordingId, 'SPEAKER_00', { participantId: 'taylor' }), { code: 'SPEAKER_ALREADY_NAMED' })
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_00', { participantId: 'taylor' })
  assert.equal(labelsOf(await platform.getRecording(alex, 'm1', recordingId).then((result) => result.speakers)).SPEAKER_00, 'taylor', 'the organizer can correct a claim')
})

test('the named person can dispute a name, and the organizer cannot simply restore it', async () => {
  const { platform, record } = await setup()
  const recordingId = await record()
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'sam' })
  await assert.rejects(platform.removeSpeaker(taylor, 'm1', recordingId, 'SPEAKER_01'), { code: 'SPEAKER_CHANGE_FORBIDDEN' })
  const disputed = await platform.removeSpeaker(sam, 'm1', recordingId, 'SPEAKER_01')
  assert.deepEqual(disputed.labels.find((item) => item.label === 'SPEAKER_01').disputedBy, ['sam'])
  assert.equal(disputed.history[0].method, 'disputed')
  await assert.rejects(platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'sam' }), { code: 'SPEAKER_DISPUTED' })
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'taylor' })
  await platform.removeSpeaker(alex, 'm1', recordingId, 'SPEAKER_01')
  const reclaimed = await platform.setSpeaker(sam, 'm1', recordingId, 'SPEAKER_01', { participantId: 'sam' })
  assert.deepEqual(reclaimed.labels.find((item) => item.label === 'SPEAKER_01').disputedBy, [], 'their own claim clears their dispute')
  await assert.rejects(platform.removeSpeaker(alex, 'm1', recordingId, 'SPEAKER_00'), { code: 'SPEAKER_NOT_NAMED' })
  const actions = (await platform.audit.chain(tenantId)).filter((event) => event.action.startsWith('speaker.')).map((event) => [event.action, event.outcome])
  assert.ok(actions.some(([action]) => action === 'speaker.dispute'))
  assert.equal(JSON.stringify(await platform.audit.chain(tenantId)).includes('SPEAKER_01'), false, 'audit events carry no labels or names')
})

test('a name applies only to its own recording, and is dropped when the person leaves the meeting', async () => {
  const { platform, storage, record } = await setup()
  const first = await record()
  const second = await record()
  await platform.setSpeaker(alex, 'm1', first, 'SPEAKER_00', { participantId: 'sam' })
  assert.ok((await platform.getRecording(alex, 'm1', second)).segments.every((segment) => !segment.speaker), 'SPEAKER_00 of another recording stays anonymous')
  const knowledge = await platform.getMeetingKnowledge(alex, 'm1')
  assert.equal(knowledge.segments.filter((segment) => segment.speaker?.participantId === 'sam').length, 2)
  await storage.transaction({ tenantId }, async (transaction) => {
    const meeting = await transaction.meetings.get('m1')
    meeting.participantIds = ['alex', 'taylor']
    await transaction.meetings.save(meeting)
  })
  assert.ok((await platform.getMeetingKnowledge(alex, 'm1')).segments.every((segment) => !segment.speaker))
})

test('confirmed names reach the export and the chat provider; unconfirmed labels stay anonymous', async () => {
  const requests = []
  const answerer = { providerName: 'Test provider', answer: async (request) => { requests.push(request); const cited = request.excerpts.find((item) => item.speaker === 'sam (confirmed)') ?? request.excerpts[0]; return { answer: cited.text, answered: true, citations: [cited.label], model: 'test' } } }
  const { platform, record } = await setup({ answerer })
  const recordingId = await record()
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'sam' })
  const exported = (await platform.exportMeetingRecord(alex, 'm1')).body
  assert.match(exported, /sam \(confirmed\): A participant noted that security review must close/)
  assert.match(exported, /SPEAKER\\_00: The facilitator opened the review/, 'an unconfirmed label stays anonymous (Markdown-escaped)')
  const { turn } = await platform.askChat(alex, { question: 'What about security and the launch?' })
  const sentSpeakers = requests[0].excerpts.filter((item) => item.kind === 'transcript').map((item) => item.speaker)
  assert.ok(sentSpeakers.includes('sam (confirmed)'))
  assert.ok(sentSpeakers.includes('SPEAKER_00'))
  assert.ok(turn.sources.some((source) => source.speaker === 'sam'))
})
