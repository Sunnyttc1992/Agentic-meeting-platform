import test from 'node:test'
import assert from 'node:assert/strict'
import { runRagEvaluation } from '../evals/rag-harness.mjs'
import { answerMetrics, retrievalMetrics, summarize } from '../evals/rag-metrics.mjs'
import { QUESTIONS } from '../evals/rag-cases.mjs'

test('retrieval metrics: recall, precision, MRR, and nDCG on a ranked list', () => {
  assert.deepEqual(retrievalMetrics(['x', 'a', 'y', 'b'], ['a', 'b', 'c']), { hit: 1, recall: 0.667, precision: 0.5, mrr: 0.5, ndcg: 0.498, spurious: null })
  assert.deepEqual(retrievalMetrics(['a', 'b'], ['a', 'b']), { hit: 1, recall: 1, precision: 1, mrr: 1, ndcg: 1, spurious: null })
  assert.deepEqual(retrievalMetrics([], ['a']), { hit: 0, recall: 0, precision: null, mrr: 0, ndcg: 0, spurious: null })
  assert.equal(retrievalMetrics(['x'], []).spurious, 1, 'anything retrieved for an unanswerable question is spurious')
  assert.equal(retrievalMetrics([], []).spurious, 0)
})

test('answer metrics: citations, facts, and abstention', () => {
  const testCase = { relevant: ['m:d1', 'm:s1'], facts: [/48,?000/, /acme/i] }
  const answered = { status: 'answered', answer: 'Acme got 48,000.', sources: [{ meetingId: 'm', sourceId: 'd1' }, { meetingId: 'm', sourceId: 's9' }] }
  assert.deepEqual(answerMetrics(answered, testCase), { answered: true, abstentionCorrect: true, citationPrecision: 0.5, citationRecall: 0.5, factCoverage: 1 })
  const abstained = { status: 'not-covered', answer: 'Not covered.', sources: [] }
  assert.deepEqual(answerMetrics(abstained, testCase), { answered: false, abstentionCorrect: false, citationPrecision: null, citationRecall: null, factCoverage: 0 })
  assert.equal(answerMetrics(abstained, { relevant: [], answerable: false }).abstentionCorrect, true)
  assert.equal(answerMetrics(answered, { relevant: [], answerable: false }).abstentionCorrect, false)
  assert.equal(summarize([{ category: 'k', retrieval: { recall: 1 }, leaked: true }]).overall.leaks, 1)
})

// A regression floor for lexical retrieval on the synthetic set. Raise it
// when retrieval improves; a drop means a change made chat find less.
test('lexical retrieval keeps its baseline on the synthetic set and never leaks the restricted meeting', async () => {
  const { rows, summary } = await runRagEvaluation()
  assert.equal(rows.length, QUESTIONS.length)
  assert.equal(summary.overall.leaks, 0)
  assert.equal(summary.byCategory.keyword.recall, 1)
  assert.equal(summary.byCategory.keyword.mrr, 1)
  assert.ok(summary.overall.recall >= 0.75, `overall recall ${summary.overall.recall}`)
  assert.ok(summary.overall.mrr >= 0.75, `overall MRR ${summary.overall.mrr}`)
  for (const row of rows.filter((item) => item.category === 'restricted')) assert.deepEqual(row.retrieved, [], `${row.id} retrieves nothing`)
})
