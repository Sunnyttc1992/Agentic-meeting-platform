import test from 'node:test'
import assert from 'node:assert/strict'
import { FixedClock } from './adapters/in-memory.js'
import { chatKeywords, ClaudeChatAnswerer, OpenAIChatAnswerer, prepareChatPrompt } from './chat.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { createInMemoryMeetingStorage } from './storage.js'

const tenantId = 'northstar'
const alex = { tenantId, userId: 'alex' }
const sam = { tenantId, userId: 'sam' }
const CANARY = 'ORION-CANARY-7731'

function fakeAnswerer(reply = (request) => ({ answer: 'Sign the vendor renewal once the security findings close.', answered: true, citations: [request.excerpts[0].label, 'E99'] })) {
  const requests = []
  return {
    requests,
    providerName: 'Test provider',
    answer: async (request) => { requests.push(structuredClone(request)); return { model: 'test-model-1', ...(await reply(request)) } },
  }
}

async function seed(platform, id, { title, participantIds, transcript, decision }) {
  await platform.createMeeting(alex, { id, title, tenantId, organizerId: 'alex', participantIds, classification: 'standard', createdAt: '2026-10-05T15:00:00.000Z' })
  for (const userId of participantIds) {
    await platform.recordConsent({ tenantId, userId }, id, { participantId: userId, capturedAt: '2026-10-06T11:59:00Z', expiresAt: '2026-10-06T23:00:00Z', policyVersion: 'v1', decision: 'granted' })
  }
  const authorization = await platform.authorizeRecording(alex, id)
  await platform.appendTranscript(alex, id, authorization, [{ id: `${id}-s1`, speakerId: 'alex', startMs: 65_000, endMs: 70_000, text: transcript, provenance: { engine: 'test' } }])
  await platform.addAssertions(alex, id, [{ id: `${id}-d1`, kind: 'decision', text: decision, citations: [`${id}-s1`] }])
}

async function setup({ answerer = fakeAnswerer(), storage = createInMemoryMeetingStorage() } = {}) {
  const platform = new MeetingIntelligencePlatform({ storage, clock: new FixedClock('2026-10-06T12:00:00Z'), policy: new PolicyEngine(), chatAnswerer: answerer, authorizationTtlMs: 60_000 })
  await seed(platform, 'meeting-a', { title: 'Vendor renewal review', participantIds: ['alex', 'sam'], transcript: 'The vendor renewal is blocked by two open security findings.', decision: 'Sign the vendor renewal after the security findings close.' })
  await seed(platform, 'meeting-b', { title: 'Board prep (restricted)', participantIds: ['alex'], transcript: `The vendor budget will be cut under ${CANARY}.`, decision: `Vendor renewal moves to ${CANARY} board review.` })
  return { platform, answerer, storage }
}

test('keywords drop filler and light-stem the rest', () => {
  assert.deepEqual(chatKeywords('What did we decide about the vendors in the meeting?'), ['decide', 'vendor'])
  assert.deepEqual(chatKeywords('Who owns the data processing agreement?'), ['owns', 'data', 'process', 'agreement'])
  assert.deepEqual(chatKeywords('the and of'), [])
})

test('the provider sees only excerpts the asker may read, labelled without identifiers or titles', async () => {
  const { platform, answerer } = await setup()
  const { turn } = await platform.askChat(sam, { question: 'What did we decide about the vendor renewal?' })
  assert.equal(answerer.requests.length, 1)
  const sent = JSON.stringify(answerer.requests[0])
  assert.doesNotMatch(sent, new RegExp(CANARY), 'denied meeting content never reaches the provider')
  assert.doesNotMatch(sent, /meeting-a|meeting-b|northstar|Vendor renewal review|Board prep|-s1|-d1/, 'no tenant, meeting, source IDs, or titles leave the server')
  const prompt = prepareChatPrompt(answerer.requests[0])
  assert.match(prompt, /\[E1 · Meeting A, 2026-10-05 · decision\] Sign the vendor renewal after the security findings close\./)
  assert.match(prompt, /\[E2 · Meeting A, 2026-10-05 · transcript 01:05 unattributed\]/)

  assert.equal(turn.status, 'answered')
  assert.equal(turn.answer, 'Sign the vendor renewal once the security findings close.')
  assert.deepEqual(turn.sources.map((source) => [source.label, source.meetingTitle, source.kind]), [['E1', 'Vendor renewal review', 'decision']], 'an invented citation (E99) is dropped')
  assert.doesNotMatch(JSON.stringify(await platform.getChatHistory(sam)), new RegExp(`${CANARY}|meeting-b|Board prep`), 'no leak through history, sources, or counts')
})

test('an organizer who can read both meetings gets both, ranked decisions first', async () => {
  const { platform, answerer } = await setup()
  await platform.askChat(alex, { question: 'What happened with the vendor renewal?' })
  const excerpts = answerer.requests[0].excerpts
  assert.ok(excerpts.some((item) => item.text.includes(CANARY)))
  assert.deepEqual([...new Set(excerpts.map((item) => item.meetingLetter))].sort(), ['A', 'B'])
  assert.equal(excerpts[0].kind, 'decision')
})

test('answer statuses: no sources skips the provider, and unsupported or uncovered answers keep no citations', async () => {
  const { platform, answerer } = await setup()
  const none = (await platform.askChat(sam, { question: 'What about the parking garage?' })).turn
  assert.deepEqual([none.status, none.answer, none.sources], ['no-sources', null, []])
  assert.equal(answerer.requests.length, 0, 'nothing is sent when nothing matched')

  const uncited = await setup({ answerer: fakeAnswerer(() => ({ answer: 'It was approved.', answered: true, citations: ['E42'] })) })
  const unsupported = (await uncited.platform.askChat(sam, { question: 'vendor renewal?' })).turn
  assert.deepEqual([unsupported.status, unsupported.answer, unsupported.sources], ['unsupported', null, []])

  const uncovered = await setup({ answerer: fakeAnswerer(() => ({ answer: 'The meetings provided do not cover pricing.', answered: false, citations: ['E1'] })) })
  const notCovered = (await uncovered.platform.askChat(sam, { question: 'vendor pricing?' })).turn
  assert.deepEqual([notCovered.status, notCovered.sources], ['not-covered', []])

  const local = await setup({ answerer: null })
  const sourcesOnly = (await local.platform.askChat(sam, { question: 'vendor renewal?' })).turn
  assert.equal(sourcesOnly.status, 'sources-only')
  assert.equal(sourcesOnly.answer, null)
  assert.ok(sourcesOnly.sources.length > 0 && sourcesOnly.sources.every((source) => source.meetingTitle === 'Vendor renewal review'))
})

test('a provider failure saves nothing, and invalid questions are rejected before any retrieval', async () => {
  const { platform } = await setup({ answerer: fakeAnswerer(() => { throw new Error('provider down: secret details') }) })
  await assert.rejects(platform.askChat(sam, { question: 'vendor renewal?' }), (error) => error.code === 'CHAT_ANSWER_FAILED' && !/secret/.test(error.message))
  assert.deepEqual((await platform.getChatHistory(sam)).turns, [])
  for (const question of ['', '   ', 'x'.repeat(1001), 42, null]) {
    await assert.rejects(platform.askChat(sam, { question }), { code: 'INVALID_CHAT_QUESTION' })
  }
})

test('saved history is per user, feeds later questions, and is cleared on request', async () => {
  const { platform, answerer } = await setup()
  await platform.askChat(sam, { question: 'What did we decide about the vendor renewal?' })
  await platform.askChat(sam, { question: 'And what is blocking the vendor?' })
  assert.deepEqual(answerer.requests[1].history, [{ question: 'What did we decide about the vendor renewal?', answer: 'Sign the vendor renewal once the security findings close.' }])
  assert.equal((await platform.getChatHistory(sam)).turns.length, 2)
  assert.deepEqual((await platform.getChatHistory(alex)).turns, [], 'another user never sees these turns')
  assert.deepEqual(await platform.clearChatHistory(sam), { cleared: true })
  assert.deepEqual((await platform.getChatHistory(sam)).turns, [])
})

test('losing access to a meeting hides every turn that drew on it, from the screen and from the provider', async () => {
  const { platform, answerer, storage } = await setup()
  await platform.askChat(sam, { question: 'What did we decide about the vendor renewal?' })
  await storage.transaction({ tenantId }, async (transaction) => {
    const meeting = await transaction.meetings.get('meeting-a')
    meeting.participantIds = ['alex']
    await transaction.meetings.save(meeting)
  })
  assert.deepEqual((await platform.getChatHistory(sam)).turns, [])
  const after = (await platform.askChat(sam, { question: 'vendor renewal?' })).turn
  assert.equal(after.status, 'no-sources')
  assert.equal(answerer.requests.length, 1, 'the hidden turn is not sent as context either')
})

test('deleting a meeting deletes every saved turn that drew on it, for every user', async () => {
  const { platform } = await setup()
  await platform.askChat(alex, { question: 'What happened with the vendor renewal?' })
  await platform.askChat(sam, { question: 'What did we decide about the vendor renewal?' })
  await platform.askChat(alex, { question: 'What about the parking garage?' })
  await platform.deleteMeetingContent(alex, 'meeting-a')
  assert.deepEqual((await platform.chat.forUser(tenantId, 'alex')).map((turn) => turn.question), ['What about the parking garage?'])
  assert.deepEqual(await platform.chat.forUser(tenantId, 'sam'), [])
})

test('a short transcript excerpt travels with its neighbouring lines, each with its own speaker', async () => {
  const { platform, answerer } = await setup({ answerer: fakeAnswerer((request) => ({ answer: 'Wait at least thirty days.', answered: true, citations: [request.excerpts.find((item) => item.text === 'before contacting the NVC.').label] })) })
  const alexOnly = { tenantId, userId: 'alex' }
  await platform.createMeeting(alexOnly, { id: 'visa', title: 'Visa processing', tenantId, organizerId: 'alex', participantIds: ['alex'], classification: 'standard' })
  await platform.recordConsent(alexOnly, 'visa', { participantId: 'alex', capturedAt: '2026-10-06T11:59:00Z', expiresAt: '2026-10-06T23:00:00Z', policyVersion: 'v1', decision: 'granted' })
  const authorization = await platform.authorizeRecording(alexOnly, 'visa')
  await platform.appendTranscript(alexOnly, 'visa', authorization, [
    { id: 'v1', diarizationLabel: 'SPEAKER_00', startMs: 0, endMs: 2000, text: 'Once the petition is approved,', provenance: { engine: 'test' } },
    { id: 'v2', diarizationLabel: 'SPEAKER_01', startMs: 2000, endMs: 4000, text: 'wait at least thirty days', provenance: { engine: 'test' } },
    { id: 'v3', diarizationLabel: 'SPEAKER_00', startMs: 4000, endMs: 6000, text: 'before contacting the NVC.', provenance: { engine: 'test' } },
  ])
  const { turn } = await platform.askChat(alexOnly, { question: 'contacting the NVC?' })
  const sent = answerer.requests.at(-1).excerpts.find((item) => item.text === 'before contacting the NVC.')
  assert.deepEqual(sent.context, { before: { speaker: 'SPEAKER_01', text: 'wait at least thirty days' }, after: null })
  assert.match(prepareChatPrompt(answerer.requests.at(-1)), /\(just before, SPEAKER_01: wait at least thirty days\)/)
  const shown = turn.sources.find((source) => source.text === 'before contacting the NVC.')
  assert.deepEqual(shown.context, { before: 'wait at least thirty days', after: null })
  const reloaded = (await platform.getChatHistory(alexOnly)).turns.at(-1).sources.find((source) => source.text === 'before contacting the NVC.')
  assert.deepEqual(reloaded.context, { before: 'wait at least thirty days', after: null }, 'the context survives a reload')
})

test('provider adapters send the minimal request unstored and fail closed', async () => {
  const excerpts = [{ label: 'E1', meetingLetter: 'A', meetingDate: '2026-10-05', kind: 'decision', at: null, speaker: null, text: 'Sign the renewal.' }]
  const openaiRequests = []
  const openai = new OpenAIChatAnswerer({ model: 'gpt-test', client: { responses: { create: async (request) => { openaiRequests.push(request); return { status: 'completed', output: [], output_text: JSON.stringify({ answer: 'Sign it.', answered: true, citations: ['E1', 'E7'] }) } } } } })
  assert.deepEqual(await openai.answer({ question: 'Decision?', history: [], excerpts }), { answer: 'Sign it.', answered: true, citations: ['E1'], model: 'gpt-test' })
  assert.equal(openaiRequests[0].store, false)
  assert.equal(openaiRequests[0].text.format.strict, true)
  const refusing = new OpenAIChatAnswerer({ client: { responses: { create: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }) } } })
  await assert.rejects(refusing.answer({ question: 'q', history: [], excerpts }))

  const claude = new ClaudeChatAnswerer({ model: 'claude-test', client: { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ answer: 'Sign it.', answered: true, citations: ['E1'] }) }] }) } } } })
  assert.deepEqual(await claude.answer({ question: 'Decision?', history: [], excerpts }), { answer: 'Sign it.', answered: true, citations: ['E1'], model: 'claude-test' })
  const truncated = new ClaudeChatAnswerer({ client: { beta: { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [] }) } } } })
  await assert.rejects(truncated.answer({ question: 'q', history: [], excerpts }))
})
