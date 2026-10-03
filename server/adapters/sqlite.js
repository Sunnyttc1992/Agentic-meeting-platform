import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sealAuditEvent } from '../audit.js'
import { invariant } from '../errors.js'
import { canonicalOutboxEvent, composeRepositoryStorage, createSerializedTransactionRunner, MEETING_LEDGER_DATA_MODEL_VERSION, tenantScope } from '../storage.js'
import { commitmentMatchesQuery, deriveCommitmentRows } from './in-memory.js'

// Local durable storage: one SQLite file on this machine (node:sqlite, no
// extra dependency). It implements the same repository signatures as the
// in-memory adapters, so the shared tenant facade in storage.js applies its
// tenant binding and record checks unchanged. Writes run in real SQLite
// transactions, run one at a time (nested calls use savepoints), so a failed write rolls back
// canonical rows, derived commitments, and outbox rows together.
//
// Recording audio is encrypted with AES-256-GCM. The key is a generated
// 32-byte file kept outside the database; each ciphertext is bound to its
// tenant and recording ID, so a blob cannot be moved onto another recording.
// Transcripts and summaries are stored unencrypted in the database file, so
// the machine itself must be protected (for example, with full-disk encryption).
const AUDIO_KEY_VERSION = 1
const AUDIO_KEY_FILE = `recording-audio-v${AUDIO_KEY_VERSION}.key`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meetings (tenant_id TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (tenant_id, id));
CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, meeting_id TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS recordings_by_meeting ON recordings (tenant_id, meeting_id);
CREATE TABLE IF NOT EXISTS recording_content (recording_id TEXT PRIMARY KEY REFERENCES recordings (id), key_version INTEGER NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS segments (seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, meeting_id TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS segments_by_meeting ON segments (tenant_id, meeting_id);
CREATE TABLE IF NOT EXISTS assertions (seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, meeting_id TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS assertions_by_meeting ON assertions (tenant_id, meeting_id);
CREATE TABLE IF NOT EXISTS commitments (tenant_id TEXT NOT NULL, meeting_id TEXT NOT NULL, assertion_id TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (tenant_id, meeting_id, assertion_id));
CREATE TABLE IF NOT EXISTS audit_events (tenant_id TEXT NOT NULL, sequence INTEGER NOT NULL, meeting_id TEXT, doc TEXT NOT NULL, PRIMARY KEY (tenant_id, sequence));
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TABLE IF NOT EXISTS outbox (tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (tenant_id, idempotency_key));
`

const parse = (row) => (row ? JSON.parse(row.doc) : null)
const parseAll = (rows) => rows.map((row) => JSON.parse(row.doc))
const restrictToOwner = (path) => { try { chmodSync(path, 0o600) } catch { /* best effort; Windows uses ACLs */ } }

function loadOrCreateAudioKey(keyDirectory) {
  const keyFile = join(keyDirectory, AUDIO_KEY_FILE)
  if (!existsSync(keyFile)) {
    mkdirSync(keyDirectory, { recursive: true })
    try {
      writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  restrictToOwner(keyFile)
  const key = readFileSync(keyFile)
  invariant(key.length === 32, 'INVALID_STORAGE_KEY', 'The recording audio key file is not a 256-bit key', 500)
  return key
}

export function openLocalDurableStorage({ directory, databaseFile = 'meeting-ledger.sqlite' } = {}) {
  invariant(typeof directory === 'string' && directory.length > 0, 'INVALID_STORAGE_ADAPTER', 'A data directory is required')
  mkdirSync(directory, { recursive: true })
  const databasePath = join(directory, databaseFile)
  const db = new DatabaseSync(databasePath)
  let audioKey
  try {
    restrictToOwner(databasePath)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    db.exec(SCHEMA)
    const version = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('data_model_version')?.value
    if (!version) db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('data_model_version', MEETING_LEDGER_DATA_MODEL_VERSION)
    invariant(!version || version === MEETING_LEDGER_DATA_MODEL_VERSION, 'UNSUPPORTED_STORAGE_MODEL', 'The local database was written by an unsupported data model version', 500)
    audioKey = loadOrCreateAudioKey(join(directory, 'keys'))
  } catch (error) {
    // Never leave a refused database open (on Windows that also locks the file).
    db.close()
    throw error
  }
  const audioAad = (tenantId, recordingId) => Buffer.from(`${MEETING_LEDGER_DATA_MODEL_VERSION}:${tenantId}:${recordingId}`)

  const sql = (text) => db.prepare(text)
  const meetings = {
    save(record) {
      sql('INSERT INTO meetings (tenant_id, id, doc) VALUES (?, ?, ?) ON CONFLICT (tenant_id, id) DO UPDATE SET doc = excluded.doc')
        .run(record.tenantId, record.id, JSON.stringify(record))
      return structuredClone(record)
    },
    get: (tenantId, meetingId) => parse(sql('SELECT doc FROM meetings WHERE tenant_id = ? AND id = ?').get(tenantId, meetingId)),
    list: (tenantId) => parseAll(sql('SELECT doc FROM meetings WHERE tenant_id = ? ORDER BY rowid').all(tenantId)),
  }

  const insertKnowledge = (table) => (records) => {
    const insert = sql(`INSERT INTO ${table} (tenant_id, meeting_id, doc) VALUES (?, ?, ?)`)
    for (const record of records) insert.run(record.tenantId, record.meetingId, JSON.stringify(record))
  }
  const knowledgeFor = (table, tenantId, meetingId) => parseAll(sql(`SELECT doc FROM ${table} WHERE tenant_id = ? AND meeting_id = ? ORDER BY seq`).all(tenantId, meetingId))
  const knowledge = {
    addSegments: insertKnowledge('segments'),
    addAssertions: insertKnowledge('assertions'),
    forMeeting: (tenantId, meetingId) => ({ segments: knowledgeFor('segments', tenantId, meetingId), assertions: knowledgeFor('assertions', tenantId, meetingId) }),
    meetingIdsMatching(tenantId, query) {
      const term = query.toLocaleLowerCase()
      const matches = (table) => parseAll(sql(`SELECT doc FROM ${table} WHERE tenant_id = ? ORDER BY seq`).all(tenantId))
        .filter((item) => item.text.toLocaleLowerCase().includes(term)).map((item) => item.meetingId)
      return [...new Set([...matches('segments'), ...matches('assertions')])]
    },
    clearMeeting(tenantId, meetingId) {
      sql('DELETE FROM segments WHERE tenant_id = ? AND meeting_id = ?').run(tenantId, meetingId)
      sql('DELETE FROM assertions WHERE tenant_id = ? AND meeting_id = ?').run(tenantId, meetingId)
    },
  }

  const recordings = {
    save(record) {
      sql('INSERT INTO recordings (id, tenant_id, meeting_id, doc) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc')
        .run(record.id, record.tenantId, record.meetingId, JSON.stringify(record))
      return structuredClone(record)
    },
    get: (id) => parse(sql('SELECT doc FROM recordings WHERE id = ?').get(id)),
    listForMeeting: (tenantId, meetingId) => parseAll(sql('SELECT doc FROM recordings WHERE tenant_id = ? AND meeting_id = ? ORDER BY rowid').all(tenantId, meetingId)),
    putBytes(id, bytes) {
      const row = sql('SELECT tenant_id FROM recordings WHERE id = ?').get(id)
      if (!row) return false
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', audioKey, nonce)
      cipher.setAAD(audioAad(row.tenant_id, id))
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()])
      sql('INSERT INTO recording_content (recording_id, key_version, nonce, tag, ciphertext) VALUES (?, ?, ?, ?, ?) ON CONFLICT (recording_id) DO UPDATE SET key_version = excluded.key_version, nonce = excluded.nonce, tag = excluded.tag, ciphertext = excluded.ciphertext')
        .run(id, AUDIO_KEY_VERSION, nonce, cipher.getAuthTag(), ciphertext)
      return true
    },
    getBytes(id) {
      const row = sql('SELECT r.tenant_id, c.key_version, c.nonce, c.tag, c.ciphertext FROM recording_content c JOIN recordings r ON r.id = c.recording_id WHERE c.recording_id = ?').get(id)
      if (!row) return null
      invariant(row.key_version === AUDIO_KEY_VERSION, 'RECORDING_CONTENT_UNAVAILABLE', 'Recording audio was encrypted with an unavailable key', 409)
      try {
        const decipher = createDecipheriv('aes-256-gcm', audioKey, Buffer.from(row.nonce))
        decipher.setAAD(audioAad(row.tenant_id, id))
        decipher.setAuthTag(Buffer.from(row.tag))
        return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()])
      } catch {
        // A wrong key or any altered byte fails authentication: never return
        // partially decrypted or tampered audio.
        invariant(false, 'RECORDING_CONTENT_UNAVAILABLE', 'Recording audio failed its integrity check', 409)
      }
    },
    clearContent(id) {
      sql('DELETE FROM recording_content WHERE recording_id = ?').run(id)
      const record = recordings.get(id)
      if (record) recordings.save({ ...record, contentClearedAt: new Date().toISOString() })
    },
  }

  const audit = {
    append(event) {
      const head = parse(sql('SELECT doc FROM audit_events WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1').get(event?.tenantId ?? ''))
      const stored = sealAuditEvent(event, head)
      sql('INSERT INTO audit_events (tenant_id, sequence, meeting_id, doc) VALUES (?, ?, ?, ?)')
        .run(stored.tenantId, stored.sequence, stored.meetingId ?? null, JSON.stringify(stored))
      return structuredClone(stored)
    },
    chain: (tenantId) => parseAll(sql('SELECT doc FROM audit_events WHERE tenant_id = ? ORDER BY sequence').all(tenantId)),
    forMeeting: (tenantId, meetingId) => parseAll(sql('SELECT doc FROM audit_events WHERE tenant_id = ? AND meeting_id = ? ORDER BY sequence').all(tenantId, meetingId)),
  }

  const commitments = {
    replaceMeeting(tenantId, meetingId, knowledgeForMeeting) {
      commitments.clearMeeting(tenantId, meetingId)
      const insert = sql('INSERT INTO commitments (tenant_id, meeting_id, assertion_id, doc) VALUES (?, ?, ?, ?)')
      for (const row of deriveCommitmentRows(tenantId, meetingId, knowledgeForMeeting)) insert.run(tenantId, meetingId, row.assertionId, JSON.stringify(row))
    },
    clearMeeting: (tenantId, meetingId) => { sql('DELETE FROM commitments WHERE tenant_id = ? AND meeting_id = ?').run(tenantId, meetingId) },
    query: (tenantId, query = '') => parseAll(sql('SELECT doc FROM commitments WHERE tenant_id = ? ORDER BY rowid').all(tenantId)).filter((row) => commitmentMatchesQuery(row, query)),
  }

  const outbox = {
    enqueue(scope, event) {
      const stored = canonicalOutboxEvent(scope, event)
      sql('INSERT INTO outbox (tenant_id, idempotency_key, doc) VALUES (?, ?, ?) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING')
        .run(stored.tenantId, stored.idempotencyKey, JSON.stringify(stored))
      return parse(sql('SELECT doc FROM outbox WHERE tenant_id = ? AND idempotency_key = ?').get(stored.tenantId, stored.idempotencyKey))
    },
    list: (scope) => parseAll(sql('SELECT doc FROM outbox WHERE tenant_id = ? ORDER BY rowid').all(tenantScope(scope).tenantId)),
  }

  const runAtomically = createSerializedTransactionRunner({
    begin: () => db.exec('BEGIN IMMEDIATE'),
    commit: () => {
      try {
        db.exec('COMMIT')
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw error
      }
    },
    rollback: () => { if (db.isTransaction) db.exec('ROLLBACK') },
    beginNested: (depth) => {
      const savepoint = `meeting_ledger_${depth}`
      db.exec(`SAVEPOINT ${savepoint}`)
      return savepoint
    },
    commitNested: (savepoint) => db.exec(`RELEASE ${savepoint}`),
    rollbackNested: (savepoint) => db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`),
  })

  const storage = composeRepositoryStorage({
    kind: 'local-sqlite',
    repositories: { meetings, knowledge, recordings, audit, commitments, outbox },
    runAtomically,
  })
  return Object.freeze({ storage, close: () => db.close() })
}
