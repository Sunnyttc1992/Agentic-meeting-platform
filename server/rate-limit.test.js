import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryAppendOnlyAudit, InMemoryKnowledgeRepository, InMemoryMeetingRepository, FixedClock } from './adapters/in-memory.js'
import { createHttpServer } from './http.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { createRateLimiter, RATE_LIMITS_PER_MINUTE, rateLimitClass } from './rate-limit.js'

test('expensive and data-moving routes get their own, tighter limit classes', () => {
  assert.equal(rateLimitClass('POST', '/meetings/m/recordings/r/process'), 'processing')
  assert.equal(rateLimitClass('POST', '/meetings/m/recordings/r/retry'), 'processing')
  assert.equal(rateLimitClass('POST', '/meetings/m/recording/preflight'), 'capture')
  assert.equal(rateLimitClass('POST', '/meetings/m/recordings'), 'capture')
  assert.equal(rateLimitClass('PUT', '/meetings/m/recordings/r/bytes'), 'capture')
  assert.equal(rateLimitClass('DELETE', '/meetings/m/recordings'), 'capture')
  assert.equal(rateLimitClass('GET', '/meetings/m/export'), 'export')
  assert.equal(rateLimitClass('POST', '/ai/retrieve'), 'ai')
  assert.equal(rateLimitClass('GET', '/meetings/m/recordings/r'), 'standard', 'status polling is ordinary')
  assert.ok(RATE_LIMITS_PER_MINUTE.processing < RATE_LIMITS_PER_MINUTE.export && RATE_LIMITS_PER_MINUTE.export < RATE_LIMITS_PER_MINUTE.standard)
  assert.ok(RATE_LIMITS_PER_MINUTE.standard >= 60_000 / 350, 'the studio status poll fits inside the standard budget')
})

test('the limiter is per principal and per class, resets each window, and reports Retry-After', () => {
  let at = 0
  const limiter = createRateLimiter({ limits: { processing: 2, standard: 5 }, now: () => at })
  assert.equal(limiter.check('northstar:alex', 'processing').allowed, true)
  assert.equal(limiter.check('northstar:alex', 'processing').allowed, true)
  at = 15_000
  assert.deepEqual(limiter.check('northstar:alex', 'processing'), { allowed: false, retryAfterSeconds: 45 })
  assert.equal(limiter.check('northstar:sam', 'processing').allowed, true, 'another principal has its own budget')
  assert.equal(limiter.check('southstar:alex', 'processing').allowed, true, 'the same user name in another tenant is separate')
  assert.equal(limiter.check('northstar:alex', 'standard').allowed, true, 'other classes are unaffected')
  at = 60_000
  assert.equal(limiter.check('northstar:alex', 'processing').allowed, true, 'a new window restores the budget')
})

test('a flood of fabricated identities cannot grow the limiter without bound', () => {
  let at = 0
  const limiter = createRateLimiter({ now: () => at })
  for (let index = 0; index < 10_000; index += 1) assert.equal(limiter.check(`t:user-${index}`, 'standard').allowed, true)
  assert.equal(limiter.check('t:one-too-many', 'standard').allowed, false, 'new keys are refused while the table is full')
  at = 60_000
  assert.equal(limiter.check('t:after-window', 'standard').allowed, true, 'expired windows are pruned to make room')
})

test('the API answers 429 with Retry-After before doing any platform work or writing audit events', async () => {
  const audit = new InMemoryAppendOnlyAudit()
  const platform = new MeetingIntelligencePlatform({ meetings: new InMemoryMeetingRepository(), knowledge: new InMemoryKnowledgeRepository(), audit, clock: new FixedClock('2026-10-03T12:00:00Z'), policy: new PolicyEngine() })
  await platform.createMeeting({ tenantId: 'northstar', userId: 'alex' }, { id: 'meeting-1', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard' })
  const server = createHttpServer(platform)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const exportAs = (userId) => fetch(`${base}/meetings/meeting-1/export`, { headers: { 'x-tenant-id': 'northstar', 'x-user-id': userId, 'x-correlation-id': `corr-${userId}` } })
  try {
    for (let index = 0; index < RATE_LIMITS_PER_MINUTE.export; index += 1) assert.equal((await exportAs('sam')).status, 409, 'within budget the platform answers normally')
    const auditedBefore = audit.all().length
    const throttled = await exportAs('sam')
    assert.equal(throttled.status, 429)
    assert.ok(Number(throttled.headers.get('retry-after')) >= 1)
    assert.deepEqual(await throttled.json(), { error: { code: 'RATE_LIMITED', message: 'Too many requests; please wait and try again' }, correlationId: 'corr-sam' })
    assert.equal(audit.all().length, auditedBefore, 'throttled requests never reach the platform or the audit log')
    assert.equal((await exportAs('alex')).status, 409, 'another participant is not throttled by sam')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
