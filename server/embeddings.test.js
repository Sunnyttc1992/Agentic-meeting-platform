import test from 'node:test'
import assert from 'node:assert/strict'
import { FixedClock } from './adapters/in-memory.js'
import { cosineSimilarity, OllamaEmbedder } from './embeddings.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { createInMemoryMeetingStorage } from './storage.js'
import { runRagEvaluation } from '../evals/rag-harness.mjs'
import { CANARY } from '../evals/rag-cases.mjs'
import { conceptEmbedder as fakeEmbedder } from '../evals/concept-embedder.mjs'

test('the embedding client only talks to a local service and returns unit vectors', async () => {
  for (const baseUrl of ['http://example.com:11434', 'https://127.0.0.1:11434', 'http://10.0.0.5:11434']) {
    assert.throws(() => new OllamaEmbedder({ baseUrl }), /this computer/)
  }
  const requests = []
  const embedder = new OllamaEmbedder({ model: 'bge-m3', fetchImpl: async (url, init) => { requests.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ embeddings: JSON.parse(init.body).input.map(() => [3, 4]) }) } } })
  const vectors = await embedder.embed(['a', 'b'])
  assert.deepEqual(vectors, [[0.6, 0.8], [0.6, 0.8]])
  assert.equal(requests[0][0], 'http://127.0.0.1:11434/api/embed')
  assert.equal(requests[0][1].model, 'bge-m3')
  assert.equal(cosineSimilarity(vectors[0], vectors[1]), 1)
  const broken = new OllamaEmbedder({ fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [[1, 2], [3]] }) }) })
  await assert.rejects(broken.embed(['a', 'b']), /invalid/)
})

test('hybrid retrieval finds paraphrases, and never embeds a meeting the asker cannot read', async () => {
  const embedder = fakeEmbedder()
  const { rows, summary } = await runRagEvaluation({ embedder })
  assert.ok(rows.every((row) => row.retrievalMode === 'hybrid'))
  assert.equal(summary.overall.leaks, 0)
  assert.equal(rows.find((row) => row.id === 'P1').retrieval.hit, 1, '"relocating" finds the office move')
  assert.ok(summary.byCategory.paraphrase.recall > 0.47, 'better than keywords alone')
  assert.equal(embedder.embedded.some((text) => text.includes(CANARY)), false, 'restricted content is never sent for embedding')
})

async function seededPlatform(embedder) {
  const storage = createInMemoryMeetingStorage()
  const platform = new MeetingIntelligencePlatform({ storage, clock: new FixedClock('2026-10-06T12:00:00Z'), policy: new PolicyEngine(), embedder, authorizationTtlMs: 60_000 })
  const alex = { tenantId: 'northstar', userId: 'alex' }
  await platform.createMeeting(alex, { id: 'office', title: 'Office move', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex'], classification: 'standard' })
  await platform.recordConsent(alex, 'office', { participantId: 'alex', capturedAt: '2026-10-06T11:59:00Z', expiresAt: '2026-10-06T23:00:00Z', policyVersion: 'v1', decision: 'granted' })
  const authorization = await platform.authorizeRecording(alex, 'office')
  await platform.appendTranscript(alex, 'office', authorization, [{ id: 's1', speakerId: 'alex', startMs: 0, endMs: 4000, text: 'The team moves to the third floor in November.', provenance: { engine: 'test' } }])
  return { platform, alex }
}

test('vectors are built once, extended only for new knowledge, and deleted with the meeting', async () => {
  const embedder = fakeEmbedder()
  const { platform, alex } = await seededPlatform(embedder)
  assert.equal((await platform.askChat(alex, { question: 'When are we relocating?' })).turn.retrieval, 'hybrid')
  assert.equal((await platform.embeddings.forMeeting('northstar', 'office')).length, 1)
  const afterFirst = embedder.embedded.length
  await platform.askChat(alex, { question: 'Where is the office going?' })
  assert.equal(embedder.embedded.length, afterFirst + 1, 'only the new question is embedded')
  await platform.addAssertions(alex, 'office', [{ id: 'd1', kind: 'decision', text: 'Move to the third floor.', citations: ['s1'] }])
  await platform.askChat(alex, { question: 'relocation decision?' })
  assert.deepEqual(embedder.embedded.slice(-1), ['decision: Move to the third floor.'], 'only the new item is embedded')
  assert.equal((await platform.embeddings.forMeeting('northstar', 'office')).length, 2)
  await platform.deleteMeetingContent(alex, 'office')
  assert.deepEqual(await platform.embeddings.forMeeting('northstar', 'office'), [])
})

test('when the embedding service is down, chat falls back to keyword retrieval', async () => {
  const { platform, alex } = await seededPlatform(fakeEmbedder({ fail: true }))
  const { turn } = await platform.askChat(alex, { question: 'Which floor do we move to?' })
  assert.equal(turn.retrieval, 'keyword')
  assert.equal(turn.status, 'sources-only')
  assert.equal((await platform.askChat(alex, { question: 'When are we relocating?' })).turn.status, 'no-sources', 'a paraphrase needs the embeddings')
})
