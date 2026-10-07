// RAG evaluation metrics for meeting chat.
//
// Retrieval (ranked list of source keys vs. the labelled relevant set):
//   hit@k      1 if any relevant source is in the top k
//   recall@k   share of relevant sources found in the top k
//   precision@k share of the top k that is relevant
//   MRR        1 / rank of the first relevant source (0 if none)
//   nDCG@k     rank-discounted gain, normalized by the ideal ranking
//   spurious   for a question with no relevant source: 1 if anything was
//              retrieved anyway (it would be sent to the provider for nothing)
// Answers (a saved chat turn vs. the labels):
//   citation precision  share of cited sources that are relevant
//   citation recall     share of relevant sources that were cited
//   fact coverage       share of required facts the answer states
//   abstention          unanswerable questions get no answer, answerable ones get one
//   flagged             an answered turn carries a grounding flag (an unmatched
//                       number or statement); on a correct answer this is a false alarm
// Leakage: any retrieved, cited, or answered trace of a meeting the asker
// cannot read. It must be zero; it is a gate, not a score.
import { MAX_CHAT_EXCERPTS } from '../server/chat.js'

const round = (value) => (value === null ? null : Math.round(value * 1000) / 1000)
const mean = (values) => {
  const present = values.filter((value) => value !== null && value !== undefined)
  return present.length ? round(present.reduce((sum, value) => sum + value, 0) / present.length) : null
}

// k is chat's excerpt budget: an empty or short list is scored against it.
export function retrievalMetrics(retrieved, relevant, k = MAX_CHAT_EXCERPTS) {
  const gold = new Set(relevant)
  const top = retrieved.slice(0, k)
  const hits = top.map((key) => gold.has(key))
  const firstHit = hits.indexOf(true)
  const dcg = hits.reduce((sum, hit, index) => sum + (hit ? 1 / Math.log2(index + 2) : 0), 0)
  const ideal = Array.from({ length: Math.min(gold.size, k) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0)
  return {
    hit: gold.size ? (firstHit >= 0 ? 1 : 0) : null,
    recall: gold.size ? round(new Set(top.filter((key) => gold.has(key))).size / gold.size) : null,
    precision: gold.size && top.length ? round(hits.filter(Boolean).length / top.length) : null,
    mrr: gold.size ? round(firstHit >= 0 ? 1 / (firstHit + 1) : 0) : null,
    ndcg: gold.size && ideal ? round(dcg / ideal) : null,
    spurious: gold.size ? null : (top.length > 0 ? 1 : 0),
  }
}

export function answerMetrics(turn, testCase) {
  const answerable = testCase.answerable !== false
  const gold = new Set(testCase.relevant)
  const cited = turn.sources.map((source) => `${source.meetingId}:${source.sourceId}`)
  const answered = turn.status === 'answered'
  const facts = testCase.facts ?? []
  return {
    answered,
    abstentionCorrect: answerable ? answered : !answered,
    citationPrecision: answered && cited.length ? round(cited.filter((key) => gold.has(key)).length / cited.length) : null,
    citationRecall: answered && gold.size ? round(new Set(cited.filter((key) => gold.has(key))).size / gold.size) : null,
    flagged: answered ? ((turn.grounding?.unsupportedNumbers?.length ?? 0) + (turn.grounding?.unsupportedSentences?.length ?? 0) > 0 ? 1 : 0) : null,
    factCoverage: answerable && facts.length ? round(answered ? facts.filter((pattern) => pattern.test(turn.answer ?? '')).length / facts.length : 0) : null,
  }
}

export function leaks(turn, { canary, restrictedMeetingIds }) {
  const text = JSON.stringify(turn)
  return text.includes(canary) || turn.sources.some((source) => restrictedMeetingIds.includes(source.meetingId))
}

export function summarize(rows) {
  const group = (items) => ({
    questions: items.length,
    hit: mean(items.map((row) => row.retrieval.hit)),
    recall: mean(items.map((row) => row.retrieval.recall)),
    precision: mean(items.map((row) => row.retrieval.precision)),
    mrr: mean(items.map((row) => row.retrieval.mrr)),
    ndcg: mean(items.map((row) => row.retrieval.ndcg)),
    spurious: mean(items.map((row) => row.retrieval.spurious)),
    ...(items.some((row) => row.answer) ? {
      abstention: mean(items.map((row) => (row.answer ? (row.answer.abstentionCorrect ? 1 : 0) : null))),
      citationPrecision: mean(items.map((row) => row.answer?.citationPrecision)),
      citationRecall: mean(items.map((row) => row.answer?.citationRecall)),
      factCoverage: mean(items.map((row) => row.answer?.factCoverage)),
      flagged: mean(items.map((row) => row.answer?.flagged)),
    } : {}),
    leaks: items.filter((row) => row.leaked).length,
  })
  const categories = [...new Set(rows.map((row) => row.category))]
  return { overall: group(rows), byCategory: Object.fromEntries(categories.map((category) => [category, group(rows.filter((row) => row.category === category))])) }
}
