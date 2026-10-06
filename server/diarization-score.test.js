import test from 'node:test'
import assert from 'node:assert/strict'
import { mapLabels, scoreDiarization, truthFor } from '../evals/diarization-score.mjs'

const spans = [
  { voice: 'david', startMs: 0, endMs: 3_000 },
  { voice: 'zira', startMs: 2_000, endMs: 5_000 },
  { voice: 'david', startMs: 8_000, endMs: 9_000 },
]

test('ground truth is the dominant synthetic voice, MIXED under crosstalk, SILENT with no voice', () => {
  assert.equal(truthFor({ startMs: 0, endMs: 2_000 }, spans), 'david')
  assert.equal(truthFor({ startMs: 1_500, endMs: 3_500 }, spans), 'MIXED')
  assert.equal(truthFor({ startMs: 3_000, endMs: 5_000 }, spans), 'zira')
  assert.equal(truthFor({ startMs: 5_500, endMs: 7_500 }, spans), 'SILENT')
})

test('anonymous labels map to the voice they overlap most, and a split speaker shows as an extra label', () => {
  const labels = mapLabels([
    { label: 'SPEAKER_00', startMs: 0, endMs: 2_500 },
    { label: 'SPEAKER_01', startMs: 2_500, endMs: 5_000 },
    { label: 'SPEAKER_02', startMs: 8_000, endMs: 9_000 },
  ], spans)
  assert.deepEqual([...labels.entries()], [['SPEAKER_00', 'david'], ['SPEAKER_01', 'zira'], ['SPEAKER_02', 'david']])
})

test('the score separates unsafe outcomes from conservative abstention', () => {
  const turns = [
    { label: 'A', startMs: 0, endMs: 3_000 },
    { label: 'B', startMs: 2_000, endMs: 5_000 },
    { label: 'A', startMs: 8_000, endMs: 9_000 },
  ]
  const result = scoreDiarization({
    turns, voiceSpans: spans,
    segments: [
      { startMs: 0, endMs: 1_800, diarizationLabel: 'A' },            // correct
      { startMs: 1_900, endMs: 3_100, diarizationLabel: 'UNATTRIBUTED' }, // crosstalk, abstained
      { startMs: 3_200, endMs: 5_000, diarizationLabel: 'A' },        // zira credited to david
      { startMs: 8_000, endMs: 9_000, diarizationLabel: 'UNATTRIBUTED' }, // missed
      { startMs: 1_500, endMs: 3_500, diarizationLabel: 'B' },        // crosstalk credited to one voice
    ],
  })
  assert.deepEqual(result, {
    segments: 5, correct: 1, wrongVoice: 1, missed: 1, mixedAbstained: 1, mixedCreditedToOneVoice: 1, silent: 0,
    voices: 2, labelsFound: 2, overlapRecall: 1,
  })
})
