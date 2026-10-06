import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError, invariant } from '../errors.js'

// Per-recording data keys for crypto-shredding. Each recording's audio is
// encrypted under its own random 256-bit key. That key is wrapped (AES-256-GCM)
// by the operator's master audio key and kept as one small file in a key
// directory that is never part of a database dump. Deleting a recording's
// content overwrites and removes its key file, so every remaining copy of the
// ciphertext (PostgreSQL dead tuples, WAL, logical backups) becomes
// permanently unreadable even though the master key survives.
//
// File names are a hash of tenant and recording, so the directory listing
// discloses no identifiers. The wrap binds the key to its tenant and recording.
const WRAP_FORMAT = 1
const WRAPPED_LENGTH = 1 + 12 + 16 + 32
const restrictToOwner = (path) => { try { chmodSync(path, 0o600) } catch { /* best effort; Windows uses ACLs */ } }
const unavailable = () => new DomainError('RECORDING_CONTENT_UNAVAILABLE', 'Recording audio key is unavailable', 503)
const wrapAad = (tenantId, recordingId) => Buffer.from(`recording-key:${WRAP_FORMAT}:${tenantId}:${recordingId}`)

export function openRecordingKeyStore({ directory, masterKey }) {
  invariant(typeof directory === 'string' && directory.length > 0, 'INVALID_STORAGE_KEY', 'A recording key directory is required', 500)
  invariant(typeof masterKey === 'function', 'INVALID_STORAGE_KEY', 'The recording key store needs a master key provider', 500)
  try {
    mkdirSync(directory, { recursive: true })
    // Refuse to start on a directory the server cannot write: a later upload
    // would otherwise fail only after the operator believes setup is done.
    const probe = join(directory, `.probe-${randomBytes(6).toString('hex')}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch {
    throw new DomainError('INVALID_STORAGE_KEY', 'The recording key directory is not writable', 500)
  }
  const pathFor = (tenantId, recordingId) => join(directory, `${createHash('sha256').update(`${tenantId}\0${recordingId}`).digest('hex')}.key`)
  const master = async () => {
    try {
      const key = await masterKey()
      if (Buffer.isBuffer(key) && key.length === 32) return key
    } catch { /* the provider exposes only availability */ }
    throw unavailable()
  }

  return Object.freeze({
    directory,
    // Creates a fresh key for this recording, replacing any earlier one, and
    // returns it. The file is written beside its final name and renamed into
    // place so a crash never leaves a truncated key.
    async create(tenantId, recordingId) {
      const wrappingKey = await master()
      const dataKey = randomBytes(32)
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce)
      cipher.setAAD(wrapAad(tenantId, recordingId))
      const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()])
      const path = pathFor(tenantId, recordingId)
      const staging = `${path}.${randomBytes(6).toString('hex')}.tmp`
      try {
        writeFileSync(staging, Buffer.concat([Buffer.from([WRAP_FORMAT]), nonce, cipher.getAuthTag(), wrapped]), { flag: 'wx', mode: 0o600 })
        restrictToOwner(staging)
        if (existsSync(path)) shred(path)
        renameSync(staging, path)
      } catch {
        rmSync(staging, { force: true })
        throw unavailable()
      }
      return dataKey
    },
    async read(tenantId, recordingId) {
      const wrappingKey = await master()
      let file
      try { file = readFileSync(pathFor(tenantId, recordingId)) } catch { throw unavailable() }
      if (file.length !== WRAPPED_LENGTH || file[0] !== WRAP_FORMAT) throw unavailable()
      try {
        const decipher = createDecipheriv('aes-256-gcm', wrappingKey, file.subarray(1, 13))
        decipher.setAAD(wrapAad(tenantId, recordingId))
        decipher.setAuthTag(file.subarray(13, 29))
        return Buffer.concat([decipher.update(file.subarray(29)), decipher.final()])
      } catch {
        throw unavailable()
      }
    },
    // Idempotent. Returns whether a key existed.
    destroy(tenantId, recordingId) {
      const path = pathFor(tenantId, recordingId)
      if (!existsSync(path)) return false
      shred(path)
      return true
    },
    has: (tenantId, recordingId) => existsSync(pathFor(tenantId, recordingId)),
  })
}

// Overwrite before unlinking so the key bytes do not stay in the file's
// allocated clusters. Flash wear-levelling can still retain old blocks; the
// residual exposure is a 61-byte wrapped key that also needs the master key.
function shred(path) {
  const { size } = statSync(path)
  const descriptor = openSync(path, 'r+')
  try {
    writeSync(descriptor, randomBytes(Math.max(size, WRAPPED_LENGTH)), 0, Math.max(size, WRAPPED_LENGTH), 0)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  unlinkSync(path)
}
