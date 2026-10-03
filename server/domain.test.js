import test from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeAssertion } from './domain.js'

test('knowledge assertions independently reject non-string manual-facing fields', () => {
  const canary = 'DOMAIN-MANUAL-ASSERTION-CANARY'
  const invalids = [
    ['id', { canary }, 'INVALID_ASSERTION'], ['id', [canary], 'INVALID_ASSERTION'],
    ['kind', { canary }, 'INVALID_ASSERTION'], ['kind', ['finding'], 'INVALID_ASSERTION'],
    ['text', { canary }, 'INVALID_ASSERTION'], ['text', [canary], 'INVALID_ASSERTION'],
    ['citations', { canary }, 'UNCITED_ASSERTION'], ['citations', [[canary]], 'UNCITED_ASSERTION'],
  ]

  for (const [field, payload, code] of invalids) {
    const value = {
      id: 'manual-domain', tenantId: 'northstar', meetingId: 'meeting-1',
      kind: 'finding', text: 'A cited manual finding', citations: ['segment-1'],
    }
    value[field] = payload
    assert.throws(() => knowledgeAssertion(value), { code })
  }
})
