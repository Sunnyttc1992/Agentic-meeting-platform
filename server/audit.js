import { createHash } from 'node:crypto'
import { invariant } from './errors.js'

// Tamper-evident audit chain (SEC-05, milestone evidence).  Every tenant has
// its own chain: an event's hash covers its content-free envelope, its
// tenant-local sequence number, and the previous event's hash.  Editing,
// removing, reordering, or splicing an event therefore breaks verification
// from that point on.  A chain alone cannot reveal truncation of its newest
// events; callers detect that by verifying against an externally retained
// head anchor (production: a WORM/SIEM checkpoint the application identity
// cannot rewrite).
export const AUDIT_CHAIN_VERSION = 'audit-chain-v1'
export const AUDIT_CHAIN_GENESIS = '0'.repeat(64)
const CHAIN_FIELDS = Object.freeze(['sequence', 'previousHash', 'hash', 'chainVersion'])
const SHA256_HEX = /^[0-9a-f]{64}$/

// Deterministic JSON with recursively sorted keys, so the same envelope always
// hashes to the same value regardless of property insertion order.
export function canonicalAuditJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalAuditJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalAuditJson(value[key])}`).join(',')}}`
}

function envelopeOf(event) {
  const envelope = {}
  for (const [key, value] of Object.entries(event)) if (key !== 'hash') envelope[key] = value
  return envelope
}

export function auditEventHash(event) {
  return createHash('sha256').update(canonicalAuditJson(envelopeOf(event))).digest('hex')
}

/**
 * Mints the chain fields for a new event.  Chain fields are owned by the audit
 * store: a caller that supplies its own sequence or hash is attempting to
 * forge chain position and is rejected rather than silently overwritten.
 */
export function sealAuditEvent(event, previous = null) {
  invariant(event && typeof event === 'object' && !Array.isArray(event), 'INVALID_AUDIT_EVENT', 'Audit event must be an object')
  invariant(typeof event.tenantId === 'string' && event.tenantId.length > 0, 'INVALID_AUDIT_EVENT', 'Audit event requires a tenant')
  invariant(CHAIN_FIELDS.every((field) => !Object.hasOwn(event, field)), 'INVALID_AUDIT_EVENT', 'Audit chain fields are minted by the audit store')
  invariant(previous === null || previous.tenantId === event.tenantId, 'TENANT_SCOPE_VIOLATION', 'Audit chains are tenant-local', 403)
  const sealed = {
    ...structuredClone(event),
    chainVersion: AUDIT_CHAIN_VERSION,
    sequence: previous ? previous.sequence + 1 : 1,
    previousHash: previous ? previous.hash : AUDIT_CHAIN_GENESIS,
  }
  sealed.hash = auditEventHash(sealed)
  return Object.freeze(sealed)
}

const failure = (checked, sequence, reason) => Object.freeze({
  valid: false, checked, head: null, failure: Object.freeze({ sequence, reason }),
})

/**
 * Independently re-derives a tenant chain.  The result carries only sequence
 * numbers, a head hash, and an allowlisted reason code -- never event
 * contents -- so it is safe to return to an authorized audit reader.
 *
 * `anchor` ({ sequence, hash }) is a previously retained head.  The chain must
 * still contain that exact event, which detects tail truncation and history
 * rewritten behind the anchor.
 */
export function verifyAuditChain(events, { tenantId, anchor = null } = {}) {
  invariant(Array.isArray(events), 'INVALID_AUDIT_CHAIN', 'Audit chain must be an array')
  invariant(typeof tenantId === 'string' && tenantId.length > 0, 'INVALID_AUDIT_CHAIN', 'Audit chain verification requires a tenant')
  invariant(anchor === null || (Number.isSafeInteger(anchor.sequence) && anchor.sequence > 0 && typeof anchor.hash === 'string' && SHA256_HEX.test(anchor.hash)),
    'INVALID_AUDIT_ANCHOR', 'Audit anchor requires a positive sequence and a SHA-256 hash', 400)
  let previousHash = AUDIT_CHAIN_GENESIS
  for (const [index, event] of events.entries()) {
    const position = index + 1
    if (!event || typeof event !== 'object') return failure(index, position, 'MALFORMED_EVENT')
    if (event.tenantId !== tenantId) return failure(index, position, 'TENANT_MISMATCH')
    if (event.chainVersion !== AUDIT_CHAIN_VERSION) return failure(index, position, 'UNSUPPORTED_CHAIN_VERSION')
    if (event.sequence !== position) return failure(index, position, 'SEQUENCE_GAP')
    if (event.previousHash !== previousHash) return failure(index, position, 'CHAIN_BROKEN')
    if (typeof event.hash !== 'string' || !SHA256_HEX.test(event.hash) || auditEventHash(event) !== event.hash) return failure(index, position, 'HASH_MISMATCH')
    previousHash = event.hash
  }
  const last = events.at(-1)
  const head = last ? Object.freeze({ sequence: last.sequence, hash: last.hash }) : null
  if (anchor) {
    const anchored = events[anchor.sequence - 1]
    if (!anchored) return failure(events.length, anchor.sequence, 'ANCHOR_MISSING')
    if (anchored.hash !== anchor.hash) return failure(events.length, anchor.sequence, 'ANCHOR_MISMATCH')
  }
  return Object.freeze({ valid: true, checked: events.length, head, failure: null })
}
