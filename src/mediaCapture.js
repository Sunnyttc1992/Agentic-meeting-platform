import { normalizeRecordingMimeType, RECORDING_MIME_CANDIDATES } from './recordingFormats.js'

export function createMediaCapture({
  MediaRecorderClass,
  BlobClass = Blob,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  allowSyntheticFixture = false,
  onSyntheticFixture = () => {},
  onAudioUrl = () => {},
  onError = () => {},
}) {
  let stream = null
  let recorder = null
  let chunks = []
  let audioUrl = null
  let discardOnStop = false
  let audioBlob = null

  const stopTracks = () => {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
  }

  const clearAudio = () => {
    chunks = []
    audioBlob = null
    if (audioUrl) revokeObjectURL(audioUrl)
    audioUrl = null
    onAudioUrl(null)
  }

  const finish = () => {
    if (!discardOnStop && chunks.length) {
      const syntheticFixture = allowSyntheticFixture
        && recorder?.isSyntheticFixture === true
        && chunks.length === 1
        && chunks[0]?.type === 'application/x-meeting-prototype-fixture'
      if (syntheticFixture) {
        // This deliberately has no audio URL and preserves the truthful
        // non-audio content type, so it cannot be played or uploaded as media.
        audioBlob = new BlobClass(chunks, { type: 'application/x-meeting-prototype-fixture' })
        chunks = []
        onAudioUrl(null)
        onSyntheticFixture(true)
        recorder = null
        return
      }
      // The recorder's declared format and every emitted chunk are separate
      // trust boundaries. Never infer one from the other: a missing MIME type
      // must not be silently treated as a safe WebM payload.
      const contentType = normalizeRecordingMimeType(recorder?.mimeType)
      const incompatibleChunk = chunks.some((chunk) => !chunk?.type || normalizeRecordingMimeType(chunk.type) !== contentType)
      if (!contentType || incompatibleChunk) {
        clearAudio()
        recorder = null
        onError(new Error('This browser produced an unsupported audio format. Try Chrome, Edge, Firefox, or Safari with a supported audio recorder.'))
        return
      }
      audioBlob = new BlobClass(chunks, { type: contentType })
      audioUrl = createObjectURL(audioBlob)
      onAudioUrl(audioUrl)
      chunks = []
    } else {
      clearAudio()
    }
    recorder = null
  }

  return {
    connect(nextStream) { stream = nextStream },
    start() {
      clearAudio()
      onSyntheticFixture(null)
      discardOnStop = false
      if (allowSyntheticFixture && MediaRecorderClass?.isSyntheticFixture === true) {
        // Do not use MIME negotiation for the explicit non-audio mock. The
        // only accepted synthetic value is checked again in finish().
        recorder = new MediaRecorderClass(stream)
        recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
        recorder.onstop = finish
        recorder.start(1000)
        return
      }
      const mimeType = typeof MediaRecorderClass.isTypeSupported === 'function'
        ? RECORDING_MIME_CANDIDATES.find((type) => MediaRecorderClass.isTypeSupported(type))
        : null
      if (typeof MediaRecorderClass.isTypeSupported === 'function' && !mimeType) {
        stopTracks()
        throw new Error('This browser does not support an accepted audio recording format.')
      }
      recorder = mimeType ? new MediaRecorderClass(stream, { mimeType }) : new MediaRecorderClass(stream)
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
      recorder.onstop = finish
      recorder.start(1000)
    },
    stop({ discard = false } = {}) {
      discardOnStop = discard
      if (recorder?.state === 'recording') recorder.stop()
      else if (discard) clearAudio()
      stopTracks()
    },
    discard() {
      this.stop({ discard: true })
      clearAudio()
    },
    dispose() {
      discardOnStop = true
      if (recorder?.state === 'recording') recorder.stop()
      else clearAudio()
      stopTracks()
      chunks = []
    },
    blob() { return audioBlob },
    snapshot() { return { stream, recorder, chunks: [...chunks], audioUrl } },
  }
}
