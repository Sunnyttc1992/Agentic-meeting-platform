// Deterministic scoring for one evaluation case. `result` is the normalized
// output of a meeting-intelligence adapter's extract(). Every check is
// independent so a report shows exactly which rule a provider broke.

const describe = (value) => (value instanceof RegExp ? String(value) : JSON.stringify(value))

function matchesFields(action, expected) {
  return Object.entries(expected).every(([key, value]) => {
    if (key === 'text' || key === 'optional') return true
    return (action[key] ?? null) === value
  })
}

export function scoreCase(caseDef, result) {
  const checks = []
  const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail })
  const segmentIds = new Set(caseDef.segments.map((segment) => segment.id))
  const items = [result.summary, ...result.decisions, ...result.risks, ...result.questions, ...result.actions].filter(Boolean)
  const badCitations = items.filter((item) => !item.citations.length || item.citations.some((id) => !segmentIds.has(id)))
  check('every item cites real transcript segments', badCitations.length === 0, badCitations.map((item) => item.text).join(' | '))

  for (const expected of caseDef.expect.actions ?? []) {
    const candidates = result.actions.filter((action) => expected.text.test(action.text))
    if (!candidates.length) {
      if (!expected.optional) check(`action ${describe(expected.text)} is present`, false, 'no matching action')
      continue
    }
    const fields = Object.fromEntries(Object.entries(expected).filter(([key]) => !['text', 'optional'].includes(key)))
    const hit = candidates.find((action) => matchesFields(action, fields))
    check(
      `action ${describe(expected.text)} has ${describe(fields)}`,
      hit,
      hit ? '' : `got ${candidates.map((action) => describe({ agreement: action.agreement, ownerId: action.ownerId, speakerLabel: action.speakerLabel, deadline: action.deadline })).join(' / ')}`,
    )
  }
  for (const forbidden of caseDef.expect.forbidActions ?? []) {
    const offenders = result.actions.filter((action) => matchesFields(action, forbidden))
    check(`no action with ${describe(forbidden)}`, offenders.length === 0, offenders.map((action) => action.text).join(' | '))
  }
  for (const pattern of caseDef.expect.forbidDecisions ?? []) {
    const offenders = result.decisions.filter((decision) => pattern.test(decision.text))
    check(`no decision matching ${describe(pattern)}`, offenders.length === 0, offenders.map((decision) => decision.text).join(' | '))
  }
  if (caseDef.expect.maxActions !== undefined) check(`at most ${caseDef.expect.maxActions} actions`, result.actions.length <= caseDef.expect.maxActions, `got ${result.actions.length}`)
  if (caseDef.expect.maxDecisions !== undefined) check(`at most ${caseDef.expect.maxDecisions} decisions`, result.decisions.length <= caseDef.expect.maxDecisions, `got ${result.decisions.length}`)
  return checks
}
