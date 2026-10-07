import { DomainError, invariant } from './errors.js'
import { cosineSimilarity } from './embeddings.js'

// Guardrail layer for meeting chat. Every question passes through the same
// stages, in order:
//   1. input     validateQuestion, ChatQuota (per-user daily cost guard)
//   2. outbound  redactPersonalData on everything bound for the provider
//   3. output    keepValidCitations, checkGrounding (numbers and sentences)
// Authorization (before any read) and data minimization (no IDs, titles, or
// audio) stay in the platform's retrieval path; this module holds the
// content checks. Each triggered guardrail is audited by its code only.
export const GUARDRAIL_CODES = Object.freeze({
  personalDataRedacted: 'PERSONAL_DATA_REDACTED',
  citationDropped: 'CITATION_DROPPED',
  ungroundedNumber: 'UNGROUNDED_NUMBER',
  ungroundedStatement: 'UNGROUNDED_STATEMENT',
  quotaExceeded: 'CHAT_QUOTA_EXCEEDED',
})
export const MAX_CHAT_QUESTION_LENGTH = 1000
export const DEFAULT_DAILY_QUESTION_LIMIT = 200
// A sentence of an answer counts as grounded when the local embedding model
// rates it at least this close to one of the excerpts it cites.
export const GROUNDING_SIMILARITY = 0.5

// ---------- 1. Input ----------

// Control characters, zero-width marks, and bidirectional overrides: built
// from code points so the source stays plain ASCII.
const INVISIBLE_OR_CONTROL = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]].map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`, 'gu')

export function validateQuestion(raw) {
  // Control characters are dropped (they carry no meaning in a question and
  // can hide text from a reader); line breaks become spaces.
  const question = typeof raw === 'string' ? raw.replace(INVISIBLE_OR_CONTROL, ' ').replace(/\s+/g, ' ').trim() : ''
  invariant(question.length > 0 && question.length <= MAX_CHAT_QUESTION_LENGTH, 'INVALID_CHAT_QUESTION', `A question must be 1 to ${MAX_CHAT_QUESTION_LENGTH} characters`, 400)
  return question
}

// Per-user daily question limit, counted per UTC day in this server process.
// It bounds provider cost; a restart resets it, which is acceptable for one
// local installation.
export class ChatQuota {
  #counts = new Map()

  constructor({ limit = DEFAULT_DAILY_QUESTION_LIMIT, clock = { now: () => new Date() } } = {}) {
    invariant(Number.isSafeInteger(limit) && limit > 0, 'INVALID_CHAT_QUOTA', 'The daily question limit must be a positive whole number', 500)
    this.limit = limit
    this.clock = clock
  }

  #key(tenantId, userId) { return `${this.clock.now().toISOString().slice(0, 10)}:${tenantId}:${userId}` }

  check(tenantId, userId) {
    if ((this.#counts.get(this.#key(tenantId, userId)) ?? 0) >= this.limit) {
      throw new DomainError(GUARDRAIL_CODES.quotaExceeded, `The daily limit of ${this.limit} questions is reached; it resets at midnight UTC`, 429)
    }
  }

  record(tenantId, userId) {
    const key = this.#key(tenantId, userId)
    for (const existing of this.#counts.keys()) if (!existing.startsWith(key.slice(0, 10))) this.#counts.delete(existing)
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1)
  }
}

// ---------- 2. Outbound ----------

// Patterns for personal and identifying data that the answer never needs.
// Names cannot be found reliably by pattern and are not redacted.
const REDACTIONS = [
  ['[email]', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g],
  ['[id number]', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['[case number]', /\b[A-Za-z]{2,4}\d{7,}\b/g],
  ['[card or account number]', /\b\d(?:[ -]?\d){12,18}\b/g],
  ['[phone]', /(?<![\w$])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\w)/g],
  ['[phone]', /(?<![\w$])\+\d[\d\s.-]{7,14}\d(?!\w)/g],
  ['[number]', /(?<![\w$,.])\d{7,}(?!\w|[,.]\d)/g],
]

export function redactPersonalData(text) {
  let value = String(text ?? '')
  let count = 0
  for (const [replacement, pattern] of REDACTIONS) {
    value = value.replace(pattern, () => { count += 1; return replacement })
  }
  return { text: value, count }
}

// Applies redaction to every outbound field. The question is the asker's own
// words and is sent as written.
export function prepareOutbound({ question, history, recalled = [], excerpts }) {
  let redacted = 0
  const clean = (text) => { const result = redactPersonalData(text); redacted += result.count; return result.text }
  const turn = (item) => ({ question: clean(item.question), answer: clean(item.answer ?? '') })
  return {
    request: {
      question,
      history: history.map(turn),
      recalled: recalled.map(turn),
      excerpts: excerpts.map((item) => ({ ...item, text: clean(item.text) })),
    },
    redacted,
  }
}

// ---------- 3. Output ----------

export function keepValidCitations(citations, excerptsByLabel) {
  const labels = Array.isArray(citations) ? citations : []
  const cited = [...new Set(labels)].map((label) => excerptsByLabel.get(label)).filter(Boolean)
  return { cited, dropped: labels.length - cited.length }
}

const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 }
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 }
const SCALES = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 }

// Numbers a text states, as digits: "$48,000", "48000", "forty eight
// thousand", and "November first" all yield their values.
export function statedNumbers(text, { words = true } = {}) {
  const values = new Set()
  const lower = String(text ?? '').toLowerCase()
  for (const match of lower.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = Number(match[0].replace(/,/g, ''))
    if (Number.isFinite(value)) values.add(value)
  }
  if (!words) return values
  const tokens = lower.replace(/-/g, ' ').match(/[a-z]+/g) ?? []
  let total = 0
  let current = 0
  let active = false
  const flush = () => { if (active) values.add(total + current); total = 0; current = 0; active = false }
  for (const word of tokens) {
    if (Object.hasOwn(SMALL, word)) { current += SMALL[word]; active = true }
    else if (Object.hasOwn(TENS, word)) { current += TENS[word]; active = true }
    else if (Object.hasOwn(ORDINALS, word)) { current += ORDINALS[word]; active = true; flush() }
    else if (Object.hasOwn(SCALES, word) && active) {
      if (SCALES[word] === 100) current *= 100
      else { total += current * SCALES[word]; current = 0 }
    } else if (word !== 'and' || !active) flush()
  }
  flush()
  return values
}

const sentencesOf = (text) => String(text ?? '').split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean)

// Grounding check for a written answer. Every number it states must appear in
// what was sent (excerpts and meeting dates), and with an embedder every
// substantive sentence must be close in meaning to an excerpt it cites.
// Flags are shown to the reader; an answer with no grounded sentence at all
// is withheld by the platform.
// `citedVectors`, when given, are the stored vectors of the cited excerpts, so
// only the answer's sentences need embedding.
export async function checkGrounding({ answer, citedTexts, citedVectors = null, sentTexts, embedder = null }) {
  const available = new Set(sentTexts.flatMap((text) => [...statedNumbers(text)]))
  // The answer is checked for digits only: ordinary words such as "third" or
  // "one" are not claims, while sources are read with number words too.
  const unsupportedNumbers = [...statedNumbers(answer, { words: false })].filter((value) => !available.has(value))
  const sentences = sentencesOf(answer)
  let unsupportedSentences = []
  let method = 'numbers'
  if (embedder && citedTexts.length > 0) {
    try {
      const checked = sentences.map((sentence, index) => ({ sentence, index })).filter((item) => item.sentence.split(/\s+/).length >= 4)
      if (checked.length > 0) {
        const vectors = await embedder.embed([...checked.map((item) => item.sentence), ...(citedVectors ? [] : citedTexts)])
        const sources = citedVectors ?? vectors.slice(checked.length)
        unsupportedSentences = checked.filter((item, position) => Math.max(...sources.map((source) => cosineSimilarity(vectors[position], source))) < GROUNDING_SIMILARITY).map((item) => item.index)
        method = 'numbers+meaning'
        return { method, sentences: sentences.length, checkedSentences: checked.length, unsupportedSentences, unsupportedNumbers, allUnsupported: unsupportedSentences.length === checked.length }
      }
    } catch { method = 'numbers' }
  }
  return { method, sentences: sentences.length, checkedSentences: 0, unsupportedSentences, unsupportedNumbers, allUnsupported: false }
}
