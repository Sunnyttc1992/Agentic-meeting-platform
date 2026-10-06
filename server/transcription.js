import { fileURLToPath } from 'node:url'
import { parseSpeechWav } from './wav.js'

const defaultCacheDir = fileURLToPath(new URL('../.cache/models', import.meta.url))
const STOCK_SILENCE_HALLUCINATION = /^(?:thank you|thanks for watching)[.!?]*$/i
const FRAME_SAMPLES = 320 // 20 ms at the validated 16 kHz input rate

function clipSamples(samples, startMs, endMs, durationMs) {
  const start = Math.max(0, Math.min(samples.length, Math.floor((startMs / durationMs) * samples.length)))
  const end = Math.max(start, Math.min(samples.length, Math.ceil((endMs / durationMs) * samples.length)))
  return samples.subarray(start, end)
}

// This is intentionally not a general voice-activity detector. It only
// identifies two artefacts that make Whisper emit stock phrases in our
// microphone fixture: silence and a steady sine wave. A real phrase remains
// eligible when its amplitude or zero-crossing pattern varies like speech.
function isSilentOrSteadyTone(samples) {
  if (samples.length < FRAME_SAMPLES) return true
  const rms = []
  const crossings = []
  for (let offset = 0; offset + FRAME_SAMPLES <= samples.length; offset += FRAME_SAMPLES) {
    let energy = 0
    let crossingCount = 0
    let previous = samples[offset]
    for (let index = offset; index < offset + FRAME_SAMPLES; index += 1) {
      const current = samples[index]
      energy += current * current
      if ((current >= 0) !== (previous >= 0)) crossingCount += 1
      previous = current
    }
    rms.push(Math.sqrt(energy / FRAME_SAMPLES))
    crossings.push(crossingCount / FRAME_SAMPLES)
  }
  const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length
  const meanRms = mean(rms)
  if (meanRms < 0.01) return true
  const variation = (values, average) => Math.sqrt(mean(values.map((value) => (value - average) ** 2))) / Math.max(average, 0.0001)
  const meanCrossings = mean(crossings)
  const active = rms.filter((value) => value >= 0.015).length / rms.length
  return active >= 0.95 && variation(rms, meanRms) < 0.08 && meanCrossings > 0.005 && variation(crossings, meanCrossings) < 0.08
}

// Whisper runs in this Node process (ONNX via transformers.js). Meeting audio
// never leaves the machine; the only network access is the one-time model
// weight download from the Hugging Face hub into `.cache/models`.
//
// Whisper does not separate speakers. Segments are therefore labeled
// UNATTRIBUTED and carry no identity confidence rather than inventing one.
export class LocalWhisperTranscriber {
  #pipeline = null

  constructor({ model = process.env.WHISPER_MODEL ?? 'onnx-community/whisper-base', language = process.env.WHISPER_LANGUAGE ?? 'en', cacheDir = defaultCacheDir, loadPipeline = null } = {}) {
    this.model = model
    this.language = language
    this.cacheDir = cacheDir
    this.loadPipeline = loadPipeline
  }

  async #asr() {
    if (!this.#pipeline) {
      this.#pipeline = (async () => {
        if (this.loadPipeline) return this.loadPipeline()
        const { pipeline, env } = await import('@huggingface/transformers')
        env.cacheDir = this.cacheDir
        return pipeline('automatic-speech-recognition', this.model, { dtype: 'q8' })
      })()
      this.#pipeline.catch(() => { this.#pipeline = null })
    }
    return this.#pipeline
  }

  // Returns ordered, non-empty, time-bounded segments.
  async transcribe(bytes) {
    const { samples, durationMs } = parseSpeechWav(bytes)
    const asr = await this.#asr()
    const output = await asr(samples, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, language: this.language, task: 'transcribe' })
    const segments = []
    for (const chunk of output?.chunks ?? []) {
      const text = String(chunk?.text ?? '').replace(/\s+/g, ' ').trim()
      // Whisper emits punctuation-only chunks for silence; they are not speech.
      if (!/[\p{L}\p{N}]/u.test(text)) continue
      const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : []
      const startMs = Math.max(0, Math.round((Number.isFinite(start) ? start : 0) * 1000))
      const previousEnd = segments.at(-1)?.endMs ?? 0
      const boundedStart = Math.max(startMs, previousEnd)
      const endMs = Math.min(durationMs, Math.max(boundedStart + 1, Math.round((Number.isFinite(end) ? end : durationMs / 1000) * 1000)))
      if (endMs <= boundedStart) continue
      if (STOCK_SILENCE_HALLUCINATION.test(text) && isSilentOrSteadyTone(clipSamples(samples, boundedStart, endMs, durationMs))) continue
      segments.push({ startMs: boundedStart, endMs, text })
    }
    return segments
  }
}
