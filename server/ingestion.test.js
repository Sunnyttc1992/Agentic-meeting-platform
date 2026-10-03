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

const alex = { tenantId: 'northstar', userId: 'alex' }
const sam = { tenantId: 'northstar', userId: 'sam' }
const bytes = Buffer.from('deterministic audio fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')

test('ingestion accepts normalized browser audio formats and rejects unknown MIME without consuming the lease', async () => {
  for (const contentType of ['audio/webm;codecs=opus', 'audio/ogg;codecs="opus"', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']) {
    const { platform, recordings } = (await setup())
    const lease = (await platform.authorizeRecording(alex, 'meeting-1'))
    const created = (await platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType, byteLength: bytes.length, sha256 }))
    await platform.uploadRecording(alex, 'meeting-1', created.recordingId, { contentType, contentLength: bytes.length, bytes })
    assert.equal(recordings.get(created.recordingId).contentType, contentType.split(';')[0])
    assert.equal(recordings.get(created.recordingId).state, 'uploaded')
  }
  for (const contentType of ['', 'audio/unknown', 'video/webm', 'audio/webm;codecs=vp9', 'audio/mp4;extra=yes']) {
    const { platform, meetings } = (await setup())
    const lease = (await platform.authorizeRecording(alex, 'meeting-1'))
    await assert.rejects(async () => (await platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType, byteLength: bytes.length, sha256 })), (error) => error.code === 'INVALID_CONTENT_TYPE')
    assert.equal(meetings.get('northstar', 'meeting-1').recording.usedAt, null)
  }
})

async function setup({ processor = new FakeSpeechProcessor(), policyOptions = {} } = {}) {
  const meetings = new InMemoryMeetingRepository()
  const knowledge = new InMemoryKnowledgeRepository()
  const recordings = new InMemoryRecordingRepository()
  const audit = new InMemoryAppendOnlyAudit()
  const clock = new FixedClock('2026-10-01T12:00:00Z')
  const jobs = []
  const policy = new PolicyEngine({ knownClassifications: ['standard', 'internal'], ...policyOptions })
  const platform = new MeetingIntelligencePlatform({
    meetings,
    knowledge,
    recordings,
    audit,
    clock,
    policy,
    speechProcessor: processor,
    authorizationTtlMs: 1_000,
    maxRecordingBytes: 100,
    schedule: (job) => jobs.push(job),
  })
  await platform.createMeeting(alex, {
    id: 'meeting-1',
    tenantId: 'northstar',
    organizerId: 'alex',
    participantIds: ['alex', 'sam'],
    classification: 'standard',
  })
  for (const actor of [alex, sam]) {
    await platform.recordConsent(actor, 'meeting-1', {
      participantId: actor.userId,
      capturedAt: '2026-10-01T11:59:00Z',
      expiresAt: '2026-10-01T13:00:00Z',
      policyVersion: 'v1',
      decision: 'granted',
    })
  }
  return { platform, meetings, knowledge, recordings, audit, clock, jobs, policy }
}

async function createUploaded(setupResult = null) {
  setupResult ??= await setup()
  const lease = (await setupResult.platform.authorizeRecording(alex, 'meeting-1'))
  const created = (await setupResult.platform.createRecording(alex, 'meeting-1', {
    leaseId: lease.leaseId,
    contentType: 'audio/webm',
    byteLength: bytes.length,
    sha256,
  }))
  await setupResult.platform.uploadRecording(alex, 'meeting-1', created.recordingId, {
    contentType: 'audio/webm',
    contentLength: bytes.length,
    bytes,
  })
  return { setupResult, lease, created }
}

async function createUploadedMetadata() {
  const setupResult = (await setup())
  const lease = (await setupResult.platform.authorizeRecording(alex, 'meeting-1'))
  const created = (await setupResult.platform.createRecording(alex, 'meeting-1', {
    leaseId: lease.leaseId,
    contentType: 'audio/webm',
    byteLength: bytes.length,
    sha256,
  }))
  return { setupResult, created }
}

function saveMeeting(setupResult, mutate) {
  const meeting = setupResult.meetings.get('northstar', 'meeting-1')
  mutate(meeting)
  setupResult.meetings.save(meeting)
}

async function refreshConsent(setupResult, version) {
  for (const actor of [alex, sam]) {
    await setupResult.platform.recordConsent(actor, 'meeting-1', {
      participantId: actor.userId,
      capturedAt: '2026-10-01T11:59:30Z',
      expiresAt: '2026-10-01T14:00:00Z',
      policyVersion: version,
      decision: 'granted',
    })
  }
}

function deferredFakeProcessor() {
  let release
  let markStarted
  const gate = new Promise((resolve) => { release = resolve })
  // Resolves when the platform hands the recording to the processor, which
  // happens only after the recording has been saved as `processing`.
  const started = new Promise((resolve) => { markStarted = resolve })
  const fake = new FakeSpeechProcessor()
  return {
    release,
    started,
    processor: {
      async process(input) {
        markStarted()
        await gate
        return fake.process(input)
      },
    },
  }
}

async function assertProtectedDisposition(setupResult, recordingId, { bytesDeleted = false } = {}) {
  const recording = setupResult.recordings.get(recordingId)
  assert.equal(recording.state, 'quarantined')
  assert.equal(recording.error, 'POLICY_REVOKED')
  assert.equal(recording.processor, null)
  assert.deepEqual(setupResult.knowledge.forMeeting('northstar', 'meeting-1'), { segments: [], assertions: [] })
  assert.deepEqual((await setupResult.platform.searchKnowledge(alex, 'security')), [])
  assert.deepEqual((await setupResult.platform.retrieveForAi(alex, 'security')), [])
  assert.equal(setupResult.recordings.getBytes(recordingId) === null, bytesDeleted)

  const meeting = setupResult.meetings.get('northstar', 'meeting-1')
  if (meeting.retentionState === 'active') {
    const status = (await setupResult.platform.getRecording(alex, 'meeting-1', recordingId))
    assert.equal('segments' in status, false)
    assert.equal('assertions' in status, false)
  } else {
    await assert.rejects(async () => (await setupResult.platform.getRecording(alex, 'meeting-1', recordingId)), { code: 'RETENTION_RESTRICTED' })
  }
}

const policyRevocations = [
  {
    name: 'policy-version mismatch',
    async mutate(setupResult) {
      saveMeeting(setupResult, (meeting) => { meeting.consentPolicyVersion = 'v2' })
      await refreshConsent(setupResult, 'v2')
    },
  },
  {
    name: 'consent expiry',
    mutate(setupResult) { setupResult.clock.advance(3_600_001) },
  },
  {
    name: 'consent withdrawal',
    async mutate(setupResult) {
      await setupResult.platform.recordConsent(sam, 'meeting-1', {
        participantId: 'sam',
        capturedAt: '2026-10-01T12:00:01Z',
        expiresAt: '2026-10-01T13:00:00Z',
        policyVersion: 'v1',
        decision: 'withdrawn',
      })
    },
  },
  {
    name: 'never-record classification',
    mutate(setupResult) { saveMeeting(setupResult, (meeting) => { meeting.classification = 'legal-privileged' }) },
  },
  {
    name: 'otherwise-allowed classification change',
    mutate(setupResult) { saveMeeting(setupResult, (meeting) => { meeting.classification = 'internal' }) },
  },
  {
    name: 'retention restriction',
    bytesDeleted: true,
    mutate(setupResult) { saveMeeting(setupResult, (meeting) => { meeting.retentionState = 'pending-deletion' }) },
  },
  {
    name: 'organizer authorization loss',
    mutate(setupResult) { saveMeeting(setupResult, (meeting) => { meeting.organizerId = 'sam' }) },
  },
]

test('lease is opaque, bound, fresh, mime/size constrained, and single-use', async () => {
  const setupResult = (await setup())
  const lease = (await setupResult.platform.authorizeRecording(alex, 'meeting-1'))
  assert.match(lease.leaseId, /^[0-9a-f-]{36}$/)
  for (const [actor, meetingId, code] of [
    [{ tenantId: 'other', userId: 'alex' }, 'meeting-1', 'MEETING_NOT_FOUND'],
    [sam, 'meeting-1', 'NOT_ORGANIZER'],
    [alex, 'wrong', 'MEETING_NOT_FOUND'],
  ]) {
    await assert.rejects(async () => (await setupResult.platform.createRecording(actor, meetingId, {
      leaseId: lease.leaseId,
      contentType: 'audio/webm',
      byteLength: bytes.length,
      sha256,
    })), { code })
  }
  await assert.rejects(async () => (await setupResult.platform.createRecording(alex, 'meeting-1', {
    leaseId: lease.leaseId,
    contentType: 'audio/mp3',
    byteLength: 1,
    sha256,
  })), { code: 'INVALID_CONTENT_TYPE' })
  const made = (await setupResult.platform.createRecording(alex, 'meeting-1', {
    leaseId: lease.leaseId,
    contentType: 'audio/ogg',
    byteLength: bytes.length,
    sha256,
  }))
  await assert.rejects(async () => (await setupResult.platform.createRecording(alex, 'meeting-1', {
    leaseId: lease.leaseId,
    contentType: 'audio/ogg',
    byteLength: bytes.length,
    sha256,
  })), { code: 'RECORDING_LEASE_REPLAYED' })
  assert.ok(made.recordingId)
})

test('stale v1 lease is revoked after v2 policy and consent refresh with zero artifact or job', async () => {
  const setupResult = (await setup())
  const lease = (await setupResult.platform.authorizeRecording(alex, 'meeting-1'))
  saveMeeting(setupResult, (meeting) => { meeting.consentPolicyVersion = 'v2' })
  await refreshConsent(setupResult, 'v2')

  await assert.rejects(async () => (await setupResult.platform.createRecording(alex, 'meeting-1', {
    leaseId: lease.leaseId,
    contentType: 'audio/webm',
    byteLength: bytes.length,
    sha256,
  })), { code: 'RECORDING_POLICY_CHANGED' })
  assert.equal(setupResult.meetings.get('northstar', 'meeting-1').recording.status, 'revoked')
  assert.equal(setupResult.recordings.listForMeeting('northstar', 'meeting-1').length, 0)
  assert.equal(setupResult.jobs.length, 0)
})

test('legacy transcript append also rejects stale lease policy bindings', async () => {
  const setupResult = (await setup())
  const lease = (await setupResult.platform.authorizeRecording(alex, 'meeting-1'))
  saveMeeting(setupResult, (meeting) => { meeting.classification = 'internal' })
  await assert.rejects(async () => (await setupResult.platform.appendTranscript(alex, 'meeting-1', lease, [{
    id: 'stale-segment',
    speakerId: 'alex',
    startMs: 0,
    endMs: 1,
    text: 'STALE-LEASE-CONTENT-CANARY',
    provenance: {},
  }])), { code: 'RECORDING_POLICY_CHANGED' })
  assert.deepEqual(setupResult.knowledge.forMeeting('northstar', 'meeting-1'), { segments: [], assertions: [] })
})

test('expired lease and malformed hash or size create no artifact', async () => {
  for (const mutation of [
    { sha256: sha256.toUpperCase(), code: 'INVALID_SHA256' },
    { byteLength: 0, code: 'INVALID_BYTE_LENGTH' },
    { byteLength: 101, code: 'INVALID_BYTE_LENGTH' },
  ]) {
    const setupResult = (await setup())
    const lease = (await setupResult.platform.authorizeRecording(alex, 'meeting-1'))
    await assert.rejects(async () => (await setupResult.platform.createRecording(alex, 'meeting-1', {
      leaseId: lease.leaseId,
      contentType: 'audio/webm',
      byteLength: bytes.length,
      sha256,
      ...mutation,
    })), { code: mutation.code })
    assert.equal(setupResult.recordings.listForMeeting('northstar', 'meeting-1').length, 0)
  }
  const setupResult = (await setup())
  const lease = (await setupResult.platform.authorizeRecording(alex, 'meeting-1'))
  setupResult.clock.advance(1_001)
  await assert.rejects(async () => (await setupResult.platform.createRecording(alex, 'meeting-1', {
    leaseId: lease.leaseId,
    contentType: 'audio/webm',
    byteLength: bytes.length,
    sha256,
  })), { code: 'RECORDING_LEASE_EXPIRED' })
})

test('upload enforces declared headers, actual length, hash, binding, and one-time use', async () => {
  for (const [change, code] of [
    [{ contentType: 'audio/ogg' }, 'CONTENT_TYPE_MISMATCH'],
    [{ contentLength: undefined }, 'CONTENT_LENGTH_REQUIRED'],
    [{ contentLength: bytes.length + 1 }, 'CONTENT_LENGTH_MISMATCH'],
    [{ bytes: bytes.subarray(1) }, 'ACTUAL_LENGTH_MISMATCH'],
    [{ bytes: Buffer.alloc(bytes.length, 7) }, 'HASH_MISMATCH'],
  ]) {
    const { setupResult, created } = (await createUploadedMetadata())
    await assert.rejects(async () => (await setupResult.platform.uploadRecording(alex, 'meeting-1', created.recordingId, {
      contentType: 'audio/webm',
      contentLength: bytes.length,
      bytes,
      ...change,
    })), { code })
  }
  const { setupResult, created } = (await createUploaded())
  await assert.rejects(async () => (await setupResult.platform.uploadRecording(alex, 'meeting-1', created.recordingId, {
    contentType: 'audio/webm', contentLength: bytes.length, bytes,
  })), { code: 'DUPLICATE_UPLOAD' })
  await assert.rejects(async () => (await setupResult.platform.uploadRecording(sam, 'meeting-1', created.recordingId, {
    contentType: 'audio/webm', contentLength: bytes.length, bytes,
  })), { code: 'NOT_ORGANIZER' })
})

test('processing is upload-gated and publishes only normalized identity evidence with exact citations', async () => {
  const metadataOnly = (await createUploadedMetadata())
  await assert.rejects(async () => (await metadataOnly.setupResult.platform.startProcessing(alex, 'meeting-1', metadataOnly.created.recordingId)), { code: 'RECORDING_NOT_UPLOADED' })
  await metadataOnly.setupResult.platform.uploadRecording(alex, 'meeting-1', metadataOnly.created.recordingId, {
    contentType: 'audio/webm', contentLength: bytes.length, bytes,
  })
  assert.equal((await metadataOnly.setupResult.platform.startProcessing(alex, 'meeting-1', metadataOnly.created.recordingId)).state, 'queued')
  assert.equal((await metadataOnly.setupResult.platform.startProcessing(alex, 'meeting-1', metadataOnly.created.recordingId)).state, 'queued')
  await metadataOnly.setupResult.jobs[0]()

  const result = (await metadataOnly.setupResult.platform.getRecording(sam, 'meeting-1', metadataOnly.created.recordingId))
  assert.equal(result.recording.state, 'completed')
  assert.equal(result.recording.processor, 'Local deterministic processor')
  assert.ok(result.segments.every((segment) => segment.diarizationLabel && segment.verifiedParticipantId === null))
  assert.ok(result.segments.every((segment) => Number.isFinite(segment.identityConfidence) && segment.provenance.mode === 'local-deterministic-fake'))
  const ids = new Set(result.segments.map((segment) => segment.id))
  assert.ok(result.assertions.every((assertion) => assertion.citations.every((id) => ids.has(id))))
  // The action becomes a commitment only after private processor
  // normalization.  The row retains evidence linkage but never processor
  // provenance or untrusted metadata.
  const canonicalAction = result.assertions.find((assertion) => assertion.kind === 'action')
  const commitments = (await metadataOnly.setupResult.platform.queryCommitments(sam, 'security review', 'canonical-processor-action')).commitments
  assert.deepEqual(commitments, [{
    id: `commitment:${canonicalAction.id}`,
    meetingId: 'meeting-1',
    text: canonicalAction.text,
    ownerId: null,
    deadline: null,
    status: 'open',
    source: { assertionId: canonicalAction.id, citations: canonicalAction.citations },
  }])
})

test('direct participant action canary cannot enter the commitment registry, while canonical processor action remains cited and queryable', async () => {
  const canary = 'DIRECT-PARTICIPANT-ACTION-CANARY'
  const setupResult = (await setup())
  const { created } = (await createUploaded(setupResult))

  await assert.rejects(async () => (await setupResult.platform.addAssertions(alex, 'meeting-1', [{
    id: 'participant-action-canary', kind: 'action', text: canary,
    citations: ['invented-segment-id'],
    commitment: { ownerId: 'sam', deadline: '2026-10-15T17:00:00-04:00', status: 'completed' },
    provenance: { source: 'speech-processor', canonicalOrigin: 'processor-normalized-v1' },
  }], 'participant-action-add')), { code: 'UNTRUSTED_ACTION_ASSERTION' })
  assert.deepEqual((await setupResult.platform.queryCommitments(alex, canary, 'participant-action-query')), { commitments: [] })
  assert.equal(JSON.stringify(setupResult.knowledge.forMeeting('northstar', 'meeting-1')).includes(canary), false)
  assert.equal(setupResult.audit.all().some((event) => event.correlationId === 'participant-action-query' && event.meetingId === 'meeting-1'), false)

  await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId, 'canonical-action-process')
  await setupResult.jobs[0]()
  const canonical = (await setupResult.platform.queryCommitments(alex, 'security review', 'canonical-action-query')).commitments
  assert.equal(canonical.length, 1)
  assert.equal(canonical[0].source.citations.length, 1)
  assert.equal(canonical[0].source.citations[0], `${created.recordingId}-segment-2`)
  assert.equal(canonical[0].text.includes('security review'), true)
})

for (const stage of ['queued', 'processing']) {
  test(`every current-policy revocation enters protected disposition from ${stage}`, async (t) => {
    for (const revocation of policyRevocations) {
      await t.test(revocation.name, async () => {
        const deferred = stage === 'processing' ? deferredFakeProcessor() : null
        const setupResult = (await setup({ processor: deferred?.processor ?? new FakeSpeechProcessor() }))
        const { created } = (await createUploaded(setupResult))
        await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId, `corr-${stage}-${revocation.name}`)

        let job
        if (stage === 'processing') {
          job = setupResult.jobs[0]()
          await deferred.started
          assert.equal(setupResult.recordings.get(created.recordingId).state, 'processing')
        }
        revocation.mutate(setupResult)
        if (stage === 'processing') deferred.release()
        await (job ?? setupResult.jobs[0]())

        await assertProtectedDisposition(setupResult, created.recordingId, { bytesDeleted: revocation.bytesDeleted })
        const processAudit = setupResult.audit.all().find((event) =>
          event.correlationId === `corr-${stage}-${revocation.name}` && event.action === 'recording.process.complete')
        assert.equal(processAudit.outcome, 'denied')
        assert.notEqual(processAudit.reason, 'PROCESSOR_FAILED')
      })
    }
  })
}

test('processor exceptions expose only allowlisted PROCESSOR_FAILED in status and every audit', async () => {
  const canary = 'TRANSCRIPT-CANARY-IN-UNTRUSTED-ERROR'
  const processor = {
    async process() {
      const error = new Error(`${canary}-message`)
      error.code = `${canary}-code`
      error.name = `${canary}-name`
      error.stack = `${canary}-stack`
      throw error
    },
  }
  const setupResult = (await setup({ processor }))
  const { created } = (await createUploaded(setupResult))
  await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId, 'corr-failed')
  await setupResult.jobs[0]()

  const result = (await setupResult.platform.getRecording(alex, 'meeting-1', created.recordingId))
  assert.equal(result.recording.state, 'failed')
  assert.equal(result.recording.progress, 100)
  assert.equal(result.recording.error, 'PROCESSOR_FAILED')
  assert.equal(result.recording.processor, null)
  assert.equal('segments' in result, false)
  assert.equal('assertions' in result, false)
  assert.deepEqual(setupResult.knowledge.forMeeting('northstar', 'meeting-1'), { segments: [], assertions: [] })
  const serializedStatus = JSON.stringify(result)
  const serializedAudits = JSON.stringify(setupResult.audit.all())
  assert.equal(serializedStatus.includes(canary), false)
  assert.equal(serializedAudits.includes(canary), false)
  const auditEvent = setupResult.audit.all().find((event) => event.correlationId === 'corr-failed' && event.action === 'recording.process.complete')
  assert.deepEqual({ outcome: auditEvent.outcome, reason: auditEvent.reason }, { outcome: 'denied', reason: 'PROCESSOR_FAILED' })
})

test('untrusted processor metadata and false participant bindings are normalized before publication', async () => {
  const fake = new FakeSpeechProcessor()
  const processor = {
    async process(input) {
      const result = await fake.process(input)
      return {
        ...result,
        processor: 'TRANSCRIPT-CANARY-PROCESSOR-NAME',
        segments: result.segments.map((segment) => ({ ...segment, verifiedParticipantId: 'sam' })),
      }
    },
  }
  const setupResult = (await setup({ processor }))
  const { created } = (await createUploaded(setupResult))
  await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId)
  await setupResult.jobs[0]()
  const result = (await setupResult.platform.getRecording(alex, 'meeting-1', created.recordingId))
  assert.equal(result.recording.processor, 'Speech processor')
  assert.ok(result.segments.every((segment) => segment.verifiedParticipantId === null))
})

test('successful processor canary metadata is canonicalized before every persisted, retrieval, status, and audit sink', async () => {
  const canary = 'SUCCESS-PROCESSOR-METADATA-CANARY'
  const fake = new FakeSpeechProcessor()
  const processor = {
    async process(input) {
      const result = await fake.process(input)
      const rawSegmentId = `${canary}-segment-id`
      return {
        ...result,
        processor: `${canary}-processor-label`,
        metadata: { canary, debug: { trace: canary } },
        debug: canary,
        segments: [
          ...result.segments,
          {
            id: rawSegmentId,
            startMs: 13400,
            endMs: 16000,
            text: 'A normal transcript sentence remains available with its evidence link.',
            diarizationLabel: `${canary}-speaker-label`,
            verifiedParticipantId: canary,
            identityConfidence: 0.87654321,
            provenance: { canary, nested: { canary }, providerTrace: canary },
            metadata: { canary },
          },
        ],
        assertions: [
          ...result.assertions,
          {
            id: `${canary}-assertion-id`,
            kind: `${canary}-kind`,
            text: 'A normal finding remains cited by the canonical transcript segment.',
            citations: [rawSegmentId],
            provenance: { canary, providerTrace: canary },
            metadata: { canary },
          },
        ],
      }
    },
  }
  const setupResult = (await setup({ processor }))
  const { created } = (await createUploaded(setupResult))
  await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId, 'corr-success-canary')
  await setupResult.jobs[0]()

  const status = (await setupResult.platform.getRecording(alex, 'meeting-1', created.recordingId))
  const knowledge = (await setupResult.platform.getMeetingKnowledge(alex, 'meeting-1'))
  const search = (await setupResult.platform.searchKnowledge(alex, 'normal'))
  const aiContext = (await setupResult.platform.retrieveForAi(alex, 'normal'))
  const persistedRecording = setupResult.recordings.get(created.recordingId)
  const persistedKnowledge = setupResult.knowledge.forMeeting('northstar', 'meeting-1')
  const audits = setupResult.audit.all()

  // Raw IDs and labels are replaced, raw provenance/result metadata is dropped,
  // unknown assertion kinds are canonicalized, and identity remains policy-derived.
  const lastSegment = status.segments.at(-1)
  const lastAssertion = status.assertions.at(-1)
  assert.equal(status.recording.processor, 'Speech processor')
  assert.equal(lastSegment.id, `${created.recordingId}-segment-4`)
  assert.equal(lastSegment.diarizationLabel, 'SPEAKER_02')
  assert.equal(lastSegment.verifiedParticipantId, null)
  assert.equal(lastSegment.identityConfidence, 0.8765)
  assert.deepEqual(lastSegment.provenance, {
    source: 'speech-processor', processor: 'Speech processor', mode: 'redacted',
    recordingId: created.recordingId, identityBinding: 'unverified-diarization-only',
  })
  assert.equal(lastAssertion.id, `${created.recordingId}-assertion-3`)
  assert.equal(lastAssertion.kind, 'finding')
  assert.deepEqual(lastAssertion.citations, [lastSegment.id])
  assert.deepEqual(lastAssertion.provenance, {
    source: 'speech-processor', processor: 'Speech processor', mode: 'redacted', recordingId: created.recordingId,
    canonicalOrigin: 'processor-normalized-v1',
  })

  // Check all observable sinks, including direct in-memory persistence used by
  // later status, knowledge, search, AI retrieval, and audit API paths.
  for (const sink of [status, knowledge, search, aiContext, persistedRecording, persistedKnowledge, audits]) {
    assert.equal(JSON.stringify(sink).includes(canary), false)
  }
})

test('oversized processor citation lists fail closed before canonical knowledge, commitments, status, or audit can retain their raw evidence', async () => {
  const canary = 'OVERSIZED-PROCESSOR-CITATION-CANARY'
  const fake = new FakeSpeechProcessor()
  const processor = {
    async process(input) {
      const result = await fake.process(input)
      return {
        ...result,
        assertions: [{
          id: 'oversized-assertion',
          kind: 'action',
          text: 'This action must not publish.',
          // Deliberately repeat a valid raw source ID. A value-count limit is
          // required even when every individual citation resolves correctly.
          citations: Array.from({ length: 17 }, () => `${canary}-segment`),
        }],
        segments: [{
          ...result.segments[0],
          id: `${canary}-segment`,
        }],
      }
    },
  }
  const setupResult = (await setup({ processor }))
  const { created } = (await createUploaded(setupResult))
  await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId, 'oversized-citations')
  await setupResult.jobs[0]()

  const status = (await setupResult.platform.getRecording(alex, 'meeting-1', created.recordingId))
  assert.equal(status.recording.state, 'failed')
  assert.equal(status.recording.error, 'PROCESSOR_FAILED')
  assert.deepEqual(setupResult.knowledge.forMeeting('northstar', 'meeting-1'), { segments: [], assertions: [] })
  assert.deepEqual((await setupResult.platform.queryCommitments(alex, '', 'oversized-citations-query')), { commitments: [] })
  const materialized = JSON.stringify([status, setupResult.recordings.get(created.recordingId), setupResult.knowledge.forMeeting('northstar', 'meeting-1'), setupResult.audit.all()])
  assert.equal(materialized.includes(canary), false)
})

test('fake diarization stays independent and alex+bob roster evidence never invents sam', async () => {
  const processor = new FakeSpeechProcessor()
  const recording = { id: 'recording-1', tenantId: 'northstar', meetingId: 'meeting-1' }
  const withoutEvidence = await processor.process({ recording })
  assert.ok(withoutEvidence.segments.every((segment) => segment.verifiedParticipantId === null))

  const withEvidence = await processor.process({
    recording,
    rosterEvidence: [
      { diarizationLabel: 'SPEAKER_00', participantId: 'alex', authorized: true, binding: 'exact' },
      { diarizationLabel: 'SPEAKER_01', participantId: 'bob', authorized: true, binding: 'exact' },
      { diarizationLabel: 'SPEAKER_01', participantId: 'sam', authorized: false, binding: 'exact' },
    ],
  })
  assert.deepEqual(withEvidence.segments.map((segment) => segment.verifiedParticipantId), ['alex', 'bob', 'alex'])
  assert.equal(withEvidence.segments.some((segment) => segment.verifiedParticipantId === 'sam'), false)
  assert.ok(withEvidence.segments.every((segment) => Number.isFinite(segment.identityConfidence) && segment.provenance.recordingId === 'recording-1'))
  const segmentIds = new Set(withEvidence.segments.map((segment) => segment.id))
  assert.ok(withEvidence.assertions.every((assertion) => assertion.citations.every((id) => segmentIds.has(id))))
})

test('deletion clears bytes, knowledge, and candidates while legal hold does not expand reads', async () => {
  const { setupResult, created } = (await createUploaded())
  await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId)
  await setupResult.jobs[0]()
  await assert.rejects(async () => (await setupResult.platform.getRecording({ tenantId: 'northstar', userId: 'outsider' }, 'meeting-1', created.recordingId)), { code: 'MEETING_FORBIDDEN' })
  await setupResult.platform.deleteMeetingContent(alex, 'meeting-1')
  assert.equal(setupResult.recordings.getBytes(created.recordingId), null)
  assert.deepEqual(setupResult.knowledge.forMeeting('northstar', 'meeting-1'), { segments: [], assertions: [] })
  assert.deepEqual((await setupResult.platform.retrieveForAi(alex, 'security')), [])

  const held = (await createUploaded()).setupResult
  saveMeeting(held, (meeting) => { meeting.retentionState = 'held' })
  await assert.rejects(async () => (await held.platform.deleteMeetingContent(alex, 'meeting-1')), { code: 'LEGAL_HOLD' })
  await assert.rejects(async () => (await held.platform.getMeetingKnowledge({ tenantId: 'northstar', userId: 'outsider' }, 'meeting-1')), { code: 'RETENTION_RESTRICTED' })
})

test('audit events remain content-free and correlation-aware', async () => {
  const { setupResult, created } = (await createUploaded())
  await setupResult.platform.startProcessing(alex, 'meeting-1', created.recordingId, 'corr-process')
  await setupResult.jobs[0]()
  const serialized = JSON.stringify(setupResult.audit.all())
  assert.equal(serialized.includes('deterministic audio fixture'), false)
  assert.equal(serialized.includes('phased launch'), false)
  assert.ok(setupResult.audit.all().some((event) => event.correlationId === 'corr-process' && event.action === 'recording.process.complete'))
})
