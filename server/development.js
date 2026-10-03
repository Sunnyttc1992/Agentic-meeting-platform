import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { FakeSpeechProcessor, LocalMeetingProcessor } from './speech.js'
import { createInMemoryMeetingStorage } from './storage.js'
import { LocalWhisperTranscriber } from './transcription.js'
import { ClaudeMeetingIntelligence } from './intelligence.js'
import { RECORDING_MIME_TYPES, SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'

// 16 kHz mono 16-bit WAV is 32 KB/s: 160 MB holds roughly 83 minutes.
const LOCAL_MAX_RECORDING_BYTES = 160 * 1024 * 1024

// Summaries are enabled only when Anthropic credentials are actually present,
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

export function createSpeechProcessor({ mode = process.env.MEETING_PROCESSOR ?? 'local', env = process.env } = {}) {
  if (mode === 'fake') return new FakeSpeechProcessor()
  return new LocalMeetingProcessor({
    transcriber: new LocalWhisperTranscriber(),
    intelligence: hasAnthropicCredentials(env) ? new ClaudeMeetingIntelligence() : null,
  })
}

export function createDevelopmentPlatform({ speechProcessor = createSpeechProcessor() } = {}) {
  const storage = createInMemoryMeetingStorage()
  const platform = new MeetingIntelligencePlatform({
    storage, speechProcessor,
    policy: new PolicyEngine(),
    maxRecordingBytes: LOCAL_MAX_RECORDING_BYTES,
    // The real pipeline transcribes only verified 16 kHz mono WAV.
    acceptedMimeTypes: speechProcessor instanceof FakeSpeechProcessor ? RECORDING_MIME_TYPES : [SPEECH_WAV_MIME_TYPE],
  })
  platform.createMeeting(
    { tenantId: 'northstar', userId: 'alex' },
    {
      id: 'meeting-1',
      tenantId: 'northstar',
      organizerId: 'alex',
      participantIds: ['alex', 'sam'],
      requiredParticipantIds: ['alex', 'sam'],
      classification: 'standard',
      consentPolicyVersion: 'v1',
    },
    'development-seed',
  )
  return platform
}
