// Local speaker-labelling benchmark on synthetic multi-voice audio (CAP-04).
// Windows' built-in text-to-speech voices read scripted lines, which are mixed
// on a known timeline: clean turns, crosstalk, interjections over a monologue,
// long silences, and a rapid exchange. Each scenario then runs through the real
// local Whisper transcriber and the operator-provisioned pyannote model, and
// the anonymous labels are scored against the timeline (evals/diarization-score.mjs).
//
// Everything stays on this machine: no summary provider is called, the model
// runs offline, and the synthetic audio is deleted afterwards. It needs the
// DIARIZATION_PYTHON and DIARIZATION_MODEL_DIR settings, so it is never part of
// `npm test`. Usage: npm run benchmark:diarization
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { applyDiarizationLabels, LocalPyannoteDiarizer } from '../server/diarization.js'
import { LocalWhisperTranscriber } from '../server/transcription.js'
import { parseSpeechWav, SPEECH_SAMPLE_RATE } from '../server/wav.js'
import { encodeWavPcm16 } from '../src/audioTranscode.js'
import { scoreDiarization } from '../evals/diarization-score.mjs'

const run = promisify(execFile)
const VOICES = { david: 'Microsoft David Desktop', zira: 'Microsoft Zira Desktop' }
const LINES = {
  david: [
    'Let us start with the vendor review, because the contract renewal is due at the end of the month.',
    'The security assessment came back with two open findings that we have to close before signing.',
    'I can take the first finding and send the remediation plan to the vendor by Friday.',
    'If legal needs more time, we should ask the vendor for a two week extension on the renewal.',
    'Then we keep the January launch date, but only if both findings are closed in time.',
  ],
  zira: [
    'Before that, can we confirm who owns the data processing agreement for this vendor?',
    'Legal has the agreement, but they told me the review queue is about three weeks long.',
    'That works for me, and I will ask legal whether they can prioritize this contract.',
    'Agreed, and I will update the launch checklist so the dependency is visible to everyone.',
    'One more thing, the budget owner still has to approve the renewal amount.',
  ],
  interjections: ['Right.', 'Agreed.', 'Yes, exactly.', 'Okay.'],
}

const alternate = (count) => Array.from({ length: count }, (_, index) => {
  const voice = index % 2 === 0 ? 'david' : 'zira'
  return { voice, line: LINES[voice][Math.floor(index / 2)] }
})

// Each scenario places utterances relative to the end of the previous one:
// a positive gap leaves silence, a negative gap starts the next voice early.
const SCENARIOS = [
  { name: 'clean turns', utterances: alternate(6).map((item) => ({ ...item, gapMs: 600 })) },
  { name: 'crosstalk', utterances: alternate(6).map((item, index) => ({ ...item, gapMs: index === 0 ? 0 : -1200 })) },
  {
    name: 'interjections over a monologue',
    utterances: LINES.david.slice(0, 4).flatMap((line, index) => [
      { voice: 'david', line, gapMs: 300 },
      { voice: 'zira', line: LINES.interjections[index], gapMs: 'mid' },
    ]),
  },
  { name: 'long silences', utterances: alternate(4).map((item, index) => ({ ...item, gapMs: index === 0 ? 0 : 6000 })) },
  { name: 'rapid exchange', utterances: [...LINES.interjections, ...LINES.interjections].map((line, index) => ({ voice: index % 2 === 0 ? 'david' : 'zira', line, gapMs: 150 })) },
]

async function synthesize(directory) {
  const items = []
  const keyOf = (voice, line) => `${voice}:${line}`
  for (const scenario of SCENARIOS) {
    for (const { voice, line } of scenario.utterances) {
      if (!items.some((item) => item.key === keyOf(voice, line))) items.push({ key: keyOf(voice, line), voice: VOICES[voice], text: line, path: join(directory, `u${items.length}.wav`) })
    }
  }
  const manifest = join(directory, 'manifest.json')
  await writeFile(manifest, JSON.stringify(items))
  const script = `Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($item in (Get-Content -Raw -LiteralPath '${manifest}' | ConvertFrom-Json)) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try { $synth.SelectVoice($item.voice); $synth.SetOutputToWaveFile($item.path, $format); $synth.Speak($item.text) } finally { $synth.Dispose() }
}`
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120_000 })
  const clips = new Map()
  for (const item of items) clips.set(item.key, trimSilence(parseSpeechWav(await readFile(item.path)).samples))
  return (voice, line) => clips.get(keyOf(voice, line))
}

function trimSilence(samples, threshold = 0.01) {
  let start = 0
  let end = samples.length
  while (start < end && Math.abs(samples[start]) < threshold) start += 1
  while (end > start && Math.abs(samples[end - 1]) < threshold) end -= 1
  return samples.slice(start, end)
}

function mix(scenario, clipFor) {
  const msToSamples = (ms) => Math.round((ms / 1000) * SPEECH_SAMPLE_RATE)
  const placed = []
  let cursor = msToSamples(500)
  let previous = null
  for (const { voice, line, gapMs } of scenario.utterances) {
    const clip = clipFor(voice, line)
    // An interjection lands in the middle of the utterance before it.
    const start = gapMs === 'mid' ? previous.start + Math.floor((previous.clip.length - clip.length) / 2) : Math.max(0, cursor + msToSamples(gapMs))
    placed.push({ voice, clip, start })
    if (gapMs !== 'mid') { previous = { start, clip }; cursor = start + clip.length }
  }
  const length = Math.max(...placed.map((item) => item.start + item.clip.length)) + msToSamples(500)
  const samples = new Float32Array(length)
  for (const { clip, start } of placed) for (let index = 0; index < clip.length; index += 1) samples[start + index] += clip[index] * 0.7
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.max(-1, Math.min(1, samples[index]))
  const toMs = (sampleIndex) => Math.round((sampleIndex / SPEECH_SAMPLE_RATE) * 1000)
  return {
    wav: Buffer.from(encodeWavPcm16(samples)),
    durationMs: toMs(length),
    voiceSpans: placed.map(({ voice, clip, start }) => ({ voice, startMs: toMs(start), endMs: toMs(start + clip.length) })),
  }
}

const diarizer = new LocalPyannoteDiarizer()
if (!diarizer.enabled) {
  console.error('Local diarization is not configured. Set DIARIZATION_PYTHON and DIARIZATION_MODEL_DIR in .env (see server/README.md).')
  process.exit(2)
}
const transcriber = new LocalWhisperTranscriber()
const directory = await mkdtemp(join(tmpdir(), 'meeting-ledger-diarization-benchmark-'))
const results = []
try {
  const clipFor = await synthesize(directory)
  for (const scenario of SCENARIOS) {
    const { wav, durationMs, voiceSpans } = mix(scenario, clipFor)
    const started = Date.now()
    const [segments, turns] = await Promise.all([transcriber.transcribe(wav), diarizer.diarize(wav)])
    const score = scoreDiarization({ segments: applyDiarizationLabels(segments, turns), turns, voiceSpans })
    results.push({ scenario: scenario.name, audioSeconds: Math.round(durationMs / 100) / 10, processingSeconds: Math.round((Date.now() - started) / 100) / 10, ...score })
    console.log(JSON.stringify(results.at(-1)))
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

const total = (key) => results.reduce((sum, item) => sum + item[key], 0)
const attributable = total('correct') + total('wrongVoice') + total('missed')
console.log(`\nSegments: ${total('segments')} | credited correctly: ${total('correct')}/${attributable} | wrong voice: ${total('wrongVoice')} | left unattributed: ${total('missed')}`)
console.log(`Crosstalk segments: ${total('mixedAbstained') + total('mixedCreditedToOneVoice')} | abstained: ${total('mixedAbstained')} | credited to one voice: ${total('mixedCreditedToOneVoice')}`)
// The safety bar: never credit a segment to the wrong voice.
process.exitCode = total('wrongVoice') === 0 ? 0 : 1
