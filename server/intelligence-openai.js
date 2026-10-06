import OpenAI from 'openai'
import {
  EMPTY_MEETING_INTELLIGENCE,
  MEETING_INTELLIGENCE_INSTRUCTIONS,
  MEETING_INTELLIGENCE_SCHEMA,
  normalizeMeetingIntelligence,
  prepareMeetingPrompt,
} from './intelligence.js'

// OpenAI adapter for the same cited meeting intelligence. It sends exactly what
// the Claude adapter sends (transcript with anonymous speaker labels, the
// meeting's participant IDs, and the meeting date), uses the shared
// instructions and strict output schema, and returns untrusted output that the
// platform re-validates. `store: false` keeps the response out of OpenAI's
// stored-response history, which otherwise retains it for at least 30 days.
export const DEFAULT_OPENAI_SUMMARY_MODEL = 'gpt-5.5'

export class OpenAIMeetingIntelligence {
  providerName = 'OpenAI'

  constructor({ client = new OpenAI(), model = process.env.OPENAI_SUMMARY_MODEL ?? DEFAULT_OPENAI_SUMMARY_MODEL } = {}) {
    this.client = client
    this.model = model
  }

  async extract({ segments, participantIds, meetingDate }) {
    if (segments.length === 0) return EMPTY_MEETING_INTELLIGENCE
    const { speakerLabels, userContent } = prepareMeetingPrompt({ segments, participantIds, meetingDate })
    const response = await this.client.responses.create({
      model: this.model,
      instructions: MEETING_INTELLIGENCE_INSTRUCTIONS,
      input: userContent,
      store: false,
      max_output_tokens: 16000,
      text: { format: { type: 'json_schema', name: 'meeting_intelligence', schema: MEETING_INTELLIGENCE_SCHEMA, strict: true } },
    })
    // A refusal, a truncated reply, or any non-completed status fails closed.
    const refused = (response.output ?? []).some((item) => item?.type === 'message' && (item.content ?? []).some((part) => part?.type === 'refusal'))
    if (response.status !== 'completed' || refused) {
      throw new Error(`Meeting intelligence did not complete (${refused ? 'refusal' : response.incomplete_details?.reason ?? response.status})`)
    }
    return normalizeMeetingIntelligence(JSON.parse(response.output_text), speakerLabels)
  }
}
