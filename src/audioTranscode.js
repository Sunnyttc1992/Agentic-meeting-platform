import { SPEECH_WAV_MIME_TYPE } from "./recordingFormats.js"

// The browser decodes its own recording (WebM/Ogg/MP4) and resamples it to
// 16 kHz mono PCM, the exact input local Whisper needs. The conversion runs on
// this device; the server then verifies the WAV header and length before it
// stores a single byte, so it never decodes untrusted compressed media.
export const SPEECH_SAMPLE_RATE = 16000

export function encodeWavPcm16(samples, sampleRate = SPEECH_SAMPLE_RATE) {
  const dataBytes = samples.length * 2
  const view = new DataView(new ArrayBuffer(44 + dataBytes))
  const ascii = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)) }
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE")
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, "data"); view.setUint32(40, dataBytes, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(view.buffer)
}

export function mixToMono(audioBuffer) {
  const mono = new Float32Array(audioBuffer.length)
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) mono[index] += data[index] / audioBuffer.numberOfChannels
  }
  return mono
}

export async function toSpeechWav(blob, { OfflineAudioContextClass = globalThis.OfflineAudioContext, BlobClass = Blob } = {}) {
  if (!OfflineAudioContextClass) throw new Error("This browser cannot prepare audio for transcription.")
  // decodeAudioData resamples to the context's rate, so a 16 kHz context
  // yields 16 kHz samples directly.
  const context = new OfflineAudioContextClass(1, 1, SPEECH_SAMPLE_RATE)
  const decoded = await context.decodeAudioData(await blob.arrayBuffer())
  if (decoded.sampleRate !== SPEECH_SAMPLE_RATE) throw new Error("Audio could not be resampled for transcription.")
  if (decoded.length === 0) throw new Error("The recording contains no audio.")
  return new BlobClass([encodeWavPcm16(mixToMono(decoded))], { type: SPEECH_WAV_MIME_TYPE })
}
