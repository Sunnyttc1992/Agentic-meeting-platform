import { execFile as executeFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseSpeechWav } from './wav.js'

const execFile = promisify(executeFile)
const MAX_TURNS = 10_000
const MAX_OUTPUT_BYTES = 1_000_000
const MAX_LABEL_LENGTH = 128
const workerFile = new URL('./diarize_worker.py', import.meta.url)

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function containedPath(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const path = relative(resolvedRoot, resolvedCandidate)
  return path && !path.startsWith('..') && !isAbsolute(path) ? resolvedCandidate : null
}

function localWorkerEnvironment(env) {
  return {
    ...env,
    // The model must already be in the approved local directory. These deny
    // opportunistic hub downloads and pyannote telemetry from the worker.
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    PYANNOTE_METRICS_ENABLED: '0',
  }
}

function safeTurns(value, durationMs) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.turns) || value.turns.length > MAX_TURNS) {
    throw new Error('Invalid local diarization output')
  }
  const turns = []
  for (const item of value.turns) {
    if (!isPlainObject(item) || Object.keys(item).length !== 3) throw new Error('Invalid local diarization turn')
    const { startMs, endMs, label } = item
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || endMs > durationMs
      || typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      throw new Error('Invalid local diarization turn')
    }
    turns.push(Object.freeze({ startMs, endMs, label }))
  }
  return Object.freeze(turns.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.label.localeCompare(right.label)))
}

// Binds a text span only to the anonymous local diarization label with the
// greatest overlap. Ties intentionally remain deterministic but never imply
// identity; a span without overlap stays UNATTRIBUTED.
// A transcript segment takes the anonymous label that clearly dominates its
// speech: at least two-thirds of the speaker time inside it, summed per label.
// Silence, crosstalk without a clear majority, or no overlap leaves it
// UNATTRIBUTED, so a mixed segment is never credited to one voice.
export const DOMINANT_SPEAKER_SHARE = 2 / 3

export function applyDiarizationLabels(transcript, turns) {
  return transcript.map((segment) => {
    const byLabel = new Map()
    for (const turn of turns) {
      const shared = Math.max(0, Math.min(segment.endMs, turn.endMs) - Math.max(segment.startMs, turn.startMs))
      if (shared > 0) byLabel.set(turn.label, (byLabel.get(turn.label) ?? 0) + shared)
    }
    const ranked = [...byLabel.entries()].sort(([labelA, a], [labelB, b]) => b - a || labelA.localeCompare(labelB))
    const total = ranked.reduce((sum, [, shared]) => sum + shared, 0)
    const [label, shared] = ranked[0] ?? [null, 0]
    return { ...segment, diarizationLabel: label && shared / total >= DOMINANT_SPEAKER_SHARE ? label : 'UNATTRIBUTED' }
  })
}

async function invokePyannoteWorker({ python, modelDir, inputPath, outputPath, workerPath, env }) {
  await execFile(python, [workerPath, '--model', modelDir, '--input', inputPath, '--output', outputPath], {
    windowsHide: true,
    timeout: 30 * 60 * 1000,
    maxBuffer: 16 * 1024,
    env: localWorkerEnvironment(env),
  })
}

// Local-only adapter for an operator-provisioned pyannote Community-1 model.
// It does not accept a Hugging Face token and never contacts the hub. The
// caller owns the decrypted recording bytes only for the duration of this
// function; both input and output are removed in the finally path.
export class LocalPyannoteDiarizer {
  constructor({
    python = process.env.DIARIZATION_PYTHON,
    modelDir = process.env.DIARIZATION_MODEL_DIR,
    tempRoot = process.env.MEETING_DIARIZATION_TEMP_DIR ?? join(tmpdir(), 'meeting-ledger-diarization'),
    workerPath = workerFile,
    env = process.env,
    runWorker = invokePyannoteWorker,
  } = {}) {
    this.python = python
    this.modelDir = modelDir
    this.tempRoot = resolve(tempRoot)
    this.workerPath = workerPath instanceof URL ? fileURLToPath(workerPath) : workerPath
    this.env = env
    this.runWorker = runWorker
  }

  get enabled() {
    return typeof this.python === 'string' && this.python.length > 0 && typeof this.modelDir === 'string' && this.modelDir.length > 0
  }

  async diarize(bytes) {
    if (!this.enabled) return Object.freeze([])
    const { durationMs } = parseSpeechWav(bytes)
    const modelDir = resolve(this.modelDir)
    if (!existsSync(modelDir)) throw new Error('Configured diarization model directory is unavailable')
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 })
    const jobDirectory = await mkdtemp(join(this.tempRoot, 'job-'))
    if (!containedPath(this.tempRoot, jobDirectory)) throw new Error('Invalid diarization job directory')
    const inputPath = join(jobDirectory, 'recording.wav')
    const outputPath = join(jobDirectory, 'turns.json')
    try {
      await writeFile(inputPath, bytes, { mode: 0o600 })
      await this.runWorker({
        python: this.python,
        modelDir,
        inputPath,
        outputPath,
        workerPath: this.workerPath,
        env: this.env,
      })
      const output = await stat(outputPath)
      if (!output.isFile() || output.size > MAX_OUTPUT_BYTES) throw new Error('Invalid local diarization output')
      return safeTurns(JSON.parse(await readFile(outputPath, 'utf8')), durationMs)
    } finally {
      // `jobDirectory` was created under `tempRoot` above and is verified
      // before it can be recursively removed.
      if (containedPath(this.tempRoot, jobDirectory)) await rm(jobDirectory, { recursive: true, force: true, maxRetries: 2 })
    }
  }
}

export const LOCAL_PYANNOTE_WORKER_FILE = basename(fileURLToPath(workerFile))
