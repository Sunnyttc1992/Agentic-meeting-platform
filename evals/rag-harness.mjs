// Runs the RAG evaluation set through the real platform (in-memory storage,
// the same askChat path the UI uses). With no answerer the platform returns
// every retrieved excerpt in rank order, which is what retrieval is scored
// on; with an answerer, the saved turn is also scored as an answer.
import { FixedClock } from '../server/adapters/in-memory.js'
import { MeetingIntelligencePlatform } from '../server/platform.js'
import { PolicyEngine } from '../server/policy.js'
import { createInMemoryMeetingStorage } from '../server/storage.js'
import { ASKER, CANARY, MEETINGS, QUESTIONS } from './rag-cases.mjs'
import { answerMetrics, leaks, retrievalMetrics, summarize } from './rag-metrics.mjs'

const organizer = Object.freeze({ tenantId: ASKER.tenantId, userId: 'alex' })

async function seededPlatform(chatAnswerer) {
  const platform = new MeetingIntelligencePlatform({
    storage: createInMemoryMeetingStorage(), clock: new FixedClock('2026-10-06T12:00:00Z'),
    policy: new PolicyEngine(), chatAnswerer, authorizationTtlMs: 60_000,
  })
  for (const meeting of MEETINGS) {
    await platform.createMeeting(organizer, { id: meeting.id, title: meeting.title, tenantId: ASKER.tenantId, organizerId: 'alex', participantIds: meeting.participantIds, classification: 'standard', createdAt: meeting.createdAt })
    for (const userId of meeting.participantIds) {
      await platform.recordConsent({ tenantId: ASKER.tenantId, userId }, meeting.id, { participantId: userId, capturedAt: '2026-10-06T11:59:00Z', expiresAt: '2026-10-06T23:00:00Z', policyVersion: 'v1', decision: 'granted' })
    }
    const authorization = await platform.authorizeRecording(organizer, meeting.id)
    await platform.appendTranscript(organizer, meeting.id, authorization, Object.entries(meeting.segments).map(([id, text], index) => ({
      id, speakerId: 'alex', startMs: index * 10_000, endMs: index * 10_000 + 8_000, text, provenance: { engine: 'rag-eval' },
    })))
    await platform.addAssertions(organizer, meeting.id, Object.entries(meeting.assertions).map(([id, [kind, text, citations]]) => ({ id, kind, text, citations })))
  }
  return platform
}

const restrictedMeetingIds = MEETINGS.filter((meeting) => !meeting.participantIds.includes(ASKER.userId)).map((meeting) => meeting.id)

export async function runRagEvaluation({ chatAnswerer = null, questions = QUESTIONS } = {}) {
  const retrievalPlatform = await seededPlatform(null)
  const answerPlatform = chatAnswerer ? await seededPlatform(chatAnswerer) : null
  const rows = []
  for (const testCase of questions) {
    const retrievedTurn = (await retrievalPlatform.askChat(ASKER, { question: testCase.question })).turn
    const retrieved = retrievedTurn.sources.map((source) => `${source.meetingId}:${source.sourceId}`)
    const row = {
      id: testCase.id, category: testCase.category, question: testCase.question,
      retrieved, retrieval: retrievalMetrics(retrieved, testCase.relevant),
      leaked: leaks(retrievedTurn, { canary: CANARY, restrictedMeetingIds }),
    }
    if (answerPlatform) {
      const turn = (await answerPlatform.askChat(ASKER, { question: testCase.question })).turn
      // Each question is scored on its own, without earlier turns as context.
      await answerPlatform.clearChatHistory(ASKER)
      row.answer = { status: turn.status, text: turn.answer, ...answerMetrics(turn, testCase) }
      row.leaked ||= leaks(turn, { canary: CANARY, restrictedMeetingIds })
    }
    rows.push(row)
  }
  return { rows, summary: summarize(rows) }
}
