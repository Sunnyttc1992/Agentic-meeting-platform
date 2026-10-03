// Renders an authorized meeting's canonical knowledge as a portable Markdown
// record. Every value that originated in speech or a model is escaped so a
// transcript cannot inject links, images, HTML, tables, or headings into the
// document when it is opened in a Markdown viewer. Generation is pure: the
// platform decides who may export, and audits the attempt, before calling it.
// Brackets are enough to break link and image syntax; parentheses stay
// readable. `<`/`>` stop raw HTML and autolinks, `|` stops table breakouts.
const MARKDOWN_SPECIALS = /[\\`*_[\]<>#|!~]/g
const MAX_CORRELATION_LENGTH = 128

export function escapeMarkdownText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().replace(MARKDOWN_SPECIALS, (character) => `\\${character}`)
    // GitHub-flavored Markdown auto-links bare URLs and `www.` names; escaping
    // the slashes and dot keeps the text readable but never clickable.
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}\\.`)
}

const timestamp = (ms) => {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const SECTIONS = Object.freeze([
  ['decision', 'Decisions'],
  ['risk', 'Risks and blockers'],
  ['question', 'Open questions'],
  ['finding', 'Findings'],
])

export function exportFilename(meetingId) {
  const safe = String(meetingId).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'meeting'
  return `${safe}-record.md`
}

export function renderMeetingRecordMarkdown({ meeting, segments = [], assertions = [], processor = null, exportedBy, exportedAt, correlationId }) {
  const times = new Map(segments.map((segment) => [segment.id, timestamp(segment.startMs)]))
  const sources = (citations = []) => {
    const cited = citations.map((id) => times.get(id)).filter(Boolean)
    return cited.length ? `Sources ${cited.join(', ')}` : 'Sources unavailable'
  }
  const ofKind = (kind) => assertions.filter((assertion) => assertion.kind === kind)
  const lines = [
    `# Meeting record: ${escapeMarkdownText(meeting.id)}`,
    '',
    `> **Confidential.** Exported for ${escapeMarkdownText(exportedBy)} on ${escapeMarkdownText(exportedAt)}. Access to this record is governed by meeting policy and every export is audited. Do not forward it.`,
    '',
    `- Classification: ${escapeMarkdownText(meeting.classification)}`,
    `- Participants: ${meeting.participantIds.map(escapeMarkdownText).join(', ')}`,
    `- Processed by: ${escapeMarkdownText(processor ?? 'Not recorded')}`,
    '- Speakers are not identified. Owners and due dates appear only where they were stated in the meeting.',
    '',
  ]

  const summary = ofKind('summary')[0]
  if (summary) lines.push('## Executive summary', '', escapeMarkdownText(summary.text), '', `_${sources(summary.citations)}_`, '')

  const actions = ofKind('action')
  if (actions.length) {
    lines.push('## Action plan', '', '| Action | Owner | Due | Sources |', '| --- | --- | --- | --- |')
    for (const action of actions) {
      const due = action.commitment?.deadline ? action.commitment.deadline.slice(0, 10) : 'Not stated'
      lines.push(`| ${escapeMarkdownText(action.text)} | ${escapeMarkdownText(action.commitment?.ownerId ?? 'Unassigned')} | ${escapeMarkdownText(due)} | ${sources(action.citations)} |`)
    }
    lines.push('')
  }

  for (const [kind, title] of SECTIONS) {
    const items = ofKind(kind)
    if (!items.length) continue
    lines.push(`## ${title}`, '', ...items.map((item) => `- ${escapeMarkdownText(item.text)} (${sources(item.citations)})`), '')
  }

  if (segments.length) {
    lines.push('## Transcript', '')
    for (const segment of segments) {
      const speaker = segment.diarizationLabel === 'UNATTRIBUTED' ? 'Speaker not identified' : escapeMarkdownText(segment.verifiedParticipantId ?? segment.diarizationLabel ?? 'Unknown speaker')
      lines.push(`- **${timestamp(segment.startMs)}** ${speaker}: ${escapeMarkdownText(segment.text)}`)
    }
    lines.push('')
  }

  lines.push('---', '', `Audit correlation: ${escapeMarkdownText(String(correlationId ?? '').slice(0, MAX_CORRELATION_LENGTH))}`, '')
  return lines.join('\n')
}
