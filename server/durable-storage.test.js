import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FixedClock } from './adapters/in-memory.js'
import { openLocalDurableStorage } from './adapters/sqlite.js'
import { verifyAuditChain } from './audit.js'
import { ClaudeMeetingIntelligence } from './intelligence.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { LocalMeetingProcessor } from './speech.js'
import { assertMeetingStorageContract } from './storage.js'
import { encodeWavPcm16 } from '../src/audioTranscode.js'
import { SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'

const alex = { tenantId: 'northstar', userId: 'alex' }
const sam = { tenantId: 'northstar', userId: 'sam' }
const REPLY = {
  summary: { text: 'Rollout stays phased pending security sign-off.', citations: ['S1'] },
  decisions: [{ text: 'Keep the phased rollout.', citations: ['S1'] }], risks: [], open_questions: [],
  action_plan: [{ action: 'Send the security findings.', owner_participant_id: 'sam', due_date: '2026-10-20', citations: ['S2'] }],
}
// A distinctive waveform, so the raw database file can be searched for it.
const AUDIO = Buffer.from(encodeWavPcm16(Float32Array.from({ length: 16000 }, (_, index) => Math.sin(index * 0.37) * 0.6)))

function tempDirectory() { return mkdtempSync(join(tmpdir(), 'meeting-ledger-')) }

function openPlatform(directory, { schedule = (job) => job() } = {}) {
  const durable = openLocalDurableStorage({ directory })
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(REPLY) }] }) } } }
  const platform = new MeetingIntelligencePlatform({
    storage: durable.storage, clock: new FixedClock('2026-10-03T12:00:00Z'), policy: new PolicyEngine(),
    speechProcessor: new LocalMeetingProcessor({
      transcriber: { transcribe: async () => [{ startMs: 0, endMs: 3000, text: 'Rollout stays phased.' }, { startMs: 3000, endMs: 6000, text: 'Sam sends the security findings by October 20.' }] },
      intelligence: new ClaudeMeetingIntelligence({ client }),
    }),
    acceptedMimeTypes: [SPEECH_WAV_MIME_TYPE], schedule,
  })
  return { platform, durable }
}

async function seedMeeting(platform) {
  await platform.createMeeting(alex, { id: 'meeting-1', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard', consentPolicyVersion: 'v1' })
  for (const actor of [alex, sam]) await platform.recordConsent(actor, 'meeting-1', { participantId: actor.userId, capturedAt: '2026-10-03T11:59:00Z', expiresAt: '2026-10-03T15:00:00Z', policyVersion: 'v1', decision: 'granted', method: 'explicit' })
}

async function uploadAudio(platform) {
  const lease = (await platform.authorizeRecording(alex, 'meeting-1'))
  const created = (await platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType: SPEECH_WAV_MIME_TYPE, byteLength: AUDIO.length, sha256: createHash('sha256').update(AUDIO).digest('hex') }))
  await platform.uploadRecording(alex, 'meeting-1', created.recordingId, { contentType: SPEECH_WAV_MIME_TYPE, contentLength: AUDIO.length, bytes: AUDIO })
  return created.recordingId
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('the SQLite adapter satisfies the sealed storage contract', async () => {
  const directory = tempDirectory()
  const { durable } = openPlatform(directory)
  try {
    assert.equal((await assertMeetingStorageContract(durable.storage)), durable.storage)
    assert.equal(durable.storage.kind, 'local-sqlite')
  } finally { durable.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('a processed meeting survives a restart, and the audit chain continues unbroken', async () => {
  const directory = tempDirectory()
  try {
    const first = openPlatform(directory)
    await seedMeeting(first.platform)
    const recordingId = (await uploadAudio(first.platform))
    await first.platform.startProcessing(alex, 'meeting-1', recordingId)
    await settle()
    const before = (await first.platform.getRecording(alex, 'meeting-1', recordingId))
    assert.equal(before.recording.state, 'completed')
    const headBefore = first.durable.storage.scope({ tenantId: 'northstar' }).audit.chain().length
    first.durable.close()

    const second = openPlatform(directory)
    try {
      const after = (await second.platform.getRecording(sam, 'meeting-1', recordingId))
      assert.deepEqual(after.segments, before.segments)
      assert.deepEqual(after.assertions, before.assertions)
      assert.deepEqual((await second.platform.queryCommitments(sam, '')).commitments.map((item) => [item.ownerId, item.deadline]), [['sam', '2026-10-20T00:00:00.000Z']])
      assert.match((await second.platform.exportMeetingRecord(sam, 'meeting-1')).body, /Send the security findings\. \| Proposed \| sam \| 2026-10-20/)
      assert.ok((await second.platform.authorizeRecording(alex, 'meeting-1')).leaseId, 'consent evidence survived the restart')

      const chain = second.durable.storage.scope({ tenantId: 'northstar' }).audit.chain()
      assert.ok(chain.length > headBefore, 'new events extend the existing chain')
      assert.equal(verifyAuditChain(chain, { tenantId: 'northstar' }).valid, true)
    } finally { second.durable.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a second recording keeps the first recording\'s transcript and actions in the same SQLite transaction', async () => {
  const directory = tempDirectory()
  const { platform, durable } = openPlatform(directory)
  try {
    await seedMeeting(platform)
    const first = await uploadAudio(platform)
    await platform.startProcessing(alex, 'meeting-1', first)
    await settle()
    const before = await platform.getRecording(alex, 'meeting-1', first)
    const second = await uploadAudio(platform)
    await platform.startProcessing(alex, 'meeting-1', second)
    await settle()
    assert.equal((await platform.getRecording(alex, 'meeting-1', second)).recording.state, 'completed')
    const after = await platform.getRecording(sam, 'meeting-1', first)
    assert.deepEqual(after.segments, before.segments)
    assert.deepEqual(after.assertions, before.assertions)
    assert.equal((await platform.queryCommitments(sam, '')).commitments.length, 2)
  } finally { durable.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('recording audio is encrypted at rest, bound to its recording, and fails closed when tampered or rekeyed', async () => {
  const directory = tempDirectory()
  try {
    const { platform, durable } = openPlatform(directory, { schedule: () => {} })
    await seedMeeting(platform)
    const recordingId = (await uploadAudio(platform))
    const otherId = (await uploadAudio(platform))
    const write = async (operation) => (await durable.storage.transaction({ tenantId: 'northstar' }, operation))
    assert.deepEqual((await write((tx) => tx.recordings.getBytes(recordingId))), AUDIO, 'decrypts to the original bytes')
    durable.close()

    const probe = AUDIO.subarray(2000, 2064)
    for (const file of readdirSync(directory).filter((name) => name.startsWith('meeting-ledger.sqlite'))) {
      assert.equal(readFileSync(join(directory, file)).indexOf(probe), -1, `${file} contains no plaintext audio`)
    }

    const raw = new DatabaseSync(join(directory, 'meeting-ledger.sqlite'))
    const original = raw.prepare('SELECT nonce, tag, ciphertext FROM recording_content WHERE recording_id = ?').get(recordingId)
    raw.prepare('UPDATE recording_content SET nonce = ?, tag = ?, ciphertext = ? WHERE recording_id = ?').run(original.nonce, original.tag, original.ciphertext, otherId)
    const flipped = Buffer.from(original.ciphertext); flipped[100] ^= 0xff
    raw.prepare('UPDATE recording_content SET ciphertext = ? WHERE recording_id = ?').run(flipped, recordingId)
    raw.close()

    const reopened = openLocalDurableStorage({ directory })
    const read = async (id) => (await reopened.storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes(id)))
    await assert.rejects(async () => (await read(recordingId)), { code: 'RECORDING_CONTENT_UNAVAILABLE' }, 'a flipped byte fails authentication')
    await assert.rejects(async () => (await read(otherId)), { code: 'RECORDING_CONTENT_UNAVAILABLE' }, 'ciphertext moved onto another recording fails')
    reopened.close()

    writeFileSync(join(directory, 'keys', 'recording-audio-v1.key'), randomBytes(32))
    const rekeyed = openLocalDurableStorage({ directory })
    await assert.rejects(async () => (await rekeyed.storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes(otherId))), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    rekeyed.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the database itself refuses to edit or delete audit events', async () => {
  const directory = tempDirectory()
  try {
    const { platform, durable } = openPlatform(directory)
    await seedMeeting(platform)
    durable.close()
    const raw = new DatabaseSync(join(directory, 'meeting-ledger.sqlite'))
    assert.throws(() => raw.exec("UPDATE audit_events SET doc = '{}'"), /append-only/)
    assert.throws(() => raw.exec('DELETE FROM audit_events'), /append-only/)
    assert.ok(raw.prepare('SELECT count(*) AS n FROM audit_events').get().n > 0)
    raw.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a failed transaction rolls back every write, including nested ones', async () => {
  const directory = tempDirectory()
  const durable = openLocalDurableStorage({ directory })
  try {
    const meeting = { id: 'rollback-1', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex'] }
    await assert.rejects(async () => (await durable.storage.transaction({ tenantId: 'northstar' }, async (tx) => {
      tx.meetings.save(meeting)
      await durable.storage.transaction({ tenantId: 'northstar' }, (inner) => inner.outbox.enqueue({ tenantId: 'northstar', type: 'meeting.changed', idempotencyKey: 'k1' }))
      throw new Error('fail after writing')
    })), /fail after writing/)
    const scope = durable.storage.scope({ tenantId: 'northstar' })
    assert.equal(scope.meetings.get('rollback-1'), null)
    assert.deepEqual(scope.outbox.list(), [])
    await assert.rejects(async () => (await durable.storage.transaction({ tenantId: 'northstar' }, (tx) => tx.meetings.save({ ...meeting, tenantId: 'southstar' }))), { code: 'TENANT_SCOPE_VIOLATION' })
    await durable.storage.transaction({ tenantId: 'northstar' }, (tx) => tx.meetings.save(meeting))
    assert.equal(scope.meetings.get('rollback-1').id, 'rollback-1', 'the next transaction works normally')
    assert.equal(durable.storage.scope({ tenantId: 'southstar' }).meetings.get('rollback-1'), null, 'other tenants cannot see it')
  } finally { durable.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('a job interrupted by a restart comes back failed and retryable, and then completes', async () => {
  const directory = tempDirectory()
  try {
    const first = openPlatform(directory, { schedule: () => {} })
    await seedMeeting(first.platform)
    const recordingId = (await uploadAudio(first.platform))
    await first.platform.startProcessing(alex, 'meeting-1', recordingId)
    assert.equal((await first.platform.getRecording(alex, 'meeting-1', recordingId)).recording.state, 'queued')
    first.durable.close()

    const second = openPlatform(directory)
    try {
      assert.deepEqual((await second.platform.recoverInterruptedProcessing('northstar', 'corr-recovery')), { recovered: 1 })
      const failed = (await second.platform.getRecording(alex, 'meeting-1', recordingId)).recording
      assert.deepEqual([failed.state, failed.error, failed.retryAvailable], ['failed', 'PROCESSOR_FAILED', true])
      assert.deepEqual((await second.platform.recoverInterruptedProcessing('northstar')), { recovered: 0 }, 'recovery is idempotent')
      const recoveryAudit = second.durable.storage.scope({ tenantId: 'northstar' }).audit.chain().find((event) => event.correlationId === 'corr-recovery')
      assert.equal(recoveryAudit.principalId, 'service:recovery')

      await second.platform.retryProcessing(alex, 'meeting-1', recordingId)
      await settle()
      assert.equal((await second.platform.getRecording(alex, 'meeting-1', recordingId)).recording.state, 'completed')
    } finally { second.durable.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('deleted meeting content is not left readable in the SQLite database or its write-ahead log', async () => {
  const directory = tempDirectory()
  try {
    const { platform, durable } = openPlatform(directory)
    await seedMeeting(platform)
    const recordingId = (await uploadAudio(platform))
    await platform.startProcessing(alex, 'meeting-1', recordingId)
    await settle()
    assert.equal((await platform.getRecording(alex, 'meeting-1', recordingId)).recording.state, 'completed')
    await platform.deleteMeetingContent(alex, 'meeting-1')

    const canaries = ['security findings by October 20', 'Rollout stays phased', 'Send the security findings']
    const assertErased = (when) => {
      for (const name of readdirSync(directory).filter((file) => file.startsWith('meeting-ledger.sqlite'))) {
        const raw = readFileSync(join(directory, name)).toString('latin1')
        for (const canary of canaries) assert.equal(raw.includes(canary), false, `${when}: ${name} still contains deleted text "${canary}"`)
      }
    }
    assertErased('while the server is still running')
    durable.close()
    assertErased('after shutdown')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a database from an unsupported data model version is refused', () => {
  const directory = tempDirectory()
  try {
    openLocalDurableStorage({ directory }).close()
    const raw = new DatabaseSync(join(directory, 'meeting-ledger.sqlite'))
    raw.prepare("UPDATE schema_meta SET value = 'meeting-ledger-v0' WHERE key = 'data_model_version'").run()
    raw.close()
    assert.throws(() => openLocalDurableStorage({ directory }), { code: 'UNSUPPORTED_STORAGE_MODEL' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
