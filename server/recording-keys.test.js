import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encryptAudio, openRecordingAudio, RECORDING_DATA_KEY_VERSION, sealRecordingAudio } from './adapters/audio-encryption.js'
import { openRecordingKeyStore } from './adapters/recording-keys.js'

const MASTER = randomBytes(32)
const AUDIO = randomBytes(4096)

async function withStore(work, masterKey = () => MASTER) {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-ledger-rk-'))
  try { return await work(openRecordingKeyStore({ directory, masterKey }), directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('each recording gets its own wrapped key, in a file whose name discloses no identifier', async () => {
  await withStore(async (keys, directory) => {
    const first = await sealRecordingAudio(keys, 'northstar', 'recording-a', AUDIO)
    const second = await sealRecordingAudio(keys, 'northstar', 'recording-b', AUDIO)
    assert.equal(first.keyVersion, RECORDING_DATA_KEY_VERSION)
    assert.notDeepEqual(await keys.read('northstar', 'recording-a'), await keys.read('northstar', 'recording-b'))
    const files = readdirSync(directory)
    assert.equal(files.length, 2)
    assert.ok(files.every((name) => /^[0-9a-f]{64}\.key$/.test(name) && !name.includes('recording') && !name.includes('northstar')))
    for (const name of files) assert.equal(readFileSync(join(directory, name)).indexOf(await keys.read('northstar', 'recording-a')), -1, 'the data key is never stored in the clear')
    assert.deepEqual(await openRecordingAudio({ masterKey: () => MASTER, recordingKeys: keys }, 'northstar', 'recording-b', second), AUDIO)
  })
})

test('destroying a recording key makes every surviving copy of its ciphertext unreadable', async () => {
  await withStore(async (keys) => {
    const sealed = await sealRecordingAudio(keys, 'northstar', 'recording-a', AUDIO)
    const backupCopy = structuredClone(sealed)
    assert.equal(keys.destroy('northstar', 'recording-a'), true)
    assert.equal(keys.destroy('northstar', 'recording-a'), false, 'destroy is idempotent')
    await assert.rejects(openRecordingAudio({ masterKey: () => MASTER, recordingKeys: keys }, 'northstar', 'recording-a', backupCopy), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    // The master key alone never opens per-recording ciphertext.
    await assert.rejects(async () => openRecordingAudio({ masterKey: () => MASTER, recordingKeys: keys }, 'northstar', 'recording-a', { ...backupCopy, keyVersion: 1 }), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
  })
})

test('a wrapped key is bound to its tenant and recording, and to the master key', async () => {
  await withStore(async (keys, directory) => {
    await sealRecordingAudio(keys, 'northstar', 'recording-a', AUDIO)
    await keys.create('northstar', 'recording-b')
    // Swap the two key files: neither recording may open with the other's key.
    const files = readdirSync(directory)
    renameSync(join(directory, files[0]), join(directory, 'swap'))
    renameSync(join(directory, files[1]), join(directory, files[0]))
    renameSync(join(directory, 'swap'), join(directory, files[1]))
    await assert.rejects(keys.read('northstar', 'recording-a'), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    await assert.rejects(keys.read('northstar', 'recording-b'), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
  })
  await withStore(async (keys, directory) => {
    await keys.create('northstar', 'recording-a')
    const other = openRecordingKeyStore({ directory, masterKey: () => randomBytes(32) })
    await assert.rejects(other.read('northstar', 'recording-a'), { code: 'RECORDING_CONTENT_UNAVAILABLE' }, 'a different master key cannot unwrap it')
    const name = readdirSync(directory)[0]
    writeFileSync(join(directory, name), readFileSync(join(directory, name)).subarray(0, 20))
    await assert.rejects(keys.read('northstar', 'recording-a'), { code: 'RECORDING_CONTENT_UNAVAILABLE' }, 'a truncated key file fails closed')
  })
})

test('a master-key outage fails closed before any key is created or read', async () => {
  let available = true
  await withStore(async (keys, directory) => {
    await keys.create('northstar', 'recording-a')
    available = false
    await assert.rejects(keys.create('northstar', 'recording-b'), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    await assert.rejects(keys.read('northstar', 'recording-a'), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    assert.equal(readdirSync(directory).length, 1, 'no key file was written during the outage')
  }, () => { if (!available) throw new Error('C:\\secret\\path missing'); return MASTER })
})

test('replacing a recording key leaves no staging file and invalidates the earlier ciphertext', async () => {
  await withStore(async (keys, directory) => {
    const earlier = await sealRecordingAudio(keys, 'northstar', 'recording-a', AUDIO)
    const later = await sealRecordingAudio(keys, 'northstar', 'recording-a', AUDIO)
    assert.equal(readdirSync(directory).length, 1)
    const opener = { masterKey: () => MASTER, recordingKeys: keys }
    await assert.rejects(openRecordingAudio(opener, 'northstar', 'recording-a', earlier), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    assert.deepEqual(await openRecordingAudio(opener, 'northstar', 'recording-a', later), AUDIO)
  })
})

test('audio stored before per-recording keys stays readable with the master key', async () => {
  await withStore(async (keys) => {
    const legacy = encryptAudio(MASTER, 'northstar', 'recording-old', AUDIO)
    assert.equal(legacy.keyVersion, 1)
    assert.deepEqual(await openRecordingAudio({ masterKey: () => MASTER, recordingKeys: keys }, 'northstar', 'recording-old', legacy), AUDIO)
  })
})

test('the key store refuses a directory it cannot write', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-ledger-rk-'))
  try {
    const blocker = join(directory, 'not-a-directory')
    writeFileSync(blocker, '')
    assert.throws(() => openRecordingKeyStore({ directory: blocker, masterKey: () => MASTER }), { code: 'INVALID_STORAGE_KEY' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
