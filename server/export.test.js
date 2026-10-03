import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { FixedClock, InMemoryAppendOnlyAudit, InMemoryKnowledgeRepository, InMemoryMeetingRepository, InMemoryRecordingRepository } from './adapters/in-memory.js'
import { createHttpServer } from './http.js'
import { ClaudeMeetingIntelligence } from './intelligence.js'
import { escapeMarkdownText, exportFilename } from './meeting-export.js'
import { MeetingIntelligencePlatform } from './platform.js'
import { PolicyEngine } from './policy.js'
import { LocalMeetingProcessor } from './speech.js'
import { encodeWavPcm16 } from '../src/audioTranscode.js'
import { downloadMeetingRecord } from '../src/meetingExport.js'
import { SPEECH_WAV_MIME_TYPE } from '../src/recordingFormats.js'

const alex = { tenantId: 'northstar', userId: 'alex' }
const sam = { tenantId: 'northstar', userId: 'sam' }
const ceo = { tenantId: 'northstar', userId: 'ceo' }
const INJECTION = 'See [click here](https://evil.example) <script>alert(1)</script> | forged | cell # heading ![img](x)'

const TRANSCRIPT = [
  { startMs: 0, endMs: 4000, text: 'Security review is still open, so January waits for sign-off.' },
  { startMs: 4000, endMs: 9000, text: 'Sam, send the security findings by October 20.' },
  { startMs: 9000, endMs: 13000, text: INJECTION },
]
const CLAUDE_REPLY = {
  summary: { text: 'The team kept the phased rollout pending security sign-off.', citations: ['S1'] },
  decisions: [{ text: 'Keep the phased rollout.', citations: ['S1'] }],
  risks: [{ text: INJECTION, citations: ['S3'] }],
  open_questions: [],
  action_plan: [{ action: 'Send the security findings.', owner_participant_id: 'sam', due_date: '2026-10-20', citations: ['S2'] }],
}

async function processedMeeting() {
  const audit = new InMemoryAppendOnlyAudit()
  const knowledge = new InMemoryKnowledgeRepository()
  const jobs = []
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(CLAUDE_REPLY) }] }) } } }
  const platform = new MeetingIntelligencePlatform({
    meetings: new InMemoryMeetingRepository(), knowledge, recordings: new InMemoryRecordingRepository(), audit,
    speechProcessor: new LocalMeetingProcessor({ transcriber: { transcribe: async () => TRANSCRIPT }, intelligence: new ClaudeMeetingIntelligence({ client }), now: () => new Date('2026-10-03T12:00:00Z') }),
    policy: new PolicyEngine({ managementGrants: [{ tenantId: 'northstar', managerId: 'ceo', subordinateIds: ['alex'] }] }),
    clock: new FixedClock('2026-10-03T12:00:00Z'), acceptedMimeTypes: [SPEECH_WAV_MIME_TYPE], schedule: (job) => jobs.push(job),
  })
  platform.createMeeting(alex, { id: 'meeting-1', tenantId: 'northstar', organizerId: 'alex', participantIds: ['alex', 'sam'], classification: 'standard', consentPolicyVersion: 'v1' })
  for (const actor of [alex, sam]) platform.recordConsent(actor, 'meeting-1', { participantId: actor.userId, capturedAt: '2026-10-03T11:59:00Z', expiresAt: '2026-10-03T15:00:00Z', policyVersion: 'v1', decision: 'granted', method: 'explicit' })
  const process = async () => {
    const bytes = Buffer.from(encodeWavPcm16(new Float32Array(16000)))
    const lease = platform.authorizeRecording(alex, 'meeting-1')
    const created = platform.createRecording(alex, 'meeting-1', { leaseId: lease.leaseId, contentType: SPEECH_WAV_MIME_TYPE, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    platform.uploadRecording(alex, 'meeting-1', created.recordingId, { contentType: SPEECH_WAV_MIME_TYPE, contentLength: bytes.length, bytes })
    platform.startProcessing(alex, 'meeting-1', created.recordingId)
    await jobs.shift()()
  }
  return { platform, audit, process }
}

test('a participant exports a cited, confidential meeting record', async () => {
  const { platform, process } = await processedMeeting()
  await process()
  const record = platform.exportMeetingRecord(sam, 'meeting-1', 'corr-export-1')
  assert.equal(record.filename, 'meeting-1-record.md')
  assert.equal(record.contentType, 'text/markdown; charset=utf-8')
  const body = record.body
  assert.match(body, /\*\*Confidential\.\*\* Exported for sam on 2026-10-03T12:00:00\.000Z/)
  assert.match(body, /## Executive summary\n\nThe team kept the phased rollout pending security sign-off\.\n\n_Sources 00:00_/)
  assert.match(body, /\| Send the security findings\. \| sam \| 2026-10-20 \| Sources 00:04 \|/)
  assert.match(body, /## Decisions\n\n- Keep the phased rollout\. \(Sources 00:00\)/)
  assert.match(body, /- \*\*00:04\*\* Speaker not identified: Sam, send the security findings by October 20\./)
  assert.match(body, /Processed by: Local Whisper \+ Claude/)
  assert.match(body, /Audit correlation: corr-export-1/)
})

test('speech and model text cannot inject links, HTML, table cells, or headings into the export', async () => {
  const { platform, process } = await processedMeeting()
  await process()
  const body = platform.exportMeetingRecord(alex, 'meeting-1').body
  assert.doesNotMatch(body, /(?<!\\)\]\(/, 'no live Markdown link or image')
  assert.doesNotMatch(body, /(?<!\\)<script/, 'no raw HTML')
  assert.doesNotMatch(body, /https:\/\/evil/, 'no auto-linked URL')
  assert.match(body, /See \\\[click here\\\]\(https:\\\/\\\/evil\.example\) \\<script\\>alert\(1\)\\<\/script\\> \\\| forged \\\| cell \\# heading \\!\\\[img\\\]\(x\)/)
  assert.equal(escapeMarkdownText('line one\n## Injected heading'), 'line one \\#\\# Injected heading', 'newlines cannot start a new block')
  assert.equal(escapeMarkdownText('visit www.evil.example'), 'visit www\\.evil.example')
  assert.equal(exportFilename('../../etc/passwd'), 'etc-passwd-record.md')
  assert.equal(exportFilename('"><script>'), 'script-record.md')
})

test('export is participant-only, denies managers and outsiders opaquely, and every attempt is audited without content', async () => {
  const { platform, audit, process } = await processedMeeting()
  await process()
  assert.ok(platform.getMeetingKnowledge(ceo, 'meeting-1').segments.length > 0, 'the manager can view the meeting')
  assert.throws(() => platform.exportMeetingRecord(ceo, 'meeting-1', 'corr-ceo'), { code: 'EXPORT_FORBIDDEN' }, 'but cannot carry it out')
  assert.throws(() => platform.exportMeetingRecord({ tenantId: 'northstar', userId: 'outsider' }, 'meeting-1'), { code: 'MEETING_FORBIDDEN' })
  assert.throws(() => platform.exportMeetingRecord({ tenantId: 'southstar', userId: 'sam' }, 'meeting-1'), { code: 'MEETING_NOT_FOUND' })
  platform.exportMeetingRecord(alex, 'meeting-1', 'corr-alex')

  const exports = audit.all().filter((event) => event.action === 'meeting.export')
  assert.deepEqual(exports.map((event) => [event.principalId, event.outcome, event.reason]), [
    ['ceo', 'denied', 'EXPORT_FORBIDDEN'],
    ['outsider', 'denied', 'MEETING_FORBIDDEN'],
    ['sam', 'denied', 'MEETING_NOT_FOUND'],
    ['alex', 'allowed', null],
  ])
  assert.doesNotMatch(JSON.stringify(audit.all()), /security findings|phased rollout|evil\.example/, 'audit stays content-free')
})

test('export refuses an unprocessed or deleted meeting instead of producing an empty or stale record', async () => {
  const { platform, process } = await processedMeeting()
  assert.throws(() => platform.exportMeetingRecord(alex, 'meeting-1'), { code: 'NO_MEETING_RECORD' })
  await process()
  platform.deleteMeetingContent(alex, 'meeting-1')
  assert.throws(() => platform.exportMeetingRecord(alex, 'meeting-1'), { code: 'RETENTION_RESTRICTED' })
})

test('the export route serves an uncached attachment and keeps errors generic', async () => {
  const { platform, process } = await processedMeeting()
  const server = createHttpServer(platform)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = (actor) => fetch(`${base}/meetings/meeting-1/export`, { headers: { 'x-tenant-id': actor.tenantId, 'x-user-id': actor.userId, 'x-correlation-id': 'corr-http-export' } })
  try {
    const empty = await get(alex)
    assert.equal(empty.status, 409)
    assert.equal((await empty.json()).error.code, 'NO_MEETING_RECORD')
    await process()
    const response = await get(sam)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8')
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="meeting-1-record.md"')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(await response.text(), /Audit correlation: corr-http-export/)
    assert.equal((await get(ceo)).status, 403)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the browser helper downloads only a server-named file and maps errors to plain messages', async () => {
  const clicks = []
  const revoked = []
  const documentImpl = {
    body: { append: () => {} },
    createElement: () => ({ click() { clicks.push({ href: this.href, download: this.download }) }, remove() {} }),
  }
  const URLImpl = { createObjectURL: () => 'blob:record', revokeObjectURL: (url) => revoked.push(url) }
  const ok = (disposition) => async (url, options) => {
    assert.equal(url, '/meetings/meeting-1/export')
    assert.equal(options.headers['x-user-id'], 'alex')
    return new Response('# record', { status: 200, headers: { 'content-disposition': disposition } })
  }
  assert.deepEqual(await downloadMeetingRecord({ fetchImpl: ok('attachment; filename="meeting-1-record.md"'), documentImpl, URLImpl }), { ok: true, filename: 'meeting-1-record.md' })
  await downloadMeetingRecord({ fetchImpl: ok('attachment; filename="../../evil.exe"'), documentImpl, URLImpl })
  assert.deepEqual(clicks.map((click) => click.download), ['meeting-1-record.md', 'meeting-record.md'], 'an unexpected filename is never used')
  assert.deepEqual(revoked, ['blob:record', 'blob:record'])

  const failing = (status, code) => async () => new Response(JSON.stringify({ error: { code } }), { status })
  assert.match((await downloadMeetingRecord({ fetchImpl: failing(409, 'NO_MEETING_RECORD'), documentImpl, URLImpl })).message, /no processed recording/)
  assert.match((await downloadMeetingRecord({ fetchImpl: failing(403, 'EXPORT_FORBIDDEN'), documentImpl, URLImpl })).message, /Only meeting participants/)
  assert.match((await downloadMeetingRecord({ fetchImpl: async () => { throw new Error('offline') }, documentImpl, URLImpl })).message, /local server is running/)
})
