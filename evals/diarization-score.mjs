// Scores anonymous speaker labels against a known synthetic timeline.
//
// The product rule (server/diarization.js) credits a transcript segment to one
// anonymous label only when that voice clearly dominates it. The benchmark
// therefore cares most about the unsafe outcomes: a segment credited to the
// wrong voice, and crosstalk credited to a single voice. Leaving a segment
// UNATTRIBUTED is conservative and counted separately.
export const DOMINANT_SHARE = 2 / 3

const overlap = (a, b) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))

// The ground truth for one segment: the voice speaking at least two-thirds of
// the voiced time inside it, MIXED when no voice dominates, SILENT when no
// synthetic voice speaks in it at all.
export function truthFor(segment, voiceSpans) {
  const byVoice = new Map()
  for (const span of voiceSpans) {
    const shared = overlap(segment, span)
    if (shared > 0) byVoice.set(span.voice, (byVoice.get(span.voice) ?? 0) + shared)
  }
  const total = [...byVoice.values()].reduce((sum, value) => sum + value, 0)
  if (total === 0) return 'SILENT'
  const [voice, shared] = [...byVoice.entries()].sort((a, b) => b[1] - a[1])[0]
  return shared / total >= DOMINANT_SHARE ? voice : 'MIXED'
}

// Anonymous labels are arbitrary; each is mapped to the synthetic voice it
// overlaps most. Two labels may map to one voice (a split speaker), which the
// report shows as more labels than voices.
export function mapLabels(turns, voiceSpans) {
  const totals = new Map()
  for (const turn of turns) {
    for (const span of voiceSpans) {
      const shared = overlap(turn, span)
      if (shared === 0) continue
      const byVoice = totals.get(turn.label) ?? new Map()
      byVoice.set(span.voice, (byVoice.get(span.voice) ?? 0) + shared)
      totals.set(turn.label, byVoice)
    }
  }
  return new Map([...totals.entries()].map(([label, byVoice]) => [label, [...byVoice.entries()].sort((a, b) => b[1] - a[1])[0][0]]))
}

// Fraction of crosstalk time in which the diarizer reported two or more
// labels at once.
function overlapRecall(turns, voiceSpans, stepMs = 10) {
  let crosstalk = 0
  let detected = 0
  const end = Math.max(0, ...voiceSpans.map((span) => span.endMs))
  for (let at = 0; at < end; at += stepMs) {
    const voices = new Set(voiceSpans.filter((span) => span.startMs <= at && at < span.endMs).map((span) => span.voice))
    if (voices.size < 2) continue
    crosstalk += 1
    if (new Set(turns.filter((turn) => turn.startMs <= at && at < turn.endMs).map((turn) => turn.label)).size >= 2) detected += 1
  }
  return crosstalk === 0 ? null : Math.round((detected / crosstalk) * 1000) / 1000
}

export function scoreDiarization({ segments, turns, voiceSpans }) {
  const labelVoice = mapLabels(turns, voiceSpans)
  const counts = { segments: segments.length, correct: 0, wrongVoice: 0, missed: 0, mixedAbstained: 0, mixedCreditedToOneVoice: 0, silent: 0 }
  for (const segment of segments) {
    const truth = truthFor(segment, voiceSpans)
    const predicted = segment.diarizationLabel === 'UNATTRIBUTED' ? null : (labelVoice.get(segment.diarizationLabel) ?? 'UNKNOWN')
    if (truth === 'SILENT') counts.silent += 1
    else if (truth === 'MIXED') counts[predicted ? 'mixedCreditedToOneVoice' : 'mixedAbstained'] += 1
    else if (!predicted) counts.missed += 1
    else counts[predicted === truth ? 'correct' : 'wrongVoice'] += 1
  }
  return {
    ...counts,
    voices: new Set(voiceSpans.map((span) => span.voice)).size,
    labelsFound: new Set(turns.map((turn) => turn.label)).size,
    overlapRecall: overlapRecall(turns, voiceSpans),
  }
}
