import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_CHAIN_GENESIS, auditEventHash, sealAuditEvent, verifyAuditChain } from './audit.js'
import { InMemoryAppendOnlyAudit, InMemoryKnowledgeRepository, InMemoryMeetingRepository, FixedClock } from './adapters/in-memory.js'
import { createHttpServer } from './http.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { createInMemoryMeetingStorage } from './storage.js'

const tenant = 'northstar'
const organizer = { tenantId: tenant, userId: 'alex' }
const auditor = { tenantId: tenant, userId: 'audra' }

function chainOf(count, tenantId = tenant) {
  const audit = new InMemoryAppendOnlyAudit()
  for (let index = 0; index < count; index += 1) {
    audit.append({ id: `event-${index}`, tenantId, action: 'knowledge.read', outcome: 'allowed', reason: null, meetingId: 'meeting-1', occurredAt: `2026-09-30T12:00:0${index}Z` })
  }
  return audit
}

// An attacker who can write the store recomputes the edited event's own hash.
const reseal = (event) => {
  const copy = { ...event }
  delete copy.hash
  return { ...copy, hash: auditEventHash(copy) }
}

test('audit store mints a tenant-local hash chain that verifies end to end', () => {
  const audit = chainOf(4)
  audit.append({ id: 'south-1', tenantId: 'southstar', action: 'knowledge.read', outcome: 'denied', reason: 'MEETING_FORBIDDEN' })
  const north = audit.chain(tenant)
  const south = audit.chain('southstar')
  assert.deepEqual(north.map((event) => event.sequence), [1, 2, 3, 4])
  assert.equal(north[0].previousHash, AUDIT_CHAIN_GENESIS)
  assert.equal(north[1].previousHash, north[0].hash)
  assert.equal(south[0].sequence, 1, 'another tenant starts its own chain')
  assert.equal(south[0].previousHash, AUDIT_CHAIN_GENESIS)
  assert.deepEqual(verifyAuditChain(north, { tenantId: tenant }), { valid: true, checked: 4, head: { sequence: 4, hash: north[3].hash }, failure: null })
  assert.equal(verifyAuditChain(south, { tenantId: 'southstar' }).valid, true)
  assert.deepEqual(verifyAuditChain([], { tenantId: tenant }), { valid: true, checked: 0, head: null, failure: null })
})

test('callers cannot supply chain position or hashes', () => {
  const audit = chainOf(1)
  for (const field of ['sequence', 'previousHash', 'hash', 'chainVersion']) {
    assert.throws(() => audit.append({ id: 'forged', tenantId: tenant, action: 'x', outcome: 'allowed', [field]: 1 }), { code: 'INVALID_AUDIT_EVENT' })
  }
  assert.throws(() => sealAuditEvent({ id: 'cross', tenantId: 'southstar' }, audit.chain(tenant)[0]), { code: 'TENANT_SCOPE_VIOLATION' })
  assert.equal(audit.chain(tenant).length, 1)
})

test('verification detects edits, deletions, reordering, splices, and foreign events', () => {
  const chain = chainOf(5).chain(tenant)
  const verify = (events) => verifyAuditChain(events, { tenantId: tenant }).failure

  const edited = chain.map((event) => ({ ...event }))
  edited[2].outcome = 'denied'
  assert.deepEqual(verify(edited), { sequence: 3, reason: 'HASH_MISMATCH' })

  const spliced = [...chain]
  spliced[2] = reseal({ ...chain[2], outcome: 'denied' })
  assert.deepEqual(verify(spliced), { sequence: 4, reason: 'CHAIN_BROKEN' }, 'a resealed edit breaks the next link')

  assert.deepEqual(verify([chain[0], chain[1], chain[3], chain[4]]), { sequence: 3, reason: 'SEQUENCE_GAP' })
  assert.deepEqual(verify([chain[0], chain[2], chain[1], chain[3], chain[4]]), { sequence: 2, reason: 'SEQUENCE_GAP' })

  const renumbered = [chain[0], chain[1], { ...chain[3], sequence: 3 }]
  assert.deepEqual(verify(renumbered), { sequence: 3, reason: 'CHAIN_BROKEN' })

  const foreign = chainOf(1, 'southstar').chain('southstar')[0]
  assert.deepEqual(verify([chain[0], foreign]), { sequence: 2, reason: 'TENANT_MISMATCH' })
  assert.deepEqual(verify([null]), { sequence: 1, reason: 'MALFORMED_EVENT' })
})

test('a retained head anchor detects truncation and a wholesale chain rewrite', () => {
  const chain = chainOf(5).chain(tenant)
  const anchor = { sequence: 4, hash: chain[3].hash }
  assert.equal(verifyAuditChain(chain, { tenantId: tenant, anchor }).valid, true)

  const truncated = verifyAuditChain(chain.slice(0, 3), { tenantId: tenant })
  assert.equal(truncated.valid, true, 'a chain alone cannot see its missing tail')
  assert.deepEqual(verifyAuditChain(chain.slice(0, 3), { tenantId: tenant, anchor }).failure, { sequence: 4, reason: 'ANCHOR_MISSING' })

  // Rewriting history and recomputing every later hash yields an internally
  // valid chain; only the externally retained anchor exposes it.
  const rewritten = []
  for (const event of chain) {
    const { sequence, previousHash, hash, chainVersion, ...envelope } = event
    rewritten.push(sealAuditEvent(sequence === 2 ? { ...envelope, outcome: 'denied' } : envelope, rewritten.at(-1) ?? null))
  }
  assert.equal(verifyAuditChain(rewritten, { tenantId: tenant }).valid, true)
  assert.deepEqual(verifyAuditChain(rewritten, { tenantId: tenant, anchor }).failure, { sequence: 4, reason: 'ANCHOR_MISMATCH' })

  assert.throws(() => verifyAuditChain(chain, { tenantId: tenant, anchor: { sequence: 0, hash: chain[0].hash } }), { code: 'INVALID_AUDIT_ANCHOR' })
  assert.throws(() => verifyAuditChain(chain, { tenantId: tenant, anchor: { sequence: 1, hash: 'not-a-hash' } }), { code: 'INVALID_AUDIT_ANCHOR' })
})

function platformSetup({ auditReaderGrants = [], storage = null } = {}) {
  const audit = new InMemoryAppendOnlyAudit()
  const clock = new FixedClock('2026-09-30T12:00:00Z')
  const policy = new PolicyEngine({ auditReaderGrants, managementGrants: [{ tenantId: tenant, managerId: 'ceo', subordinateIds: ['alex'] }] })
  const platform = storage
    ? new MeetingIntelligencePlatform({ storage, clock, policy })
    : new MeetingIntelligencePlatform({ meetings: new InMemoryMeetingRepository(), knowledge: new InMemoryKnowledgeRepository(), audit, clock, policy })
  platform.createMeeting(organizer, { id: 'meeting-1', tenantId: tenant, organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard' })
  platform.getMeetingKnowledge(organizer, 'meeting-1', 'corr-read')
  assert.throws(() => platform.getMeetingKnowledge({ tenantId: tenant, userId: 'outsider' }, 'meeting-1', 'corr-denied'))
  return { platform, audit, clock }
}

test('audit integrity requires an explicit, current, same-tenant audit-reader grant and every attempt is audited', () => {
  const { platform, audit, clock } = platformSetup({
    auditReaderGrants: [
      { tenantId: tenant, principalId: 'audra', expiresAt: '2026-09-30T13:00:00Z' },
      { tenantId: 'southstar', principalId: 'mallory' },
    ],
  })
  for (const [actor, label] of [[organizer, 'organizer'], [{ tenantId: tenant, userId: 'ceo' }, 'manager'], [{ tenantId: tenant, userId: 'mallory' }, 'other-tenant grant']]) {
    assert.throws(() => platform.verifyAuditIntegrity(actor, {}, `corr-deny-${label}`), { code: 'AUDIT_READER_REQUIRED' }, label)
    const denial = audit.all().at(-1)
    assert.deepEqual([denial.action, denial.outcome, denial.reason, denial.correlationId], ['audit.verify', 'denied', 'AUDIT_READER_REQUIRED', `corr-deny-${label}`])
  }

  const result = platform.verifyAuditIntegrity(auditor, {}, 'corr-verify')
  assert.deepEqual(Object.keys(result).sort(), ['checked', 'failure', 'head', 'valid'])
  assert.equal(result.valid, true)
  assert.equal(result.checked, audit.chain(tenant).length - 1, 'the verification event follows the reported head')
  assert.equal(audit.all().at(-1).action, 'audit.verify')
  assert.equal(audit.all().at(-1).outcome, 'allowed')
  assert.equal(verifyAuditChain(audit.chain(tenant), { tenantId: tenant }).valid, true)

  const anchored = platform.verifyAuditIntegrity(auditor, { anchor: result.head }, 'corr-anchored')
  assert.equal(anchored.valid, true)

  clock.advance(60 * 60 * 1000)
  assert.throws(() => platform.verifyAuditIntegrity(auditor, {}, 'corr-expired'), { code: 'AUDIT_READER_REQUIRED' })
})

test('audit integrity output is content-free and reports tampering only as a reason code', () => {
  const { platform, audit } = platformSetup({ auditReaderGrants: [{ tenantId: tenant, principalId: 'audra' }] })
  const tampered = audit.chain(tenant)
  tampered[1] = { ...tampered[1], outcome: 'TAMPER-CANARY' }
  const result = verifyAuditChain(tampered, { tenantId: tenant })
  assert.deepEqual(result.failure, { sequence: 2, reason: 'HASH_MISMATCH' })
  assert.doesNotMatch(JSON.stringify(result), /TAMPER-CANARY|meeting-1|corr-|alex|outsider/)
  assert.doesNotMatch(JSON.stringify(platform.verifyAuditIntegrity(auditor)), /meeting-1|corr-|alex|outsider|knowledge\.read/)
})

test('storage-backed platforms verify the audit chain through the tenant facade', () => {
  const storage = createInMemoryMeetingStorage()
  const { platform } = platformSetup({ storage, auditReaderGrants: [{ tenantId: tenant, principalId: 'audra' }] })
  const result = platform.verifyAuditIntegrity(auditor, {}, 'corr-storage')
  assert.equal(result.valid, true)
  assert.ok(result.checked >= 3)
  const chain = storage.scope({ tenantId: tenant }).audit.chain()
  assert.equal(chain.at(-1).action, 'audit.verify')
  assert.equal(verifyAuditChain(chain, { tenantId: tenant }).valid, true)
  assert.deepEqual(storage.scope({ tenantId: 'southstar' }).audit.chain(), [])
})

test('audit integrity HTTP route enforces the grant and strict anchor parameters', async () => {
  const { platform } = platformSetup({ auditReaderGrants: [{ tenantId: tenant, principalId: 'audra' }] })
  const server = createHttpServer(platform)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async (actor, query = '') => {
    const response = await fetch(`${base}/audit/integrity${query}`, { headers: { 'x-tenant-id': actor.tenantId, 'x-user-id': actor.userId, 'x-correlation-id': 'corr-http-audit' } })
    return { status: response.status, body: await response.json() }
  }
  try {
    const allowed = await get(auditor)
    assert.equal(allowed.status, 200)
    assert.equal(allowed.body.valid, true)
    const anchored = await get(auditor, `?anchorSequence=${allowed.body.head.sequence}&anchorHash=${allowed.body.head.hash}`)
    assert.equal(anchored.body.valid, true)
    assert.equal((await get(organizer)).status, 403)
    assert.equal((await get(auditor, '?anchorSequence=1')).body.error.code, 'INVALID_AUDIT_ANCHOR')
    assert.equal((await get(auditor, '?anchorSequence=-1&anchorHash=abc')).status, 400)
    assert.equal((await get(auditor, '?tenantId=southstar')).body.error.code, 'INVALID_REQUEST')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
