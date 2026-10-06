// Helpers for the real-audio benchmark: read the WAV a desktop recorder saves
// (any sample rate, mono or stereo, 16/24/32-bit PCM or 32-bit float) and
// convert it in memory to the pipeline's 16 kHz mono, and score a transcript
// against the script that was read aloud.

const PCM = 1
const FLOAT = 3
const EXTENSIBLE = 0xfffe

export function decodeWav(buffer) {
  const bytes = Buffer.from(buffer)
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a RIFF/WAVE file')
  let format = null
  let data = null
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      let audioFormat = bytes.readUInt16LE(body)
      if (audioFormat === EXTENSIBLE && size >= 26) audioFormat = bytes.readUInt16LE(body + 24)
      format = { audioFormat, channels: bytes.readUInt16LE(body + 2), sampleRate: bytes.readUInt32LE(body + 4), bitsPerSample: bytes.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(bytes.length, body + size))
    }
    offset = body + size + (size % 2)
  }
  if (!format || !data) throw new Error('WAV file is missing its format or data chunk')
  const { audioFormat, channels, sampleRate, bitsPerSample } = format
  const width = bitsPerSample / 8
  const read = {
    [`${PCM}:16`]: (at) => bytes.readInt16LE(at) / 32768,
    [`${PCM}:24`]: (at) => bytes.readIntLE(at, 3) / 8388608,
    [`${PCM}:32`]: (at) => bytes.readInt32LE(at) / 2147483648,
    [`${FLOAT}:32`]: (at) => bytes.readFloatLE(at),
  }[`${audioFormat}:${bitsPerSample}`]
  if (!read || channels < 1) throw new Error(`Unsupported WAV encoding (format ${audioFormat}, ${bitsPerSample}-bit, ${channels} channels)`)
  const frames = Math.floor(data.length / (width * channels))
  const start = data.byteOffset - bytes.byteOffset
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += read(start + (frame * channels + channel) * width)
    mono[frame] = sum / channels
  }
  return { samples: mono, sampleRate }
}

// Windowed-sinc resampling with a low-pass at the lower Nyquist frequency, so
// a 48 kHz recording does not alias into the 16 kHz speech band.
export function resample(samples, fromRate, toRate, taps = 32) {
  if (fromRate === toRate) return Float32Array.from(samples)
  const ratio = toRate / fromRate
  const cutoff = Math.min(1, ratio)
  const output = new Float32Array(Math.floor(samples.length * ratio))
  for (let index = 0; index < output.length; index += 1) {
    const center = index / ratio
    const first = Math.ceil(center - taps / cutoff)
    const last = Math.floor(center + taps / cutoff)
    let sum = 0
    let weight = 0
    for (let source = Math.max(0, first); source <= Math.min(samples.length - 1, last); source += 1) {
      const x = (source - center) * cutoff
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window = 0.5 + 0.5 * Math.cos((Math.PI * (source - center) * cutoff) / taps)
      const w = sinc * window
      sum += samples[source] * w
      weight += w
    }
    output[index] = weight === 0 ? 0 : sum / weight
  }
  return output
}

export const normalizeWords = (text) => String(text).toLocaleLowerCase()
  .replace(/[’']/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .split(' ')
  .filter(Boolean)

// Word error rate: (substitutions + deletions + insertions) / reference words.
export function wordErrorRate(reference, hypothesis) {
  const ref = normalizeWords(reference)
  const hyp = normalizeWords(hypothesis)
  // Each cell holds [cost, substitutions, deletions, insertions].
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => [j, 0, 0, j])
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [[i, 0, i, 0]]
    for (let j = 1; j <= hyp.length; j += 1) {
      const same = ref[i - 1] === hyp[j - 1]
      const options = [
        [previous[j - 1][0] + (same ? 0 : 1), previous[j - 1], same ? [0, 0, 0] : [1, 0, 0]],
        [previous[j][0] + 1, previous[j], [0, 1, 0]],
        [current[j - 1][0] + 1, current[j - 1], [0, 0, 1]],
      ]
      const [cost, from, add] = options.sort((a, b) => a[0] - b[0])[0]
      current.push([cost, from[1] + add[0], from[2] + add[1], from[3] + add[2]])
    }
    previous = current
  }
  const [errors, substitutions, deletions, insertions] = previous[hyp.length]
  return { referenceWords: ref.length, errors, substitutions, deletions, insertions, wer: ref.length ? Math.round((errors / ref.length) * 1000) / 1000 : null }
}
