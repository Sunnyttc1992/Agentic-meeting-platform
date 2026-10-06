import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeWav, resample, wordErrorRate } from '../evals/real-audio.mjs'

function wav({ sampleRate, channels, bitsPerSample, audioFormat = 1, frames }) {
  const width = bitsPerSample / 8
  const data = Buffer.alloc(frames.length * channels * width)
  frames.forEach((value, frame) => {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = (frame * channels + channel) * width
      const sample = channel === 0 ? value : value / 2
      if (audioFormat === 3) data.writeFloatLE(sample, at)
      else if (bitsPerSample === 16) data.writeInt16LE(Math.round(sample * 32767), at)
      else data.writeIntLE(Math.round(sample * 8388607), at, 3)
    }
  })
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(audioFormat, 20); header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * width, 28); header.writeUInt16LE(channels * width, 32); header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

test('desktop-recorder WAV encodings decode to mono', () => {
  const frames = [0.5, -0.5, 0.25]
  for (const [bitsPerSample, audioFormat] of [[16, 1], [24, 1], [32, 3]]) {
    const { samples, sampleRate } = decodeWav(wav({ sampleRate: 48_000, channels: 2, bitsPerSample, audioFormat, frames }))
    assert.equal(sampleRate, 48_000)
    assert.deepEqual([...samples].map((value) => Math.round(value * 1000) / 1000), [0.375, -0.375, 0.188], `${bitsPerSample}-bit stereo averages its channels`)
  }
  assert.throws(() => decodeWav(Buffer.from('not audio')), /RIFF/)
})

test('resampling to 16 kHz keeps a speech-band tone and removes one above the new Nyquist limit', () => {
  const tone = (frequency, rate) => Float32Array.from({ length: rate }, (_, index) => Math.sin((2 * Math.PI * frequency * index) / rate))
  const rms = (values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
  const speech = resample(tone(440, 48_000), 48_000, 16_000)
  assert.equal(speech.length, 16_000)
  assert.ok(Math.abs(rms(speech.subarray(1000, 15_000)) - Math.SQRT1_2) < 0.02, 'a 440 Hz tone passes')
  assert.ok(rms(resample(tone(12_000, 48_000), 48_000, 16_000).subarray(1000, 15_000)) < 0.05, 'a 12 kHz tone does not alias into the speech band')
})

test('word error rate counts substitutions, deletions, and insertions after normalizing case and punctuation', () => {
  assert.deepEqual(wordErrorRate('Send the contract by Friday.', 'send the contract, by friday'), { referenceWords: 5, errors: 0, substitutions: 0, deletions: 0, insertions: 0, wer: 0 })
  assert.deepEqual(wordErrorRate('send the contract', 'send a contract'), { referenceWords: 3, errors: 1, substitutions: 1, deletions: 0, insertions: 0, wer: 0.333 })
  assert.deepEqual(wordErrorRate('send the contract today', 'send contract today'), { referenceWords: 4, errors: 1, substitutions: 0, deletions: 1, insertions: 0, wer: 0.25 })
  assert.deepEqual(wordErrorRate('send the contract', 'send the signed contract'), { referenceWords: 3, errors: 1, substitutions: 0, deletions: 0, insertions: 1, wer: 0.333 })
})
