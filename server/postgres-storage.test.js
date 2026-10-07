import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { FixedClock } from './adapters/in-memory.js'
import { openPostgresStorage } from './adapters/postgres.js'
import { assertPostgresSchemaCurrent, migratePostgres, POSTGRES_MIGRATIONS } from './adapters/postgres-schema.js'
import { verifyAuditChain } from './audit.js'
import { ClaudeMeetingIntelligence } from './intelligence.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { LocalMeetingProcessor } from './speech.js'
import { assertMeetingStorageContract } from './storage.js'
import { encodeWavPcm16 } from '../src/audioTranscode.js'
import { SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'

// PGlite is real PostgreSQL compiled to WebAssembly. Migrations run as the
// owning administrator; the storage then runs as the non-owner `meeting_app`
// role, so row-level security is actually enforced in these tests.
const APP_ROLE = 'meeting_app'
const AUDIO_KEY = randomBytes(32)
// Per-recording keys live outside the database, in one folder per test run.
const KEY_DIR = mkdtempSync(join(tmpdir(), 'meeting-ledger-keys-'))
test.after(() => rmSync(KEY_DIR, { recursive: true, force: true }))
const alex = { tenantId: 'northstar', userId: 'alex' }
const sam = { tenantId: 'northstar', userId: 'sam' }
const REPLY = {
  summary: { text: 'Rollout stays phased pending security sign-off.', citations: ['S1'] },
  decisions: [{ text: 'Keep the phased rollout.', citations: ['S1'] }], risks: [], open_questions: [],
  action_plan: [{ action: 'Send the security findings.', owner_participant_id: 'sam', due_date: '2026-10-20', citations: ['S2'] }],
}
const AUDIO = Buffer.from(encodeWavPcm16(Float32Array.from({ length: 16000 }, (_, index) => Math.sin(index * 0.37) * 0.6)))

async function openDatabase(dataDir = undefined, { migrate = true } = {}) {
  const db = new PGlite(dataDir)
  const admin = { query: (text, params) => db.query(text, params), exec: (text) => db.exec(text) }
  await db.exec(`DO $$ BEGIN CREATE ROLE ${APP_ROLE} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
  if (migrate) await migratePostgres(admin, { appRole: APP_ROLE })
  await db.exec(`SET ROLE ${APP_ROLE}`)
  // PGlite is a single connection: hand it out one transaction at a time.
  let tail = Promise.resolve()
  const connect = async () => {
    const previous = tail
    let release
    tail = new Promise((resolve) => { release = resolve })
    await previous
    return { query: (text, params) => db.query(text, params), release }
  }
  const asAdmin = async (work) => { await db.exec('RESET ROLE'); try { return await work(admin) } finally { await db.exec(`SET ROLE ${APP_ROLE}`) } }
  return { db, connect, asAdmin, app: admin, close: () => db.close() }
}

const chatAnswerer = { providerName: 'Test provider', answer: async ({ excerpts }) => ({ answer: 'Keep the phased rollout.', answered: true, citations: [excerpts[0].label], model: 'test-model' }) }

function platformOn(storage, { schedule = (job) => job() } = {}) {
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(REPLY) }] }) } } }
  return new MeetingIntelligencePlatform({
    storage, clock: new FixedClock('2026-10-03T12:00:00Z'), policy: new PolicyEngine(),
    speechProcessor: new LocalMeetingProcessor({
      transcriber: { transcribe: async () => [{ startMs: 0, endMs: 3000, text: 'Rollout stays phased.' }, { startMs: 3000, endMs: 6000, text: 'Sam sends the security findings by October 20.' }] },
      intelligence: new ClaudeMeetingIntelligence({ client }),
    }),
    acceptedMimeTypes: [SPEECH_WAV_MIME_TYPE], schedule, chatAnswerer,
  })
}

async function seedAndUpload(platform) {
  await platform.createMeeting(alex, { id: 'meeting-1', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard', consentPolicyVersion: 'v1' })
  for (const actor of [alex, sam]) await platform.recordConsent(actor, 'meeting-1', { participantId: actor.userId, capturedAt: '2026-10-03T11:59:00Z', expiresAt: '2026-10-03T15:00:00Z', policyVersion: 'v1', decision: 'granted', method: 'explicit' })
  const lease = await platform.authorizeRecording(alex, 'meeting-1')
  const created = await platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType: SPEECH_WAV_MIME_TYPE, byteLength: AUDIO.length, sha256: createHash('sha256').update(AUDIO).digest('hex') })
  await platform.uploadRecording(alex, 'meeting-1', created.recordingId, { contentType: SPEECH_WAV_MIME_TYPE, contentLength: AUDIO.length, bytes: AUDIO })
  return created.recordingId
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test('the PostgreSQL adapter satisfies the sealed storage contract', async () => {
  const database = await openDatabase()
  try {
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
    assert.equal(await assertMeetingStorageContract(storage), storage)
    assert.equal(storage.kind, 'postgresql')
  } finally { await database.close() }
})

test('a processed meeting is stored in PostgreSQL, survives a restart, and keeps a valid audit chain', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'meeting-ledger-pg-'))
  try {
    const first = await openDatabase(dataDir)
    const platform = platformOn(openPostgresStorage({ connect: first.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR }).storage)
    const recordingId = await seedAndUpload(platform)
    await platform.startProcessing(alex, 'meeting-1', recordingId)
    await settle()
    const before = await platform.getRecording(alex, 'meeting-1', recordingId)
    assert.equal(before.recording.state, 'completed')
    await first.close()

    const second = await openDatabase(dataDir)
    try {
      const reopened = openPostgresStorage({ connect: second.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
      const restarted = platformOn(reopened.storage)
      const after = await restarted.getRecording(sam, 'meeting-1', recordingId)
      assert.deepEqual(after.segments, before.segments)
      assert.deepEqual(after.assertions, before.assertions)
      assert.deepEqual((await restarted.queryCommitments(sam, '')).commitments.map((item) => [item.ownerId, item.deadline]), [['sam', '2026-10-20T00:00:00.000Z']])
      assert.match((await restarted.exportMeetingRecord(sam, 'meeting-1')).body, /Send the security findings\. \| Proposed \| sam \| 2026-10-20/)
      const chain = await reopened.storage.scope({ tenantId: 'northstar' }).audit.chain()
      assert.ok(chain.length > 10)
      assert.equal(verifyAuditChain(chain, { tenantId: 'northstar' }).valid, true)
      assert.deepEqual(await restarted.getRecording(sam, 'meeting-1', recordingId).catch((error) => error.code), after, 'reads stay consistent')
    } finally { await second.close() }
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

test('a second recording keeps the first recording\'s transcript and actions in PostgreSQL', async () => {
  const database = await openDatabase()
  try {
    const platform = platformOn(openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR }).storage)
    const first = await seedAndUpload(platform)
    await platform.startProcessing(alex, 'meeting-1', first)
    await settle()
    const before = await platform.getRecording(alex, 'meeting-1', first)
    const lease = await platform.authorizeRecording(alex, 'meeting-1')
    const created = await platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType: SPEECH_WAV_MIME_TYPE, byteLength: AUDIO.length, sha256: createHash('sha256').update(AUDIO).digest('hex') })
    await platform.uploadRecording(alex, 'meeting-1', created.recordingId, { contentType: SPEECH_WAV_MIME_TYPE, contentLength: AUDIO.length, bytes: AUDIO })
    await platform.startProcessing(alex, 'meeting-1', created.recordingId)
    await settle()
    assert.equal((await platform.getRecording(alex, 'meeting-1', created.recordingId)).recording.state, 'completed')
    const after = await platform.getRecording(sam, 'meeting-1', first)
    assert.deepEqual(after.segments, before.segments)
    assert.deepEqual(after.assertions, before.assertions)
    assert.equal((await platform.queryCommitments(sam, '')).commitments.length, 2)
  } finally { await database.close() }
})

test('saved chat is stored per tenant and user in PostgreSQL and deleted with its meeting', async () => {
  const database = await openDatabase()
  try {
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
    const platform = platformOn(storage)
    await platform.startProcessing(alex, 'meeting-1', await seedAndUpload(platform))
    await settle()
    assert.equal((await platform.askChat(sam, { question: 'phased rollout?' })).turn.status, 'answered')
    assert.equal((await platformOn(storage).getChatHistory(sam)).turns.length, 1, 'history is durable')
    assert.deepEqual((await platform.getChatHistory(alex)).turns, [])
    assert.deepEqual(await storage.scope({ tenantId: 'southstar' }).chat.forUser('sam'), [], 'row-level security hides other tenants')
    await platform.deleteMeetingContent(alex, 'meeting-1')
    assert.deepEqual((await platform.getChatHistory(sam)).turns, [])
  } finally { await database.close() }
})

test('a database on the first schema still serves meetings, and chat asks for the migration until it runs', async () => {
  const database = await openDatabase(undefined, { migrate: false })
  try {
    await database.asAdmin(async (admin) => {
      await admin.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      await admin.exec(POSTGRES_MIGRATIONS[0].sql)
      await admin.query('INSERT INTO schema_migrations (version) VALUES ($1)', [POSTGRES_MIGRATIONS[0].version])
      await admin.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON meetings, recordings, recording_content, transcript_segments, knowledge_assertions, commitments, outbox_events TO ${APP_ROLE}; GRANT SELECT, INSERT ON audit_events TO ${APP_ROLE}; GRANT SELECT ON schema_migrations TO ${APP_ROLE}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};`)
    })
    await assertPostgresSchemaCurrent(database.app)
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
    const platform = platformOn(storage)
    await platform.startProcessing(alex, 'meeting-1', await seedAndUpload(platform))
    await settle()
    await assert.rejects(platform.askChat(sam, { question: 'phased rollout?' }), { code: 'CHAT_NOT_MIGRATED' })
    await assert.rejects(platform.getChatHistory(sam), { code: 'CHAT_NOT_MIGRATED' })
    await platform.deleteMeetingContent(alex, 'meeting-1')

    await database.asAdmin((admin) => migratePostgres(admin, { appRole: APP_ROLE }))
    assert.deepEqual((await platform.getChatHistory(sam)).turns, [], 'chat works once migrated')
  } finally { await database.close() }
})

test('row-level security isolates tenants inside the database itself', async () => {
  const database = await openDatabase()
  try {
    const platform = platformOn(openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR }).storage, { schedule: () => {} })
    await seedAndUpload(platform)
    const sql = (text, params) => database.app.query(text, params)

    assert.deepEqual((await sql('SELECT id FROM meetings')).rows, [], 'with no tenant context the app role sees nothing')
    await sql("SELECT set_config('app.tenant_id', 'southstar', false)")
    assert.deepEqual((await sql('SELECT id FROM meetings')).rows, [], 'another tenant sees nothing')
    assert.deepEqual((await sql('SELECT tenant_id FROM audit_events')).rows, [])
    await assert.rejects(sql("INSERT INTO meetings (tenant_id, id, doc) VALUES ('northstar', 'smuggled', '{}')"), /row-level security/, 'cannot write into another tenant')
    await sql("SELECT set_config('app.tenant_id', 'northstar', false)")
    assert.deepEqual((await sql('SELECT id FROM meetings')).rows, [{ id: 'meeting-1' }])
    await assert.rejects(sql("UPDATE meetings SET tenant_id = 'southstar'"), /row-level security/, 'cannot move a row to another tenant')
    await sql("SELECT set_config('app.tenant_id', '', false)")
  } finally { await database.close() }
})

test('the audit trail is append-only for the app role and even for the table owner', async () => {
  const database = await openDatabase()
  try {
    const platform = platformOn(openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR }).storage, { schedule: () => {} })
    await seedAndUpload(platform)
    await database.app.query("SELECT set_config('app.tenant_id', 'northstar', false)")
    await assert.rejects(database.app.query("UPDATE audit_events SET doc = '{}'::jsonb"), /permission denied/)
    await assert.rejects(database.app.query('DELETE FROM audit_events'), /permission denied/)
    await database.asAdmin(async (admin) => {
      await assert.rejects(admin.query("UPDATE audit_events SET doc = '{}'::jsonb"), /append-only/)
      await assert.rejects(admin.query('DELETE FROM audit_events'), /append-only/)
      await assert.rejects(admin.query('TRUNCATE audit_events'), /append-only/)
    })
  } finally { await database.close() }
})

test('recording audio is encrypted in the database and fails closed when tampered', async () => {
  const database = await openDatabase()
  try {
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
    const platform = platformOn(storage, { schedule: () => {} })
    const recordingId = await seedAndUpload(platform)
    const read = () => storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes(recordingId))
    assert.deepEqual(Buffer.from(await read()), AUDIO)

    await database.asAdmin(async (admin) => {
      const row = (await admin.query('SELECT ciphertext FROM recording_content WHERE recording_id = $1', [recordingId])).rows[0]
      assert.equal(Buffer.from(row.ciphertext).indexOf(AUDIO.subarray(2000, 2064)), -1, 'no plaintext audio in the database')
      const flipped = Buffer.from(row.ciphertext); flipped[100] ^= 0xff
      await admin.query("SELECT set_config('app.tenant_id', 'northstar', false)")
      await admin.query('UPDATE recording_content SET ciphertext = $1 WHERE recording_id = $2', [flipped, recordingId])
      await admin.query("SELECT set_config('app.tenant_id', '', false)")
    })
    await assert.rejects(read(), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    const wrongKey = openPostgresStorage({ connect: database.connect, audioKey: randomBytes(32), recordingKeyDirectory: KEY_DIR })
    await assert.rejects(wrongKey.storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes(recordingId)), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
  } finally { await database.close() }
})

test('deleting a recording destroys its key, so dead tuples or a restored backup row stay unreadable', async () => {
  const database = await openDatabase()
  const keyDirectory = mkdtempSync(join(tmpdir(), 'meeting-ledger-keys-'))
  try {
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: keyDirectory })
    const platform = platformOn(storage, { schedule: () => {} })
    const recordingId = await seedAndUpload(platform)
    const asTenant = (work) => database.asAdmin(async (admin) => {
      await admin.query("SELECT set_config('app.tenant_id', 'northstar', false)")
      try { return await work(admin) } finally { await admin.query("SELECT set_config('app.tenant_id', '', false)") }
    })
    const backup = await asTenant(async (admin) => (await admin.query('SELECT * FROM recording_content WHERE recording_id = $1', [recordingId])).rows[0])
    assert.equal(backup.key_version, 2, 'new audio uses a per-recording key')
    assert.equal(readdirSync(keyDirectory).length, 1)

    await platform.deleteMeetingContent(alex, 'meeting-1')
    assert.equal(readdirSync(keyDirectory).length, 0, 'the recording key is gone')
    await asTenant((admin) => admin.query('INSERT INTO recording_content (tenant_id, recording_id, key_version, nonce, tag, ciphertext) VALUES ($1, $2, $3, $4, $5, $6)',
      [backup.tenant_id, recordingId, backup.key_version, backup.nonce, backup.tag, backup.ciphertext]))
    await assert.rejects(storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes(recordingId)), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
  } finally { await database.close(); rmSync(keyDirectory, { recursive: true, force: true }) }
})

test('a recording-key outage fails closed before PostgreSQL audio reads or writes', async () => {
  const database = await openDatabase()
  let keyAvailable = true
  const audioKeyProvider = () => {
    if (!keyAvailable) throw new Error('key source unavailable')
    return AUDIO_KEY
  }
  try {
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR, audioKeyProvider })
    await storage.transaction({ tenantId: 'northstar' }, async (tx) => {
      await tx.meetings.save({ id: 'key-outage', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex'] })
      await tx.recordings.save({ id: 'key-outage-recording', tenantId: 'northstar', meetingId: 'key-outage', organizerId: 'alex' })
      await tx.recordings.putBytes('key-outage-recording', AUDIO)
    })
    assert.deepEqual(Buffer.from(await storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes('key-outage-recording'))), AUDIO)

    keyAvailable = false
    await assert.rejects(storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes('key-outage-recording')), { code: 'RECORDING_CONTENT_UNAVAILABLE' })
    await storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.save({ id: 'key-outage-write', tenantId: 'northstar', meetingId: 'key-outage', organizerId: 'alex' }))
    await assert.rejects(storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.putBytes('key-outage-write', AUDIO)), { code: 'RECORDING_CONTENT_UNAVAILABLE' })

    keyAvailable = true
    assert.equal(await storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes('key-outage-write')), null, 'the outage did not write plaintext or ciphertext')
  } finally { await database.close() }
})

test('transactions roll back on failure, nest through savepoints, and cannot switch tenants', async () => {
  const database = await openDatabase()
  try {
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
    const meeting = (id) => ({ id, tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex'] })
    const failure = new Error('fail after writing')
    await assert.rejects(storage.transaction({ tenantId: 'northstar' }, async (tx) => { await tx.meetings.save(meeting('rolled-back')); throw failure }), (error) => error === failure)
    assert.equal(await storage.scope({ tenantId: 'northstar' }).meetings.get('rolled-back'), null)

    await storage.transaction({ tenantId: 'northstar' }, async (outer) => {
      await outer.meetings.save(meeting('outer'))
      await assert.rejects(storage.transaction({ tenantId: 'northstar' }, async (inner) => { await inner.meetings.save(meeting('inner')); throw failure }))
      await assert.rejects(storage.transaction({ tenantId: 'southstar' }, () => null), { code: 'TENANT_SCOPE_VIOLATION' })
    })
    const scope = storage.scope({ tenantId: 'northstar' })
    assert.deepEqual([(await scope.meetings.get('outer'))?.id, await scope.meetings.get('inner')], ['outer', null], 'only the failed nested part rolled back')
    assert.equal(await storage.scope({ tenantId: 'southstar' }).meetings.get('outer'), null)
  } finally { await database.close() }
})

test('concurrent audit appends in one tenant get distinct, contiguous sequence numbers', async () => {
  const database = await openDatabase()
  try {
    const { storage } = openPostgresStorage({ connect: database.connect, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
    await Promise.all(Array.from({ length: 12 }, (_, index) => storage.transaction({ tenantId: 'northstar' }, (tx) => tx.audit.append({
      id: `event-${index}`, tenantId: 'northstar', action: 'knowledge.read', outcome: 'allowed', reason: null, meetingId: 'meeting-1',
    }))))
    const chain = await storage.scope({ tenantId: 'northstar' }).audit.chain()
    assert.deepEqual(chain.map((event) => event.sequence), Array.from({ length: 12 }, (_, index) => index + 1))
    assert.equal(verifyAuditChain(chain, { tenantId: 'northstar' }).valid, true)
  } finally { await database.close() }
})

test('migrations are idempotent, and the server refuses an unmigrated or newer database', async () => {
  const fresh = await openDatabase(undefined, { migrate: false })
  try {
    await assert.rejects(assertPostgresSchemaCurrent(fresh.app), { code: 'UNSUPPORTED_STORAGE_MODEL' }, 'unmigrated database is refused')
    await fresh.asAdmin(async (admin) => {
      assert.deepEqual((await migratePostgres(admin, { appRole: APP_ROLE })).applied, POSTGRES_MIGRATIONS.map((migration) => migration.version))
      assert.deepEqual((await migratePostgres(admin, { appRole: APP_ROLE })).applied, [], 'a second run applies nothing')
      await admin.query("INSERT INTO schema_migrations (version) VALUES ('999_from_a_newer_server')")
      await assert.rejects(migratePostgres(admin), { code: 'UNSUPPORTED_STORAGE_MODEL' })
    })
    await assert.rejects(assertPostgresSchemaCurrent(fresh.app), { code: 'UNSUPPORTED_STORAGE_MODEL' }, 'newer database is refused')
  } finally { await fresh.close() }
})

test('the node-postgres driver path works end to end over the PostgreSQL wire protocol', async () => {
  const { default: pg } = await import('pg')
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket')
  const { connectPostgresStorage } = await import('./adapters/postgres.js')
  const database = await openDatabase()
  const server = new PGLiteSocketServer({ db: database.db, port: 0, host: '127.0.0.1' })
  await server.start()
  const [host, port] = server.getServerConn().split(':')
  // The socket server shares one PGlite session, so use one pooled connection.
  const pool = new pg.Pool({ host, port: Number(port), user: 'postgres', database: 'postgres', max: 1 })
  try {
    const { storage, close } = await connectPostgresStorage({ pool, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR })
    const platform = platformOn(storage)
    const recordingId = await seedAndUpload(platform)
    await platform.startProcessing(alex, 'meeting-1', recordingId)
    await settle()
    const status = await platform.getRecording(sam, 'meeting-1', recordingId)
    assert.equal(status.recording.state, 'completed')
    assert.equal(status.assertions.find((item) => item.kind === 'action').commitment.ownerId, 'sam')
    assert.deepEqual(Buffer.from(await storage.transaction({ tenantId: 'northstar' }, (tx) => tx.recordings.getBytes(recordingId))), AUDIO, 'bytea round-trips through the driver')
    const client = await pool.connect()
    try {
      assert.equal((await client.query('SELECT count(*)::int AS n FROM meetings')).rows[0].n, 0, 'no tenant context leaks between pooled transactions')
    } finally { client.release() }
    await close()
  } finally {
    await server.stop()
    await database.close()
  }
})

test('the server refuses to connect as a superuser or as the tables owner, where row-level security would not apply', async () => {
  const { default: pg } = await import('pg')
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket')
  const { connectPostgresStorage } = await import('./adapters/postgres.js')
  for (const role of ['postgres', 'meeting_owner']) {
    const database = await openDatabase()
    await database.db.exec('RESET ROLE')
    if (role === 'meeting_owner') {
      await database.db.exec('CREATE ROLE meeting_owner NOLOGIN; ALTER TABLE meetings OWNER TO meeting_owner; GRANT SELECT ON schema_migrations TO meeting_owner; SET ROLE meeting_owner')
    }
    const server = new PGLiteSocketServer({ db: database.db, port: 0, host: '127.0.0.1' })
    await server.start()
    const [host, port] = server.getServerConn().split(':')
    const pool = new pg.Pool({ host, port: Number(port), user: 'postgres', database: 'postgres', max: 1 })
    try {
      await assert.rejects(connectPostgresStorage({ pool, audioKey: AUDIO_KEY, recordingKeyDirectory: KEY_DIR }), { code: 'INSECURE_DATABASE_ROLE' }, role)
    } finally {
      await server.stop()
      await database.close()
    }
  }
})
