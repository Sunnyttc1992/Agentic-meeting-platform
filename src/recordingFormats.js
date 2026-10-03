// Container types accepted by both capture and ingestion. Codec parameters are
// accepted only for the explicit browser audio formats below.
export const RECORDING_MIME_TYPES = Object.freeze(['audio/webm', 'audio/ogg', 'audio/mp4'])
export const RECORDING_MIME_CANDIDATES = Object.freeze([
  'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus',
  'audio/ogg', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2',
])

// The speech pipeline's upload format: the browser decodes its own recording
// to 16 kHz mono PCM WAV, which the server validates byte-for-byte. It is an
// ingestion type only, never a MediaRecorder capture format.
export const SPEECH_WAV_MIME_TYPE = 'audio/wav'

export function normalizeIngestMimeType(value) {
  if (typeof value === 'string' && value.trim().toLowerCase() === SPEECH_WAV_MIME_TYPE) return SPEECH_WAV_MIME_TYPE
  return normalizeRecordingMimeType(value)
}

export function normalizeRecordingMimeType(value) {
  if (typeof value !== 'string') return null
  const match = /^\s*(audio\/(?:webm|ogg|mp4))\s*(?:;\s*codecs\s*=\s*(?:"([^"]+)"|([^;\s]+))\s*)?$/i.exec(value)
  if (!match) return null
  const container = match[1].toLowerCase()
  const codec = (match[2] ?? match[3])?.toLowerCase()
  if (codec && !(container === 'audio/mp4'
    ? ['mp4a.40.2', 'mp4a.40.5'].includes(codec)
    : codec === 'opus')) return null
  return container
}
