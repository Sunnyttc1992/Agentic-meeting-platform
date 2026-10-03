import { fileURLToPath } from 'node:url'
import { parseSpeechWav } from './wav.js'

const defaultCacheDir = fileURLToPath(new URL('../.cache/models', import.meta.url))

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
      segments.push({ startMs: boundedStart, endMs, text })
    }
    return segments
  }
}
