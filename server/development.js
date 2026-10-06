import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { FakeSpeechProcessor, LocalMeetingProcessor } from './speech.js'
import { createInMemoryMeetingStorage } from './storage.js'
import { LocalWhisperTranscriber } from './transcription.js'
import { LocalPyannoteDiarizer } from './diarization.js'
import { ClaudeMeetingIntelligence } from './intelligence.js'
import { OpenAIMeetingIntelligence } from './intelligence-openai.js'
import { RECORDING_MIME_TYPES, SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'

// 16 kHz mono 16-bit WAV is 32 KB/s: 160 MB holds roughly 83 minutes.
const LOCAL_MAX_RECORDING_BYTES = 160 * 1024 * 1024

// Development tenants and their retention rules: meeting content is kept for
// 30 days from its first upload, then the sweep deletes it.
export const DEVELOPMENT_TENANTS = Object.freeze(['northstar'])
const DEVELOPMENT_RETENTION_POLICIES = Object.freeze([{ tenantId: 'northstar', classification: '*', retainDays: 30 }])

// Summaries are enabled only when a provider's credentials are actually present,
// so a missing key yields an honest "transcription only" result instead of a
// failed recording. Keys come from the environment (or an `ant auth login`
// profile); they are never read by, or sent to, the browser.
export function hasAnthropicCredentials(env = process.env, platform = process.platform) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true
  const configDir = env.ANTHROPIC_CONFIG_DIR
    ?? (platform === 'win32' && env.APPDATA ? join(env.APPDATA, 'Anthropic') : join(homedir(), '.config', 'anthropic'))
  const credentials = join(configDir, 'credentials')
  return existsSync(credentials) && readdirSync(credentials).some((name) => name.endsWith('.json'))
}

export function hasOpenAICredentials(env = process.env) {
  return Boolean(String(env.OPENAI_API_KEY ?? '').trim())
}

// Which provider writes summaries: MEETING_SUMMARY_PROVIDER picks one
// explicitly ('openai', 'anthropic', or 'none'); otherwise Anthropic when its
// credentials exist, then OpenAI. A chosen provider without credentials gives
// an honest transcript-only result, never a silent switch to the other one.
export function summaryProvider(env = process.env) {
  const chosen = String(env.MEETING_SUMMARY_PROVIDER ?? '').trim().toLowerCase()
  if (chosen === 'none') return 'none'
  if (chosen === 'openai') return hasOpenAICredentials(env) ? 'openai' : 'none'
  if (chosen === 'anthropic') return hasAnthropicCredentials(env) ? 'anthropic' : 'none'
  if (hasAnthropicCredentials(env)) return 'anthropic'
  return hasOpenAICredentials(env) ? 'openai' : 'none'
}

function createMeetingIntelligence(env) {
  const provider = summaryProvider(env)
  if (provider === 'openai') return new OpenAIMeetingIntelligence()
  if (provider === 'anthropic') return new ClaudeMeetingIntelligence()
  return null
}

export function createSpeechProcessor({ mode = process.env.MEETING_PROCESSOR ?? 'local', env = process.env } = {}) {
  if (mode === 'fake') return new FakeSpeechProcessor()
  return new LocalMeetingProcessor({
    transcriber: new LocalWhisperTranscriber(),
    diarizer: new LocalPyannoteDiarizer({ env }),
    intelligence: createMeetingIntelligence(env),
  })
}

// `storage` defaults to in-memory so tests never touch disk; the local servers
// pass durable SQLite storage (see server/adapters/sqlite.js).
export async function createDevelopmentPlatform({ speechProcessor = createSpeechProcessor(), storage = createInMemoryMeetingStorage() } = {}) {
  const platform = new MeetingIntelligencePlatform({
    storage, speechProcessor,
    policy: new PolicyEngine({ retentionPolicies: DEVELOPMENT_RETENTION_POLICIES }),
    maxRecordingBytes: LOCAL_MAX_RECORDING_BYTES,
    // The real pipeline transcribes only verified 16 kHz mono WAV.
    acceptedMimeTypes: speechProcessor instanceof FakeSpeechProcessor ? RECORDING_MIME_TYPES : [SPEECH_WAV_MIME_TYPE],
  })
  for (const tenantId of DEVELOPMENT_TENANTS) await platform.recoverInterruptedProcessing(tenantId, 'development-startup')
  return platform
}
