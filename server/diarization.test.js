import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyDiarizationLabels, LocalPyannoteDiarizer } from './diarization.js'
import { LocalMeetingProcessor, LOCAL_SPEECH_PROCESSOR_LABELS } from './speech.js'

function wav(seconds = 1) {
  const dataLength = 16_000 * 2 * seconds
  const output = Buffer.alloc(44 + dataLength)
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8)
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22)
  output.writeUInt32LE(16_000, 24); output.writeUInt32LE(32_000, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34)
  output.write('data', 36); output.writeUInt32LE(dataLength, 40)
  return output
}

test('diarization labels select the greatest anonymous overlap and leave gaps unidentified', () => {
  const result = applyDiarizationLabels([
    { startMs: 0, endMs: 1_000, text: 'First' },
    { startMs: 1_000, endMs: 2_000, text: 'Second' },
    { startMs: 2_000, endMs: 3_000, text: 'Third' },
  ], [
    { startMs: 0, endMs: 300, label: 'speaker_a' },
    { startMs: 300, endMs: 1_000, label: 'speaker_b' },
    { startMs: 1_200, endMs: 1_800, label: 'speaker_a' },
  ])
  assert.deepEqual(result.map((item) => item.diarizationLabel), ['speaker_b', 'speaker_a', 'UNATTRIBUTED'])
})

test('local pyannote adapter accepts bounded output and always removes the temporary audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-diarization-test-'))
  const modelDir = join(root, 'model')
  const temporaryRoot = join(root, 'temporary')
  await mkdir(modelDir)
  try {
    const diarizer = new LocalPyannoteDiarizer({
      python: 'unused-python', modelDir, tempRoot: temporaryRoot, workerPath: 'unused-worker',
      runWorker: async ({ inputPath, outputPath, env }) => {
        assert.equal((await stat(inputPath)).isFile(), true)
        assert.equal(env.HF_HUB_OFFLINE, undefined, 'offline settings are applied by the production worker launcher')
        await writeFile(outputPath, JSON.stringify({ version: 1, turns: [{ startMs: 0, endMs: 900, label: 'speaker_0' }] }))
      },
    })
    const result = await diarizer.diarize(wav())
    assert.deepEqual(result, [{ startMs: 0, endMs: 900, label: 'speaker_0' }])
    assert.deepEqual(await readdir(temporaryRoot), [])

    const invalid = new LocalPyannoteDiarizer({
      python: 'unused-python', modelDir, tempRoot: temporaryRoot, workerPath: 'unused-worker',
      runWorker: async ({ outputPath }) => writeFile(outputPath, '{"version":1,"turns":[{"startMs":0,"endMs":9999,"label":"speaker_0"}]}'),
    })
    await assert.rejects(invalid.diarize(wav()), /Invalid local diarization turn/)
    assert.deepEqual(await readdir(temporaryRoot), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the meeting processor preserves anonymous diarization and never supplies identity confidence', async () => {
  const processor = new LocalMeetingProcessor({
    transcriber: { transcribe: async () => [{ startMs: 0, endMs: 500, text: 'Hello' }, { startMs: 500, endMs: 1_000, text: 'Bye' }] },
    diarizer: { enabled: true, diarize: async () => [{ startMs: 0, endMs: 800, label: 'speaker_local_0' }] },
  })
  const result = await processor.process({ bytes: wav() })
  assert.equal(result.processor, LOCAL_SPEECH_PROCESSOR_LABELS.diarizedTranscriptOnly)
  assert.deepEqual(result.segments.map((item) => [item.diarizationLabel, item.identityConfidence]), [
    ['speaker_local_0', null], ['speaker_local_0', null],
  ])
})
