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
import { createHttpServer } from './http.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { FakeSpeechProcessor } from './speech.js'

// PRIV-02 / CAP-02: any participant can stop capture at a recorded boundary,
// and nothing captured under the stopped authorization can be published.
const alex = { tenantId: 'northstar', userId: 'alex' }
const sam = { tenantId: 'northstar', userId: 'sam' }
const outsider = { tenantId: 'northstar', userId: 'mallory' }
const bytes = Buffer.from('deterministic audio fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const contentType = 'audio/webm'

async function setup() {
  const meetings = new InMemoryMeetingRepository()
  const recordings = new InMemoryRecordingRepository()
  const knowledge = new InMemoryKnowledgeRepository()
  const audit = new InMemoryAppendOnlyAudit()
  const clock = new FixedClock('2026-10-01T12:00:00Z')
  const jobs = []
  const platform = new MeetingIntelligencePlatform({
    meetings, knowledge, recordings, audit, clock,
    policy: new PolicyEngine({ knownClassifications: ['standard'] }),
    speechProcessor: new FakeSpeechProcessor(),
    authorizationTtlMs: 60_000,
    maxRecordingBytes: 100,
    schedule: (job) => jobs.push(job),
  })
  await platform.createMeeting(alex, { id: 'meeting-1', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard' })
  for (const actor of [alex, sam]) {
    await platform.recordConsent(actor, 'meeting-1', { participantId: actor.userId, capturedAt: '2026-10-01T11:59:00Z', expiresAt: '2026-10-01T13:00:00Z', policyVersion: 'v1', decision: 'granted' })
  }
  return { platform, meetings, recordings, knowledge, audit, clock, jobs }
}

test('a participant stops capture for a sensitive topic: the boundary is recorded and the capture can never be uploaded', async () => {
  const { platform, meetings, audit, clock } = await setup()
  const lease = await platform.authorizeRecording(alex, 'meeting-1')
  clock.advance?.(30_000)

  const stopped = await platform.stopCapture(sam, 'meeting-1', { reason: 'sensitive-topic' }, 'corr-stop')
  assert.equal(stopped.reason, 'sensitive-topic')
  assert.equal(stopped.authorizationRevoked, true)
  assert.equal(stopped.quarantinedRecordings, 0)

  const record = meetings.get('northstar', 'meeting-1')
  assert.equal(record.recording.status, 'revoked')
  assert.equal(record.recording.revocationReason, 'SENSITIVE_TOPIC_STOP')
  assert.deepEqual(record.captureStops, [{ at: stopped.stoppedAt, reason: 'SENSITIVE_TOPIC_STOP', authorizationRevoked: true }])

  await assert.rejects(
    platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType, byteLength: bytes.length, sha256 }),
    { code: 'RECORDING_LEASE_REVOKED' },
    'audio captured before the stop cannot be uploaded under the revoked authorization',
  )
  const event = audit.all().find((item) => item.correlationId === 'corr-stop')
  assert.deepEqual([event.action, event.outcome, event.reason, event.principalId], ['recording.stop', 'allowed', 'SENSITIVE_TOPIC_STOP', 'sam'])

  const fresh = await platform.authorizeRecording(alex, 'meeting-1')
  assert.notEqual(fresh.leaseId, lease.leaseId, 'capture can resume only through a new preflight')
})

test('a stop after upload quarantines that recording, deletes its audio, and its queued job publishes nothing', async () => {
  const { platform, recordings, knowledge, jobs } = await setup()
  const lease = await platform.authorizeRecording(alex, 'meeting-1')
  const created = await platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType, byteLength: bytes.length, sha256 })
  await platform.uploadRecording(alex, 'meeting-1', created.recordingId, { contentType, contentLength: bytes.length, bytes })
  await platform.startProcessing(alex, 'meeting-1', created.recordingId)

  const stopped = await platform.stopCapture(sam, 'meeting-1', { reason: 'participant-request' })
  assert.equal(stopped.quarantinedRecordings, 1)
  await jobs.shift()()

  const recording = recordings.get(created.recordingId)
  assert.equal(recording.state, 'quarantined')
  assert.equal(recording.dispositionReason, 'PARTICIPANT_STOP_REQUEST')
  assert.equal(recordings.getBytes(created.recordingId), null, 'the stopped audio is deleted')
  assert.deepEqual(knowledge.forMeeting('northstar', 'meeting-1'), { segments: [], assertions: [] }, 'nothing from the stopped capture is published')
})

test('under legal hold a stopped recording is quarantined but its audio is preserved', async () => {
  const { platform, meetings, recordings, jobs } = await setup()
  const lease = await platform.authorizeRecording(alex, 'meeting-1')
  const created = await platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType, byteLength: bytes.length, sha256 })
  await platform.uploadRecording(alex, 'meeting-1', created.recordingId, { contentType, contentLength: bytes.length, bytes })
  const held = meetings.get('northstar', 'meeting-1')
  held.retentionState = 'held'
  meetings.save(held)

  await platform.stopCapture(sam, 'meeting-1', { reason: 'sensitive-topic' })
  assert.equal(recordings.get(created.recordingId).state, 'quarantined')
  assert.deepEqual(recordings.getBytes(created.recordingId), bytes, 'a legal hold blocks destruction')
  assert.equal(jobs.length, 0)
})

test('consent withdrawal during capture records a CONSENT_WITHDRAWN boundary and revokes the authorization', async () => {
  const { platform, meetings } = await setup()
  const lease = await platform.authorizeRecording(alex, 'meeting-1')
  await platform.recordConsent(sam, 'meeting-1', { participantId: 'sam', capturedAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-01T13:00:00Z', policyVersion: 'v1', decision: 'withdrawn' })

  const record = meetings.get('northstar', 'meeting-1')
  assert.equal(record.recording.leaseId, lease.leaseId)
  assert.equal(record.recording.status, 'revoked')
  assert.deepEqual(record.captureStops.map((stop) => [stop.reason, stop.authorizationRevoked]), [['CONSENT_WITHDRAWN', true]])
})

test('outsiders cannot stop capture or learn the meeting exists, and only the two stop reasons are accepted', async () => {
  const { platform, meetings, audit } = await setup()
  await platform.authorizeRecording(alex, 'meeting-1')
  await assert.rejects(platform.stopCapture(outsider, 'meeting-1', { reason: 'sensitive-topic' }, 'corr-outsider'), { code: 'MEETING_NOT_FOUND', status: 404 })
  await assert.rejects(platform.stopCapture(sam, 'meeting-1', { reason: 'because I said so' }), { code: 'INVALID_STOP_REASON' })
  assert.equal(meetings.get('northstar', 'meeting-1').recording.status, 'authorized', 'denied stops change nothing')
  const denied = audit.all().find((item) => item.correlationId === 'corr-outsider')
  assert.deepEqual([denied.action, denied.outcome, denied.reason], ['recording.stop', 'denied', 'MEETING_NOT_FOUND'])
})

test('the stop route accepts only a strict reason body', async () => {
  const { platform } = await setup()
  const server = createHttpServer(platform)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body) => fetch(`${base}/meetings/meeting-1/recording/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': 'northstar', 'x-user-id': 'sam', 'x-correlation-id': 'corr-http-stop' },
    body: JSON.stringify(body),
  })
  try {
    assert.equal((await post({ reason: 'sensitive-topic', note: 'extra' })).status, 400)
    const response = await post({ reason: 'sensitive-topic' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.authorizationRevoked, false, 'no capture was authorized, so only the boundary is recorded')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
