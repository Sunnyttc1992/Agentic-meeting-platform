import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryAppendOnlyAudit, InMemoryKnowledgeRepository, InMemoryMeetingRepository, FixedClock } from './adapters/in-memory.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'

const tenant = 'northstar'
const organizer = { tenantId: tenant, userId: 'alex' }
const participant = { tenantId: tenant, userId: 'sam' }

function setup(options = {}) {
  const meetings = new InMemoryMeetingRepository()
  const knowledge = new InMemoryKnowledgeRepository()
  const audit = new InMemoryAppendOnlyAudit()
  const clock = new FixedClock('2026-09-30T12:00:00Z')
  const platform = new MeetingIntelligencePlatform({ meetings, knowledge, audit, clock, policy: new PolicyEngine(options), authorizationTtlMs: 1_000 })
  return { platform, meetings, knowledge, audit, clock }
}

async function createAndConsent(platform, classification = 'standard', id = 'meeting-1') {
  await platform.createMeeting(organizer, { id, tenantId: tenant, organizerId: organizer.userId, participantIds: [organizer.userId, participant.userId], classification })
  await platform.recordConsent(organizer, id, { participantId: organizer.userId, capturedAt: '2026-09-30T11:59:00Z', expiresAt: '2026-09-30T13:00:00Z', policyVersion: 'v1', decision: 'granted' })
  await platform.recordConsent(participant, id, { participantId: participant.userId, capturedAt: '2026-09-30T11:59:05Z', expiresAt: '2026-09-30T13:00:00Z', policyVersion: 'v1', decision: 'granted' })
}

async function seedKnowledge(platform, id = 'meeting-1') {
  const authorization = (await platform.authorizeRecording(organizer, id))
  await platform.appendTranscript(organizer, id, authorization, [{ id: `${id}-segment`, speakerId: 'sam', startMs: 0, endMs: 2400, text: 'Launch depends on privacy review', provenance: { engine: 'local-test', capturedAt: '2026-09-30T12:00:01Z' } }])
  await platform.addAssertions(organizer, id, [{ id: `${id}-decision`, kind: 'decision', text: 'Privacy review gates launch', citations: [`${id}-segment`] }])
  return authorization
}

test('happy vertical slice preserves citations and writes correlated audit events', async () => {
  const { platform, audit } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  const result = (await platform.getMeetingKnowledge(participant, 'meeting-1', 'corr-read'))
  assert.equal(result.assertions[0].citations[0], 'meeting-1-segment')
  assert.equal(result.segments[0].speakerId, 'sam')
  assert.ok(audit.all().some((event) => event.correlationId === 'corr-read' && event.action === 'knowledge.read'))
})

test('unrelated user cannot read meeting knowledge', async () => {
  const { platform, audit } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  await assert.rejects(async () => (await platform.getMeetingKnowledge({ tenantId: tenant, userId: 'outsider' }, 'meeting-1')), { code: 'MEETING_FORBIDDEN' })
  assert.equal(audit.all().at(-1).outcome, 'denied')
})

test('direct participant action assertions cannot mint a commitment, owner, deadline, or status', async () => {
  const { platform, knowledge, audit } = setup({ managementGrants: [{ tenantId: tenant, managerId: 'ceo', subordinateIds: ['alex'], expiresAt: '2026-10-01T00:00:00Z' }] })
  await createAndConsent(platform)
  await seedKnowledge(platform)
  const canary = 'DIRECT-ACTION-COMMITMENT-CANARY'
  const action = {
    id: 'meeting-1-security-review', kind: 'action', text: canary,
    citations: ['meeting-1-segment'],
    commitment: { ownerId: 'sam', deadline: '2026-10-15T17:00:00-04:00', status: 'in-progress' },
    processorMetadata: { token: 'PROCESSOR-CANARY', owner: 'mallory' },
    provenance: { source: 'speech-processor', canonicalOrigin: 'processor-normalized-v1' },
  }
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [action], 'direct-action')), { code: 'UNTRUSTED_ACTION_ASSERTION' })
  assert.deepEqual((await platform.queryCommitments(participant, canary, 'direct-action-query')), { commitments: [] })
  assert.equal(JSON.stringify(knowledge.forMeeting(tenant, 'meeting-1')).includes(canary), false)
  assert.equal(audit.all().some((event) => event.correlationId === 'direct-action-query' && event.meetingId === 'meeting-1'), false)
})

test('manual notes cannot forge processor provenance at any depth or leak omitted metadata through knowledge surfaces', async () => {
  const { platform, knowledge, audit } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  const kinds = ['decision', 'finding', 'question']
  const canaries = []

  for (const kind of kinds) {
    const canary = `FORGED-${kind.toUpperCase()}-PROCESSOR-CANARY`
    canaries.push(canary)
    await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [{
      id: `forged-${kind}`,
      kind,
      text: `${kind} must not be stored`,
      citations: ['meeting-1-segment'],
      processorLabel: canary,
      opaque: {
        nested: {
          source: 'speech-processor',
          canonicalOrigin: 'processor-normalized-v1',
          processorTrace: canary,
        },
      },
    }], `forged-${kind}`)), { code: 'UNTRUSTED_PROCESSOR_PROVENANCE' })
  }

  // Arbitrary non-processor request metadata is no longer silently dropped:
  // the participant-facing envelope is exact, so it cannot become a delayed
  // retrieval channel if a future mapper changes.
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [{
    id: 'manual-rejected', kind: 'finding', text: 'A malformed manual finding', citations: ['meeting-1-segment'],
    untrustedEnvelope: { nested: { canary: 'MANUAL-METADATA-CANARY' } },
  }], 'manual-extra-field')), { code: 'INVALID_MANUAL_ASSERTION' })
  await platform.addAssertions(organizer, 'meeting-1', [{
    id: 'manual-clean', kind: 'finding', text: 'A manually recorded finding', citations: ['meeting-1-segment'],
  }], 'manual-clean')

  const stored = knowledge.forMeeting(tenant, 'meeting-1')
  const read = (await platform.getMeetingKnowledge(participant, 'meeting-1', 'manual-read'))
  const searched = (await platform.searchKnowledge(participant, 'manual', 'manual-search'))
  const ai = (await platform.retrieveForAi(participant, 'manual', 'manual-ai'))
  const serialized = JSON.stringify([stored, read, searched, ai])
  for (const canary of [...canaries, 'MANUAL-METADATA-CANARY', 'processor-normalized-v1', 'speech-processor']) {
    assert.equal(serialized.includes(canary), false)
  }
  const manualRow = stored.assertions.find((item) => item.id === 'manual-clean')
  assert.deepEqual(manualRow.provenance, {})
  for (const kind of kinds) {
    const event = audit.all().find((item) => item.correlationId === `forged-${kind}`)
    assert.deepEqual({ action: event.action, outcome: event.outcome, reason: event.reason }, {
      action: 'knowledge.assertions.add', outcome: 'denied', reason: 'UNTRUSTED_PROCESSOR_PROVENANCE',
    })
    assert.equal(JSON.stringify(event).includes(`FORGED-${kind.toUpperCase()}-PROCESSOR-CANARY`), false)
  }
  const extraFieldEvent = audit.all().find((item) => item.correlationId === 'manual-extra-field')
  assert.deepEqual({ action: extraFieldEvent.action, outcome: extraFieldEvent.outcome, reason: extraFieldEvent.reason }, {
    action: 'knowledge.assertions.add', outcome: 'denied', reason: 'INVALID_MANUAL_ASSERTION',
  })
  assert.equal(JSON.stringify(extraFieldEvent).includes('MANUAL-METADATA-CANARY'), false)
})

test('manual assertion envelope rejects every nested allowed field and every manual kind before all knowledge sinks', async () => {
  const { platform, knowledge, audit } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  const canary = 'NESTED-MANUAL-ASSERTION-CANARY'
  const variants = [
    ['id', { canary }], ['id', [canary]],
    ['kind', { canary }], ['kind', ['finding']],
    ['text', { canary }], ['text', [canary]],
    ['citations', { canary }], ['citations', [[canary]]],
  ]
  // `action` is exercised by the direct-action boundary tests above. All
  // participant-writable assertion kinds must reject nested allowed fields.
  const manualKinds = ['summary', 'decision', 'risk', 'question', 'finding']

  for (const kind of manualKinds) {
    for (const [field, payload] of variants) {
      const assertion = {
        id: `manual-${kind}-${field}`,
        kind,
        text: `A ${kind} assertion`,
        citations: ['meeting-1-segment'],
      }
      assertion[field] = payload
      const correlationId = `nested-${kind}-${field}-${Array.isArray(payload) ? 'array' : 'object'}`
      await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [assertion], correlationId)), { code: 'INVALID_MANUAL_ASSERTION' })
      const event = audit.all().find((item) => item.correlationId === correlationId)
      assert.deepEqual({ action: event.action, outcome: event.outcome, reason: event.reason }, {
        action: 'knowledge.assertions.add', outcome: 'denied', reason: 'INVALID_MANUAL_ASSERTION',
      })
      assert.equal(JSON.stringify(event).includes(canary), false)
    }
  }

  // A Proxy is not cloneable. Reject it at the same boundary, without calling
  // it into an assertion mapper or allowing it to create a capability shape.
  const proxy = new Proxy({
    id: 'manual-proxy', kind: 'finding', text: canary, citations: ['meeting-1-segment'],
  }, {})
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [proxy], 'nested-proxy')), { code: 'INVALID_MANUAL_ASSERTION' })

  const accessor = { id: 'manual-accessor', kind: 'finding', citations: ['meeting-1-segment'] }
  Object.defineProperty(accessor, 'text', { enumerable: true, get: () => canary })
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [accessor], 'nested-accessor')), { code: 'INVALID_MANUAL_ASSERTION' })

  const hiddenField = { id: 'manual-hidden', kind: 'finding', text: 'A valid-looking value', citations: ['meeting-1-segment'] }
  Object.defineProperty(hiddenField, 'trace', { enumerable: false, value: canary })
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [hiddenField], 'nested-hidden-field')), { code: 'INVALID_MANUAL_ASSERTION' })
  for (const correlationId of ['nested-proxy', 'nested-accessor', 'nested-hidden-field']) {
    const event = audit.all().find((item) => item.correlationId === correlationId)
    assert.deepEqual({ action: event.action, outcome: event.outcome, reason: event.reason }, {
      action: 'knowledge.assertions.add', outcome: 'denied', reason: 'INVALID_MANUAL_ASSERTION',
    })
    assert.equal(JSON.stringify(event).includes(canary), false)
  }

  const materialized = [
    knowledge.forMeeting(tenant, 'meeting-1'),
    (await platform.getMeetingKnowledge(participant, 'meeting-1', 'nested-read')),
    (await platform.searchKnowledge(participant, 'nested', 'nested-search')),
    (await platform.retrieveForAi(participant, 'nested', 'nested-ai')),
    (await platform.queryCommitments(participant, 'nested', 'nested-commitments')),
    audit.all(),
  ]
  const serialized = JSON.stringify(materialized)
  for (const forbidden of [canary, 'manual-proxy', 'NESTED-MANUAL-ASSERTION-CANARY']) assert.equal(serialized.includes(forbidden), false)
  assert.equal(knowledge.forMeeting(tenant, 'meeting-1').assertions.some((item) => item.id.startsWith('manual-')), false)
})

test('manual assertion collections reject Array proxy map forgery and every non-dense collection shape before all sinks', async () => {
  const { platform, knowledge, audit } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  const canary = 'OUTER-ARRAY-PROXY-MAP-CANARY'
  const forged = {
    id: 'forged-by-outer-map', kind: 'finding', text: canary, citations: ['meeting-1-segment'],
  }
  let mapCalls = 0
  const proxyCollection = new Proxy([{
    id: 'benign-underlying-row', kind: 'finding', text: 'This underlying row must not be persisted either.', citations: ['meeting-1-segment'],
  }], {
    get(target, key, receiver) {
      if (key === 'map') {
        return () => {
          mapCalls += 1
          return [forged]
        }
      }
      return Reflect.get(target, key, receiver)
    },
  })

  const sparse = []
  sparse.length = 1
  const accessor = [{ id: 'accessor', kind: 'finding', text: 'unused', citations: ['meeting-1-segment'] }]
  Object.defineProperty(accessor, '0', { enumerable: true, configurable: true, get: () => forged })
  const extraProperty = [{ id: 'extra', kind: 'finding', text: 'unused', citations: ['meeting-1-segment'] }]
  extraProperty.trace = canary
  const symbolProperty = [{ id: 'symbol', kind: 'finding', text: 'unused', citations: ['meeting-1-segment'] }]
  symbolProperty[Symbol('untrusted-collection')] = canary
  const customMap = [{ id: 'map', kind: 'finding', text: 'unused', citations: ['meeting-1-segment'] }]
  customMap.map = () => [forged]

  for (const [label, value] of [
    ['outer-proxy', proxyCollection], ['sparse', sparse], ['accessor', accessor],
    ['extra', extraProperty], ['symbol', symbolProperty], ['custom-map', customMap],
  ]) {
    await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', value, `collection-${label}`)), { code: 'INVALID_MANUAL_ASSERTION' })
    const event = audit.all().find((item) => item.correlationId === `collection-${label}`)
    assert.deepEqual({ action: event.action, outcome: event.outcome, reason: event.reason }, {
      action: 'knowledge.assertions.add', outcome: 'denied', reason: 'INVALID_MANUAL_ASSERTION',
    })
  }
  assert.equal(mapCalls, 0)

  const materialized = [
    knowledge.forMeeting(tenant, 'meeting-1'),
    (await platform.getMeetingKnowledge(participant, 'meeting-1', 'collection-read')),
    (await platform.searchKnowledge(participant, canary, 'collection-search')),
    (await platform.retrieveForAi(participant, canary, 'collection-ai')),
    (await platform.queryCommitments(participant, canary, 'collection-commitments')),
    (await platform.getMeetingPrivacyAccess(participant, 'meeting-1', 'collection-status')),
    audit.all(),
  ]
  const serialized = JSON.stringify(materialized)
  for (const forbidden of [canary, 'forged-by-outer-map', 'benign-underlying-row']) {
    assert.equal(serialized.includes(forbidden), false)
  }
  assert.equal(knowledge.forMeeting(tenant, 'meeting-1').assertions.some((item) => item.id.includes('outer') || item.id === 'accessor'), false)
})

test('commitment queries fail closed per source meeting without leaking hidden or cross-tenant actions', async () => {
  const { platform, audit } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [{
    id: 'private-action', kind: 'action', text: 'Private dependency must be closed.', citations: ['meeting-1-segment'],
    commitment: { ownerId: 'alex', status: 'open' },
  }])), { code: 'UNTRUSTED_ACTION_ASSERTION' })
  const privateResult = (await platform.queryCommitments({ tenantId: tenant, userId: 'outsider' }, 'dependency', 'commitment-private'))
  const crossTenantResult = (await platform.queryCommitments({ tenantId: 'other', userId: 'outsider' }, 'dependency', 'commitment-cross-tenant'))
  assert.deepEqual(privateResult, { commitments: [] })
  assert.deepEqual(crossTenantResult, { commitments: [] })
  const serialized = JSON.stringify([privateResult, crossTenantResult])
  for (const secret of ['meeting-1', 'Private dependency', 'private-action', 'northstar', 'MEETING_FORBIDDEN', 'TENANT_MISMATCH']) assert.equal(serialized.includes(secret), false)
  assert.equal(audit.all().some((event) => event.correlationId === 'commitment-private' && event.meetingId === 'meeting-1'), false)
  assert.equal(audit.all().some((event) => event.correlationId === 'commitment-cross-tenant' && event.meetingId === 'meeting-1'), false)
})

test('management briefing aggregates only authorized canonical sources with cited risks, blockers, and commitments', async () => {
  const { platform, knowledge, audit } = setup({
    managementGrants: [{ tenantId: tenant, managerId: 'ceo', subordinateIds: ['alex'], expiresAt: '2026-10-01T00:00:00Z' }],
  })
  await createAndConsent(platform)
  await seedKnowledge(platform)

  knowledge.addAssertions([
    {
      id: 'meeting-1-risk', tenantId: tenant, meetingId: 'meeting-1', kind: 'risk',
      text: 'Privacy review is a launch blocker.', citations: ['meeting-1-segment'],
      provenance: { source: 'speech-processor', processorMetadata: 'BRIEFING-PROCESSOR-CANARY' },
    },
    {
      id: 'meeting-1-action', tenantId: tenant, meetingId: 'meeting-1', kind: 'action',
      text: 'Complete the privacy review.', citations: ['meeting-1-segment'],
      commitment: { ownerId: 'sam', deadline: '2026-10-15T17:00:00.000Z', status: 'blocked' },
      provenance: { source: 'speech-processor', canonicalOrigin: 'processor-normalized-v1', processorMetadata: 'BRIEFING-PROCESSOR-CANARY' },
    },
  ])
  platform.commitments.replaceMeeting(tenant, 'meeting-1', knowledge.forMeeting(tenant, 'meeting-1'))

  // A non-participant meeting is intentionally present in the same tenant.
  // Its canary must not affect counts, rows, citations, or the public audit.
  const hiddenOrganizer = { tenantId: tenant, userId: 'bob' }
  await platform.createMeeting(hiddenOrganizer, {
    id: 'meeting-hidden', tenantId: tenant, organizerId: 'bob', participantIds: ['bob', 'riley'], classification: 'standard',
  })
  knowledge.addSegments([{ id: 'hidden-segment', tenantId: tenant, meetingId: 'meeting-hidden', startMs: 0, endMs: 1, diarizationLabel: 'SPEAKER_00', text: 'HIDDEN-BRIEFING-CANARY' }])
  knowledge.addAssertions([{ id: 'hidden-risk', tenantId: tenant, meetingId: 'meeting-hidden', kind: 'risk', text: 'HIDDEN-BRIEFING-CANARY', citations: ['hidden-segment'], provenance: { source: 'speech-processor' } }])

  const participantBrief = (await platform.getManagementBriefing(participant, 'briefing-participant'))
  const executiveBrief = (await platform.getManagementBriefing({ tenantId: tenant, userId: 'ceo' }, 'briefing-executive'))
  const outsiderBrief = (await platform.getManagementBriefing({ tenantId: tenant, userId: 'outsider' }, 'briefing-outsider'))
  const crossTenantBrief = (await platform.getManagementBriefing({ tenantId: 'other', userId: 'outsider' }, 'briefing-cross-tenant'))

  assert.deepEqual(participantBrief.briefing.counts, { decisions: 1, risks: 1, blockers: 2, openActions: 1 })
  assert.equal(participantBrief.briefing.risks[0].source.meetingId, 'meeting-1')
  assert.deepEqual(participantBrief.briefing.risks[0].source.citations, ['meeting-1-segment'])
  assert.equal(participantBrief.briefing.actions[0].source.assertionId, 'meeting-1-action')
  assert.equal(participantBrief.briefing.actions[0].status, 'blocked')
  assert.deepEqual(executiveBrief, participantBrief)
  assert.deepEqual(outsiderBrief, { briefing: { counts: { decisions: 0, risks: 0, blockers: 0, openActions: 0 }, decisions: [], risks: [], blockers: [], actions: [] } })
  assert.deepEqual(crossTenantBrief, outsiderBrief)

  const briefingAudits = audit.all().filter((item) => String(item.correlationId).startsWith('briefing-'))
  const serialized = JSON.stringify([participantBrief, executiveBrief, outsiderBrief, crossTenantBrief, briefingAudits])
  for (const hidden of ['meeting-hidden', 'hidden-segment', 'HIDDEN-BRIEFING-CANARY', 'BRIEFING-PROCESSOR-CANARY', 'processorMetadata', 'canonicalOrigin']) {
    assert.equal(serialized.includes(hidden), false)
  }
  for (const correlationId of ['briefing-participant', 'briefing-executive', 'briefing-outsider', 'briefing-cross-tenant']) {
    const event = audit.all().find((item) => item.correlationId === correlationId)
    assert.deepEqual({ action: event.action, outcome: event.outcome, meetingId: event.meetingId }, {
      action: 'management-briefing.read', outcome: 'allowed', meetingId: null,
    })
  }
})

test('oversized canonical assertion evidence never creates a commitment or briefing/API source, while a bounded sibling remains traceable', async () => {
  const { platform, knowledge, audit } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  const canary = 'OVERSIZED-COMMITMENT-CITATION-CANARY'
  const shared = {
    tenantId: tenant,
    meetingId: 'meeting-1',
    kind: 'action',
    provenance: { source: 'speech-processor', canonicalOrigin: 'processor-normalized-v1' },
  }
  // Repository injection models a stale or independently-corrupted derived
  // record. Registry publication and all public read surfaces must still drop
  // it instead of silently truncating its source evidence.
  knowledge.addAssertions([
    {
      ...shared,
      id: 'oversized-action',
      text: canary,
      citations: Array.from({ length: 17 }, () => 'meeting-1-segment'),
      commitment: { ownerId: 'sam', status: 'open' },
    },
    {
      ...shared,
      id: 'bounded-action',
      text: 'Publish the reviewed security decision.',
      citations: ['meeting-1-segment'],
      commitment: { ownerId: 'sam', status: 'open' },
    },
  ])
  platform.commitments.replaceMeeting(tenant, 'meeting-1', knowledge.forMeeting(tenant, 'meeting-1'))

  const commitments = (await platform.queryCommitments(participant, '', 'bounded-commitments'))
  const briefing = (await platform.getManagementBriefing(participant, 'bounded-briefing'))
  assert.deepEqual(commitments.commitments, [{
    id: 'commitment:bounded-action', meetingId: 'meeting-1', text: 'Publish the reviewed security decision.',
    ownerId: 'sam', deadline: null, status: 'open',
    source: { assertionId: 'bounded-action', citations: ['meeting-1-segment'] },
  }])
  assert.deepEqual(briefing.briefing.actions, [{
    id: 'commitment:bounded-action', text: 'Publish the reviewed security decision.', ownerId: 'sam', deadline: null, status: 'open',
    source: { meetingId: 'meeting-1', assertionId: 'bounded-action', citations: ['meeting-1-segment'] },
  }])
  assert.equal(briefing.briefing.counts.openActions, 1)
  const materialized = JSON.stringify([commitments, briefing, audit.all()])
  assert.equal(materialized.includes(canary), false)
  assert.equal(materialized.includes('oversized-action'), false)
})

test('direct action replays and invalid owner details remain outside the commitment boundary', async () => {
  const { platform, knowledge } = setup()
  await createAndConsent(platform)
  await seedKnowledge(platform)
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [{
    id: 'invalid-owner', kind: 'action', text: 'Outsider owns this', citations: ['meeting-1-segment'], commitment: { ownerId: 'outsider' },
  }])), { code: 'UNTRUSTED_ACTION_ASSERTION' })
  await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [{
    id: 'replay-action', kind: 'action', text: 'Alex owns this', citations: ['meeting-1-segment'], commitment: { ownerId: 'alex' },
  }])), { code: 'UNTRUSTED_ACTION_ASSERTION' })
  assert.equal(knowledge.forMeeting(tenant, 'meeting-1').assertions.some((item) => item.kind === 'action'), false)
})

test('never-record classification is rejected before recording authorization', async () => {
  const { platform } = setup()
  await createAndConsent(platform, 'legal-privileged')
  await assert.rejects(async () => (await platform.authorizeRecording(organizer, 'meeting-1')), { code: 'NEVER_RECORD' })
})

test('expired recording authorization cannot append transcript and denial is audited without content', async () => {
  const { platform, clock, audit } = setup()
  await createAndConsent(platform)
  const authorization = (await platform.authorizeRecording(organizer, 'meeting-1'))
  clock.advance(1_001)
  await assert.rejects(async () => (await platform.appendTranscript(organizer, 'meeting-1', authorization, [{ id: 'late', speakerId: 'sam', startMs: 0, endMs: 1, text: 'SECRET-CANARY', provenance: {} }], 'corr-expired')), { code: 'RECORDING_AUTHORIZATION_EXPIRED' })
  const event = audit.all().find((item) => item.correlationId === 'corr-expired')
  assert.deepEqual({ action: event.action, outcome: event.outcome, reason: event.reason }, { action: 'transcript.append', outcome: 'denied', reason: 'RECORDING_AUTHORIZATION_EXPIRED' })
  assert.equal(JSON.stringify(event).includes('SECRET-CANARY'), false)
})

test('management hierarchy requires an explicit unexpired policy grant', async () => {
  const withoutGrant = setup()
  await createAndConsent(withoutGrant.platform)
  await seedKnowledge(withoutGrant.platform)
  const executive = { tenantId: tenant, userId: 'ceo', roles: ['executive'] }
  await assert.rejects(async () => (await withoutGrant.platform.getMeetingKnowledge(executive, 'meeting-1')), { code: 'MEETING_FORBIDDEN' })

  const withGrant = setup({ managementGrants: [{ tenantId: tenant, managerId: 'ceo', subordinateIds: ['alex'], expiresAt: '2026-10-01T00:00:00Z' }] })
  await createAndConsent(withGrant.platform)
  await seedKnowledge(withGrant.platform)
  assert.equal((await withGrant.platform.getMeetingKnowledge(executive, 'meeting-1')).meeting.id, 'meeting-1')
})

test('privacy access read model distinguishes participant and management-chain viewers without returning meeting content', async () => {
  const participantSlice = setup()
  await createAndConsent(participantSlice.platform, 'legal-privileged')
  const participantView = (await participantSlice.platform.getMeetingPrivacyAccess(participant, 'meeting-1', 'privacy-participant'))
  assert.deepEqual(participantView.access, { posture: 'participant', authorized: true })
  assert.deepEqual(participantView.classification, {
    classification: 'legal-privileged', confidentiality: 'never-record', recordingProhibited: true,
  })
  assert.deepEqual(participantView.retention, { state: 'active', deletion: 'not-requested' })
  assert.equal('meeting' in participantView, false)
  assert.equal('segments' in participantView, false)
  assert.equal('assertions' in participantView, false)

  const managementSlice = setup({ managementGrants: [{ tenantId: tenant, managerId: 'ceo', subordinateIds: ['alex'], expiresAt: '2026-10-01T00:00:00Z' }] })
  await createAndConsent(managementSlice.platform)
  const managementView = (await managementSlice.platform.getMeetingPrivacyAccess({ tenantId: tenant, userId: 'ceo' }, 'meeting-1', 'privacy-management'))
  assert.deepEqual(managementView.access, { posture: 'management-chain', authorized: true })
})

test('privacy access denies unrelated callers and redacts immutable audit timeline identities and opaque values', async () => {
  const { platform, audit } = setup()
  await createAndConsent(platform)
  audit.append({
    id: 'audit-private-id', correlationId: 'CORRELATION-SECRET', tenantId: tenant, principalId: 'sam', actorId: 'sam',
    resourceType: 'recording', resourceId: 'RECORDING-SECRET', meetingId: 'meeting-1', recordingId: 'RECORDING-SECRET',
    action: 'UNTRUSTED-ACTION-SECRET', outcome: 'UNTRUSTED-OUTCOME-SECRET', reason: 'UNTRUSTED-REASON-SECRET', occurredAt: '2026-09-30T12:00:00Z',
  })
  const result = (await platform.getMeetingPrivacyAccess(participant, 'meeting-1', 'privacy-redaction'))
  const redacted = result.auditTimeline.find((event) => event.action === 'redacted-event')
  assert.deepEqual(redacted, {
    occurredAt: '2026-09-30T12:00:00Z', action: 'redacted-event', outcome: 'redacted', reason: 'REDACTED', immutable: true,
  })
  const serialized = JSON.stringify(result)
  for (const value of ['CORRELATION-SECRET', 'RECORDING-SECRET', 'UNTRUSTED-REASON-SECRET', '"principalId"', '"actorId"']) {
    assert.equal(serialized.includes(value), false)
  }
  await assert.rejects(async () => (await platform.getMeetingPrivacyAccess({ tenantId: tenant, userId: 'outsider' }, 'meeting-1', 'privacy-denied')), { code: 'MEETING_NOT_FOUND' })
  const denied = audit.all().find((event) => event.correlationId === 'privacy-denied')
  assert.deepEqual({ action: denied.action, outcome: denied.outcome, reason: denied.reason }, {
    action: 'privacy-access.read', outcome: 'denied', reason: 'MEETING_FORBIDDEN',
  })
})

test('unauthorized matching meetings never enter AI context', async () => {
  const { platform, audit } = setup()
  await createAndConsent(platform, 'standard', 'meeting-private')
  await seedKnowledge(platform, 'meeting-private')
  const context = (await platform.retrieveForAi({ tenantId: tenant, userId: 'outsider' }, 'privacy', 'corr-ai'))
  assert.deepEqual(context, [])
  assert.ok(audit.all().some((event) => event.correlationId === 'corr-ai' && event.action === 'ai.retrieve' && event.outcome === 'denied'))
})

test('tenant scope prevents cross-tenant lookup from revealing existence', async () => {
  const { platform, audit } = setup()
  await createAndConsent(platform)
  await assert.rejects(async () => (await platform.getMeetingKnowledge({ tenantId: 'other', userId: 'sam' }, 'meeting-1', 'corr-cross')), { code: 'MEETING_NOT_FOUND' })
  const event = audit.all().find((item) => item.correlationId === 'corr-cross')
  assert.deepEqual(
    { tenantId: event.tenantId, principalId: event.principalId, resourceId: event.resourceId, action: event.action, outcome: event.outcome, reason: event.reason },
    { tenantId: 'other', principalId: 'sam', resourceId: 'meeting-1', action: 'knowledge.read', outcome: 'denied', reason: 'MEETING_NOT_FOUND' },
  )
})

test('recording requires affirmative current consent from every required participant', async () => {
  for (const [decision, expected] of [['declined', 'CONSENT_NOT_GRANTED'], ['withdrawn', 'CONSENT_NOT_GRANTED']]) {
    const { platform } = setup()
    await createAndConsent(platform)
    await platform.recordConsent(participant, 'meeting-1', { participantId: participant.userId, capturedAt: '2026-09-30T11:59:05Z', expiresAt: '2026-09-30T13:00:00Z', policyVersion: 'v1', decision })
    await assert.rejects(async () => (await platform.authorizeRecording(organizer, 'meeting-1')), { code: expected })
  }

  const expired = setup()
  await createAndConsent(expired.platform)
  await expired.platform.recordConsent(participant, 'meeting-1', { participantId: participant.userId, capturedAt: '2026-09-30T11:59:05Z', expiresAt: '2026-09-30T12:00:00Z', policyVersion: 'v1', decision: 'granted' })
  await assert.rejects(async () => (await expired.platform.authorizeRecording(organizer, 'meeting-1')), { code: 'CONSENT_EXPIRED' })

  const stale = setup()
  await createAndConsent(stale.platform)
  await stale.platform.recordConsent(participant, 'meeting-1', { participantId: participant.userId, capturedAt: '2026-09-30T11:59:05Z', expiresAt: '2026-09-30T13:00:00Z', policyVersion: 'old', decision: 'granted' })
  await assert.rejects(async () => (await stale.platform.authorizeRecording(organizer, 'meeting-1')), { code: 'CONSENT_POLICY_MISMATCH' })

  const malformed = setup()
  await malformed.platform.createMeeting(organizer, { id: 'meeting-1', tenantId: tenant, organizerId: organizer.userId, participantIds: [organizer.userId, participant.userId], classification: 'standard' })
  await assert.rejects(async () => (await malformed.platform.recordConsent(participant, 'meeting-1', { participantId: participant.userId, capturedAt: 'bad', expiresAt: 'also-bad', policyVersion: 'v1', decision: 'granted' })), { code: 'INVALID_CONSENT' })
})

test('unclassified, unknown, and organization-sensitive meetings fail closed without an explicit allow', async () => {
  const unclassified = setup()
  await createAndConsent(unclassified.platform, null)
  await assert.rejects(async () => (await unclassified.platform.authorizeRecording(organizer, 'meeting-1')), { code: 'CLASSIFICATION_REQUIRED' })

  const unknown = setup()
  await createAndConsent(unknown.platform, 'mystery-category')
  await assert.rejects(async () => (await unknown.platform.authorizeRecording(organizer, 'meeting-1')), { code: 'CLASSIFICATION_REQUIRED' })

  const explicitlyClassified = setup({ sensitiveRecordingAllows: [{ tenantId: tenant, meetingId: 'meeting-1', classification: 'mystery-category', allowed: true, expiresAt: '2026-10-01T00:00:00Z' }] })
  await createAndConsent(explicitlyClassified.platform, 'mystery-category')
  assert.equal((await explicitlyClassified.platform.authorizeRecording(organizer, 'meeting-1')).status, 'authorized')

  const sensitive = setup({ organizationSensitiveCategories: ['board-confidential'] })
  await createAndConsent(sensitive.platform, 'board-confidential')
  await assert.rejects(async () => (await sensitive.platform.authorizeRecording(organizer, 'meeting-1')), { code: 'SENSITIVE_RECORDING_DENIED' })

  const allowed = setup({ organizationSensitiveCategories: ['board-confidential'], sensitiveRecordingAllows: [{ tenantId: tenant, meetingId: 'meeting-1', classification: 'board-confidential', allowed: true, expiresAt: '2026-10-01T00:00:00Z' }] })
  await createAndConsent(allowed.platform, 'board-confidential')
  assert.equal((await allowed.platform.authorizeRecording(organizer, 'meeting-1')).status, 'authorized')
})

test('every non-active lifecycle state blocks reads, writes, and AI retrieval', async () => {
  for (const state of ['held', 'pending-deletion', 'deletion-in-progress', 'deleted', 'quarantined', 'pending-disposition']) {
    const { platform, meetings, audit } = setup()
    await createAndConsent(platform)
    await seedKnowledge(platform)
    const record = meetings.get(tenant, 'meeting-1')
    record.retentionState = state
    meetings.save(record)

    await assert.rejects(async () => (await platform.getMeetingKnowledge(participant, 'meeting-1', `read-${state}`)), { code: 'RETENTION_RESTRICTED' })
    await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [{ id: `assert-${state}`, kind: 'decision', text: 'blocked', citations: ['meeting-1-segment'] }], `write-${state}`)), { code: 'RETENTION_RESTRICTED' })
    await assert.rejects(async () => (await platform.appendTranscript(organizer, 'meeting-1', record.recording, [{ id: `segment-${state}`, speakerId: 'sam', startMs: 0, endMs: 1, text: 'LIFECYCLE-CANARY', provenance: {} }], `append-${state}`)), { code: 'RETENTION_RESTRICTED' })
    assert.deepEqual((await platform.searchKnowledge(participant, 'privacy', `search-${state}`)), [])
    assert.deepEqual((await platform.retrieveForAi(participant, 'privacy', `ai-${state}`)), [])

    for (const correlationId of [`read-${state}`, `write-${state}`, `append-${state}`, `search-${state}`, `ai-${state}`]) {
      const event = audit.all().find((item) => item.correlationId === correlationId)
      assert.equal(event.outcome, 'denied')
      assert.equal(event.reason, 'RETENTION_RESTRICTED')
      assert.equal(JSON.stringify(event).includes('LIFECYCLE-CANARY'), false)
    }
  }
})
