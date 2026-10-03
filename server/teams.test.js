import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryAppendOnlyAudit, InMemoryKnowledgeRepository, InMemoryMeetingRepository, FixedClock } from './adapters/in-memory.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { MicrosoftTeamsIntegrationAdapter, teamsImportHandoff, teamsReadiness } from './teams.js'

const organizer = { tenantId: 'northstar', userId: 'alex' }
const participant = { tenantId: 'northstar', userId: 'sam' }

async function setup() {
  const meetings = new InMemoryMeetingRepository()
  const audit = new InMemoryAppendOnlyAudit()
  const platform = new MeetingIntelligencePlatform({
    meetings, knowledge: new InMemoryKnowledgeRepository(), audit,
    policy: new PolicyEngine(), clock: new FixedClock('2026-09-30T12:00:00Z'),
    teamsIntegration: new MicrosoftTeamsIntegrationAdapter(),
  })
  await platform.createMeeting(organizer, {
    id: 'meeting-1', tenantId: 'northstar', organizerId: 'alex',
    participantIds: ['alex', 'sam'], classification: 'standard',
  })
  return { platform, audit }
}

async function grant(platform, actor) {
  await platform.recordConsent(actor, 'meeting-1', {
    participantId: actor.userId, capturedAt: '2026-09-30T11:59:00Z',
    expiresAt: '2026-09-30T13:00:00Z', policyVersion: 'v1', decision: 'granted', method: 'explicit',
  })
}

test('Teams readiness exposes no secret, identifier, or live-connect claim', () => {
  const readiness = teamsReadiness({
    entraClientId: 'public-client-id', entraTenantId: 'tenant-configuration', redirectUri: 'http://localhost:4173/teams/callback',
  })
  assert.equal(readiness.integration, 'microsoft-teams')
  assert.equal(readiness.status, 'administrator-setup-required')
  assert.equal(readiness.connection, 'not-connected')
  assert.equal(readiness.oauth.secretsAcceptedHere, false)
  assert.equal(readiness.oauth.tenantConfigured, true)
  assert.equal(readiness.capabilities.cloudRecordingImport, false)
  const serialized = JSON.stringify(readiness)
  for (const value of ['public-client-id', 'tenant-configuration', '/teams/callback']) assert.equal(serialized.includes(value), false)
})

test('Teams handoff rejects URLs, credentials, and unapproved sources', () => {
  assert.deepEqual(teamsImportHandoff({ teamsMeetingId: 'teams_123456', source: 'cloud-recording' }), { teamsMeetingId: 'teams_123456', source: 'cloud-recording' })
  for (const body of [
    { teamsMeetingId: 'https://teams.example/recording', source: 'cloud-recording' },
    { teamsMeetingId: 'teams_123456', source: 'cloud-recording', accessToken: 'ENTRA-TOKEN-CANARY' },
    { teamsMeetingId: 'teams_123456', source: 'live-bot' },
  ]) assert.throws(() => teamsImportHandoff(body))
})

test('Teams import handoff requires current meeting consent before connection state', async () => {
  const { platform, audit } = (await setup())
  await assert.rejects(async () => (await platform.prepareTeamsImport(organizer, 'meeting-1', { teamsMeetingId: 'teams_123456', source: 'cloud-recording' })), { code: 'CONSENT_REQUIRED' })
  await grant(platform, organizer)
  await grant(platform, participant)
  await assert.rejects(async () => (await platform.prepareTeamsImport(organizer, 'meeting-1', { teamsMeetingId: 'teams_123456', source: 'cloud-recording' }, 'teams-import')), { code: 'TEAMS_NOT_CONNECTED' })
  const event = audit.all().find((item) => item.correlationId === 'teams-import')
  assert.deepEqual({ action: event.action, outcome: event.outcome, reason: event.reason }, { action: 'teams.import.prepare', outcome: 'denied', reason: 'TEAMS_NOT_CONNECTED' })
  assert.equal(JSON.stringify(audit.all()).includes('teams_123456'), false)
})
