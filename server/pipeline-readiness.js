import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasAnthropicCredentials } from './development.js'

const require = createRequire(import.meta.url)
const defaultCacheDir = fileURLToPath(new URL('../.cache/models', import.meta.url))
const defaultModel = 'onnx-community/whisper-base'

function safeBoolean(check) {
  try { return Boolean(check()) } catch { return false }
}

function modelDirectories(cacheDir, model) {
  const normalized = String(model).replaceAll('/', '--')
  return [join(cacheDir, `models--${normalized}`), join(cacheDir, String(model))]
}

// A cache directory alone does not mean a model is usable. Check only the
// cache tree, with a deliberately shallow bounded walk, for both a model
// configuration file and an ONNX weight. This never invokes transformers.js,
// creates a download, or emits a filesystem path to the caller.
export function hasCachedWhisperModel({ cacheDir = defaultCacheDir, model = defaultModel, exists = existsSync, readDir = readdirSync } = {}) {
  const inspect = (directory, depth = 0) => {
    if (depth > 5 || !exists(directory)) return { config: false, weights: false }
    let entries
    try { entries = readDir(directory, { withFileTypes: true }) } catch { return { config: false, weights: false } }
    let config = false
    let weights = false
    for (const entry of entries) {
      if (entry.isFile?.()) {
        config ||= entry.name === 'config.json'
        weights ||= entry.name.endsWith('.onnx')
      } else if (entry.isDirectory?.() && !(config && weights)) {
        const found = inspect(join(directory, entry.name), depth + 1)
        config ||= found.config
        weights ||= found.weights
      }
      if (config && weights) return { config, weights }
    }
    return { config, weights }
  }

  return modelDirectories(cacheDir, model).some((directory) => {
    const found = inspect(directory)
    return found.config && found.weights
  })
}

export function hasLocalWhisperRuntime(resolveModule = require.resolve) {
  return safeBoolean(() => resolveModule('@huggingface/transformers'))
}

// This probe is intentionally side-effect free. It reports readiness, not a
// live health check: it never initializes Whisper, downloads model weights,
// opens a connection to Anthropic, reads credential values, or sends audio.
export function createPipelineReadiness({
  env = process.env,
  model = env.WHISPER_MODEL ?? defaultModel,
  cacheDir = defaultCacheDir,
  runtimeAvailable = hasLocalWhisperRuntime,
  modelCached = hasCachedWhisperModel,
  anthropicConfigured = hasAnthropicCredentials,
} = {}) {
  return Object.freeze({
    inspect({ teamsReadiness } = {}) {
      const teamsNotConnected = teamsReadiness?.connection === 'not-connected'
      return Object.freeze({
        scope: 'loopback-only',
        whisper: Object.freeze({
          runtimeAvailable: safeBoolean(() => runtimeAvailable()),
          modelCacheReady: safeBoolean(() => modelCached({ cacheDir, model })),
        }),
        anthropic: Object.freeze({ credentialsConfigured: safeBoolean(() => anthropicConfigured(env)) }),
        teams: Object.freeze({ connection: teamsNotConnected ? 'not-connected' : 'unavailable' }),
      })
    },
  })
}
