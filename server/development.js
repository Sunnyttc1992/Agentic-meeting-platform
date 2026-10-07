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
import { ClaudeChatAnswerer, OpenAIChatAnswerer } from './chat.js'
import { OllamaEmbedder } from './embeddings.js'
import { ChatQuota, DEFAULT_DAILY_QUESTION_LIMIT } from './guardrails.js'
import { DEFAULT_CHAT_RETENTION_DAYS } from './chat-memory.js'
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

// Meeting chat sends excerpts from several meetings to a provider, a wider
// flow than a summary, so it is off unless MEETING_CHAT_PROVIDER names one
// ('openai' or 'anthropic') whose credentials exist. Otherwise chat still
// finds and cites matching excerpts locally, without writing an answer.
export function chatProvider(env = process.env) {
  const chosen = String(env.MEETING_CHAT_PROVIDER ?? '').trim().toLowerCase()
  if (chosen === 'openai') return hasOpenAICredentials(env) ? 'openai' : 'none'
  if (chosen === 'anthropic') return hasAnthropicCredentials(env) ? 'anthropic' : 'none'
  return 'none'
}

export function createChatAnswerer(env = process.env) {
  const provider = chatProvider(env)
  if (provider === 'openai') return new OpenAIChatAnswerer()
  if (provider === 'anthropic') return new ClaudeChatAnswerer()
  return null
}

// Meaning-based chat retrieval uses a local embedding model through Ollama on
// this computer (bge-m3 unless MEETING_EMBEDDING_MODEL names another). Set
// MEETING_EMBEDDING_MODEL=none to use keyword retrieval only. When Ollama is
// not running, chat falls back to keywords per question.
export function createEmbedder(env = process.env) {
  const model = String(env.MEETING_EMBEDDING_MODEL ?? '').trim()
  if (model.toLowerCase() === 'none') return null
  return new OllamaEmbedder({ baseUrl: env.OLLAMA_URL ?? 'http://127.0.0.1:11434', ...(model ? { model } : {}) })
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
export async function createDevelopmentPlatform({ speechProcessor = createSpeechProcessor(), storage = createInMemoryMeetingStorage(), chatAnswerer = createChatAnswerer(), embedder = createEmbedder(), env = process.env } = {}) {
  // Chat guardrail and memory settings: a daily question limit per user and
  // how long saved chat is kept.
  const positive = (value, fallback) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback)
  const platform = new MeetingIntelligencePlatform({
    storage, speechProcessor, chatAnswerer, embedder,
    chatQuota: new ChatQuota({ limit: positive(env.MEETING_CHAT_DAILY_LIMIT, DEFAULT_DAILY_QUESTION_LIMIT) }),
    chatRetentionDays: positive(env.MEETING_CHAT_RETENTION_DAYS, DEFAULT_CHAT_RETENTION_DAYS),
    policy: new PolicyEngine({ retentionPolicies: DEVELOPMENT_RETENTION_POLICIES }),
    maxRecordingBytes: LOCAL_MAX_RECORDING_BYTES,
    // The real pipeline transcribes only verified 16 kHz mono WAV.
    acceptedMimeTypes: speechProcessor instanceof FakeSpeechProcessor ? RECORDING_MIME_TYPES : [SPEECH_WAV_MIME_TYPE],
  })
  for (const tenantId of DEVELOPMENT_TENANTS) await platform.recoverInterruptedProcessing(tenantId, 'development-startup')
  return platform
}
