import { AsyncLocalStorage } from 'node:async_hooks'
import { sealAuditEvent } from '../audit.js'
import { DomainError, invariant } from '../errors.js'
import { canonicalOutboxEvent, composeRepositoryStorage, tenantScope } from '../storage.js'
import { openRecordingAudio, sealRecordingAudio } from './audio-encryption.js'
import { openRecordingKeyStore } from './recording-keys.js'
import { commitmentMatchesQuery, deriveCommitmentRows } from './in-memory.js'
import { assertLeastPrivilegeRole, assertPostgresSchemaCurrent } from './postgres-schema.js'

// PostgreSQL storage for the self-hosted deployment. It implements the same
// repository signatures as the in-memory and SQLite adapters, so the shared
// tenant facade in storage.js applies its tenant binding and record checks
// unchanged, and commitments and outbox rows come from the same functions.
//
// Tenant isolation is enforced twice:
// - every query filters on tenant_id explicitly, and
// - every transaction sets `app.tenant_id`, which the row-level security
//   policies in postgres-schema.js check for the (non-owner) application role.
// A transaction holds one pooled connection; nested calls in the same async
// context reuse it through savepoints. Separate requests use separate
// connections, so they run concurrently with database isolation instead of a
// process-wide lock.
//
// `connect()` must return a client with `query(text, params) -> { rows }` and
// `release()`. See connectPool (node-postgres) and the PGlite helper in tests.
export function openPostgresStorage({ connect, audioKey, audioKeyProvider = null, recordingKeyDirectory, close = async () => {} }) {
  invariant(typeof connect === 'function', 'INVALID_STORAGE_ADAPTER', 'A PostgreSQL connection factory is required')
  invariant(Buffer.isBuffer(audioKey) && audioKey.length === 32, 'INVALID_STORAGE_KEY', 'A 256-bit recording audio key is required', 500)
  invariant(audioKeyProvider === null || typeof audioKeyProvider === 'function', 'INVALID_STORAGE_KEY', 'The recording audio key provider must be a function', 500)
  const active = new AsyncLocalStorage()
  const currentAudioKey = async () => {
    try {
      const key = await (audioKeyProvider ? audioKeyProvider() : audioKey)
      invariant(Buffer.isBuffer(key) && key.length === 32, 'RECORDING_CONTENT_UNAVAILABLE', 'Recording audio key is unavailable', 503)
      return key
    } catch (error) {
      if (error instanceof DomainError && error.code === 'RECORDING_CONTENT_UNAVAILABLE') throw error
      // A provider is allowed to expose only a generic availability boundary.
      // Paths, provider errors, and key material never leave this adapter.
      throw new DomainError('RECORDING_CONTENT_UNAVAILABLE', 'Recording audio key is unavailable', 503)
    }
  }
  // Per-recording keys live outside the database, so a dump or dead tuple never
  // carries a key with its ciphertext. They are wrapped by the pinned master key.
  const recordingKeys = openRecordingKeyStore({ directory: recordingKeyDirectory, masterKey: currentAudioKey })

  async function transaction(tenantId, work) {
    const normalized = tenantScope({ tenantId }).tenantId
    const current = active.getStore()
    if (current) {
      invariant(current.tenantId === normalized, 'TENANT_SCOPE_VIOLATION', 'A transaction cannot change tenants', 403)
      const savepoint = `meeting_ledger_${current.depth + 1}`
      await current.client.query(`SAVEPOINT ${savepoint}`)
      try {
        const result = await active.run({ ...current, depth: current.depth + 1 }, () => work(current.client))
        await current.client.query(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        await current.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        await current.client.query(`RELEASE SAVEPOINT ${savepoint}`)
        throw error
      }
    }
    const client = await connect()
    try {
      await client.query('BEGIN')
      // Transaction-local: the setting ends with this transaction, so a pooled
      // connection never carries one tenant's context into another request.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [normalized])
      const result = await active.run({ client, tenantId: normalized, depth: 0 }, () => work(client))
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* the original error matters */ }
      throw error
    } finally {
      client.release()
    }
  }

  // A repository call joins the caller's transaction when there is one, and
  // otherwise runs in its own short tenant-bound transaction.
  const inTenant = (tenantId, work) => {
    const current = active.getStore()
    if (current) {
      invariant(current.tenantId === tenantId, 'TENANT_SCOPE_VIOLATION', 'A transaction cannot change tenants', 403)
      return work(current.client)
    }
    return transaction(tenantId, work)
  }
  const docs = (result) => result.rows.map((row) => row.doc)
  const firstDoc = (result) => result.rows[0]?.doc ?? null
  const json = (value) => JSON.stringify(value)
  const requireTenant = (tenantId) => invariant(typeof tenantId === 'string' && tenantId.length > 0, 'TENANT_SCOPE_VIOLATION', 'PostgreSQL operations require a tenant', 403)

  const meetings = {
    save: (record) => inTenant(record.tenantId, async (client) => {
      await client.query('INSERT INTO meetings (tenant_id, id, doc) VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant_id, id) DO UPDATE SET doc = excluded.doc', [record.tenantId, record.id, json(record)])
      return structuredClone(record)
    }),
    get: (tenantId, meetingId) => inTenant(tenantId, async (client) => firstDoc(await client.query('SELECT doc FROM meetings WHERE tenant_id = $1 AND id = $2', [tenantId, meetingId]))),
    list: (tenantId) => inTenant(tenantId, async (client) => docs(await client.query('SELECT doc FROM meetings WHERE tenant_id = $1 ORDER BY row_seq', [tenantId]))),
  }

  const insertKnowledge = (table) => async (records) => {
    if (records.length === 0) return
    await inTenant(records[0].tenantId, async (client) => {
      for (const record of records) await client.query(`INSERT INTO ${table} (tenant_id, meeting_id, doc) VALUES ($1, $2, $3::jsonb)`, [record.tenantId, record.meetingId, json(record)])
    })
  }
  const knowledgeFor = async (client, table, tenantId, meetingId) => docs(await client.query(`SELECT doc FROM ${table} WHERE tenant_id = $1 AND meeting_id = $2 ORDER BY seq`, [tenantId, meetingId]))
  const knowledge = {
    addSegments: insertKnowledge('transcript_segments'),
    addAssertions: insertKnowledge('knowledge_assertions'),
    forMeeting: (tenantId, meetingId) => inTenant(tenantId, async (client) => ({
      segments: await knowledgeFor(client, 'transcript_segments', tenantId, meetingId),
      assertions: await knowledgeFor(client, 'knowledge_assertions', tenantId, meetingId),
    })),
    meetingIdsMatching: (tenantId, query) => inTenant(tenantId, async (client) => {
      const term = query.toLocaleLowerCase()
      const matches = async (table) => docs(await client.query(`SELECT doc FROM ${table} WHERE tenant_id = $1 ORDER BY seq`, [tenantId]))
        .filter((item) => item.text.toLocaleLowerCase().includes(term)).map((item) => item.meetingId)
      return [...new Set([...await matches('transcript_segments'), ...await matches('knowledge_assertions')])]
    }),
    clearMeeting: (tenantId, meetingId) => inTenant(tenantId, async (client) => {
      await client.query('DELETE FROM transcript_segments WHERE tenant_id = $1 AND meeting_id = $2', [tenantId, meetingId])
      await client.query('DELETE FROM knowledge_assertions WHERE tenant_id = $1 AND meeting_id = $2', [tenantId, meetingId])
    }),
  }

  const recordings = {
    save: (record) => inTenant(record.tenantId, async (client) => {
      await client.query('INSERT INTO recordings (tenant_id, id, meeting_id, doc) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (tenant_id, id) DO UPDATE SET doc = excluded.doc', [record.tenantId, record.id, record.meetingId, json(record)])
      return structuredClone(record)
    }),
    get: (id, tenantId) => {
      requireTenant(tenantId)
      return inTenant(tenantId, async (client) => firstDoc(await client.query('SELECT doc FROM recordings WHERE tenant_id = $1 AND id = $2', [tenantId, id])))
    },
    listForMeeting: (tenantId, meetingId) => inTenant(tenantId, async (client) => docs(await client.query('SELECT doc FROM recordings WHERE tenant_id = $1 AND meeting_id = $2 ORDER BY row_seq', [tenantId, meetingId]))),
    putBytes: (id, bytes, tenantId) => {
      requireTenant(tenantId)
      return inTenant(tenantId, async (client) => {
        const exists = (await client.query('SELECT 1 FROM recordings WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows.length > 0
        if (!exists) return false
        const sealed = await sealRecordingAudio(recordingKeys, tenantId, id, bytes)
        await client.query(`INSERT INTO recording_content (tenant_id, recording_id, key_version, nonce, tag, ciphertext) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tenant_id, recording_id) DO UPDATE SET key_version = excluded.key_version, nonce = excluded.nonce, tag = excluded.tag, ciphertext = excluded.ciphertext`,
        [tenantId, id, sealed.keyVersion, sealed.nonce, sealed.tag, sealed.ciphertext])
        return true
      })
    },
    getBytes: (id, tenantId) => {
      requireTenant(tenantId)
      return inTenant(tenantId, async (client) => {
        const row = (await client.query('SELECT key_version, nonce, tag, ciphertext FROM recording_content WHERE tenant_id = $1 AND recording_id = $2', [tenantId, id])).rows[0]
        if (!row) return null
        return openRecordingAudio({ masterKey: currentAudioKey, recordingKeys }, tenantId, id, { keyVersion: row.key_version, nonce: row.nonce, tag: row.tag, ciphertext: row.ciphertext })
      })
    },
    clearContent: (id, tenantId) => {
      requireTenant(tenantId)
      return inTenant(tenantId, async (client) => {
        await client.query('DELETE FROM recording_content WHERE tenant_id = $1 AND recording_id = $2', [tenantId, id])
        // The key goes now, not at commit: a rolled-back deletion then leaves
        // unreadable audio (fail closed), never a deleted recording's key.
        recordingKeys.destroy(tenantId, id)
        await client.query("UPDATE recordings SET doc = jsonb_set(doc, '{contentClearedAt}', to_jsonb($3::text)) WHERE tenant_id = $1 AND id = $2", [tenantId, id, new Date().toISOString()])
      })
    },
  }

  const audit = {
    append: (event) => inTenant(event?.tenantId, async (client) => {
      // Serialize appends per tenant until commit, so two concurrent requests
      // cannot read the same chain head and race for one sequence number.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meeting-ledger-audit:${event.tenantId}`])
      const head = firstDoc(await client.query('SELECT doc FROM audit_events WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1', [event.tenantId]))
      const stored = sealAuditEvent(event, head)
      await client.query('INSERT INTO audit_events (tenant_id, sequence, meeting_id, doc) VALUES ($1, $2, $3, $4::jsonb)', [stored.tenantId, stored.sequence, stored.meetingId ?? null, json(stored)])
      return structuredClone(stored)
    }),
    chain: (tenantId) => inTenant(tenantId, async (client) => docs(await client.query('SELECT doc FROM audit_events WHERE tenant_id = $1 ORDER BY sequence', [tenantId]))),
    forMeeting: (tenantId, meetingId) => inTenant(tenantId, async (client) => docs(await client.query('SELECT doc FROM audit_events WHERE tenant_id = $1 AND meeting_id = $2 ORDER BY sequence', [tenantId, meetingId]))),
  }

  const commitments = {
    replaceMeeting: (tenantId, meetingId, knowledgeForMeeting) => inTenant(tenantId, async (client) => {
      await client.query('DELETE FROM commitments WHERE tenant_id = $1 AND meeting_id = $2', [tenantId, meetingId])
      for (const row of deriveCommitmentRows(tenantId, meetingId, knowledgeForMeeting)) {
        await client.query('INSERT INTO commitments (tenant_id, meeting_id, assertion_id, doc) VALUES ($1, $2, $3, $4::jsonb)', [tenantId, meetingId, row.assertionId, json(row)])
      }
    }),
    clearMeeting: (tenantId, meetingId) => inTenant(tenantId, async (client) => { await client.query('DELETE FROM commitments WHERE tenant_id = $1 AND meeting_id = $2', [tenantId, meetingId]) }),
    query: (tenantId, query = '') => inTenant(tenantId, async (client) => docs(await client.query('SELECT doc FROM commitments WHERE tenant_id = $1 ORDER BY row_seq', [tenantId])).filter((row) => commitmentMatchesQuery(row, query))),
  }

  const outbox = {
    enqueue: (scope, event) => {
      const stored = canonicalOutboxEvent(scope, event)
      return inTenant(stored.tenantId, async (client) => {
        await client.query('INSERT INTO outbox_events (tenant_id, idempotency_key, doc) VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING', [stored.tenantId, stored.idempotencyKey, json(stored)])
        return firstDoc(await client.query('SELECT doc FROM outbox_events WHERE tenant_id = $1 AND idempotency_key = $2', [stored.tenantId, stored.idempotencyKey]))
      })
    },
    list: (scope) => {
      const { tenantId } = tenantScope(scope)
      return inTenant(tenantId, async (client) => docs(await client.query('SELECT doc FROM outbox_events WHERE tenant_id = $1 ORDER BY row_seq', [tenantId])))
    },
  }

  const storage = composeRepositoryStorage({
    kind: 'postgresql',
    repositories: { meetings, knowledge, recordings, audit, commitments, outbox },
    runAtomically: (work, scope) => transaction(scope.tenantId, () => work()),
  })
  return Object.freeze({ storage, close })
}

// Opens storage on a node-postgres pool. Refuses to start unless the schema is
// migrated to exactly this server's version and the connection uses a
// least-privilege role that row-level security actually applies to.
export async function connectPostgresStorage({ pool, audioKey, audioKeyProvider = null, recordingKeyDirectory }) {
  const client = await pool.connect()
  let refusal = null
  try {
    await assertPostgresSchemaCurrent(client)
    await assertLeastPrivilegeRole(client)
  } catch (error) {
    refusal = error
  } finally {
    // Release before ending the pool: pool.end() waits for checked-out clients.
    client.release()
  }
  if (refusal) {
    await pool.end()
    throw refusal
  }
  return openPostgresStorage({ connect: () => pool.connect(), audioKey, audioKeyProvider, recordingKeyDirectory, close: () => pool.end() })
}
