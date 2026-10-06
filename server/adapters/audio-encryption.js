import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { invariant } from '../errors.js'
import { MEETING_LEDGER_DATA_MODEL_VERSION } from '../storage.js'

// Recording audio encryption shared by every durable backend: AES-256-GCM with
// a fresh 96-bit nonce per write. The additional authenticated data binds each
// ciphertext to its tenant and recording, so a blob moved onto another
// recording, any altered byte, or a wrong key fails authentication instead of
// yielding audio.
//
// Version 1 ciphertext is encrypted directly under the master audio key.
// Version 2 is encrypted under the recording's own data key (recording-keys.js),
// so destroying that key erases every copy. New audio is always version 2;
// version 1 remains readable for recordings stored before per-recording keys.
export const AUDIO_KEY_VERSION = 1
export const RECORDING_DATA_KEY_VERSION = 2
const READABLE_VERSIONS = new Set([AUDIO_KEY_VERSION, RECORDING_DATA_KEY_VERSION])

const restrictToOwner = (path) => { try { chmodSync(path, 0o600) } catch { /* best effort; Windows uses ACLs */ } }
const audioAad = (tenantId, recordingId) => Buffer.from(`${MEETING_LEDGER_DATA_MODEL_VERSION}:${tenantId}:${recordingId}`)

function assertKey(key) {
  invariant(Buffer.isBuffer(key) && key.length === 32, 'INVALID_STORAGE_KEY', 'The recording audio key must be 256 bits', 500)
  return key
}

// Reads an existing key file. Used where the operator must supply the key
// (self-hosted PostgreSQL): a missing key is a configuration error, never a
// reason to generate a new one silently.
export function readAudioKeyFile(keyFile) {
  invariant(typeof keyFile === 'string' && existsSync(keyFile), 'INVALID_STORAGE_KEY', 'The recording audio key file does not exist', 500)
  return assertKey(readFileSync(keyFile))
}

// Creates the key on first use, for the single-machine local setup.
export function loadOrCreateAudioKey(keyFile) {
  if (!existsSync(keyFile)) {
    mkdirSync(dirname(keyFile), { recursive: true })
    try {
      writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  restrictToOwner(keyFile)
  return assertKey(readFileSync(keyFile))
}

export function encryptAudio(key, tenantId, recordingId, bytes, keyVersion = AUDIO_KEY_VERSION) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', assertKey(key), nonce)
  cipher.setAAD(audioAad(tenantId, recordingId))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()])
  return { keyVersion, nonce, tag: cipher.getAuthTag(), ciphertext }
}

export function decryptAudio(key, tenantId, recordingId, { keyVersion, nonce, tag, ciphertext }) {
  invariant(READABLE_VERSIONS.has(keyVersion), 'RECORDING_CONTENT_UNAVAILABLE', 'Recording audio was encrypted with an unavailable key', 409)
  try {
    const decipher = createDecipheriv('aes-256-gcm', assertKey(key), Buffer.from(nonce))
    decipher.setAAD(audioAad(tenantId, recordingId))
    decipher.setAuthTag(Buffer.from(tag))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()])
  } catch {
    // Never return partially decrypted or tampered audio.
    invariant(false, 'RECORDING_CONTENT_UNAVAILABLE', 'Recording audio failed its integrity check', 409)
  }
}

// Seals new audio under a fresh per-recording key.
export async function sealRecordingAudio(recordingKeys, tenantId, recordingId, bytes) {
  return encryptAudio((await recordingKeys.create(tenantId, recordingId)), tenantId, recordingId, bytes, RECORDING_DATA_KEY_VERSION)
}

// Opens either format. A version 2 row whose key was destroyed is unavailable.
export async function openRecordingAudio({ masterKey, recordingKeys }, tenantId, recordingId, sealed) {
  const key = sealed.keyVersion === RECORDING_DATA_KEY_VERSION
    ? (await recordingKeys.read(tenantId, recordingId))
    : (await masterKey())
  return decryptAudio(key, tenantId, recordingId, sealed)
}
