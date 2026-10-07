// RAG evaluation for meeting chat on the synthetic set in evals/rag-cases.mjs.
//
//   npm run eval:rag                 retrieval only: local and free; hybrid
//                                    (keywords + local bge-m3 via Ollama) when
//                                    Ollama is running, otherwise keywords
//   npm run eval:rag -- --keyword    keyword retrieval only, for comparison
//   npm run eval:rag -- --answers    also scores written answers; sends the
//                                    synthetic excerpts to MEETING_CHAT_PROVIDER
//                                    and costs real API credit
//   npm run eval:rag -- --json       machine-readable output
import { parseArgs } from 'node:util'
import { createChatAnswerer, createEmbedder } from '../server/development.js'
import { runRagEvaluation } from '../evals/rag-harness.mjs'

const { values } = parseArgs({ options: { answers: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, keyword: { type: 'boolean', default: false } } })
let chatAnswerer = null
if (values.answers) {
  chatAnswerer = createChatAnswerer()
  if (!chatAnswerer) {
    console.error('Answer scoring needs MEETING_CHAT_PROVIDER (openai or anthropic) and that provider\'s credentials in .env.')
    process.exit(2)
  }
}

const embedder = values.keyword ? null : createEmbedder()
const { rows, summary } = await runRagEvaluation({ chatAnswerer, embedder })
const mode = rows.every((row) => row.retrievalMode === 'hybrid') ? `hybrid (keywords + ${embedder.model})` : embedder ? 'keywords (embedding service unavailable)' : 'keywords'
if (values.json) {
  console.log(JSON.stringify({ rows: rows.map(({ id, category, retrieved, retrieval, answer, leaked }) => ({ id, category, retrieved, retrieval, answer, leaked })), summary }, null, 2))
} else {
  const cell = (value) => (value === null || value === undefined ? '  -  ' : value.toFixed(2).padStart(5))
  console.log(`Retrieval: ${mode}${chatAnswerer ? ` · Answers: ${chatAnswerer.providerName} (${chatAnswerer.model})` : ''}\n`)
  console.log('id   category       recall   MRR  nDCG  prec' + (chatAnswerer ? '  status        cite-P cite-R facts' : ''))
  for (const row of rows) {
    const r = row.retrieval
    const answer = row.answer ? `  ${row.answer.status.padEnd(13)} ${cell(row.answer.citationPrecision)} ${cell(row.answer.citationRecall)} ${cell(row.answer.factCoverage)}${row.answer.abstentionCorrect ? '' : '  WRONG ABSTENTION'}` : ''
    console.log(`${row.id.padEnd(4)} ${row.category.padEnd(13)} ${cell(r.recall)} ${cell(r.mrr)} ${cell(r.ndcg)} ${cell(r.precision)}${answer}${r.spurious ? '  (retrieved for unanswerable)' : ''}${row.leaked ? '  LEAK' : ''}`)
  }
  console.log('\nBy category:')
  for (const [category, group] of Object.entries(summary.byCategory)) {
    const answerPart = group.abstention !== undefined ? ` | abstention ${cell(group.abstention)} cite-P ${cell(group.citationPrecision)} cite-R ${cell(group.citationRecall)} facts ${cell(group.factCoverage)} flagged ${cell(group.flagged)}` : ''
    console.log(`  ${category.padEnd(13)} n=${group.questions} recall ${cell(group.recall)} MRR ${cell(group.mrr)} nDCG ${cell(group.ndcg)} precision ${cell(group.precision)} spurious ${cell(group.spurious)}${answerPart}`)
  }
  const o = summary.overall
  console.log(`\nOverall: hit ${cell(o.hit)} recall ${cell(o.recall)} MRR ${cell(o.mrr)} nDCG ${cell(o.ndcg)} precision ${cell(o.precision)}${o.abstention !== undefined ? ` | abstention ${cell(o.abstention)} cite-P ${cell(o.citationPrecision)} cite-R ${cell(o.citationRecall)} facts ${cell(o.factCoverage)} flagged ${cell(o.flagged)}` : ''} | leaks ${o.leaks}`)
}
// Leakage is a gate: any trace of the restricted meeting fails the run.
process.exitCode = summary.overall.leaks === 0 ? 0 : 1
