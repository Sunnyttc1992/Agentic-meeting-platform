import test from "node:test"
import assert from "node:assert/strict"
import { initialRecordingState, recordingReducer, revokeRecordingUrl } from "../src/recordingMachine.js"
import { createMediaCapture } from "../src/mediaCapture.js"
import { normalizeRecordingMimeType } from "../src/recordingFormats.js"
import { sanitizePrivacyAccess } from "../src/privacyAccess.js"
import { sanitizeTeamsReadiness } from "../src/teamsIntegration.js"
import { sanitizeCommitmentQuery, sanitizeCommitments } from "../src/commitments.js"
import { currentRecordEvidence } from "../src/currentRecordEvidence.js"
import { loadManagementBriefing, sanitizeManagementBriefing } from "../src/managementBriefing.js"
import { createServer } from "vite"
import { webcrypto } from "node:crypto"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

test('recording formats normalize only allowlisted containers and codecs', () => {
  for (const [value, expected] of [
    ['audio/webm;codecs=opus', 'audio/webm'],
    [' Audio/Ogg ; codecs="opus" ', 'audio/ogg'],
    ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'],
    ['audio/mp4', 'audio/mp4'],
  ]) assert.equal(normalizeRecordingMimeType(value), expected)
  for (const value of ['', null, 'video/webm', 'audio/wav', 'audio/webm;codecs=vp9', 'audio/mp4;codecs=opus', 'audio/webm;codecs=opus;extra=yes']) {
    assert.equal(normalizeRecordingMimeType(value), null)
  }
})

test('mock capture is available only to loopback origins, including when Vite dev is remote', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  try {
    const { browserMockEnabled } = await vite.ssrLoadModule('/src/RecordingStudio.jsx')
    assert.equal(browserMockEnabled({ search: '?mockMedia=1', hostname: 'localhost', dev: false }), true)
    assert.equal(browserMockEnabled({ search: '?mockMedia=1', hostname: '127.0.0.1', dev: false }), true)
    assert.equal(browserMockEnabled({ search: '?mockMedia=1', hostname: '[::1]', dev: false }), true)
    assert.equal(browserMockEnabled({ search: '?mockMedia=1', hostname: 'localhost', dev: true }), true)
    assert.equal(browserMockEnabled({ search: '?mockMedia=1', hostname: 'meeting.example.com', dev: false }), false)
    assert.equal(browserMockEnabled({ search: '?mockMedia=1', hostname: 'meeting.example.com', dev: true }), false)
    assert.equal(browserMockEnabled({ search: '', hostname: 'localhost', dev: false }), false)
  } finally {
    await vite.close()
  }
})

test('mock recording uses a clearly labeled synthetic fixture with no playback URL', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  try {
    const { createDevelopmentSyntheticFixture } = await vite.ssrLoadModule('/src/RecordingStudio.jsx')
    const fixture = createDevelopmentSyntheticFixture()

    assert.equal(fixture.type, 'application/x-meeting-prototype-fixture')
    assert.equal(normalizeRecordingMimeType(fixture.type), null)

    const syntheticSignals = []
    let playbackUrls = 0
    const capture = createMediaCapture({
      MediaRecorderClass: class FixtureRecorder {
        static isSyntheticFixture = true
        constructor() { this.state = 'inactive'; this.mimeType = fixture.type; this.isSyntheticFixture = true }
        start() { this.state = 'recording' }
        stop() { this.ondataavailable({ data: fixture }); this.state = 'inactive'; this.onstop() }
      },
      allowSyntheticFixture: true,
      onSyntheticFixture: (value) => { syntheticSignals.push(value) },
      createObjectURL: () => { playbackUrls += 1; return 'blob:must-not-exist' },
    })
    capture.connect({ getTracks: () => [{ stop() {} }] })
    capture.start()
    capture.stop()
    assert.equal(capture.blob().type, fixture.type)
    assert.equal(capture.snapshot().audioUrl, null)
    assert.equal(playbackUrls, 0)
    assert.deepEqual(syntheticSignals, [null, true])
  } finally {
    await vite.close()
  }
})

test('recording UI renders synthetic fixture language distinct from real microphone states', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  try {
    const { CaptureTruthfulCopy } = await vite.ssrLoadModule('/src/RecordingStudio.jsx')
    for (const phase of ['ready', 'recording', 'stopped']) {
      const fixtureHtml = renderToStaticMarkup(React.createElement(CaptureTruthfulCopy, { mode: 'synthetic', phase }))
      const microphoneHtml = renderToStaticMarkup(React.createElement(CaptureTruthfulCopy, { mode: 'real', phase }))

      assert.match(fixtureHtml, /synthetic test fixture/i)
      assert.match(fixtureHtml, /no microphone/i)
      assert.match(fixtureHtml, /no audio/i)
      assert.doesNotMatch(fixtureHtml, /microphone connected|audio is held temporarily|review first/i)
      assert.notEqual(fixtureHtml, microphoneHtml)
    }
    const stoppedFixture = renderToStaticMarkup(React.createElement(CaptureTruthfulCopy, { mode: 'synthetic', phase: 'stopped' }))
    assert.match(stoppedFixture, /playback, upload, processing, and import are unavailable/i)
    assert.doesNotMatch(stoppedFixture, /<audio|process locally/i)
  } finally {
    await vite.close()
  }
})

test('capture negotiates a supported format and normalizes native codec parameters', () => {
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    const options = []
    class NativeRecorder {
      static isTypeSupported(type) { return type === mimeType }
      constructor(stream, configuration) { options.push(configuration); this.mimeType = configuration.mimeType; this.state = 'inactive' }
      start() { this.state = 'recording' }
      stop() { this.ondataavailable({ data: new Blob(['audio'], { type: this.mimeType }) }); this.state = 'inactive'; this.onstop() }
    }
    const capture = createMediaCapture({ MediaRecorderClass: NativeRecorder, createObjectURL: () => 'blob:format' })
    capture.connect({ getTracks: () => [{ stop() {} }] })
    capture.start()
    capture.stop()
    assert.deepEqual(options, [{ mimeType }])
    assert.equal(capture.blob().type, normalizeRecordingMimeType(mimeType))
  }
})

test('capture rejects unknown or empty recorder and chunk formats without guessing webm', () => {
  for (const mimeType of ['', 'audio/unknown']) {
    let reported = null
    let stopped = false
    class UnknownRecorder {
      constructor() { this.mimeType = mimeType; this.state = 'inactive' }
      start() { this.state = 'recording' }
      stop() { this.ondataavailable({ data: new Blob(['audio'], { type: mimeType }) }); this.state = 'inactive'; this.onstop() }
    }
    const capture = createMediaCapture({ MediaRecorderClass: UnknownRecorder, onError: (error) => { reported = error }, createObjectURL: () => { throw new Error('must not create playback') } })
    capture.connect({ getTracks: () => [{ stop() { stopped = true } }] })
    capture.start()
    capture.stop()
    assert.equal(capture.blob(), null)
    assert.match(reported.message, /unsupported audio format/)
    assert.equal(stopped, true)
  }
})

test('capture fails closed when either recorder or emitted chunk omits its MIME type', () => {
  for (const { recorderMimeType, chunkMimeType } of [
    { recorderMimeType: 'audio/webm', chunkMimeType: '' },
    { recorderMimeType: '', chunkMimeType: 'audio/webm' },
  ]) {
    let reported = null
    let stopped = false
    let blobCreations = 0
    let urlCreations = 0
    class MissingMimeRecorder {
      constructor() { this.mimeType = recorderMimeType; this.state = 'inactive' }
      start() { this.state = 'recording' }
      stop() {
        this.ondataavailable({ data: { size: 5, type: chunkMimeType } })
        this.state = 'inactive'
        this.onstop()
      }
    }
    const capture = createMediaCapture({
      MediaRecorderClass: MissingMimeRecorder,
      BlobClass: class TrackingBlob { constructor() { blobCreations += 1 } },
      createObjectURL: () => { urlCreations += 1; return 'blob:must-not-exist' },
      onError: (error) => { reported = error },
    })
    capture.connect({ getTracks: () => [{ stop() { stopped = true } }] })
    capture.start()
    capture.stop()

    assert.equal(capture.blob(), null)
    assert.deepEqual(capture.snapshot().chunks, [])
    assert.equal(capture.snapshot().audioUrl, null)
    assert.equal(blobCreations, 0)
    assert.equal(urlCreations, 0)
    assert.match(reported.message, /unsupported audio format/)
    assert.equal(stopped, true)
  }
})

test('unsupported browser negotiation releases the microphone before creating a recorder', () => {
  let stopped = false
  class UnsupportedRecorder {
    static isTypeSupported() { return false }
    constructor() { throw new Error('must not construct unsupported recorder') }
  }
  const capture = createMediaCapture({ MediaRecorderClass: UnsupportedRecorder })
  capture.connect({ getTracks: () => [{ stop() { stopped = true } }] })
  assert.throws(() => capture.start(), /does not support an accepted audio recording format/)
  assert.equal(stopped, true)
  assert.equal(capture.blob(), null)
})

test('upload refuses unknown and empty MIME before any network request', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  try {
    const { uploadLocalRecording } = await vite.ssrLoadModule('/src/RecordingStudio.jsx')
    let requests = 0
    for (const type of ['', 'video/webm', 'audio/webm;codecs=vp9', 'application/x-meeting-prototype-fixture']) {
      await assert.rejects(uploadLocalRecording({ blob: new Blob(['audio'], { type }), leaseId: 'lease', fetchImpl: () => { requests += 1 } }), /unsupported or missing audio format/)
    }
    assert.equal(requests, 0)
  } finally { await vite.close() }
})

test("privacy access allowlists classification labels before preserving an authorized response", () => {
  const baseline = {
    access: { authorized: true, posture: "participant" },
    classification: { classification: "legal-privileged", confidentiality: "never-record", recordingProhibited: true },
    retention: { state: "active", deletion: "not-requested" },
    auditTimeline: [],
  }

  assert.equal(sanitizePrivacyAccess(baseline)?.classification.classification, "legal-privileged")
  assert.equal(
    sanitizePrivacyAccess({
      ...baseline,
      classification: { ...baseline.classification, classification: "LEGAL-PRIVILEGED-INVESTIGATION-ALPHA" },
    })?.classification.classification,
    "redacted",
  )
})

test("Teams readiness retains only non-secret configuration flags and a disconnected posture", () => {
  const readiness = sanitizeTeamsReadiness({
    integration: "microsoft-teams",
    status: "administrator-setup-required",
    connection: "not-connected",
    oauth: {
      mode: "server-side-entra-authorization-code-pkce",
      clientIdConfigured: true,
      tenantConfigured: false,
      redirectUriConfigured: true,
      secretsAcceptedHere: false,
      clientId: "ENTRA-CLIENT-ID-CANARY",
      clientSecret: "ENTRA-SECRET-CANARY",
    },
    capabilities: {
      meetingMetadata: false,
      cloudRecordingImport: false,
      liveBotCapture: false,
      changeNotificationIngestion: false,
    },
  })

  assert.deepEqual(readiness, {
    status: "administrator-setup-required",
    clientIdConfigured: true,
    tenantConfigured: false,
    redirectUriConfigured: true,
  })
  assert.equal(JSON.stringify(readiness).includes("CANARY"), false)
})

test("commitment client preserves only strict authorized action fields and source citations", () => {
  const canary = "PROCESSOR-METADATA-CANARY"
  const result = sanitizeCommitments({
    commitments: [{
      id: "commitment:assertion-1",
      meetingId: "meeting-1",
      text: "Complete the security review before the January release.",
      ownerId: "alex",
      deadline: "2026-10-15T17:00:00-04:00",
      status: "open",
      source: { assertionId: "assertion-1", citations: ["recording-1-s2"], processor: canary },
      processorMetadata: { canary },
    }],
  })

  assert.deepEqual(result, {
    commitments: [{
      id: "commitment:assertion-1",
      meetingId: "meeting-1",
      text: "Complete the security review before the January release.",
      ownerId: "alex",
      deadline: "2026-10-15T21:00:00.000Z",
      status: "open",
      source: { assertionId: "assertion-1", citations: ["recording-1-s2"] },
    }],
  })
  assert.equal(JSON.stringify(result).includes(canary), false)
})

test("commitment client drops malformed rows and bounds outbound query text", () => {
  assert.deepEqual(sanitizeCommitments({
    commitments: [
      { id: "commitment:bad", meetingId: "meeting-1", text: "Bad status", ownerId: null, deadline: null, status: "unknown", source: { assertionId: "a", citations: ["s1"] } },
      { id: "commitment:bad-citation", meetingId: "meeting-1", text: "Bad source", ownerId: null, deadline: null, status: "open", source: { assertionId: "a", citations: ["bad citation"] } },
    ],
  }), { commitments: [] })
  assert.equal(sanitizeCommitmentQuery("  security\u0000 review  "), "security review")
  assert.equal(sanitizeCommitmentQuery("x".repeat(200)).length, 120)
})

test("commitment evidence opens only when every citation belongs to the current authorized transcript", () => {
  const valid = currentRecordEvidence("meeting-1", ["recording-1-s1", "recording-1-s2"])
  assert.deepEqual(valid, ["recording-1-s1", "recording-1-s2"])

  const foreignCanary = "foreign-private-recording-s9-CITATION-CANARY"
  assert.equal(currentRecordEvidence("meeting-1", ["recording-1-s2", foreignCanary]), null)
  assert.equal(currentRecordEvidence("meeting-2", ["recording-1-s2"]), null)
  assert.equal(currentRecordEvidence("meeting-1", []), null)
})

test("commitment citations reject hostile array traps and never rewrite a canary into authorized evidence", () => {
  const canary = "foreign-private-recording-s9-CITATION-CANARY"
  const hostileCitations = new Proxy([canary], {
    get(target, key, receiver) {
      if (key === "map" || key === "filter") return () => ["recording-1-s2"]
      return Reflect.get(target, key, receiver)
    },
  })
  const payload = {
    commitments: [{
      id: "commitment:proxy-citation",
      meetingId: "meeting-1",
      text: "Do not render untrusted citation evidence.",
      ownerId: null,
      deadline: null,
      status: "open",
      source: { assertionId: "assertion-1", citations: hostileCitations },
    }],
  }

  assert.equal(sanitizeCommitments(payload), null)
  assert.equal(currentRecordEvidence("meeting-1", hostileCitations), null)
  assert.equal(JSON.stringify(sanitizeCommitments(payload)).includes(canary), false)
})

test("citation arrays require ordinary dense string data properties with no extras", () => {
  const valid = ["recording-1-s1", "recording-1-s2"]
  assert.deepEqual(currentRecordEvidence("meeting-1", valid), valid)

  const accessor = ["recording-1-s1"]
  Object.defineProperty(accessor, "0", { get: () => "recording-1-s2", enumerable: true, configurable: true })
  const extra = ["recording-1-s1"]
  extra.map = () => ["recording-1-s2"]
  const symbol = ["recording-1-s1"]
  symbol[Symbol("citation")] = "recording-1-s2"
  const sparse = new Array(1)
  const foreignPrototype = ["recording-1-s1"]
  Object.setPrototypeOf(foreignPrototype, null)

  for (const citations of [accessor, extra, symbol, sparse, foreignPrototype]) {
    assert.equal(currentRecordEvidence("meeting-1", citations), null)
  }
})

test("commitment collection does not traverse a caller-controlled array map or filter", () => {
  const hostileRows = new Proxy([], {
    get(target, key, receiver) {
      if (key === "map" || key === "filter") return () => [{ id: "commitment:forged" }]
      return Reflect.get(target, key, receiver)
    },
  })
  assert.equal(sanitizeCommitments({ commitments: hostileRows }), null)
})

test("management briefing client retains only bounded canonical categories and drops processor metadata", () => {
  const canary = "processor-provenance-must-not-render"
  const payload = {
    briefing: {
      counts: { decisions: 1, risks: 1, blockers: 0, openActions: 1 },
      decisions: [{
        id: "decision-1",
        text: "Approve the limited release.",
        source: { meetingId: "meeting-1", assertionId: "assertion-1", citations: ["recording-1-s1"] },
        processor: canary,
      }],
      risks: [{
        id: "risk-1",
        text: "Security review remains a launch risk.",
        source: { meetingId: "meeting-1", assertionId: "assertion-2", citations: ["recording-1-s2"] },
      }],
      blockers: [],
      actions: [{
        id: "action-1",
        text: "Confirm the security review date.",
        ownerId: "alex",
        deadline: "2026-10-14T00:00:00.000Z",
        status: "blocked",
        source: { meetingId: "meeting-1", assertionId: "assertion-3", citations: ["recording-1-s3"] },
      }],
    },
  }
  const droppedCanary = sanitizeManagementBriefing(JSON.stringify(payload))
  assert.deepEqual(droppedCanary?.briefing.decisions, [])
  assert.equal(JSON.stringify(droppedCanary).includes(canary), false)

  delete payload.briefing.decisions[0].processor
  const result = sanitizeManagementBriefing(JSON.stringify(payload))
  assert.deepEqual(result?.briefing.decisions[0], {
    id: "decision-1",
    text: "Approve the limited release.",
    source: { meetingId: "meeting-1", assertionId: "assertion-1", citations: ["recording-1-s1"] },
  })
  assert.equal(JSON.stringify(result).includes(canary), false)
})

test("management briefing rejects hostile structures and never turns foreign sources into local evidence", () => {
  const hostileCitations = ["recording-1-s1"]
  Object.defineProperty(hostileCitations, "0", { get: () => "recording-1-s1", enumerable: true, configurable: true })
  const hostile = {
    briefing: {
      counts: { decisions: 0, risks: 0, blockers: 0, openActions: 0 },
      decisions: [], risks: [], blockers: [], actions: [],
    },
  }
  hostile.briefing.risks = [{
    id: "risk-hostile", text: "Do not read this.",
    source: { meetingId: "meeting-1", assertionId: "assertion-hostile", citations: hostileCitations },
  }]
  // Objects are not a trusted response format. They are rejected before this
  // hostile nested graph can be inspected.
  const droppedHostile = sanitizeManagementBriefing(hostile)
  assert.equal(droppedHostile, null)

  const foreign = sanitizeManagementBriefing(JSON.stringify({
    briefing: {
      counts: { decisions: 0, risks: 1, blockers: 0, openActions: 0 },
      decisions: [], blockers: [], actions: [],
      risks: [{ id: "risk-foreign", text: "Visible only as a scoped item.", source: { meetingId: "meeting-other", assertionId: "assertion-foreign", citations: ["recording-1-s1"] } }],
    },
  }))
  assert.ok(foreign)
  assert.equal(currentRecordEvidence(foreign.briefing.risks[0].source.meetingId, foreign.briefing.risks[0].source.citations), null)
})

test("management briefing rejects object graphs before invoking nested response accessors", () => {
  const counts = { source: 0, category: 0, commitment: 0 }
  const normalSource = () => ({ meetingId: "meeting-1", assertionId: "assertion-1", citations: ["recording-1-s1"] })
  const sourceAccessor = normalSource()
  Object.defineProperty(sourceAccessor, "citations", {
    enumerable: true, configurable: true,
    get() { counts.source += 1; return ["accessor-canary"] },
  })
  const category = []
  Object.defineProperty(category, "0", {
    enumerable: true, configurable: true,
    get() { counts.category += 1; return { id: "category-canary" } },
  })
  const commitmentAccessor = { id: "action-1", text: "Never read this", ownerId: null, deadline: null, status: "open", source: normalSource() }
  Object.defineProperty(commitmentAccessor, "source", {
    enumerable: true, configurable: true,
    get() { counts.commitment += 1; return normalSource() },
  })

  const payload = ({ decisions = [], actions = [] } = {}) => ({
    briefing: {
      counts: { decisions: 0, risks: 0, blockers: 0, openActions: 1 },
      decisions, risks: [], blockers: [], actions,
    },
  })
  const results = [
    sanitizeManagementBriefing(payload({ actions: [{ id: "action-1", text: "Never read this", ownerId: null, deadline: null, status: "open", source: sourceAccessor }] })),
    sanitizeManagementBriefing(payload({ decisions: category })),
    sanitizeManagementBriefing(payload({ actions: [commitmentAccessor] })),
  ]
  assert.deepEqual(results, [null, null, null])
  assert.deepEqual(counts, { source: 0, category: 0, commitment: 0 })
  assert.equal(JSON.stringify(results).includes("canary"), false)
})

test("management briefing rejects Proxy graphs without invoking any traps", () => {
  const trapCounts = { envelope: 0, category: 0, item: 0, source: 0, citations: 0 }
  const traps = (name) => new Proxy({}, {
    get(target, key, receiver) { trapCounts[name] += 1; return Reflect.get(target, key, receiver) },
    getPrototypeOf(target) { trapCounts[name] += 1; return Reflect.getPrototypeOf(target) },
    getOwnPropertyDescriptor(target, key) { trapCounts[name] += 1; return Reflect.getOwnPropertyDescriptor(target, key) },
    ownKeys(target) { trapCounts[name] += 1; return Reflect.ownKeys(target) },
    has(target, key) { trapCounts[name] += 1; return Reflect.has(target, key) },
  })
  const citations = new Proxy(["recording-1-s1"], traps("citations"))
  const source = new Proxy({ meetingId: "meeting-1", assertionId: "assertion-1", citations }, traps("source"))
  const item = new Proxy({ id: "decision-1", text: "Never inspect this", source }, traps("item"))
  const category = new Proxy([item], traps("category"))
  const envelope = new Proxy({
    briefing: {
      counts: { decisions: 1, risks: 0, blockers: 0, openActions: 0 },
      decisions: category, risks: [], blockers: [], actions: [],
    },
  }, traps("envelope"))

  assert.equal(sanitizeManagementBriefing(envelope), null)
  assert.deepEqual(trapCounts, { envelope: 0, category: 0, item: 0, source: 0, citations: 0 })
})

test("management briefing parses raw JSON and loader uses the text boundary", async () => {
  const rawJson = JSON.stringify({
    briefing: {
      counts: { decisions: 1, risks: 0, blockers: 0, openActions: 0 },
      decisions: [{
        id: "decision-1", text: "Approve the limited release.",
        source: { meetingId: "meeting-1", assertionId: "assertion-1", citations: ["recording-1-s1"] },
      }],
      risks: [], blockers: [], actions: [],
    },
  })
  const parsed = sanitizeManagementBriefing(rawJson)
  assert.equal(parsed?.briefing.decisions[0]?.id, "decision-1")
  assert.equal(sanitizeManagementBriefing("{ malformed"), null)

  let textCalls = 0
  const result = await loadManagementBriefing({
    correlationId: "corr-briefing-1",
    fetchImpl: async () => ({
      ok: true,
      text: async () => { textCalls += 1; return rawJson },
      json: async () => { throw new Error("response.json must not be called") },
    }),
  })
  assert.equal(textCalls, 1)
  assert.equal(result.status, "authorized")
  assert.equal(result.data.briefing.decisions[0].id, "decision-1")
})

test("recording reducer follows consent-gated happy path", () => {
  let state = recordingReducer(initialRecordingState, { type: "OPEN" })
  assert.equal(state.phase, "preflighting")
  state = recordingReducer(state, { type: "PREFLIGHT_NEEDS_CONSENT" })
  state = recordingReducer(state, { type: "CONSENT_UPDATED", participantId: "alex", decision: "granted" })
  state = recordingReducer(state, { type: "PREFLIGHT_AUTHORIZED", leaseId: "lease-1", authorizationExpiresAt: "2026-09-30T13:00:00Z" })
  state = recordingReducer(state, { type: "MICROPHONE_READY" })
  state = recordingReducer(state, { type: "START" })
  state = recordingReducer(state, { type: "STOP" })
  assert.equal(state.phase, "stopped")
  assert.equal(state.stopReason, "user")
})

test("processing state machine exposes hash, upload, queue, progress, and completion",()=>{let state={...initialRecordingState,phase:"stopped",leaseId:"lease-1"};state=recordingReducer(state,{type:"PROCESS_CONFIRM"});assert.equal(state.phase,"hashing");state=recordingReducer(state,{type:"UPLOAD_CREATED",recordingId:"rec-1"});assert.equal(state.phase,"uploading");state=recordingReducer(state,{type:"UPLOAD_COMPLETE"});assert.equal(state.phase,"queued");state=recordingReducer(state,{type:"PROCESS_STATUS",state:"processing",progress:65});assert.equal(state.progress,65);state=recordingReducer(state,{type:"PROCESS_STATUS",state:"completed",progress:100,result:{segments:[]}});assert.equal(state.phase,"completed")})

test("local processing hashes then creates, uploads, and starts exactly once", async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" })
  try {
    const { uploadLocalRecording } = await vite.ssrLoadModule("/src/RecordingStudio.jsx")
    globalThis.crypto ??= webcrypto
    const calls = []
    const stages = []
    const responses = [
      new Response(JSON.stringify({ recordingId: "rec-1", uploadRoute: "/upload" }), { status: 201, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ state: "uploaded" }), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ state: "queued" }), { status: 202, headers: { "content-type": "application/json" } }),
    ]
    const blob = new Blob(["audio"], { type: "audio/webm;codecs=opus" })
    const id = await uploadLocalRecording({
      blob,
      leaseId: "lease-1",
      fetchImpl: async (url, options) => {
        calls.push({ url, options })
        return responses.shift()
      },
      onCreated: (recordingId) => stages.push({ stage: "created", recordingId, callCount: calls.length }),
      onQueued: (recordingId) => stages.push({ stage: "queued", recordingId, callCount: calls.length }),
    })
    assert.equal(id, "rec-1")
    assert.equal(calls.length, 3)
    assert.deepEqual(stages, [
      { stage: "created", recordingId: "rec-1", callCount: 1 },
      { stage: "queued", recordingId: "rec-1", callCount: 3 },
    ])
    const metadata = JSON.parse(calls[0].options.body)
    assert.equal(metadata.leaseId, "lease-1")
    assert.equal(metadata.contentType, "audio/webm")
    assert.equal(calls[1].options.headers['content-type'], "audio/webm")
    assert.match(metadata.sha256, /^[0-9a-f]{64}$/)
    assert.equal(calls[1].options.body, blob)
  } finally {
    await vite.close()
  }
})

test("discard and policy-stop transitions never enter upload phases",()=>{for(const action of [{type:"DISCARD"},{type:"POLICY_STOP",reason:"withdrawn"}]){const state=recordingReducer({...initialRecordingState,phase:"recording",leaseId:"lease"},action);assert.ok(["discarded","policy-stopped"].includes(state.phase));assert.equal(["hashing","uploading","queued","processing"].includes(state.phase),false)}})

test("policy stop and discard are explicit irreversible states", () => {
  const active = { ...initialRecordingState, phase: "recording" }
  assert.deepEqual(recordingReducer(active, { type: "POLICY_STOP", reason: "Consent withdrawn" }), { ...active, phase: "policy-stopped", stopReason: "Consent withdrawn" })
  const discarded = recordingReducer(active, { type: "DISCARD" })
  assert.equal(discarded.phase, "discarded")
  assert.equal(discarded.authorizationExpiresAt, null)
})

test("object URL cleanup only revokes present URLs", () => {
  const revoked = []
  revokeRecordingUrl(null, (url) => revoked.push(url))
  revokeRecordingUrl("blob:meeting-audio", (url) => revoked.push(url))
  assert.deepEqual(revoked, ["blob:meeting-audio"])
})

function mediaHarness() {
  const events = []
  const track = { stop: () => events.push("track:stop") }
  class FakeRecorder {
    constructor() { this.state = "inactive"; this.mimeType = "audio/webm" }
    start(interval) { this.state = "recording"; events.push(`recorder:start:${interval}`) }
    stop() {
      events.push("recorder:stop")
      this.ondataavailable?.({ data: { size: 8, bytes: "audio", type: "audio/webm" } })
      this.state = "inactive"
      this.onstop?.()
    }
  }
  const urls = []
  const capture = createMediaCapture({
    MediaRecorderClass: FakeRecorder,
    BlobClass: class FakeBlob { constructor(parts, options) { this.parts = parts; this.type = options.type } },
    createObjectURL: () => "blob:local-audio",
    revokeObjectURL: (url) => events.push(`url:revoke:${url}`),
    onAudioUrl: (url) => urls.push(url),
  })
  capture.connect({ getTracks: () => [track] })
  return { capture, events, urls }
}

test("user stop ends device capture but preserves local playback", () => {
  const { capture, events, urls } = mediaHarness()
  capture.start()
  capture.stop()
  assert.equal(capture.snapshot().audioUrl, "blob:local-audio")
  assert.deepEqual(urls, [null, "blob:local-audio"])
  assert.deepEqual(events, ["recorder:start:1000", "recorder:stop", "track:stop"])
})

test("policy stop clears chunks, stops tracks, and never creates playback", () => {
  const { capture, events, urls } = mediaHarness()
  capture.start()
  capture.stop({ discard: true })
  assert.deepEqual(capture.snapshot(), { stream: null, recorder: null, chunks: [], audioUrl: null })
  assert.deepEqual(urls, [null, null])
  assert.deepEqual(events, ["recorder:start:1000", "recorder:stop", "track:stop"])
})

test("discard revokes an existing playback URL and cleanup is idempotent", () => {
  const { capture, events } = mediaHarness()
  capture.start()
  capture.stop()
  capture.discard()
  capture.dispose()
  assert.equal(events.filter((event) => event === "url:revoke:blob:local-audio").length, 1)
  assert.deepEqual(capture.snapshot(), { stream: null, recorder: null, chunks: [], audioUrl: null })
})

test("late microphone resolution after unmount stops every track without retaining capture", async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" })
  try {
    const { acquireMicrophone } = await vite.ssrLoadModule("/src/RecordingStudio.jsx")
    let resolveMicrophone
    const pendingMicrophone = new Promise((resolve) => { resolveMicrophone = resolve })
    const events = []
    const audioUrls = []
    const capture = createMediaCapture({
      MediaRecorderClass: class FakeRecorder {
        constructor() { events.push("recorder:connected") }
        start() { events.push("recorder:started") }
      },
      createObjectURL: () => {
        events.push("url:created")
        return "blob:late-audio"
      },
      onAudioUrl: (url) => audioUrls.push(url),
    })
    let mounted = true
    let ready = false
    const request = acquireMicrophone({
      getUserMedia: () => pendingMicrophone,
      isActive: () => mounted,
      authorizationExpiresAt: "2999-01-01T00:00:00Z",
      onStream: (stream) => capture.connect(stream),
      onReady: () => {
        ready = true
        capture.start()
      },
      onError: (error) => { throw error },
    })

    mounted = false
    resolveMicrophone({
      getTracks: () => [
        { stop: () => events.push("track:one:stopped") },
        { stop: () => events.push("track:two:stopped") },
      ],
    })
    await request

    assert.deepEqual(events, ["track:one:stopped", "track:two:stopped"])
    assert.equal(ready, false)
    assert.deepEqual(audioUrls, [])
    assert.deepEqual(capture.snapshot(), { stream: null, recorder: null, chunks: [], audioUrl: null })
  } finally {
    await vite.close()
  }
})

test("late microphone rejection after unmount suppresses stale errors and settles cleanly", async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" })
  try {
    const { acquireMicrophone } = await vite.ssrLoadModule("/src/RecordingStudio.jsx")
    let rejectMicrophone
    const pendingMicrophone = new Promise((resolve, reject) => { rejectMicrophone = reject })
    const events = []
    const audioUrls = []
    const capture = createMediaCapture({
      MediaRecorderClass: class FakeRecorder {
        constructor() { events.push("recorder:connected") }
        start() { events.push("recorder:started") }
      },
      createObjectURL: () => {
        events.push("url:created")
        return "blob:late-audio"
      },
      onAudioUrl: (url) => audioUrls.push(url),
    })
    let mounted = true
    let ready = false
    let reportedError = null
    const request = acquireMicrophone({
      getUserMedia: () => pendingMicrophone,
      isActive: () => mounted,
      authorizationExpiresAt: "2999-01-01T00:00:00Z",
      onStream: (stream) => capture.connect(stream),
      onReady: () => {
        ready = true
        capture.start()
      },
      onError: (error) => { reportedError = error },
    })

    mounted = false
    rejectMicrophone(new DOMException("Permission denied", "NotAllowedError"))
    await assert.doesNotReject(request)

    assert.equal(reportedError, null)
    assert.equal(ready, false)
    assert.deepEqual(events, [])
    assert.deepEqual(audioUrls, [])
    assert.deepEqual(capture.snapshot(), { stream: null, recorder: null, chunks: [], audioUrl: null })
  } finally {
    await vite.close()
  }
})

test("Strict Mode replay and overlapping microphone requests retain only the active generation", async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" })
  try {
    const { acquireMicrophone } = await vite.ssrLoadModule("/src/RecordingStudio.jsx")
    const resolvers = []
    const events = []
    let mediaRequestCount = 0
    let activeGeneration = 2
    let retainedStream = null
    let readyCount = 0
    const start = (generation) => acquireMicrophone({
      getUserMedia: () => {
        mediaRequestCount += 1
        return new Promise((resolve) => resolvers.push(resolve))
      },
      isActive: () => activeGeneration === generation,
      authorizationExpiresAt: "2999-01-01T00:00:00Z",
      onStream: (stream) => {
        if (retainedStream) return false
        retainedStream = stream
        return true
      },
      onReady: () => { readyCount += 1 },
      onExpired: () => { throw new Error("unexpected expiry") },
      onError: (error) => { throw error },
    })

    await start(1)
    assert.equal(mediaRequestCount, 0, "a replayed stale setup must not request media")

    const staleRequest = start(2)
    activeGeneration = 3
    const activeRequest = start(3)
    const staleStream = { getTracks: () => [{ stop: () => events.push("stale:stopped") }] }
    const activeStream = { getTracks: () => [{ stop: () => events.push("active:stopped") }] }
    resolvers[0](staleStream)
    resolvers[1](activeStream)
    await Promise.all([staleRequest, activeRequest])

    assert.deepEqual(events, ["stale:stopped"])
    assert.equal(mediaRequestCount, 2)
    assert.equal(retainedStream, activeStream)
    assert.equal(readyCount, 1)
  } finally {
    await vite.close()
  }
})

test("authorization expiry while permission is pending stops tracks and retains no recorder or URL", async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" })
  try {
    const { acquireMicrophone } = await vite.ssrLoadModule("/src/RecordingStudio.jsx")
    let resolveMicrophone
    let clock = Date.parse("2026-10-01T12:00:00Z")
    const events = []
    const urls = []
    const capture = createMediaCapture({
      MediaRecorderClass: class FakeRecorder { constructor() { events.push("recorder:connected") } },
      createObjectURL: () => { events.push("url:created"); return "blob:expired" },
      onAudioUrl: (url) => urls.push(url),
    })
    let expired = false
    const request = acquireMicrophone({
      getUserMedia: () => new Promise((resolve) => { resolveMicrophone = resolve }),
      isActive: () => true,
      authorizationExpiresAt: "2026-10-01T12:00:01Z",
      now: () => clock,
      onStream: (stream) => capture.connect(stream),
      onReady: () => { throw new Error("expired lease became ready") },
      onExpired: () => { expired = true; capture.stop({ discard: true }) },
      onError: (error) => { throw error },
    })

    clock += 2_000
    resolveMicrophone({ getTracks: () => [{ stop: () => events.push("expired:stopped") }] })
    await request

    assert.equal(expired, true)
    assert.deepEqual(events, ["expired:stopped"])
    assert.deepEqual(urls, [null])
    assert.deepEqual(capture.snapshot(), { stream: null, recorder: null, chunks: [], audioUrl: null })
  } finally {
    await vite.close()
  }
})
