import test from 'node:test'
import assert from 'node:assert/strict'
import { FixedClock, InMemoryAppendOnlyAudit } from './adapters/in-memory.js'
import { ChatQuota, checkGrounding, prepareOutbound, redactPersonalData, statedNumbers, validateQuestion } from './guardrails.js'
import { isExpired, selectMemory } from './chat-memory.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { createInMemoryMeetingStorage } from './storage.js'
import { conceptEmbedder } from '../evals/concept-embedder.mjs'

// ---------- guardrail layer: units ----------

test('input guardrail strips hidden characters and bounds the question', () => {
  const hidden = ['What', String.fromCodePoint(0x200b), ' did', String.fromCodePoint(0x202e), ' we', String.fromCodePoint(0), ' decide?'].join('')
  assert.equal(validateQuestion(`  ${hidden}\n `), 'What did we decide?')
  for (const bad of ['', '   ', 'x'.repeat(1001), null, 7]) assert.throws(() => validateQuestion(bad), { code: 'INVALID_CHAT_QUESTION' })
})

test('the daily quota stops a user at the limit and resets the next UTC day', () => {
  const clock = new FixedClock('2026-10-07T10:00:00Z')
  const quota = new ChatQuota({ limit: 2, clock })
  for (let index = 0; index < 2; index += 1) { quota.check('t', 'sam'); quota.record('t', 'sam') }
  assert.throws(() => quota.check('t', 'sam'), (error) => error.code === 'CHAT_QUOTA_EXCEEDED' && error.status === 429)
  quota.check('t', 'alex')
  clock.advance(24 * 60 * 60 * 1000)
  quota.check('t', 'sam')
})

test('redaction removes contact details and identifiers but keeps amounts, dates, and times', () => {
  const { text, count } = redactPersonalData('Mail priya.k@acme.com or call 415-555-0134 or +44 20 7946 0958. Receipt IOE0912345678, SSN 123-45-6789, card 4111 1111 1111 1111, account 99887766.')
  assert.equal(text, 'Mail [email] or call [phone] or [phone]. Receipt [case number], SSN [id number], card [card or account number], account [number].')
  assert.equal(count, 7)
  const kept = 'Approved $48,000 (1,250,000 total) on 2026-10-06 at 10:30 for November 15, in 2 weeks.'
  assert.deepEqual(redactPersonalData(kept), { text: kept, count: 0 })
  const outbound = prepareOutbound({ question: 'Who is priya.k@acme.com?', history: [{ question: 'q', answer: 'Call 415-555-0134.' }], excerpts: [{ label: 'E1', text: 'Write to priya.k@acme.com.' }] })
  assert.equal(outbound.request.question, 'Who is priya.k@acme.com?', 'the asker\'s own words are sent as written')
  assert.equal(outbound.request.excerpts[0].text, 'Write to [email].')
  assert.equal(outbound.request.history[0].answer, 'Call [phone].')
  assert.equal(outbound.redacted, 2)
})

test('stated numbers are read from digits, number words, and ordinals', () => {
  assert.deepEqual([...statedNumbers('forty eight thousand dollars')], [48000])
  assert.deepEqual([...statedNumbers('$48,000 approved')], [48000])
  assert.deepEqual([...statedNumbers('on November first, two open findings')].sort((a, b) => a - b), [1, 2])
  assert.deepEqual([...statedNumbers('one hundred and five')], [105])
})

test('the grounding check flags invented numbers and statements far from their sources', async () => {
  const sources = ['The budget owner approved forty eight thousand dollars for the vendor renewal.']
  const ok = await checkGrounding({ answer: 'The vendor budget of $48,000 was approved.', citedTexts: sources, sentTexts: sources, embedder: conceptEmbedder() })
  assert.deepEqual([ok.unsupportedNumbers, ok.unsupportedSentences, ok.allUnsupported, ok.method], [[], [], false, 'numbers+meaning'])
  const invented = await checkGrounding({ answer: 'The vendor budget of $99,000 was approved. The team relocates to the third floor soon.', citedTexts: sources, sentTexts: sources, embedder: conceptEmbedder() })
  assert.deepEqual(invented.unsupportedNumbers, [99000])
  assert.deepEqual(invented.unsupportedSentences, [1])
  const unrelated = await checkGrounding({ answer: 'The team relocates to the third floor soon.', citedTexts: sources, sentTexts: sources, embedder: conceptEmbedder() })
  assert.equal(unrelated.allUnsupported, true)
  const numbersOnly = await checkGrounding({ answer: 'It costs 12 dollars.', citedTexts: sources, sentTexts: sources })
  assert.deepEqual([numbersOnly.method, numbersOnly.unsupportedNumbers], ['numbers', [12]])
})

// ---------- memory layer: units ----------

test('memory keeps the last four turns and recalls only related older ones', async () => {
  const embedder = conceptEmbedder()
  const texts = ['Q: What is the vendor budget?\nA: 48,000 was approved.', 'Q: Who is hiring engineers?\nA: Recruiting.', 'Q: a\nA: b', 'Q: c\nA: d', 'Q: e\nA: f', 'Q: g\nA: h']
  const vectors = await embedder.embed(texts)
  const turns = texts.map((text, index) => ({ id: `t${index}`, question: text, createdAt: `2026-10-0${index + 1}T00:00:00Z`, memoryModel: embedder.model, memoryVector: vectors[index], meetingIds: [] }))
  const [question] = await embedder.embed(['Remind me about the supplier funding'])
  const { working, recalled } = selectMemory({ turns, questionVector: question, model: embedder.model })
  assert.deepEqual(working.map((turn) => turn.id), ['t2', 't3', 't4', 't5'])
  assert.deepEqual(recalled.map((turn) => turn.id), ['t0'])
  assert.deepEqual(selectMemory({ turns, questionVector: null }).recalled, [])
  assert.equal(isExpired({ createdAt: '2026-07-01T00:00:00Z' }, new Date('2026-10-07T00:00:00Z'), 90), true)
  assert.equal(isExpired({ createdAt: '2026-09-01T00:00:00Z' }, new Date('2026-10-07T00:00:00Z'), 90), false)
})

// ---------- both layers through the platform ----------

const alex = { tenantId: 'northstar', userId: 'alex' }
const sam = { tenantId: 'northstar', userId: 'sam' }

async function setup({ reply, embedder = conceptEmbedder(), quotaLimit = 50, retentionDays = 90 } = {}) {
  const clock = new FixedClock('2026-10-07T12:00:00Z')
  const audit = new InMemoryAppendOnlyAudit()
  const requests = []
  const chatAnswerer = {
    providerName: 'Test provider',
    answer: async (request) => { requests.push(structuredClone(request)); return { model: 'test-model', ...(reply ? reply(request) : { answer: request.excerpts[0].text, answered: true, citations: [request.excerpts[0].label] }) } },
  }
  const storage = createInMemoryMeetingStorage()
  const platform = new MeetingIntelligencePlatform({ storage, clock, policy: new PolicyEngine(), chatAnswerer, embedder, chatQuota: new ChatQuota({ limit: quotaLimit, clock }), chatRetentionDays: retentionDays, authorizationTtlMs: 60_000 })
  await platform.createMeeting(alex, { id: 'vendor', title: 'Vendor review', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard' })
  for (const actor of [alex, sam]) await platform.recordConsent(actor, 'vendor', { participantId: actor.userId, capturedAt: '2026-10-07T11:59:00Z', expiresAt: '2026-10-07T23:00:00Z', policyVersion: 'v1', decision: 'granted' })
  const authorization = await platform.authorizeRecording(alex, 'vendor')
  await platform.appendTranscript(alex, 'vendor', authorization, [
    { id: 's1', speakerId: 'alex', startMs: 0, endMs: 4000, text: 'The vendor budget of forty eight thousand dollars is approved.', provenance: { engine: 'test' } },
    { id: 's2', speakerId: 'alex', startMs: 4000, endMs: 8000, text: 'Send vendor questions to priya.k@acme.com or call 415-555-0134.', provenance: { engine: 'test' } },
  ])
  return { platform, requests, audit: platform.audit, clock, storage }
}
const guardrailCodes = async (platform) => (await platform.audit.chain('northstar')).filter((event) => event.action === 'chat.guardrail').map((event) => event.reason)

test('personal data is redacted from everything sent, and the redaction is audited by code only', async () => {
  const { platform, requests } = await setup()
  await platform.askChat(sam, { question: 'Who handles vendor questions?' })
  const sent = JSON.stringify(requests[0])
  assert.doesNotMatch(sent, /priya\.k@acme\.com|415-555-0134/)
  assert.match(sent, /\[email\]/)
  assert.deepEqual(await guardrailCodes(platform), ['PERSONAL_DATA_REDACTED'])
})

test('invented numbers are flagged, and an answer with no grounded statement is withheld', async () => {
  const flagged = await setup({ reply: (request) => ({ answer: 'The vendor budget of $99,000 is approved.', answered: true, citations: [request.excerpts[0].label] }) })
  const turn = (await flagged.platform.askChat(sam, { question: 'What is the vendor budget?' })).turn
  assert.equal(turn.status, 'answered')
  assert.deepEqual(turn.grounding.unsupportedNumbers, [99000])
  assert.ok((await guardrailCodes(flagged.platform)).includes('UNGROUNDED_NUMBER'))

  const off = await setup({ reply: (request) => ({ answer: 'The team relocates to the third floor next month.', answered: true, citations: [request.excerpts[0].label] }) })
  const withheld = (await off.platform.askChat(sam, { question: 'What is the vendor budget?' })).turn
  assert.deepEqual([withheld.status, withheld.answer, withheld.sources], ['unsupported', null, []])
  assert.ok((await guardrailCodes(off.platform)).includes('UNGROUNDED_STATEMENT'))
})

test('the daily quota is enforced per user and audited as a denial', async () => {
  const { platform } = await setup({ quotaLimit: 1 })
  await platform.askChat(sam, { question: 'What is the vendor budget?' })
  await assert.rejects(platform.askChat(sam, { question: 'And who approved it?' }), { code: 'CHAT_QUOTA_EXCEEDED' })
  await platform.askChat(alex, { question: 'What is the vendor budget?' })
  const denied = (await platform.audit.chain('northstar')).filter((event) => event.action === 'chat.ask' && event.outcome === 'denied')
  assert.deepEqual(denied.map((event) => event.reason), ['CHAT_QUOTA_EXCEEDED'])
})

test('an older related turn is recalled into a new question, beyond the four most recent', async () => {
  const { platform, requests } = await setup()
  await platform.askChat(sam, { question: 'What is the vendor budget?' })
  for (const question of ['Who handles vendor questions?', 'vendor phone?', 'vendor email?', 'vendor contact?']) await platform.askChat(sam, { question })
  await platform.askChat(sam, { question: 'Remind me how much funding the supplier got' })
  const last = requests.at(-1)
  assert.equal(last.history.length, 4)
  assert.deepEqual(last.recalled.map((turn) => turn.question), ['What is the vendor budget?'])
  assert.deepEqual((await platform.getChatHistory(sam)).turns.at(-1).memory, { working: 4, recalled: 1 })
})

test('saved chat expires after the retention period and the sweep deletes it', async () => {
  const { platform, clock } = await setup({ retentionDays: 30 })
  await platform.askChat(sam, { question: 'What is the vendor budget?' })
  clock.advance(31 * 24 * 60 * 60 * 1000)
  assert.deepEqual((await platform.getChatHistory(sam)).turns, [], 'an expired turn is neither shown nor used')
  assert.equal((await platform.enforceRetention('northstar')).chatTurnsExpired, 1)
  assert.deepEqual(await platform.chat.forUser('northstar', 'sam'), [])
  assert.ok((await platform.audit.chain('northstar')).some((event) => event.action === 'chat.history.expire'))
})

test('a user can forget one saved question without touching the rest or anyone else\'s', async () => {
  const { platform } = await setup()
  const first = (await platform.askChat(sam, { question: 'What is the vendor budget?' })).turn
  await platform.askChat(sam, { question: 'Who handles vendor questions?' })
  const alexTurn = (await platform.askChat(alex, { question: 'What is the vendor budget?' })).turn
  assert.deepEqual(await platform.deleteChatTurn(sam, first.id), { deleted: true })
  assert.deepEqual((await platform.getChatHistory(sam)).turns.map((turn) => turn.question), ['Who handles vendor questions?'])
  await assert.rejects(platform.deleteChatTurn(sam, alexTurn.id), { code: 'CHAT_TURN_NOT_FOUND' })
  await assert.rejects(platform.deleteChatTurn(sam, 'not-an-id'), { code: 'INVALID_CHAT_TURN' })
  assert.equal((await platform.getChatHistory(alex)).turns.length, 1)
})

test('saved turns never carry their memory vectors out to the browser', async () => {
  const { platform } = await setup()
  await platform.askChat(sam, { question: 'What is the vendor budget?' })
  assert.ok(Array.isArray((await platform.chat.forUser('northstar', 'sam'))[0].memoryVector), 'stored for recall')
  assert.doesNotMatch(JSON.stringify(await platform.getChatHistory(sam)), /memoryVector|memoryModel/)
})
