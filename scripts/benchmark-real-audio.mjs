// Real-audio quality check for the local speech pipeline (CAP-04 / CAP-06).
// Record yourself (and, with their consent, a colleague) reading
// evals/real-audio-script.txt, save it as WAV, and run:
//
//   npm run benchmark:real-audio -- --audio C:\path\to\reading.wav
//
// Options: --reference <file> (default: the bundled script), --show-transcript.
// The recording is converted to 16 kHz mono in memory and runs only through
// local Whisper and, when configured, local pyannote. Nothing is uploaded, no
// summary provider is called, and nothing is written to disk except pyannote's
// own temporary job directory, which it deletes. Only metrics are printed
// unless --show-transcript is given.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { applyDiarizationLabels, LocalPyannoteDiarizer } from '../server/diarization.js'
import { LocalWhisperTranscriber } from '../server/transcription.js'
import { SPEECH_SAMPLE_RATE } from '../server/wav.js'
import { encodeWavPcm16 } from '../src/audioTranscode.js'
import { decodeWav, resample, wordErrorRate } from '../evals/real-audio.mjs'

const { values } = parseArgs({
  options: {
    audio: { type: 'string' },
    reference: { type: 'string', default: fileURLToPath(new URL('../evals/real-audio-script.txt', import.meta.url)) },
    'show-transcript': { type: 'boolean', default: false },
  },
})
if (!values.audio) {
  console.error('Usage: npm run benchmark:real-audio -- --audio <recording.wav> [--reference <script.txt>] [--show-transcript]')
  process.exit(2)
}

const referenceLines = (await readFile(values.reference, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const speakerPrefix = /^([A-Z]):\s*/
const expectedSpeakers = new Set(referenceLines.map((line) => line.match(speakerPrefix)?.[1]).filter(Boolean)).size || null
const reference = referenceLines.map((line) => line.replace(speakerPrefix, '')).join(' ')

const decoded = decodeWav(await readFile(values.audio))
const samples = resample(decoded.samples, decoded.sampleRate, SPEECH_SAMPLE_RATE)
const wav = Buffer.from(encodeWavPcm16(samples))
const durationSeconds = Math.round((samples.length / SPEECH_SAMPLE_RATE) * 10) / 10

const diarizer = new LocalPyannoteDiarizer()
const started = Date.now()
const [segments, turns] = await Promise.all([new LocalWhisperTranscriber().transcribe(wav), diarizer.enabled ? diarizer.diarize(wav) : []])
const labeled = applyDiarizationLabels(segments, turns)
const hypothesis = labeled.map((segment) => segment.text).join(' ')

const report = {
  recordingSeconds: durationSeconds,
  sourceFormat: `${decoded.sampleRate} Hz, converted to 16 kHz mono`,
  processingSeconds: Math.round((Date.now() - started) / 100) / 10,
  transcription: wordErrorRate(reference, hypothesis),
  segments: labeled.length,
  diarization: diarizer.enabled
    ? {
        expectedSpeakers,
        labelsFound: new Set(turns.map((turn) => turn.label)).size,
        segmentsAttributed: labeled.filter((segment) => segment.diarizationLabel !== 'UNATTRIBUTED').length,
      }
    : 'not configured',
}
console.log(JSON.stringify(report, null, 2))
if (values['show-transcript']) {
  console.log('\nTranscript (local only):')
  for (const segment of labeled) console.log(`[${(segment.startMs / 1000).toFixed(1)}-${(segment.endMs / 1000).toFixed(1)} ${segment.diarizationLabel}] ${segment.text}`)
}
