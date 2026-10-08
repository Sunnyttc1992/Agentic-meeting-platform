import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { FixedClock } from './adapters/in-memory.js'
import { prepareMeetingPrompt } from './intelligence.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { FakeSpeechProcessor } from './speech.js'
import { createInMemoryMeetingStorage } from './storage.js'

const tenantId = 'northstar'
const alex = { tenantId, userId: 'alex' }
const sam = { tenantId, userId: 'sam' }
const bytes = Buffer.from('deterministic audio fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')

// A summarizer stand-in returning the normalized shape real adapters return.
function fakeSummarizer({ fail = false, reply = null } = {}) {
  const requests = []
  return {
    requests, providerName: 'Test provider', model: 'test-model-2',
    extract: async (request) => {
      requests.push(structuredClone(request))
      if (fail) throw new Error('provider down: secret details')
      return reply ?? {
        summary: { text: 'The launch moves to March after security sign-off.', citations: ['S2', 'S3'] },
        decisions: [{ text: 'Launch in March.', citations: ['S3'] }],
        risks: [{ text: 'Security review may slip.', citations: ['S2'] }],
        questions: [],
        actions: [{ text: 'Close the security review.', agreement: 'committed', ownerId: null, speakerLabel: 'SPEAKER_01', deadline: '2026-10-20', citations: ['S2'] }],
      }
    },
  }
}

async function setup({ summarizer = fakeSummarizer() } = {}) {
  const jobs = []
  const clock = new FixedClock('2026-10-07T12:00:00Z')
  const storage = createInMemoryMeetingStorage()
  const platform = new MeetingIntelligencePlatform({
    storage, clock, summarizer, schedule: (job) => jobs.push(job),
    policy: new PolicyEngine({ retentionPolicies: [{ tenantId, classification: '*', retainDays: 30 }] }),
    speechProcessor: new FakeSpeechProcessor(), authorizationTtlMs: 60_000, maxRecordingBytes: 100,
  })
  await platform.createMeeting(alex, { id: 'm1', title: 'Launch review', tenantId, organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard' })
  for (const actor of [alex, sam]) await platform.recordConsent(actor, 'm1', { participantId: actor.userId, capturedAt: '2026-10-07T11:59:00Z', expiresAt: '2026-10-07T15:00:00Z', policyVersion: 'v1', decision: 'granted' })
  const lease = await platform.authorizeRecording(alex, 'm1')
  const created = await platform.createRecording(alex, 'm1', { leaseId: lease.leaseId, contentType: 'audio/webm', byteLength: bytes.length, sha256 })
  await platform.uploadRecording(alex, 'm1', created.recordingId, { contentType: 'audio/webm', contentLength: bytes.length, bytes })
  await platform.startProcessing(alex, 'm1', created.recordingId)
  await jobs.at(-1)()
  return { platform, storage, clock, summarizer, recordingId: created.recordingId }
}

test('the organizer rewrites a summary: confirmed names reach the summarizer, items are revalidated and versioned, the transcript is untouched', async () => {
  const { platform, summarizer, recordingId } = await setup()
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'sam' })
  const before = await platform.getRecording(alex, 'm1', recordingId)
  assert.equal(before.summaryVersions.current, 1)
  assert.equal(before.summaryVersions.canRegenerate, true)

  const { version } = await platform.regenerateSummary(alex, 'm1', recordingId)
  assert.equal(version, 2)
  const prompt = prepareMeetingPrompt(summarizer.requests[0]).userContent
  assert.match(prompt, /\[S2 [^\]]*SPEAKER_01, confirmed as sam\]/)
  assert.match(prompt, /\[S1 [^\]]*SPEAKER_00\]/)

  const after = await platform.getRecording(sam, 'm1', recordingId)
  assert.deepEqual(after.segments.map((segment) => [segment.id, segment.text]), before.segments.map((segment) => [segment.id, segment.text]), 'the transcript is unchanged')
  assert.ok(after.assertions.every((item) => item.id.startsWith(`${recordingId}-v2-assertion-`)))
  assert.deepEqual(after.assertions.map((item) => item.kind), ['summary', 'decision', 'risk', 'action'])
  const action = after.assertions.find((item) => item.kind === 'action')
  assert.equal(action.commitment.ownerId, null, 'a confirmed speaker is not made the owner')
  assert.equal(action.commitment.speaker.participantId, 'sam')
  assert.equal(after.summaryVersions.current, 2)
  assert.equal(after.summaryVersions.history[0].version, 1)
  assert.deepEqual(after.summaryVersions.history[0].items.map((item) => item.text), before.assertions.map((item) => item.text))
  assert.deepEqual((await platform.queryCommitments(sam, '')).commitments.map((item) => item.text), ['Close the security review.'], 'the commitment registry follows the new version')
})

test('only the organizer can regenerate, and only with a configured summarizer', async () => {
  const { platform, recordingId } = await setup()
  await assert.rejects(platform.regenerateSummary(sam, 'm1', recordingId), { code: 'RECORDING_FORBIDDEN' })
  const bare = await setup({ summarizer: null })
  await assert.rejects(bare.platform.regenerateSummary(alex, 'm1', bare.recordingId), { code: 'SUMMARY_NOT_CONFIGURED' })
  assert.equal((await bare.platform.getRecording(alex, 'm1', bare.recordingId)).summaryVersions.canRegenerate, false)
})

test('an expired consent window does not block regeneration, but a withdrawal or legal hold does', async () => {
  const { platform, storage, clock, recordingId } = await setup()
  clock.advance(24 * 60 * 60 * 1000)
  assert.equal((await platform.regenerateSummary(alex, 'm1', recordingId)).version, 2, 'consent expired after processing; nothing new is captured')
  await platform.recordConsent(sam, 'm1', { participantId: 'sam', capturedAt: clock.now().toISOString(), expiresAt: '2026-10-09T00:00:00Z', policyVersion: 'v1', decision: 'withdrawn' })
  await assert.rejects(platform.regenerateSummary(alex, 'm1', recordingId), { code: 'CONSENT_NOT_GRANTED' })
  await platform.recordConsent(sam, 'm1', { participantId: 'sam', capturedAt: clock.now().toISOString(), expiresAt: '2026-10-09T00:00:00Z', policyVersion: 'v1', decision: 'granted' })
  await storage.transaction({ tenantId }, async (transaction) => {
    const meeting = await transaction.meetings.get('m1')
    meeting.retentionState = 'held'
    await transaction.meetings.save(meeting)
  })
  await assert.rejects(platform.regenerateSummary(alex, 'm1', recordingId), (error) => ['RETENTION_RESTRICTED', 'MEETING_FORBIDDEN'].includes(error.code))
})

test('a failed rewrite changes nothing and is audited as a denial without detail', async () => {
  const { platform, recordingId } = await setup({ summarizer: fakeSummarizer({ fail: true }) })
  const before = await platform.getRecording(alex, 'm1', recordingId)
  await assert.rejects(platform.regenerateSummary(alex, 'm1', recordingId), (error) => error.code === 'SUMMARY_FAILED' && !/secret/.test(error.message))
  const after = await platform.getRecording(alex, 'm1', recordingId)
  assert.deepEqual(after.assertions, before.assertions)
  assert.equal(after.summaryVersions.current, 1)
  const denied = (await platform.audit.chain(tenantId)).filter((event) => event.action === 'recording.summary.regenerate')
  assert.deepEqual(denied.map((event) => [event.outcome, event.reason]), [['denied', 'SUMMARY_FAILED']])
})

test('rewritten items citing transcript lines that do not exist are withheld, as on first processing', async () => {
  const reply = { summary: { text: 'Made-up summary.', citations: ['S99'] }, decisions: [{ text: 'Launch in March.', citations: ['S3'] }], risks: [], questions: [], actions: [] }
  const { platform, recordingId } = await setup({ summarizer: fakeSummarizer({ reply }) })
  await platform.regenerateSummary(alex, 'm1', recordingId)
  const after = await platform.getRecording(alex, 'm1', recordingId)
  assert.deepEqual(after.assertions.map((item) => item.text), ['Launch in March.'])
  assert.equal(after.recording.withheldAssertions, 1)
})

test('deleting the meeting wipes earlier summary versions and speaker names from the recording', async () => {
  const { platform, storage, recordingId } = await setup()
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_00', { participantId: 'alex' })
  await platform.regenerateSummary(alex, 'm1', recordingId)
  await platform.deleteMeetingContent(alex, 'm1')
  const tombstone = await storage.scope({ tenantId }).recordings.get(recordingId)
  assert.equal(tombstone.state, 'deleted')
  assert.deepEqual(tombstone.summaryHistory, [])
  assert.equal(tombstone.speakerMap, undefined)
})

test('an owner is kept only when the cited lines name that participant, never because they spoke', async () => {
  const reply = {
    summary: null, decisions: [], risks: [], questions: [],
    actions: [
      { text: 'Close the security review.', agreement: 'committed', ownerId: 'sam', speakerLabel: 'SPEAKER_01', deadline: null, citations: ['S2'] },
      { text: 'Keep the rollout gated.', agreement: 'committed', ownerId: 'alex', speakerLabel: 'SPEAKER_00', deadline: null, citations: ['S3'] },
    ],
  }
  const { platform, storage, recordingId } = await setup({ summarizer: fakeSummarizer({ reply }) })
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_01', { participantId: 'sam' })
  await platform.setSpeaker(alex, 'm1', recordingId, 'SPEAKER_00', { participantId: 'alex' })
  // Name sam in the line the first action cites, so only that owner survives.
  await storage.transaction({ tenantId }, async (transaction) => {
    const knowledge = await transaction.knowledge.forMeeting('m1')
    const segments = knowledge.segments.map((segment) => (segment.id.endsWith('-segment-2') ? { ...segment, text: 'Sam, please close the security review before January.' } : segment))
    await transaction.knowledge.clearMeeting('m1')
    await transaction.knowledge.addSegments(segments)
    await transaction.knowledge.addAssertions(knowledge.assertions)
  })
  await platform.regenerateSummary(alex, 'm1', recordingId)
  const owners = (await platform.getRecording(alex, 'm1', recordingId)).assertions.filter((item) => item.kind === 'action').map((item) => [item.text, item.commitment.ownerId ?? null, item.commitment.speaker?.participantId ?? null])
  assert.deepEqual(owners, [['Close the security review.', 'sam', 'sam'], ['Keep the rollout gated.', null, 'alex']])
})

