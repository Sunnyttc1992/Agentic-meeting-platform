import { knowledgeAssertion, transcriptSegment } from './domain.js'
import { applyDiarizationLabels } from './diarization.js'

function exactRosterBinding(diarizationLabel, rosterEvidence) {
  const matches = rosterEvidence
    .filter((item) => item?.authorized === true && item?.binding === 'exact' && item?.diarizationLabel === diarizationLabel)
    .map((item) => item.participantId)
  const participantIds = [...new Set(matches)]
  return participantIds.length === 1 ? participantIds[0] : null
}

export const LOCAL_SPEECH_PROCESSOR_LABELS = Object.freeze({
  full: 'Local Whisper + Claude',
  transcriptOnly: 'Local Whisper transcription only',
  diarizedFull: 'Local Whisper + pyannote + Claude',
  diarizedTranscriptOnly: 'Local Whisper + pyannote transcription',
})

// Real pipeline: Whisper transcribes on this machine, then (when credentials
// are configured) Claude writes the cited summary and action plan from that
// transcript. The platform normalizes and re-validates the whole result.
export class LocalMeetingProcessor {
  constructor({ transcriber, diarizer = null, intelligence = null, now = () => new Date() }) {
    this.transcriber = transcriber
    this.diarizer = diarizer?.enabled ? diarizer : null
    this.intelligence = intelligence
    this.now = now
    this.name = this.diarizer
      ? (intelligence ? LOCAL_SPEECH_PROCESSOR_LABELS.diarizedFull : LOCAL_SPEECH_PROCESSOR_LABELS.diarizedTranscriptOnly)
      : (intelligence ? LOCAL_SPEECH_PROCESSOR_LABELS.full : LOCAL_SPEECH_PROCESSOR_LABELS.transcriptOnly)
  }

  async process({ bytes, participantIds = [] }) {
    const transcribed = await this.transcriber.transcribe(bytes)
    const labeled = this.diarizer ? applyDiarizationLabels(transcribed, await this.diarizer.diarize(bytes)) : transcribed
    // Number anonymous labels by first appearance, the same order the platform
    // stores, so a label Claude cites on an action matches the transcript.
    const ordered = new Map()
    const ordinal = (label) => {
      if (!label || label === 'UNATTRIBUTED') return 'UNATTRIBUTED'
      if (!ordered.has(label)) ordered.set(label, `SPEAKER_${String(ordered.size).padStart(2, '0')}`)
      return ordered.get(label)
    }
    const segments = labeled.map((item, index) => ({
      id: `S${index + 1}`, startMs: item.startMs, endMs: item.endMs, text: item.text,
      diarizationLabel: ordinal(item.diarizationLabel), identityConfidence: null,
    }))
    if (!this.intelligence || segments.length === 0) return { segments, assertions: [], processor: this.name }
    const result = await this.intelligence.extract({ segments, participantIds, meetingDate: this.now().toISOString().slice(0, 10) })
    const assertions = []
    const add = (kind, item, extra = {}) => assertions.push({ id: `A${assertions.length + 1}`, kind, text: item.text, citations: item.citations, ...extra })
    if (result.summary) add('summary', result.summary)
    for (const item of result.decisions) add('decision', item)
    for (const item of result.risks) add('risk', item)
    for (const item of result.questions) add('question', item)
    for (const item of result.actions) add('action', item, { commitment: { ownerId: item.ownerId, deadline: item.deadline, agreement: item.agreement, speakerLabel: item.speakerLabel } })
    return { segments, assertions, processor: this.name }
  }
}

// Pluggable seam: production adapters may implement process({ recording, bytes, rosterEvidence, participantIds }).
export class FakeSpeechProcessor {
  name = 'Local deterministic processor'

  async process({ recording, rosterEvidence = [] }) {
    const provenance = {
      processor: 'FakeSpeechProcessor',
      mode: 'local-deterministic-fake',
      recordingId: recording.id,
    }
    const segmentInput = [
      {
        id: `${recording.id}-s1`, startMs: 0, endMs: 4200,
        text: 'The facilitator opened the review and confirmed the phased launch remains the working plan.',
        diarizationLabel: 'SPEAKER_00', identityConfidence: 0.98,
      },
      {
        id: `${recording.id}-s2`, startMs: 4200, endMs: 9100,
        text: 'A participant noted that security review must close before the broader January release.',
        diarizationLabel: 'SPEAKER_01', identityConfidence: 0.91,
      },
      {
        id: `${recording.id}-s3`, startMs: 9100, endMs: 13400,
        text: 'The team agreed to keep the rollout gated by customer validation and security sign-off.',
        diarizationLabel: 'SPEAKER_00', identityConfidence: 0.54,
      },
    ]
    const segments = segmentInput.map((item) => {
      const verifiedParticipantId = exactRosterBinding(item.diarizationLabel, rosterEvidence)
      return transcriptSegment({
        ...item,
        tenantId: recording.tenantId,
        meetingId: recording.meetingId,
        verifiedParticipantId,
        provenance: {
          ...provenance,
          identityBinding: verifiedParticipantId ? 'authorized-exact-roster' : 'unverified-diarization-only',
        },
      })
    })
    const assertions = [
      knowledgeAssertion({
        id: `${recording.id}-a1`, tenantId: recording.tenantId, meetingId: recording.meetingId,
        kind: 'decision', text: 'Proceed with a phased launch gated by customer validation and security sign-off.',
        citations: [segments[0].id, segments[2].id], provenance,
      }),
      knowledgeAssertion({
        id: `${recording.id}-a2`, tenantId: recording.tenantId, meetingId: recording.meetingId,
        kind: 'action', text: 'Complete the security review before the broader January release.',
        citations: [segments[1].id], provenance,
      }),
    ]
    return { segments, assertions, processor: this.name }
  }
}
