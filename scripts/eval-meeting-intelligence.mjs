// Runs the synthetic evaluation cases against the configured summary provider
// (MEETING_SUMMARY_PROVIDER / API keys, as the server would choose) and prints
// a pass/fail report. Each run sends only the synthetic transcripts in
// evals/meeting-intelligence-cases.mjs and costs real API credit, so it is
// never part of `npm test`. Usage: npm run eval:summaries
import { summaryProvider } from '../server/development.js'
import { ClaudeMeetingIntelligence } from '../server/intelligence.js'
import { OpenAIMeetingIntelligence } from '../server/intelligence-openai.js'
import { CASES, MEETING_DATE, PARTICIPANT_IDS } from '../evals/meeting-intelligence-cases.mjs'
import { scoreCase } from '../evals/score.mjs'

const provider = summaryProvider(process.env)
if (provider === 'none') {
  console.error('No summary provider is configured. Set MEETING_SUMMARY_PROVIDER and its API key in .env.')
  process.exit(2)
}
const intelligence = provider === 'openai' ? new OpenAIMeetingIntelligence() : new ClaudeMeetingIntelligence()
console.log(`Provider: ${intelligence.providerName} (${intelligence.model})\n`)

let passed = 0
let total = 0
for (const caseDef of CASES) {
  let checks
  try {
    const result = await intelligence.extract({ segments: caseDef.segments, participantIds: PARTICIPANT_IDS, meetingDate: MEETING_DATE })
    checks = scoreCase(caseDef, result)
  } catch (error) {
    checks = [{ name: 'request completed', pass: false, detail: `${error?.constructor?.name ?? 'Error'}: ${String(error?.message ?? '').slice(0, 200)}` }]
  }
  const casePassed = checks.filter((item) => item.pass).length
  passed += casePassed
  total += checks.length
  console.log(`${casePassed === checks.length ? 'PASS' : 'FAIL'}  ${caseDef.name} (${casePassed}/${checks.length})`)
  for (const item of checks.filter((entry) => !entry.pass)) console.log(`      x ${item.name}${item.detail ? `: ${item.detail}` : ''}`)
}
console.log(`\nScore: ${passed}/${total} checks (${Math.round((passed / total) * 100)}%)`)
process.exitCode = passed === total ? 0 : 1
