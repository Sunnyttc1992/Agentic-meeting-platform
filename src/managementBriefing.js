import { privacyAccessHeaders } from "./privacyAccess.js"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._@ -]{0,119}$/
const ACTION_STATUSES = new Set(["open", "in-progress", "blocked", "completed", "cancelled"])
const CATEGORIES = ["decisions", "risks", "blockers", "actions"]
const MAX_ITEMS_PER_CATEGORY = 24
const MAX_TEXT_LENGTH = 1600
const MAX_CITATIONS = 12

const objectPrototype = Object.prototype
const getPrototypeOf = Object.getPrototypeOf
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const ownKeys = Reflect.ownKeys
const hasOwn = Object.prototype.hasOwnProperty
function plainDataObject(value, requiredKeys, optionalKeys = []) {
  try {
    // Build a new object only from ordinary own data descriptors. Each
    // nested shape is passed through this same boundary before its values are
    // interpreted, so no `value[key]` lookup (and therefore no getter) is
    // needed anywhere in the response pipeline.
    if (!value || typeof value !== "object" || getPrototypeOf(value) !== objectPrototype) return null
    const descriptors = getOwnPropertyDescriptors(value)
    const expected = new Set([...requiredKeys, ...optionalKeys])
    const keys = ownKeys(descriptors)
    if (keys.length < requiredKeys.length || keys.some((key) => typeof key !== "string" || !expected.has(key))) return null
    const copy = {}
    for (const key of requiredKeys) {
      const descriptor = descriptors[key]
      if (!isPlainDataDescriptor(descriptor)) return null
      Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true })
    }
    for (const key of optionalKeys) {
      if (!hasOwn.call(descriptors, key)) continue
      const descriptor = descriptors[key]
      if (!isPlainDataDescriptor(descriptor)) return null
      Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true })
    }
    return copy
  } catch {
    return null
  }
}

function copyBriefingArray(value, maxLength) {
  try {
    if (!Array.isArray(value) || getPrototypeOf(value) !== Array.prototype) return null
    const descriptors = getOwnPropertyDescriptors(value)
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength || !isNativeArrayLengthDescriptor(descriptors.length)) return null
    const keys = ownKeys(descriptors)
    if (keys.length !== length + 1) return null
    const copy = new Array(length)
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!isPlainDataDescriptor(descriptor)) return null
      copy[index] = descriptor.value
    }
    for (const key of keys) {
      if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return null
    }
    return copy
  } catch {
    // A Proxy or an exotic object fails closed before any caller-controlled
    // member can be invoked.
    return null
  }
}

function isNativeArrayLengthDescriptor(descriptor) {
  return descriptor && hasOwn.call(descriptor, "value") &&
    !hasOwn.call(descriptor, "get") && !hasOwn.call(descriptor, "set") &&
    Number.isSafeInteger(descriptor.value) && descriptor.value >= 0 &&
    descriptor.enumerable === false && descriptor.configurable === false && descriptor.writable === true
}

function isPlainDataDescriptor(descriptor) {
  return descriptor && hasOwn.call(descriptor, "value") &&
    !hasOwn.call(descriptor, "get") && !hasOwn.call(descriptor, "set") &&
    descriptor.enumerable === true && descriptor.configurable === true && descriptor.writable === true
}

function safeIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null
}

function safeDeadline(value) {
  if (value === null) return null
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function sanitizeSource(value) {
  const source = plainDataObject(value, ["meetingId", "assertionId", "citations"])
  if (!source) return null
  const meetingId = safeIdentifier(source.meetingId)
  const assertionId = safeIdentifier(source.assertionId)
  const rawCitations = copyBriefingArray(source.citations, MAX_CITATIONS)
  const citations = rawCitations?.every((citation) => safeIdentifier(citation) !== null) ? rawCitations : null
  if (!meetingId || !assertionId || !citations?.length) return null

  const unique = []
  const known = new Set()
  for (const citation of citations) {
    if (!known.has(citation)) {
      known.add(citation)
      unique.push(citation)
    }
  }
  return Object.freeze({ meetingId, assertionId, citations: Object.freeze(unique) })
}

function sanitizeAssertion(value) {
  const item = plainDataObject(value, ["id", "text", "source"])
  if (!item) return null
  const id = safeIdentifier(item.id)
  const text = typeof item.text === "string" ? item.text.trim() : ""
  const source = sanitizeSource(item.source)
  if (!id || !text || text.length > MAX_TEXT_LENGTH || !source) return null
  return Object.freeze({ id, text, source })
}

function sanitizeAction(value) {
  const item = plainDataObject(value, ["id", "text", "ownerId", "deadline", "status", "source"])
  if (!item) return null
  const id = safeIdentifier(item.id)
  const text = typeof item.text === "string" ? item.text.trim() : ""
  const ownerId = item.ownerId === null || (typeof item.ownerId === "string" && OWNER.test(item.ownerId)) ? item.ownerId : null
  const deadline = safeDeadline(item.deadline)
  const source = sanitizeSource(item.source)
  if (!id || !text || text.length > MAX_TEXT_LENGTH || item.ownerId !== ownerId || item.deadline !== deadline || !ACTION_STATUSES.has(item.status) || !source) return null
  return Object.freeze({ id, text, ownerId, deadline, status: item.status, source })
}

function sanitizeCategory(value, sanitizer) {
  const items = copyBriefingArray(value, MAX_ITEMS_PER_CATEGORY)
  if (!items) return null
  const unique = new Map()
  for (const rawItem of items) {
    const item = sanitizer(rawItem)
    if (item) unique.set(item.id, item)
  }
  return Object.freeze(Array.from(unique.values()))
}

function sanitizeCounts(value) {
  const counts = plainDataObject(value, ["decisions", "risks", "blockers", "openActions"])
  if (!counts) return null
  for (const key of ["decisions", "risks", "blockers", "openActions"]) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0 || counts[key] > MAX_ITEMS_PER_CATEGORY) return null
  }
  return Object.freeze({
    decisions: counts.decisions,
    risks: counts.risks,
    blockers: counts.blockers,
    openActions: counts.openActions,
  })
}

// This is a display boundary, not an authorization decision. The service owns
// source authorization; the browser admits only small canonical briefing shapes
// and never retains processor, provenance, or arbitrary metadata fields.
//
// The *wire* boundary is deliberately text-only. Inspecting an object supplied
// by a caller (even with descriptor APIs) can invoke Proxy traps. Parsing raw
// JSON first makes every subsequent value platform-created data, rather than a
// graph controlled by an untrusted caller.
export function sanitizeManagementBriefing(payloadText) {
  if (typeof payloadText !== "string") return null

  let payload
  try {
    payload = JSON.parse(payloadText)
  } catch {
    return null
  }

  const envelope = plainDataObject(payload, ["briefing"])
  const briefing = envelope && plainDataObject(envelope.briefing, ["counts", ...CATEGORIES])
  if (!briefing) return null
  const counts = sanitizeCounts(briefing.counts)
  const decisions = sanitizeCategory(briefing.decisions, sanitizeAssertion)
  const risks = sanitizeCategory(briefing.risks, sanitizeAssertion)
  const blockers = sanitizeCategory(briefing.blockers, sanitizeAssertion)
  const actions = sanitizeCategory(briefing.actions, sanitizeAction)
  if (!counts || !decisions || !risks || !blockers || !actions) return null
  return Object.freeze({ briefing: Object.freeze({ counts, decisions, risks, blockers, actions }) })
}

export async function loadManagementBriefing({ fetchImpl = fetch, correlationId } = {}) {
  try {
    const response = await fetchImpl("/management-briefing", {
      method: "GET",
      headers: privacyAccessHeaders(correlationId),
    })
    if (!response.ok) return { status: "unavailable" }
    const data = sanitizeManagementBriefing(await response.text())
    return data ? { status: "authorized", data } : { status: "unavailable" }
  } catch {
    return { status: "unavailable" }
  }
}
