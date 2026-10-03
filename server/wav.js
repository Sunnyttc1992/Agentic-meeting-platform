import { invariant } from './errors.js'

// The only media the speech pipeline accepts: RIFF/WAVE, PCM, 16-bit, mono,
// 16 kHz. The browser decodes its own recording to this shape before upload,
// so the server never runs a codec on untrusted compressed media. Every field
// is checked; anything else is rejected rather than "best-effort" decoded.
export const SPEECH_SAMPLE_RATE = 16000
const HEADER_BYTES = 44

export function parseSpeechWav(input, { maxSeconds = 4 * 60 * 60 } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? [])
  const fail = (message) => invariant(false, 'INVALID_MEDIA', message, 415)
  if (bytes.length < HEADER_BYTES) fail('Audio is not a complete WAV file')
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') fail('Audio is not RIFF/WAVE')
  if (bytes.readUInt32LE(4) !== bytes.length - 8) fail('WAV length header does not match the uploaded bytes')

  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > bytes.length) fail('WAV chunk exceeds the uploaded bytes')
    if (id === 'fmt ') {
      if (format || size < 16) fail('WAV format chunk is invalid')
      format = {
        audioFormat: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        byteRate: bytes.readUInt32LE(body + 8),
        blockAlign: bytes.readUInt16LE(body + 12),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (data || !format) fail('WAV data chunk is invalid')
      data = bytes.subarray(body, body + size)
    }
    offset = body + size + (size % 2)
  }
  if (!format || !data) fail('WAV file is missing its format or data chunk')
  if (format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== SPEECH_SAMPLE_RATE || format.bitsPerSample !== 16
    || format.blockAlign !== 2 || format.byteRate !== SPEECH_SAMPLE_RATE * 2) {
    fail('Audio must be 16-bit PCM, mono, 16 kHz')
  }
  if (data.length === 0 || data.length % 2 !== 0) fail('WAV audio data is empty or misaligned')
  const sampleCount = data.length / 2
  if (sampleCount > maxSeconds * SPEECH_SAMPLE_RATE) fail('Recording is longer than the configured limit')

  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) samples[index] = data.readInt16LE(index * 2) / 32768
  return Object.freeze({ samples, sampleRate: SPEECH_SAMPLE_RATE, durationMs: Math.round((sampleCount / SPEECH_SAMPLE_RATE) * 1000) })
}
