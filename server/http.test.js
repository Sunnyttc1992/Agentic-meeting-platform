import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryAppendOnlyAudit, InMemoryKnowledgeRepository, InMemoryMeetingRepository, FixedClock } from './adapters/in-memory.js'
import { createHttpHandler, createHttpServer } from './http.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'

const tenant = 'northstar'
const organizer = { tenantId: tenant, userId: 'alex' }
const participant = { tenantId: tenant, userId: 'sam' }

async function setup({ classification = 'standard', retentionState = 'active', policyOptions = {} } = {}) {
  const meetings = new InMemoryMeetingRepository()
  const audit = new InMemoryAppendOnlyAudit()
  const clock = new FixedClock('2026-09-30T12:00:00Z')
  const platform = new MeetingIntelligencePlatform({
    meetings,
    knowledge: new InMemoryKnowledgeRepository(),
    audit,
    clock,
    policy: new PolicyEngine(policyOptions),
    authorizationTtlMs: 1_000,
  })
  await platform.createMeeting(organizer, {
    id: 'meeting-1', tenantId: tenant, organizerId: organizer.userId,
    participantIds: [organizer.userId, participant.userId], classification,
  })
  const record = meetings.get(tenant, 'meeting-1')
  record.retentionState = retentionState
  meetings.save(record)
  return { server: createHttpServer(platform), platform, meetings, audit, clock }
}

async function withServer(options, run) {
  const state = (await setup(options))
  await new Promise((resolve) => state.server.listen(0, '127.0.0.1', resolve))
  const address = state.server.address()
  try { await run({ ...state, base: `http://127.0.0.1:${address.port}` }) }
  finally { await new Promise((resolve) => state.server.close(resolve)) }
}

function headers(actor, correlationId = 'corr-http') {
  return { 'content-type': 'application/json', 'x-tenant-id': actor.tenantId, 'x-user-id': actor.userId, 'x-correlation-id': correlationId }
}

async function post(base, path, actor, body = {}, correlationId) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: headers(actor, correlationId), body: typeof body === 'string' ? body : JSON.stringify(body) })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function get(base, path, actor, correlationId = 'corr-http-get') {
  const response = await fetch(`${base}${path}`, { method: 'GET', headers: headers(actor, correlationId) })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

const granted = (actor, overrides = {}) => ({
  participantId: actor.userId,
  capturedAt: '2026-09-30T11:59:00Z', expiresAt: '2026-09-30T13:00:00Z',
  policyVersion: 'v1', decision: 'granted', method: 'explicit', ...overrides,
})

async function consentAll(base) {
  for (const actor of [organizer, participant]) {
    const result = await post(base, '/meetings/meeting-1/consent', actor, granted(actor), `consent-${actor.userId}`)
    assert.equal(result.response.status, 204)
    assert.equal(result.body, null)
  }
}

test('consent and preflight issue a short-lived meeting lease and content-free audits', async () => {
  await withServer({}, async ({ base, audit }) => {
    await consentAll(base)
    const { response, body } = await post(base, '/meetings/meeting-1/recording/preflight', organizer, {}, 'preflight-ok')
    assert.equal(response.status, 200)
    assert.equal(body.status, 'authorized')
    assert.equal(body.authorizationExpiresAt, '2026-09-30T12:00:01.000Z')
    assert.match(body.leaseId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(body.allowedMimeTypes, ['audio/webm', 'audio/ogg', 'audio/mp4'])
    assert.ok(audit.all().some((event) => event.action === 'consent.record' && event.outcome === 'allowed'))
    assert.ok(audit.all().some((event) => event.correlationId === 'preflight-ok' && event.action === 'recording.preflight' && event.outcome === 'allowed'))
  })
})

test('preflight refresh replaces the lease and extends expiry after time advances', async () => {
  await withServer({}, async ({ base, clock, platform }) => {
    await consentAll(base)
    const first = await post(base, '/meetings/meeting-1/recording/preflight', organizer)
    clock.advance(500)
    const refreshed = await post(base, '/meetings/meeting-1/recording/preflight', organizer)
    assert.equal(first.body.authorizationExpiresAt, '2026-09-30T12:00:01.000Z')
    assert.equal(refreshed.body.authorizationExpiresAt, '2026-09-30T12:00:01.500Z')
    assert.equal(refreshed.body.status, 'authorized')
  })
})

test('expired consent denies preflight and audits the denial', async () => {
  await withServer({}, async ({ base, audit }) => {
    await post(base, '/meetings/meeting-1/consent', organizer, granted(organizer))
    await post(base, '/meetings/meeting-1/consent', participant, granted(participant, { expiresAt: '2026-09-30T12:00:00Z' }))
    const { response, body } = await post(base, '/meetings/meeting-1/recording/preflight', organizer, {}, 'expired-consent')
    assert.equal(response.status, 403)
    assert.equal(body.error.code, 'CONSENT_EXPIRED')
    assert.equal(body.correlationId, 'expired-consent')
    assert.equal(audit.all().find((event) => event.correlationId === 'expired-consent').reason, 'CONSENT_EXPIRED')
  })
})

test('missing, declined, withdrawn, stale, and future consent fail closed', async () => {
  for (const [mutation, code] of [
    [null, 'CONSENT_REQUIRED'],
    [{ decision: 'declined' }, 'CONSENT_NOT_GRANTED'],
    [{ decision: 'withdrawn' }, 'CONSENT_NOT_GRANTED'],
    [{ policyVersion: 'old' }, 'CONSENT_POLICY_MISMATCH'],
    [{ capturedAt: '2026-09-30T12:00:01Z' }, 'CONSENT_MALFORMED'],
  ]) {
    await withServer({}, async ({ base }) => {
      await post(base, '/meetings/meeting-1/consent', organizer, granted(organizer))
      if (mutation) await post(base, '/meetings/meeting-1/consent', participant, granted(participant, mutation))
      const result = await post(base, '/meetings/meeting-1/recording/preflight', organizer)
      assert.equal(result.response.status, 403)
      assert.equal(result.body.error.code, code)
    })
  }
})

test('never-record, unknown, sensitive, and inactive meetings deny preflight', async () => {
  for (const [options, code] of [
    [{ classification: 'legal-privileged' }, 'NEVER_RECORD'],
    [{ classification: 'unknown-purpose' }, 'CLASSIFICATION_REQUIRED'],
    [{ classification: 'board-confidential', policyOptions: { organizationSensitiveCategories: ['board-confidential'] } }, 'SENSITIVE_RECORDING_DENIED'],
    [{ retentionState: 'pending-deletion' }, 'RETENTION_RESTRICTED'],
  ]) {
    await withServer(options, async ({ base }) => {
      await consentAll(base)
      const result = await post(base, '/meetings/meeting-1/recording/preflight', organizer)
      assert.equal(result.response.status, 403)
      assert.equal(result.body.error.code, code)
    })
  }
})

test('cross-tenant lookup is non-enumerable and non-organizer preflight is forbidden', async () => {
  await withServer({}, async ({ base }) => {
    const crossTenant = await post(base, '/meetings/meeting-1/recording/preflight', { tenantId: 'other', userId: 'alex' })
    assert.equal(crossTenant.response.status, 404)
    assert.equal(crossTenant.body.error.code, 'MEETING_NOT_FOUND')
    const nonOrganizer = await post(base, '/meetings/meeting-1/recording/preflight', participant)
    assert.equal(nonOrganizer.response.status, 403)
    assert.equal(nonOrganizer.body.error.code, 'NOT_ORGANIZER')
  })
})

test('consent endpoint enforces tenant, participant identity, and meeting membership', async () => {
  await withServer({}, async ({ base }) => {
    const crossTenant = await post(base, '/meetings/meeting-1/consent', { tenantId: 'other', userId: 'sam' }, granted({ userId: 'sam' }))
    assert.equal(crossTenant.response.status, 404)
    const impersonation = await post(base, '/meetings/meeting-1/consent', organizer, granted(participant))
    assert.equal(impersonation.response.status, 403)
    assert.equal(impersonation.body.error.code, 'CONSENT_FORBIDDEN')
    const outsider = { tenantId: tenant, userId: 'outsider' }
    const unrelated = await post(base, '/meetings/meeting-1/consent', outsider, granted(outsider))
    assert.equal(unrelated.response.status, 403)
  })
})

test('malformed JSON, absent identity, wrong media type, and strict schemas are rejected', async () => {
  await withServer({}, async ({ base }) => {
    const malformed = await post(base, '/meetings/meeting-1/consent', participant, '{')
    assert.equal(malformed.response.status, 400)
    assert.equal(malformed.body.error.code, 'INVALID_JSON')

    const missingIdentityResponse = await fetch(`${base}/meetings/meeting-1/recording/preflight`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'missing-identity' }, body: '{}' })
    assert.equal(missingIdentityResponse.status, 401)

    const wrongMedia = await fetch(`${base}/meetings/meeting-1/recording/preflight`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-tenant-id': tenant, 'x-user-id': organizer.userId, 'x-correlation-id': 'wrong-media' }, body: '{}' })
    assert.equal(wrongMedia.status, 415)

    const extraConsent = await post(base, '/meetings/meeting-1/consent', participant, { ...granted(participant), prose: 'SECRET CONSENT PROSE' })
    assert.equal(extraConsent.response.status, 400)
    assert.equal(extraConsent.body.error.code, 'INVALID_REQUEST')

    const audioAttempt = await post(base, '/meetings/meeting-1/recording/preflight', organizer, { audio: 'BASE64-AUDIO-CANARY', deviceLabel: 'private microphone' })
    assert.equal(audioAttempt.response.status, 400)
    assert.equal(audioAttempt.body.error.code, 'INVALID_REQUEST')
  })
})

test('consent and preflight audit records never contain prose, audio, device, or transcript fields', async () => {
  await withServer({}, async ({ base, audit }) => {
    await post(base, '/meetings/meeting-1/consent', participant, { ...granted(participant), method: 'explicit-ui' }, 'audit-consent')
    await post(base, '/meetings/meeting-1/recording/preflight', organizer, { audio: 'AUDIO-CANARY' }, 'audit-invalid-body')
    const serialized = JSON.stringify(audit.all().filter((event) => ['consent.record', 'recording.preflight'].includes(event.action)))
    for (const forbidden of ['AUDIO-CANARY', 'deviceLabel', 'transcript', 'consent prose', 'explicit-ui']) assert.equal(serialized.includes(forbidden), false)
  })
})

test('approved endpoints require correlation and exact consent contract values', async () => {
  await withServer({}, async ({ base }) => {
    const missingCorrelation = await fetch(`${base}/meetings/meeting-1/recording/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenant, 'x-user-id': organizer.userId },
      body: '{}',
    })
    assert.equal(missingCorrelation.status, 400)
    const missingCorrelationBody = await missingCorrelation.json()
    assert.deepEqual(missingCorrelationBody.error, { code: 'INVALID_HEADER', message: 'x-correlation-id is required' })
    assert.match(missingCorrelationBody.correlationId, /^[0-9a-f-]{36}$/)

    const missingMethod = await post(base, '/meetings/meeting-1/consent', participant, {
      ...granted(participant), method: undefined,
    }, 'missing-method')
    assert.equal(missingMethod.response.status, 400)
    assert.equal(missingMethod.body.error.code, 'INVALID_REQUEST')

    const wrongMethod = await post(base, '/meetings/meeting-1/consent', participant, {
      ...granted(participant), method: 'implicit',
    }, 'wrong-method')
    assert.equal(wrongMethod.response.status, 400)
    assert.equal(wrongMethod.body.correlationId, 'wrong-method')
  })
})

test('privacy access endpoint applies the shared hierarchy policy and returns only redacted drawer data', async () => {
  await withServer({ policyOptions: { managementGrants: [{ tenantId: tenant, managerId: 'ceo', subordinateIds: ['alex'], expiresAt: '2026-10-01T00:00:00Z' }] } }, async ({ base }) => {
    const participantRead = await get(base, '/meetings/meeting-1/privacy-access', participant, 'privacy-participant')
    assert.equal(participantRead.response.status, 200)
    assert.deepEqual(participantRead.body.access, { posture: 'participant', authorized: true })
    assert.deepEqual(participantRead.body.retention, { state: 'active', deletion: 'not-requested' })
    assert.equal('meeting' in participantRead.body, false)
    assert.equal('auditTimeline' in participantRead.body, true)

    const managementRead = await get(base, '/meetings/meeting-1/privacy-access', { tenantId: tenant, userId: 'ceo' }, 'privacy-management')
    assert.equal(managementRead.response.status, 200)
    assert.equal(managementRead.body.access.posture, 'management-chain')

    const denied = await get(base, '/meetings/meeting-1/privacy-access', { tenantId: tenant, userId: 'outsider' }, 'privacy-denied')
    assert.equal(denied.response.status, 404)
    assert.equal(denied.body.error.code, 'MEETING_NOT_FOUND')
    assert.equal('classification' in denied.body, false)
    assert.equal(JSON.stringify(denied.body).includes('meeting-1'), false)
  })
})

test('privacy access reads are non-enumerable for unauthorized, absent, and cross-tenant meeting IDs', async () => {
  await withServer({}, async ({ base, audit }) => {
    const cases = [
      ['existing-private', '/meetings/meeting-1/privacy-access', { tenantId: tenant, userId: 'outsider' }],
      ['absent', '/meetings/missing-meeting/privacy-access', { tenantId: tenant, userId: 'outsider' }],
      ['cross-tenant', '/meetings/meeting-1/privacy-access', { tenantId: 'other', userId: 'outsider' }],
    ]
    const responses = []
    for (const [correlationId, path, actor] of cases) responses.push(await get(base, path, actor, correlationId))

    for (const result of responses) {
      assert.equal(result.response.status, 404)
      assert.deepEqual(result.body, { error: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found' } })
    }
    assert.deepEqual(responses.map((result) => result.body), [responses[0].body, responses[0].body, responses[0].body])
    for (const result of responses) {
      const body = JSON.stringify(result.body)
      for (const secret of ['meeting-1', 'missing-meeting', 'northstar', 'other', 'outsider', 'existing-private', 'absent', 'cross-tenant', 'MEETING_FORBIDDEN', 'TENANT_MISMATCH', 'RETENTION_RESTRICTED', 'Principal']) {
        assert.equal(body.includes(secret), false)
      }
    }
    assert.deepEqual(cases.map(([correlationId]) => {
      const event = audit.all().find((entry) => entry.correlationId === correlationId)
      return { correlationId: event.correlationId, action: event.action, outcome: event.outcome, reason: event.reason }
    }), [
      { correlationId: 'existing-private', action: 'privacy-access.read', outcome: 'denied', reason: 'MEETING_FORBIDDEN' },
      { correlationId: 'absent', action: 'privacy-access.read', outcome: 'denied', reason: 'MEETING_NOT_FOUND' },
      { correlationId: 'cross-tenant', action: 'privacy-access.read', outcome: 'denied', reason: 'MEETING_NOT_FOUND' },
    ])
  })
})

test('commitment query endpoint refuses direct action writes and stays opaque for hidden meetings', async () => {
  await withServer({}, async ({ base, platform, audit }) => {
    await consentAll(base)
    const canary = 'HTTP-DIRECT-ACTION-CANARY'
    await assert.rejects(async () => (await platform.addAssertions(organizer, 'meeting-1', [{
      id: 'http-action', kind: 'action', text: canary, citations: ['http-action-segment'],
      commitment: { ownerId: 'sam', deadline: '2026-10-15T17:00:00-04:00', status: 'open' },
      provenance: { source: 'speech-processor', canonicalOrigin: 'processor-normalized-v1' },
    }])), { code: 'UNTRUSTED_ACTION_ASSERTION' })

    const allowed = await get(base, '/commitments?query=dependency', participant, 'http-commitment-allowed')
    assert.equal(allowed.response.status, 200)
    assert.deepEqual(allowed.body, { commitments: [] })

    const unrelated = await get(base, '/commitments?query=dependency', { tenantId: tenant, userId: 'outsider' }, 'http-commitment-unrelated')
    const crossTenant = await get(base, '/commitments?query=dependency', { tenantId: 'other', userId: 'outsider' }, 'http-commitment-cross')
    assert.equal(unrelated.response.status, 200)
    assert.deepEqual(unrelated.body, { commitments: [] })
    assert.deepEqual(crossTenant.body, { commitments: [] })
    const serialized = JSON.stringify([unrelated.body, crossTenant.body])
    for (const secret of ['meeting-1', canary, 'northstar', 'MEETING_FORBIDDEN']) assert.equal(serialized.includes(secret), false)
    assert.equal(audit.all().some((event) => event.action === 'commitment.query' && event.meetingId === 'meeting-1'), false)
  })
})

test('management briefing endpoint is tenant-scoped, cited, and neutral when no source is authorized', async () => {
  await withServer({}, async ({ base, platform, audit }) => {
    platform.knowledge.addSegments([{ id: 'brief-segment', tenantId: tenant, meetingId: 'meeting-1', startMs: 0, endMs: 1, diarizationLabel: 'SPEAKER_00', text: 'Privacy review blocks launch.' }])
    platform.knowledge.addAssertions([{
      id: 'brief-risk', tenantId: tenant, meetingId: 'meeting-1', kind: 'risk', text: 'Privacy review is a blocker.',
      citations: ['brief-segment'], provenance: { source: 'speech-processor', raw: 'HTTP-BRIEF-PROCESSOR-CANARY' },
    }])
    await platform.createMeeting(organizer, { id: 'hidden-brief', tenantId: tenant, organizerId: organizer.userId, participantIds: [organizer.userId, 'bob'], classification: 'standard' })
    platform.knowledge.addSegments([{ id: 'hidden-brief-segment', tenantId: tenant, meetingId: 'hidden-brief', startMs: 0, endMs: 1, diarizationLabel: 'SPEAKER_00', text: 'HTTP-HIDDEN-BRIEF-CANARY' }])
    platform.knowledge.addAssertions([{ id: 'hidden-brief-risk', tenantId: tenant, meetingId: 'hidden-brief', kind: 'risk', text: 'HTTP-HIDDEN-BRIEF-CANARY', citations: ['hidden-brief-segment'], provenance: {} }])

    const allowed = await get(base, '/management-briefing', participant, 'http-briefing-allowed')
    const unrelated = await get(base, '/management-briefing', { tenantId: tenant, userId: 'outsider' }, 'http-briefing-unrelated')
    const crossTenant = await get(base, '/management-briefing', { tenantId: 'other', userId: 'outsider' }, 'http-briefing-cross')
    assert.equal(allowed.response.status, 200)
    assert.deepEqual(allowed.body.briefing.counts, { decisions: 0, risks: 1, blockers: 1, openActions: 0 })
    assert.deepEqual(allowed.body.briefing.risks[0].source, { meetingId: 'meeting-1', assertionId: 'brief-risk', citations: ['brief-segment'] })
    assert.equal(unrelated.response.status, 200)
    assert.deepEqual(unrelated.body, { briefing: { counts: { decisions: 0, risks: 0, blockers: 0, openActions: 0 }, decisions: [], risks: [], blockers: [], actions: [] } })
    assert.deepEqual(crossTenant.body, unrelated.body)
    const serialized = JSON.stringify([allowed.body, unrelated.body, crossTenant.body])
    for (const secret of ['hidden-brief', 'HTTP-HIDDEN-BRIEF-CANARY', 'HTTP-BRIEF-PROCESSOR-CANARY', '"raw"', 'northstar', 'MEETING_FORBIDDEN']) assert.equal(serialized.includes(secret), false)
    assert.equal(audit.all().filter((item) => String(item.correlationId).startsWith('http-briefing-')).every((item) => item.action === 'management-briefing.read' && item.meetingId === null), true)
  })
})

test('Microsoft Teams readiness is explicit about its unconnected capability boundary', async () => {
  await withServer({}, async ({ base, audit }) => {
    const result = await get(base, '/integrations/microsoft-teams/readiness', organizer, 'teams-readiness')
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body.capabilities, {
      meetingMetadata: false,
      cloudRecordingImport: false,
      liveBotCapture: false,
      changeNotificationIngestion: false,
    })
    assert.equal(result.body.connection, 'not-connected')
    assert.equal(result.body.oauth.secretsAcceptedHere, false)
    assert.equal(audit.all().find((event) => event.correlationId === 'teams-readiness').action, 'teams.readiness')
  })
})

test('pipeline readiness is loopback-only, authentication-bound, and contains no configuration values', async () => {
  await withServer({}, async ({ base, audit }) => {
    const result = await get(base, '/pipeline/readiness', organizer, 'pipeline-readiness')
    assert.equal(result.response.status, 200)
    assert.equal(result.body.scope, 'loopback-only')
    assert.equal(typeof result.body.whisper.runtimeAvailable, 'boolean')
    assert.equal(typeof result.body.whisper.modelCacheReady, 'boolean')
    assert.equal(typeof result.body.anthropic.credentialsConfigured, 'boolean')
    assert.equal(result.body.teams.connection, 'not-connected')
    assert.equal(audit.all().find((event) => event.correlationId === 'pipeline-readiness').action, 'teams.readiness')
  })

  const { platform } = (await setup())
  const handler = createHttpHandler(platform, { pipelineReadiness: { inspect: () => ({ unexpected: 'must-not-be-returned' }) } })
  const response = { status: null, body: null, writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await handler({ method: 'GET', url: '/pipeline/readiness', socket: { remoteAddress: '192.168.1.20' }, headers: { host: 'localhost:4173' } }, response)
  assert.equal(response.status, 403)
  assert.deepEqual(JSON.parse(response.body), { error: { code: 'LOCAL_ONLY', message: 'The meeting API is available only on this machine until enterprise sign-in is configured' } })
})

test('Microsoft Teams import handoff is consent-gated and refuses URLs or credentials without persisting them', async () => {
  await withServer({}, async ({ base, audit }) => {
    const withoutConsent = await post(base, '/meetings/meeting-1/integrations/microsoft-teams/import', organizer, { teamsMeetingId: 'teams_123456', source: 'cloud-recording' }, 'teams-without-consent')
    assert.equal(withoutConsent.response.status, 403)
    assert.equal(withoutConsent.body.error.code, 'CONSENT_REQUIRED')

    await consentAll(base)
    const malformed = await post(base, '/meetings/meeting-1/integrations/microsoft-teams/import', organizer, { teamsMeetingId: 'teams_123456', source: 'cloud-recording', accessToken: 'ENTRA-TOKEN-CANARY' }, 'teams-malformed')
    assert.equal(malformed.response.status, 400)
    assert.equal(malformed.body.error.code, 'INVALID_TEAMS_IMPORT')

    const unconnected = await post(base, '/meetings/meeting-1/integrations/microsoft-teams/import', organizer, { teamsMeetingId: 'teams_123456', source: 'cloud-recording' }, 'teams-unconnected')
    assert.equal(unconnected.response.status, 409)
    assert.equal(unconnected.body.error.code, 'TEAMS_NOT_CONNECTED')
    const serialized = JSON.stringify(audit.all())
    for (const forbidden of ['teams_123456', 'ENTRA-TOKEN-CANARY', 'accessToken']) assert.equal(serialized.includes(forbidden), false)
  })
})
