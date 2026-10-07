import { cosineSimilarity } from './embeddings.js'

// Memory layer for meeting chat.
//   working memory   the last few readable turns, always offered as context
//   long-term recall older readable turns whose local embedding is close to
//                    the new question (no extra provider call: the vectors
//                    come from the same local model as retrieval)
//   retention        turns older than the retention period are neither shown
//                    nor used, and the retention sweep deletes them
// Which turns are readable is decided by the platform before this module
// sees them: a turn is usable only while the asker can read every meeting it
// drew on, and it is deleted with any of them.
export const MEMORY_WORKING_TURNS = 4
export const MEMORY_RECALL_TURNS = 2
// Calibrated on bge-m3: related question/turn pairs scored 0.52-0.56 and
// unrelated pairs at most 0.44.
export const MEMORY_RECALL_SIMILARITY = 0.48
export const DEFAULT_CHAT_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export const memoryText = (turn) => `Q: ${turn.question}\nA: ${turn.answer ?? '(no answer)'}`

// Four decimals keep recall ranking intact at a fraction of the stored size.
export const compactVector = (vector) => vector.map((value) => Math.round(value * 10_000) / 10_000)

export const retentionCutoff = (now, retentionDays) => new Date(now.getTime() - retentionDays * DAY_MS)

export function isExpired(turn, now, retentionDays) {
  const created = Date.parse(turn?.createdAt ?? '')
  return !Number.isFinite(created) || created <= retentionCutoff(now, retentionDays).getTime()
}

// `turns` are the asker's readable, unexpired turns, oldest first.
export function selectMemory({ turns, questionVector = null, model = null }) {
  const working = turns.slice(-MEMORY_WORKING_TURNS)
  const older = turns.slice(0, Math.max(0, turns.length - MEMORY_WORKING_TURNS))
  const recalled = !questionVector ? [] : older
    .filter((turn) => turn.memoryModel === model && Array.isArray(turn.memoryVector) && turn.memoryVector.length === questionVector.length)
    .map((turn) => ({ turn, similarity: cosineSimilarity(questionVector, turn.memoryVector) }))
    .filter((item) => item.similarity >= MEMORY_RECALL_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MEMORY_RECALL_TURNS)
    .map((item) => item.turn)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return { working, recalled }
}
