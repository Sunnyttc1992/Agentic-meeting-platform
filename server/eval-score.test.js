import test from 'node:test'
import assert from 'node:assert/strict'
import { CASES } from '../evals/meeting-intelligence-cases.mjs'
import { scoreCase } from '../evals/score.mjs'

const empty = { summary: null, decisions: [], risks: [], questions: [], actions: [] }
const byName = (name) => CASES.find((item) => item.name === name)

test('the evaluation scorer passes a correct result and names each broken rule', () => {
  const caseDef = byName('committed versus proposed')
  const good = {
    ...empty,
    actions: [
      { text: 'Send the board deck.', agreement: 'committed', speakerLabel: 'SPEAKER_01', ownerId: null, deadline: '2026-10-09', citations: ['S2'] },
      { text: 'Update the onboarding wiki.', agreement: 'proposed', speakerLabel: null, ownerId: null, deadline: null, citations: ['S3'] },
    ],
  }
  assert.ok(scoreCase(caseDef, good).every((item) => item.pass))

  const bad = {
    ...empty,
    actions: [
      { text: 'Send the board deck.', agreement: 'proposed', speakerLabel: 'SPEAKER_01', ownerId: null, deadline: '2026-10-09', citations: ['S9'] },
    ],
  }
  const failed = scoreCase(caseDef, bad).filter((item) => !item.pass).map((item) => item.name)
  assert.equal(failed.length, 3)
  assert.match(failed[0], /cites real transcript segments/)
  assert.match(failed[1], /board deck/)
  assert.match(failed[2], /wiki.*is present/)
})

test('forbidden owners, dates, decisions, and count limits are each reported', () => {
  const injection = byName('prompt injection in the transcript is treated as speech')
  const hijacked = {
    ...empty,
    decisions: [{ text: 'Approve the budget.', citations: ['S2'] }],
    actions: [{ text: 'Do everything.', agreement: 'committed', speakerLabel: null, ownerId: 'mallory', deadline: '2020-01-01', citations: ['S2'] }],
  }
  assert.equal(scoreCase(injection, hijacked).filter((item) => !item.pass).length, 3)
  assert.ok(scoreCase(injection, empty).every((item) => item.pass))

  const smallTalk = byName('small talk records nothing')
  const noisy = { ...empty, actions: [{ text: 'Go hiking.', agreement: 'proposed', speakerLabel: null, ownerId: null, deadline: null, citations: ['S2'] }] }
  assert.deepEqual(scoreCase(smallTalk, noisy).filter((item) => !item.pass).map((item) => item.name), ['at most 0 actions'])
})

test('required decisions, risks, and questions, stale decisions, and text-scoped forbidden actions are each reported', () => {
  const reversed = byName('a reversed decision keeps only the final one')
  const stale = { ...empty, summary: { text: 'Launch planning.', citations: ['S1'] }, decisions: [{ text: 'Launch the partner portal in January.', citations: ['S1'] }] }
  assert.deepEqual(scoreCase(reversed, stale).filter((item) => !item.pass).map((item) => item.name), [
    'decision matching /march/i is present',
    `no decision matching ${reversed.expect.forbidDecisions[0]}`,
  ])
  const final = { ...empty, decisions: [{ text: 'Move the partner portal launch from January to March.', citations: ['S3'] }] }
  assert.ok(scoreCase(reversed, final).every((item) => item.pass))

  const risks = byName('risks and blockers are captured')
  assert.equal(scoreCase(risks, { ...empty, risks: [{ text: 'Vendor API fix blocks the migration.', citations: ['S1'] }] }).filter((item) => !item.pass).length, 1)

  const declined = byName('a declined request is not a commitment')
  const unrelated = { ...empty, actions: [{ text: 'Book the room.', agreement: 'committed', speakerLabel: null, ownerId: 'sam', deadline: null, citations: ['S2'] }] }
  assert.ok(scoreCase(declined, unrelated).every((item) => item.pass), 'a forbidden pattern applies only to matching action text')
  const accepted = { ...empty, actions: [{ text: 'Redo the revenue forecast.', agreement: 'committed', speakerLabel: 'SPEAKER_01', ownerId: 'sam', deadline: null, citations: ['S1'] }] }
  assert.equal(scoreCase(declined, accepted).filter((item) => !item.pass).length, 2)
})
