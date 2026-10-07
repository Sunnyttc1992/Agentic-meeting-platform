import { AsyncLocalStorage } from 'node:async_hooks'
import { invariant } from './errors.js'
import {
  InMemoryAppendOnlyAudit,
  InMemoryChatRepository,
  InMemoryCommitmentRegistry,
  InMemoryKnowledgeRepository,
  InMemoryMeetingRepository,
  InMemoryRecordingRepository,
} from './adapters/in-memory.js'

// This module is the persistence anti-corruption layer.  Domain services use
// canonical meeting records and tenant-scoped repositories; they never depend
// on a database client, an object-store SDK, or a queue implementation.
export const MEETING_LEDGER_DATA_MODEL_VERSION = 'meeting-ledger-v1'

export const CANONICAL_DATA_SETS = Object.freeze([
  'meetings',
  'recording-manifests',
  'transcript-segments',
  'knowledge-assertions',
  'commitment-read-model',
  'audit-events',
  'outbox-events',
])

// Storage bundles and tenant facades are object capabilities, not merely
// interfaces.  A structural look-alike can hide a global repository behind a
// getter or a callback and is therefore not a safe persistence boundary.  The
// two brands stay module-private: production composition roots use the two
// factories below, while domain code can only consume the resulting closed
// capabilities.
const STORAGE_BUNDLES = new WeakSet()
const TENANT_FACADES = new WeakSet()
const FACADE_REPOSITORIES = Object.freeze([
  'meetings', 'knowledge', 'recordings', 'audit', 'commitments', 'outbox', 'chat',
])

const READER_METHODS = Object.freeze({
  meetings: Object.freeze(['get', 'list']),
  knowledge: Object.freeze(['forMeeting', 'meetingIdsMatching']),
  recordings: Object.freeze(['get', 'listForMeeting']),
  audit: Object.freeze(['forMeeting', 'chain']),
  commitments: Object.freeze(['query']),
  outbox: Object.freeze(['list']),
  chat: Object.freeze(['forUser']),
})

const WRITER_METHODS = Object.freeze({
  meetings: Object.freeze(['save']),
  knowledge: Object.freeze(['addSegments', 'addAssertions', 'clearMeeting']),
  recordings: Object.freeze(['save', 'putBytes', 'getBytes', 'clearContent']),
  audit: Object.freeze(['append']),
  commitments: Object.freeze(['replaceMeeting', 'clearMeeting']),
  outbox: Object.freeze(['enqueue']),
  chat: Object.freeze(['appendTurn', 'clearForUser', 'clearMeeting']),
})

export function tenantScope(input) {
  invariant(input && typeof input.tenantId === 'string' && input.tenantId.trim().length > 0,
    'INVALID_TENANT_SCOPE', 'A non-empty tenant scope is required', 400)
  return Object.freeze({ tenantId: input.tenantId })
}

export function assertTenantRecord(scope, record, label = 'record') {
  const normalized = tenantScope(scope)
  invariant(record && record.tenantId === normalized.tenantId,
    'TENANT_SCOPE_VIOLATION', `${label} must remain inside the active tenant scope`, 403)
  return record
}

/**
 * Production adapters implement this structural contract.  `transaction`
 * must make the canonical write plus its outbox inserts atomic.  `objectStore`
 * must accept only an opaque key reference and encrypted metadata -- never
 * bytes embedded in a database event or an application-controlled secret.
 */
function assertCapabilityFunction(value, label) {
  invariant(typeof value === 'function', 'INVALID_STORAGE_ADAPTER', `${label} must be a function capability`)
  invariant(Object.getPrototypeOf(value) === Function.prototype,
    'INVALID_STORAGE_ADAPTER', `${label} has an unexpected function prototype`)
  invariant(!Object.hasOwn(value, 'prototype'), 'INVALID_STORAGE_ADAPTER', `${label} must not expose a constructable capability`)
  invariant(Object.getOwnPropertySymbols(value).length === 0, 'INVALID_STORAGE_ADAPTER', `${label} must not expose symbol capabilities`)
  const names = Object.getOwnPropertyNames(value)
  invariant(names.every((name) => name === 'length' || name === 'name'),
    'INVALID_STORAGE_ADAPTER', `${label} exposes callback properties`)
}

function assertTenantFacade(facade, tenantId, label, writable) {
  invariant(facade && typeof facade === 'object' && Object.getPrototypeOf(facade) === null,
    'INVALID_STORAGE_ADAPTER', `${label} must return a null-prototype tenant facade`)
  invariant(Object.isFrozen(facade), 'INVALID_STORAGE_ADAPTER', `${label} tenant facade must be frozen`)
  invariant(TENANT_FACADES.has(facade), 'INVALID_STORAGE_ADAPTER', `${label} must return a branded tenant facade`)
  invariant(facade.tenantId === tenantId, 'INVALID_STORAGE_ADAPTER', `${label} tenant facade has an invalid tenant binding`)
  invariant(!Object.hasOwn(facade, 'storage') && !Object.hasOwn(facade, 'scope') && !Object.hasOwn(facade, 'transaction'),
    'INVALID_STORAGE_ADAPTER', `${label} tenant facade exposes a storage escape`)
  invariant(Object.getOwnPropertySymbols(facade).length === 0,
    'INVALID_STORAGE_ADAPTER', `${label} tenant facade must not expose symbol capabilities`)
  for (const name of FACADE_REPOSITORIES) {
    const repository = facade[name]
    invariant(repository && typeof repository === 'object' && Object.getPrototypeOf(repository) === null && Object.isFrozen(repository),
      'INVALID_STORAGE_ADAPTER', `${label} tenant facade is missing a sealed ${name} capability`)
    invariant(Object.getOwnPropertySymbols(repository).length === 0,
      'INVALID_STORAGE_ADAPTER', `${label} ${name} capability must not expose symbol capabilities`)
    const expected = [...READER_METHODS[name], ...(writable ? WRITER_METHODS[name] : [])]
    invariant(Object.keys(repository).length === expected.length && expected.every((method) => Object.hasOwn(repository, method)),
      'INVALID_STORAGE_ADAPTER', `${label} ${name} capability has an invalid surface`)
    for (const method of expected) assertCapabilityFunction(repository[method], `${label}.${name}.${method}`)
  }
}

function frozenNullObject(entries) {
  const target = Object.create(null)
  for (const [key, value] of Object.entries(entries)) {
    Object.defineProperty(target, key, { value, enumerable: true, writable: false, configurable: false })
  }
  return Object.freeze(target)
}

/**
 * Creates the only tenant capability shape accepted by the platform. The
 * supplied methods may close over a database transaction or repositories,
 * but that state is never an object property, symbol, prototype, or callback
 * argument available to the domain transaction callback.
 */
export function createTenantStorageFacade(scope, capabilities, { writable = false } = {}) {
  const normalized = tenantScope(scope)
  invariant(capabilities && typeof capabilities === 'object', 'INVALID_STORAGE_ADAPTER', 'Tenant capabilities are required')
  const entries = { tenantId: normalized.tenantId }
  for (const repositoryName of FACADE_REPOSITORIES) {
    const source = capabilities[repositoryName]
    invariant(source && typeof source === 'object' && Object.getPrototypeOf(source) === Object.prototype,
      'INVALID_STORAGE_ADAPTER', `${repositoryName} capabilities must be plain objects`)
    invariant(Object.getOwnPropertySymbols(source).length === 0,
      'INVALID_STORAGE_ADAPTER', `${repositoryName} capabilities must not expose symbols`)
    const expected = [...READER_METHODS[repositoryName], ...(writable ? WRITER_METHODS[repositoryName] : [])]
    const names = Object.getOwnPropertyNames(source)
    invariant(names.length === expected.length && expected.every((name) => Object.hasOwn(source, name)),
      'INVALID_STORAGE_ADAPTER', `${repositoryName} capabilities have an invalid surface`)
    for (const method of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(source, method)
      invariant(descriptor && Object.hasOwn(descriptor, 'value'), 'INVALID_STORAGE_ADAPTER', `${repositoryName}.${method} must be a data capability`)
      assertCapabilityFunction(descriptor.value, `${repositoryName}.${method}`)
    }
    entries[repositoryName] = frozenNullObject(Object.fromEntries(expected.map((method) => [method, source[method]])))
  }
  const facade = frozenNullObject(entries)
  TENANT_FACADES.add(facade)
  assertTenantFacade(facade, normalized.tenantId, 'tenant capability', writable)
  return facade
}

/**
 * Registers a trusted storage composition root. The returned bundle exposes
 * only tenant-bound read and transaction entrypoints; it deliberately does
 * not expose raw repositories. Production adapters must create their
 * facades with `createTenantStorageFacade` and register them here.
 */
export function createMeetingStorageBundle({ kind = 'durable', dataModelVersion = MEETING_LEDGER_DATA_MODEL_VERSION, scope, transaction }) {
  invariant(typeof scope === 'function' && typeof transaction === 'function',
    'INVALID_STORAGE_ADAPTER', 'Storage bundle requires scope and transaction functions')
  invariant(dataModelVersion === MEETING_LEDGER_DATA_MODEL_VERSION,
    'UNSUPPORTED_STORAGE_MODEL', 'Storage adapter data model version is not supported')
  const bundle = frozenNullObject({
    kind,
    dataModelVersion,
    scope: (requestedScope) => {
      const normalized = tenantScope(requestedScope)
      const facade = scope(normalized)
      assertTenantFacade(facade, normalized.tenantId, 'scope', false)
      return facade
    },
    transaction: (requestedScope, operation) => {
      const normalized = tenantScope(requestedScope)
      invariant(typeof operation === 'function', 'INVALID_STORAGE_TRANSACTION', 'Transaction operation is required')
      return transaction(normalized, (facade) => {
        assertTenantFacade(facade, normalized.tenantId, 'transaction', true)
        return operation(facade)
      })
    },
  })
  STORAGE_BUNDLES.add(bundle)
  return bundle
}

export function assertMeetingStorageContract(storage) {
  invariant(storage && typeof storage === 'object' && Object.getPrototypeOf(storage) === null && Object.isFrozen(storage),
    'INVALID_STORAGE_ADAPTER', 'Storage adapter must be a sealed capability bundle')
  invariant(STORAGE_BUNDLES.has(storage), 'INVALID_STORAGE_ADAPTER', 'Storage adapter must be registered by a trusted composition root')
  invariant(storage.dataModelVersion === MEETING_LEDGER_DATA_MODEL_VERSION,
    'UNSUPPORTED_STORAGE_MODEL', 'Storage adapter data model version is not supported')
  invariant(Object.getOwnPropertySymbols(storage).length === 0,
    'INVALID_STORAGE_ADAPTER', 'Storage adapter must not expose symbol capabilities')
  invariant(Object.keys(storage).length === 4 && ['kind', 'dataModelVersion', 'scope', 'transaction'].every((name) => Object.hasOwn(storage, name)),
    'INVALID_STORAGE_ADAPTER', 'Storage adapter exposes an invalid public surface')
  assertCapabilityFunction(storage.scope, 'storage.scope')
  assertCapabilityFunction(storage.transaction, 'storage.transaction')
  // Branding alone establishes the trusted composition root; exercise every
  // registered bundle as well, so an otherwise-branded adapter cannot hand
  // the platform a forged, re-used, or incorrectly bound facade later.
  const nonce = Math.random().toString(36).slice(2)
  const firstTenant = `__storage-contract-a-${nonce}`
  const secondTenant = `__storage-contract-b-${nonce}`
  const firstScope = storage.scope({ tenantId: firstTenant })
  const secondScope = storage.scope({ tenantId: secondTenant })
  assertTenantFacade(firstScope, firstTenant, 'scope', false)
  assertTenantFacade(secondScope, secondTenant, 'scope', false)
  invariant(firstScope !== secondScope, 'INVALID_STORAGE_ADAPTER', 'Storage scope must mint an isolated tenant capability')
  const checkTransactionFacade = (transactionFacade) => {
    assertTenantFacade(transactionFacade, firstTenant, 'transaction', true)
    invariant(transactionFacade !== firstScope, 'INVALID_STORAGE_ADAPTER', 'Transaction must mint an isolated tenant capability')
    return storage
  }
  // Transactions may be asynchronous (a database round trip). The structural
  // checks above still fail synchronously; this last check then resolves with
  // the transaction, and callers await it before first use.
  const exercised = storage.transaction({ tenantId: firstTenant }, (transaction) => transaction)
  return exercised && typeof exercised.then === 'function' ? exercised.then(checkTransactionFacade) : checkTransactionFacade(exercised)
}

// Runs one storage transaction at a time. Work may be asynchronous; a nested
// call (made while a transaction is running, in the same async context) joins
// the outer transaction through `beginNested`/`commitNested`/`rollbackNested`
// instead of waiting on itself. Serializing means an awaited step in one
// request can never interleave its writes with another request's.
export function createSerializedTransactionRunner({ begin, commit, rollback, beginNested = begin, commitNested = commit, rollbackNested = rollback }) {
  const active = new AsyncLocalStorage()
  let tail = Promise.resolve()
  return async (work) => {
    const depth = active.getStore()
    if (depth !== undefined) {
      const token = await beginNested(depth + 1)
      let result
      try {
        result = await active.run(depth + 1, work)
      } catch (error) {
        await rollbackNested(token)
        throw error
      }
      await commitNested(token)
      return result
    }
    const previous = tail
    let release
    tail = new Promise((resolve) => { release = resolve })
    await previous
    try {
      const token = await begin()
      let result
      try {
        result = await active.run(0, work)
      } catch (error) {
        await rollback(token)
        throw error
      }
      await commit(token)
      return result
    } finally {
      release()
    }
  }
}

function assertTenantRecordList(scope, records, label) {
  invariant(Array.isArray(records), 'TENANT_SCOPE_VIOLATION', `${label} must be an array`, 403)
  for (const record of records) assertTenantRecord(scope, record, label)
  return records
}

// Validates and canonicalizes one outbox row. Shared by every backend so the
// tenant binding, required fields, and stored shape cannot drift.
export function canonicalOutboxEvent(scope, event) {
  const normalized = tenantScope(scope)
  assertTenantRecord(normalized, event, 'outbox event')
  invariant(typeof event.idempotencyKey === 'string' && event.idempotencyKey.trim().length > 0,
    'INVALID_OUTBOX_EVENT', 'Outbox events require an idempotency key')
  invariant(typeof event.type === 'string' && event.type.trim().length > 0,
    'INVALID_OUTBOX_EVENT', 'Outbox events require a type')
  return Object.freeze(structuredClone({
    id: event.id ?? `outbox:${event.idempotencyKey}`,
    tenantId: normalized.tenantId,
    type: event.type,
    idempotencyKey: event.idempotencyKey,
    aggregateType: event.aggregateType ?? 'meeting',
    aggregateId: event.aggregateId ?? null,
    payload: event.payload ?? {},
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  }))
}

// A deliberately small outbox representation. It is not a queue and does not
// deliver events; it lets the prototype exercise the exact idempotency and
// tenant-binding rules a transactional database outbox will enforce later.
export class InMemoryOutboxRepository {
  #events = new Map()

  enqueue(scope, event) {
    const normalized = tenantScope(scope)
    const stored = canonicalOutboxEvent(normalized, event)
    const key = `${normalized.tenantId}:${stored.idempotencyKey}`
    const existing = this.#events.get(key)
    if (existing) return structuredClone(existing)
    this.#events.set(key, stored)
    return structuredClone(stored)
  }

  list(scope) {
    const normalized = tenantScope(scope)
    return [...this.#events.values()]
      .filter((event) => event.tenantId === normalized.tenantId)
      .map((event) => structuredClone(event))
  }
  snapshot() { return structuredClone(this.#events) }
  restore(snapshot) { this.#events = structuredClone(snapshot) }
}

// The one tenant facade shape, shared by every storage backend. Repositories
// use the in-memory adapter signatures; this layer adds the tenant binding and
// record checks, so a durable backend inherits them rather than re-implementing
// them.
// Applies `next` to a repository result whether it arrived synchronously
// (in-memory, SQLite) or as a promise (a database round trip), so tenant
// checks run on the actual record, never on a pending promise.
const settle = (value, next) => (value && typeof value.then === 'function' ? value.then(next) : next(value))

function tenantFacadeOver(repositories, scope, { writable = false, beforeOutboxEnqueue = null, beforeAuditAppend = null } = {}) {
  const normalized = tenantScope(scope)
  const { tenantId } = normalized
  // Recording methods are keyed by ID; the tenant is passed as well, so a
  // database backend can bind its row-level security context to it.
  const withRecording = (recordingId, operation) => settle(repositories.recordings.get(recordingId, tenantId), (record) => {
    invariant(record && record.tenantId === tenantId, 'TENANT_SCOPE_VIOLATION', 'Recording must remain inside the active tenant scope', 403)
    return operation(record)
  })
  const meetings = {
    get: (meetingId) => repositories.meetings.get(tenantId, meetingId),
    list: () => repositories.meetings.list(tenantId),
  }
  const knowledge = {
    forMeeting: (meetingId) => repositories.knowledge.forMeeting(tenantId, meetingId),
    meetingIdsMatching: (query) => repositories.knowledge.meetingIdsMatching(tenantId, query),
  }
  const recordings = {
    get: (recordingId) => settle(repositories.recordings.get(recordingId, tenantId), (record) => (record?.tenantId === tenantId ? record : null)),
    listForMeeting: (meetingId) => repositories.recordings.listForMeeting(tenantId, meetingId),
  }
  const audit = {
    forMeeting: (meetingId) => repositories.audit.forMeeting(tenantId, meetingId),
    chain: () => repositories.audit.chain(tenantId),
  }
  const commitments = {
    query: (query = '') => repositories.commitments.query(tenantId, query),
  }
  const outbox = {
    list: () => repositories.outbox.list(normalized),
  }
  // Saved chat turns are agent memory: always read and cleared per user.
  const chat = {
    forUser: (userId) => repositories.chat.forUser(tenantId, userId),
  }

  if (writable) {
    meetings.save = (record) => {
      assertTenantRecord(normalized, record, 'meeting')
      return repositories.meetings.save(record)
    }
    knowledge.addSegments = (records) => {
      assertTenantRecordList(normalized, records, 'transcript segment')
      return repositories.knowledge.addSegments(records)
    }
    knowledge.addAssertions = (records) => {
      assertTenantRecordList(normalized, records, 'knowledge assertion')
      return repositories.knowledge.addAssertions(records)
    }
    knowledge.clearMeeting = (meetingId) => repositories.knowledge.clearMeeting(tenantId, meetingId)
    recordings.save = (record) => {
      assertTenantRecord(normalized, record, 'recording')
      return settle(repositories.recordings.get(record.id, tenantId), (existing) => {
        invariant(!existing || existing.tenantId === tenantId, 'TENANT_SCOPE_VIOLATION', 'Recording must remain inside the active tenant scope', 403)
        return repositories.recordings.save(record)
      })
    }
    recordings.putBytes = (recordingId, bytes) => withRecording(recordingId, () => repositories.recordings.putBytes(recordingId, bytes, tenantId))
    recordings.getBytes = (recordingId) => withRecording(recordingId, () => repositories.recordings.getBytes(recordingId, tenantId))
    recordings.clearContent = (recordingId) => withRecording(recordingId, () => repositories.recordings.clearContent(recordingId, tenantId))
    audit.append = (event) => {
      assertTenantRecord(normalized, event, 'audit event')
      // The injector exists solely to exercise the fail-closed audit boundary.
      // It runs before the insert, so the composition root's transaction rolls
      // back the protected state transition along with its missing audit event.
      if (beforeAuditAppend?.(structuredClone(event))) throw new Error('Injected audit append failure')
      return repositories.audit.append(event)
    }
    commitments.replaceMeeting = (meetingId, knowledgeForMeeting) => {
      const segments = knowledgeForMeeting?.segments ?? []
      const assertions = knowledgeForMeeting?.assertions ?? []
      assertTenantRecordList(normalized, segments, 'transcript segment')
      assertTenantRecordList(normalized, assertions, 'knowledge assertion')
      invariant(segments.every((item) => item.meetingId === meetingId) && assertions.every((item) => item.meetingId === meetingId),
        'TENANT_SCOPE_VIOLATION', 'Commitments must remain inside the active meeting scope', 403)
      return repositories.commitments.replaceMeeting(tenantId, meetingId, knowledgeForMeeting)
    }
    commitments.clearMeeting = (meetingId) => repositories.commitments.clearMeeting(tenantId, meetingId)
    chat.appendTurn = (turn) => {
      assertTenantRecord(normalized, turn, 'chat turn')
      return repositories.chat.appendTurn(turn)
    }
    chat.clearForUser = (userId) => repositories.chat.clearForUser(tenantId, userId)
    chat.clearMeeting = (meetingId) => repositories.chat.clearMeeting(tenantId, meetingId)
    outbox.enqueue = (event) => {
      assertTenantRecord(normalized, event, 'outbox event')
      // The injector exists solely to exercise the prototype transaction
      // boundary. It runs before the insert, so a thrown failure is covered
      // by the composition root's rollback below.
      if (beforeOutboxEnqueue?.(structuredClone(event))) {
        throw new Error('Injected outbox enqueue failure')
      }
      return repositories.outbox.enqueue(normalized, event)
    }
  }

  return createTenantStorageFacade(normalized, {
    meetings,
    knowledge,
    recordings,
    audit,
    commitments,
    outbox,
    chat,
  }, { writable })
}

// Composes repositories with the in-memory signatures into a validated storage
// bundle. `runAtomically(work)` runs `work` (which may be asynchronous) and
// either keeps everything it wrote or rolls all of it back; use
// `createSerializedTransactionRunner` so transactions cannot interleave.
export function composeRepositoryStorage({ kind, repositories, runAtomically, beforeOutboxEnqueue = null, beforeAuditAppend = null }) {
  invariant(typeof runAtomically === 'function', 'INVALID_STORAGE_ADAPTER', 'Storage backends must provide an atomic transaction runner')
  const scopedFacade = (scope, options = {}) => tenantFacadeOver(repositories, scope, { ...options, beforeOutboxEnqueue, beforeAuditAppend })
  return createMeetingStorageBundle({
    kind,
    scope: (scope) => scopedFacade(scope),
    transaction: (scope, operation) => {
      const normalized = tenantScope(scope)
      return runAtomically(() => operation(scopedFacade(normalized, { writable: true })), normalized)
    },
  })
}

// Prototype-only composition root. This preserves existing in-memory behavior
// while allowing an application to pass one durable adapter bundle into the
// platform. `transaction` intentionally receives an explicit scope, making an
// unscoped cross-tenant query impossible at the storage boundary.
export function createInMemoryMeetingStorage({ shouldFailOutboxEnqueue = null, shouldFailAuditAppend = null } = {}) {
  invariant(shouldFailOutboxEnqueue === null || typeof shouldFailOutboxEnqueue === 'function',
    'INVALID_STORAGE_ADAPTER', 'Outbox failure injector must be a function when supplied')
  invariant(shouldFailAuditAppend === null || typeof shouldFailAuditAppend === 'function',
    'INVALID_STORAGE_ADAPTER', 'Audit failure injector must be a function when supplied')
  // Repositories remain private to this composition root. In particular, a
  // transaction callback never receives this object or any repository with a
  // caller-supplied tenant argument. Its only authority is a new, tenant-bound
  // facade minted for the requested scope.
  const repositories = {
    meetings: new InMemoryMeetingRepository(),
    knowledge: new InMemoryKnowledgeRepository(),
    recordings: new InMemoryRecordingRepository(),
    audit: new InMemoryAppendOnlyAudit(),
    commitments: new InMemoryCommitmentRegistry(),
    outbox: new InMemoryOutboxRepository(),
    chat: new InMemoryChatRepository(),
  }
  return composeRepositoryStorage({
    kind: 'in-memory-prototype',
    repositories,
    beforeOutboxEnqueue: shouldFailOutboxEnqueue,
    beforeAuditAppend: shouldFailAuditAppend,
    // Snapshot before the write facade is minted. This is the prototype of the
    // all-or-nothing contract: if an outbox enqueue or a derived commitment
    // write fails, canonical and outbox rows are restored together. Durable
    // adapters supply a real database transaction instead.
    runAtomically: createSerializedTransactionRunner({
      begin: () => Object.fromEntries(Object.entries(repositories).map(([name, repository]) => [name, repository.snapshot()])),
      commit: () => {},
      rollback: (snapshots) => { for (const [name, repository] of Object.entries(repositories)) repository.restore(snapshots[name]) },
    }),
  })
}
