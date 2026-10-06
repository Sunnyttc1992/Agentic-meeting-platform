import { useEffect, useReducer, useRef, useState } from "react"
import { ArrowLeft, Check, Microphone, Record, ShieldCheck, Stop, Trash, Warning, Waveform } from "@phosphor-icons/react"
import { initialRecordingState, recordingReducer } from "./recordingMachine.js"
import { createMediaCapture } from "./mediaCapture.js"
import { normalizeIngestMimeType, SPEECH_WAV_MIME_TYPE } from "./recordingFormats.js"
import { toSpeechWav } from "./audioTranscode.js"
import { downloadMeetingRecord } from "./meetingExport.js"

const MEETING_ID = "meeting-1"
// Leases stay short-lived; the studio renews one this long before it expires,
// and each renewal re-runs consent and policy checks on the server.
const LEASE_RENEWAL_LEAD_MS = 90_000
const LEASE_RENEWAL_RETRY_MS = 15_000
// Consent covers one meeting session, so a long meeting is not cut off mid-way.
const CONSENT_VALIDITY_MS = 4 * 60 * 60 * 1000
const TENANT_ID = "northstar"
const participants = [
  { id: "alex", name: "Alex Morgan", role: "Organizer" },
  { id: "sam", name: "Sam Rivera", role: "Participant" },
]
// The deterministic capture seam is deliberately restricted to an explicit
// loopback origin. A Vite dev server can be exposed on a LAN or remote host,
// so development mode is not an authorization boundary for mock media.
const loopbackHost = (hostname) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
export function browserMockEnabled({
  search = typeof window === "undefined" ? "" : window.location.search,
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
} = {}) {
  return loopbackHost(hostname) && new URLSearchParams(search).get("mockMedia") === "1"
}
// Mock capture deliberately carries a non-audio, explicitly synthetic MIME
// type. Do not disguise placeholder bytes as WebM/Ogg: an audio control may
// fail late and an uploader could persist invalid media. The capture module
// recognises this exact fixture only when the loopback-only mock switch made
// the caller opt in, and it never creates a playback URL for it.
const DEVELOPMENT_SYNTHETIC_FIXTURE_TYPE = "application/x-meeting-prototype-fixture"
export function createDevelopmentSyntheticFixture(BlobClass = Blob) {
  return new BlobClass(["local deterministic meeting fixture; not audio"], { type: DEVELOPMENT_SYNTHETIC_FIXTURE_TYPE })
}

// This copy is deliberately kept separate from the real-device language. A
// loopback mock exercises the consent and capture state machine only; it does
// not acquire a microphone, create audio, offer playback, or permit import.
// Keeping the distinction in one component makes it harder for a future UI
// tweak to accidentally describe test bytes as a real recording.
export function CaptureTruthfulCopy({ mode = "real", phase = "ready" }) {
  if (mode === "synthetic") {
    const copy = {
      ready: "Local synthetic test fixture. No microphone is connected and no audio can be captured, reviewed, or imported.",
      recording: "A local synthetic test fixture is running. No microphone input exists and no audio exists; playback and import are unavailable.",
      stopped: "Local synthetic test fixture complete. No microphone is used and no audio exists; playback, upload, processing, and import are unavailable.",
    }[phase]
    return <p className="fixture-copy" aria-live="polite">{copy}</p>
  }
  const copy = {
    ready: "Microphone connected. No audio has been captured yet.",
    recording: "Audio is held temporarily in this browser tab.",
    stopped: "Review first. Nothing leaves this tab until you explicitly confirm local processing.",
  }[phase]
  return <p>{copy}</p>
}
class DevelopmentMediaRecorder {
  static isSyntheticFixture = true
  constructor() { this.state="inactive"; this.mimeType=DEVELOPMENT_SYNTHETIC_FIXTURE_TYPE; this.isSyntheticFixture=true }
  start() { this.state="recording" }
  stop() { this.ondataavailable?.({ data: createDevelopmentSyntheticFixture() }); this.state="inactive"; this.onstop?.() }
}
const developmentStream = { getTracks:()=>[{stop(){}}] }

async function api(path, { userId = "alex", body = {} } = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": TENANT_ID,
      "x-user-id": userId,
      "x-correlation-id": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    const error = new Error(payload?.error?.message ?? "The request could not be completed.")
    error.code = payload?.error?.code
    throw error
  }
  return response.status === 204 ? null : response.json()
}

const authHeaders = (userId = "alex") => ({ "x-tenant-id": TENANT_ID, "x-user-id": userId, "x-correlation-id": crypto.randomUUID() })
export async function sha256Hex(blob, subtle = crypto.subtle) { return [...new Uint8Array(await subtle.digest("SHA-256", await blob.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, "0")).join("") }
export async function uploadLocalRecording({ blob, leaseId, fetchImpl = fetch, onCreated = () => {}, onQueued = () => {} }) {
  const contentType = normalizeIngestMimeType(blob.type)
  if (!contentType) throw new Error('This recording has an unsupported or missing audio format. Please record again using a supported browser.')
  const sha256 = await sha256Hex(blob)
  const createdResponse = await fetchImpl(`/meetings/${MEETING_ID}/recordings`, { method:"POST", headers:{...authHeaders(),"content-type":"application/json"}, body:JSON.stringify({leaseId,contentType,byteLength:blob.size,sha256}) })
  const created = await createdResponse.json(); if(!createdResponse.ok) throw Object.assign(new Error(created?.error?.message??"Could not create recording."),{code:created?.error?.code})
  onCreated(created.recordingId)
  const uploadResponse = await fetchImpl(created.uploadRoute,{method:"PUT",headers:{...authHeaders(),"content-type":contentType,"content-length":String(blob.size)},body:blob}); if(!uploadResponse.ok){const error=await uploadResponse.json();throw Object.assign(new Error(error?.error?.message??"Upload failed."),{code:error?.error?.code})}
  const startResponse = await fetchImpl(`/meetings/${MEETING_ID}/recordings/${created.recordingId}/process`,{method:"POST",headers:{...authHeaders(),"content-type":"application/json"},body:"{}"}); if(!startResponse.ok){const error=await startResponse.json();throw Object.assign(new Error(error?.error?.message??"Processing failed to start."),{code:error?.error?.code})}
  onQueued(created.recordingId)
  return created.recordingId
}

const displayTime = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`

const PROCESSOR_COPY = {
  "local-deterministic-fake": { label: "LOCAL DETERMINISTIC PROCESSOR" },
  "local-whisper-claude": { label: "LOCAL WHISPER · CLAUDE" },
  "local-whisper-openai": { label: "LOCAL WHISPER · OPENAI" },
  "local-whisper-transcript-only": { label: "LOCAL WHISPER" },
  "local-whisper-pyannote-claude": { label: "LOCAL WHISPER · PYANNOTE · CLAUDE" },
  "local-whisper-pyannote-openai": { label: "LOCAL WHISPER · PYANNOTE · OPENAI" },
  "local-whisper-pyannote-transcript-only": { label: "LOCAL WHISPER · PYANNOTE" },
}
const TRANSCRIPT_ONLY_MODES = new Set(["local-whisper-transcript-only", "local-whisper-pyannote-transcript-only"])
const participantName = (id) => participants.find((person) => person.id === id)?.name ?? id
// An owner is shown only when the meeting named a participant; otherwise the
// anonymous label of the speaker who took the task on, marked unverified.
const actionOwner = (commitment) => commitment?.ownerId
  ? participantName(commitment.ownerId)
  : commitment?.speakerLabel ? `${commitment.speakerLabel} · unverified` : "Unassigned"
const AGREEMENT_LABELS = { committed: "Committed", proposed: "Proposed" }
const dueDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Not stated"

// Every generated item shows the transcript moments it cites. Items the
// platform could not tie to this transcript were withheld before storage.
export function MeetingIntelligenceResult({ result, onDownload = null }) {
  const segments = result?.segments ?? []
  const assertions = result?.assertions ?? []
  const mode = segments[0]?.provenance?.mode ?? assertions[0]?.provenance?.mode
  const label = PROCESSOR_COPY[mode]?.label ?? "SPEECH PROCESSOR"
  const times = new Map(segments.map((segment) => [segment.id, displayTime(Math.floor(segment.startMs / 1000))]))
  const sources = (citations) => citations.map((id) => times.get(id)).filter(Boolean).join(", ")
  const ofKind = (kind) => assertions.filter((assertion) => assertion.kind === kind)
  const summary = ofKind("summary")[0]
  const actions = ofKind("action")
  const withheld = result?.recording?.withheldAssertions ?? 0
  return <div className="processing-complete" data-processor-mode={mode ?? "unknown"}>
    <p className="stage-index">{label} · COMPLETE</p>
    <h2>{TRANSCRIPT_ONLY_MODES.has(mode) ? "Meeting transcript" : "Cited meeting intelligence"}</h2>
    {onDownload && segments.length > 0 && <button className="copper-button result-download" onClick={onDownload}>Download meeting record</button>}
    {TRANSCRIPT_ONLY_MODES.has(mode) && <p className="intelligence-note">Summary and action plan are not configured on this server. Set <code>OPENAI_API_KEY</code> or <code>ANTHROPIC_API_KEY</code> and restart it to generate them.</p>}
    {segments.length === 0 && <p className="intelligence-note">No speech was recognized in this recording.</p>}
    {withheld > 0 && <p className="intelligence-note">{withheld} generated {withheld === 1 ? "item was" : "items were"} withheld because {withheld === 1 ? "it" : "they"} could not be tied to this transcript.</p>}
    {summary && <section className="intelligence-summary"><span>Executive summary</span><p>{summary.text}</p><small>Sources {sources(summary.citations)}</small></section>}
    {actions.length > 0 && <section className="action-plan"><span>Action plan</span>
      <div className="action-plan-table" role="table" aria-label="Action plan">
        <div role="row" className="action-plan-head"><span role="columnheader">Action</span><span role="columnheader">Status</span><span role="columnheader">Owner</span><span role="columnheader">Due</span><span role="columnheader">Source</span></div>
        {actions.map((action) => <div role="row" key={action.id}><b role="cell">{action.text}</b><span role="cell" className={`action-agreement ${action.commitment?.agreement ?? "unrecorded"}`}>{AGREEMENT_LABELS[action.commitment?.agreement] ?? "Not recorded"}</span><span role="cell">{actionOwner(action.commitment)}</span><span role="cell">{dueDate(action.commitment?.deadline)}</span><small role="cell">{sources(action.citations)}</small></div>)}
      </div>
      <small className="action-plan-note">Committed means someone agreed to the task; proposed means it was suggested but nobody took it on. Owners and due dates appear only when stated in the meeting. Speaker labels are anonymous and unverified.</small>
    </section>}
    {[["decision", "Decisions"], ["risk", "Risks & blockers"], ["question", "Open questions"], ["finding", "Findings"]].map(([kind, title]) => ofKind(kind).length > 0 && <div className="assertion-list" key={kind}>{ofKind(kind).map((assertion) => <article key={assertion.id}><span>{title}</span><b>{assertion.text}</b><small>Sources {sources(assertion.citations)}</small></article>)}</div>)}
    {segments.length > 0 && <details className="transcript-details" open={assertions.length === 0}><summary>Transcript · {segments.length} segments</summary><div className="speaker-timeline">{segments.map((segment) => <article key={segment.id}><time>{displayTime(Math.floor(segment.startMs / 1000))}</time><div><b>{segment.diarizationLabel === "UNATTRIBUTED" ? "Speaker not identified" : `${segment.diarizationLabel} · ${segment.verifiedParticipantId ?? "Unverified speaker"}`}</b>{Number.isFinite(segment.identityConfidence) && <small>Identity confidence {Math.round(segment.identityConfidence * 100)}% · {segment.provenance.mode}</small>}<p>{segment.text}</p></div></article>)}</div></details>}
  </div>
}

const stopStream = (stream) => stream.getTracks().forEach((track) => track.stop())

export async function acquireMicrophone({ getUserMedia, isActive, authorizationExpiresAt, now = Date.now, onStream, onReady, onExpired, onError }) {
  try {
    if (!isActive()) return
    const stream = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    if (!isActive()) {
      stopStream(stream)
      return
    }
    if (!authorizationExpiresAt || Date.parse(authorizationExpiresAt) <= now()) {
      stopStream(stream)
      onExpired()
      return
    }
    if (onStream(stream) === false) {
      stopStream(stream)
      return
    }
    onReady()
  } catch (error) {
    if (isActive()) onError(error)
  }
}

export function RecordingStudio({ onBack }) {
  const [state, dispatch] = useReducer(recordingReducer, initialRecordingState)
  const [elapsed, setElapsed] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const [audioUrl, setAudioUrl] = useState(null)
  const [syntheticFixture, setSyntheticFixture] = useState(false)
  const [processingResult, setProcessingResult] = useState(null)
  const mockMode = browserMockEnabled()
  // `STOP` changes the reducer phase before MediaRecorder's `onstop` callback
  // marks the fixture complete. Keep the mock posture truthfully synthetic in
  // that small transition window as well.
  const fixtureMode = mockMode || syntheticFixture
  const streamRef = useRef(null)
  const captureRef = useRef(null)
  const mountedRef = useRef(false)
  const requestGenerationRef = useRef(0)
  if (!captureRef.current) captureRef.current = createMediaCapture({
    MediaRecorderClass: mockMode ? DevelopmentMediaRecorder : window.MediaRecorder,
    allowSyntheticFixture: mockMode,
    onSyntheticFixture: setSyntheticFixture,
    onAudioUrl: setAudioUrl,
    onError: (error) => dispatch({ type: 'ERROR', error: error.message }),
  })

  const stopRecorder = (discard = false) => {
    captureRef.current.stop({ discard })
    streamRef.current = null
  }

  useEffect(() => {
    mountedRef.current = true
    const generation = ++requestGenerationRef.current
    dispatch({ type: "OPEN" })
    preflight(true, generation)
    return () => {
      mountedRef.current = false
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1
      captureRef.current.dispose()
      streamRef.current = null
    }
    // The workflow intentionally initializes once per mounted capture surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (state.phase !== "recording") return undefined
    const started = Date.now() - elapsed * 1000
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250)
    return () => clearInterval(timer)
  }, [state.phase])

  useEffect(() => {
    if (!state.authorizationExpiresAt) return undefined
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((Date.parse(state.authorizationExpiresAt) - Date.now()) / 1000))
      setRemaining(seconds)
      if (seconds === 0 && ["ready", "recording"].includes(state.phase)) {
        stopRecorder(true)
        dispatch({ type: "POLICY_STOP", reason: "Recording authorization expired" })
      }
    }
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [state.authorizationExpiresAt, state.phase])

  useEffect(() => {
    if (!state.authorizationExpiresAt || !["ready", "recording", "stopped"].includes(state.phase)) return undefined
    let cancelled = false
    let timer
    const attempt = async () => {
      try {
        const result = await api(`/meetings/${MEETING_ID}/recording/preflight`)
        if (!cancelled) dispatch({ type: "LEASE_RENEWED", leaseId: result.leaseId, authorizationExpiresAt: result.authorizationExpiresAt })
      } catch (error) {
        if (cancelled) return
        if (!error.code) {
          // Network trouble: keep retrying. If renewal never succeeds, the
          // expiry timer above still stops capture and clears the audio.
          timer = setTimeout(attempt, LEASE_RENEWAL_RETRY_MS)
          return
        }
        if (state.phase === "recording") stopRecorder(true)
        else captureRef.current.discard()
        dispatch({ type: "POLICY_STOP", reason: `Recording authorization was not renewed: ${error.message}` })
      }
    }
    timer = setTimeout(attempt, Math.max(0, Date.parse(state.authorizationExpiresAt) - Date.now() - LEASE_RENEWAL_LEAD_MS))
    return () => { cancelled = true; clearTimeout(timer) }
    // stopRecorder and the capture ref are stable for the mounted studio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.authorizationExpiresAt, state.phase])

  useEffect(() => {
    if (!state.recordingId || !["queued","processing"].includes(state.phase)) return undefined
    const timer=setInterval(async()=>{ try { const response=await fetch(`/meetings/${MEETING_ID}/recordings/${state.recordingId}`,{headers:authHeaders()}); if(response.status===429)return; const result=await response.json(); if(!response.ok) throw new Error(result?.error?.message); setProcessingResult(result); dispatch({type:"PROCESS_STATUS",state:result.recording.state,progress:result.recording.progress,result,error:result.recording.error}) } catch(error){dispatch({type:"ERROR",error:error.message})} },350)
    return()=>clearInterval(timer)
  },[state.recordingId,state.phase])

  async function preflight(initial = false, generation = ++requestGenerationRef.current) {
    const isActive = () => mountedRef.current && requestGenerationRef.current === generation
    dispatch({ type: "OPEN" })
    try {
      const result = await api(`/meetings/${MEETING_ID}/recording/preflight`)
      if (!isActive()) return
      dispatch({ type: "PREFLIGHT_AUTHORIZED", leaseId: result.leaseId, authorizationExpiresAt: result.authorizationExpiresAt, allowedMimeTypes: result.allowedMimeTypes })
      if (!isActive()) return
      await requestMicrophone(generation, result.authorizationExpiresAt)
    } catch (error) {
      if (!isActive()) return
      if (["CONSENT_REQUIRED", "CONSENT_NOT_GRANTED"].includes(error.code)) dispatch({ type: "PREFLIGHT_NEEDS_CONSENT" })
      else if (["NEVER_RECORD", "RETENTION_RESTRICTED"].includes(error.code)) dispatch({ type: "BLOCKED", error: error.message })
      else dispatch({ type: initial ? "PREFLIGHT_NEEDS_CONSENT" : "ERROR", error: error.message })
    }
  }

  async function requestMicrophone(generation, authorizationExpiresAt) {
    const isActive = () => mountedRef.current && requestGenerationRef.current === generation
    if (!isActive()) return
    if (!browserMockEnabled() && (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)) {
      if (isActive()) dispatch({ type: "ERROR", error: "This browser does not support microphone recording." })
      return
    }
    await acquireMicrophone({
      getUserMedia: (constraints) => mockMode ? Promise.resolve(developmentStream) : navigator.mediaDevices.getUserMedia(constraints),
      isActive,
      authorizationExpiresAt,
      onStream: (stream) => {
        if (!isActive() || streamRef.current) return false
        streamRef.current = stream
        captureRef.current.connect(stream)
        return true
      },
      onReady: () => dispatch({ type: "MICROPHONE_READY" }),
      onExpired: () => {
        if (!isActive()) return
        streamRef.current = null
        captureRef.current.stop({ discard: true })
        dispatch({ type: "POLICY_STOP", reason: "Recording authorization expired" })
      },
      onError: (error) => dispatch({ type: "ERROR", error: error.name === "NotAllowedError" ? "Microphone access was denied. Allow access in your browser, then try again." : error.message }),
    })
  }

  async function setConsent(participantId, decision) {
    try {
      const now = new Date()
      await api(`/meetings/${MEETING_ID}/consent`, {
        userId: participantId,
        body: { participantId, capturedAt: now.toISOString(), expiresAt: new Date(now.getTime() + CONSENT_VALIDITY_MS).toISOString(), policyVersion: "v1", decision, method: "explicit" },
      })
      if (!mountedRef.current) return
      dispatch({ type: "CONSENT_UPDATED", participantId, decision })
      if (decision !== "granted" && state.phase === "recording") {
        stopRecorder(true)
        dispatch({ type: "POLICY_STOP", reason: `${participants.find((person) => person.id === participantId)?.name} withdrew consent` })
      }
    } catch (error) {
      if (mountedRef.current) dispatch({ type: "ERROR", error: error.message })
    }
  }

  function startRecording() {
    setElapsed(0)
    setSyntheticFixture(false)
    try {
      captureRef.current.start()
      dispatch({ type: "START" })
    } catch (error) {
      stopRecorder(true)
      dispatch({ type: "ERROR", error: error.message })
    }
  }

  function userStop() {
    dispatch({ type: "STOP" })
    stopRecorder(false)
  }

  // The microphone stops and in-memory audio is discarded before any network
  // call, so a slow or failed request can never keep capture alive. The server
  // then records the boundary and revokes the authorization.
  async function sensitiveStop() {
    stopRecorder(true)
    const reason = "Stopped for a sensitive topic. The audio captured so far was discarded and cannot be uploaded."
    dispatch({ type: "POLICY_STOP", reason })
    try {
      await api(`/meetings/${MEETING_ID}/recording/stop`, { body: { reason: "sensitive-topic" } })
    } catch (error) {
      if (mountedRef.current) dispatch({ type: "POLICY_STOP", reason: `${reason} The server could not record the stop (${error.message}); the authorization still expires on its own.` })
    }
  }

  function discard() {
    captureRef.current.discard()
    streamRef.current = null
    dispatch({ type: "DISCARD" })
  }

  // The server decides whether a retry is allowed and re-checks consent and
  // policy before re-queueing; the studio only offers what status reports.
  async function retryProcessing() {
    try {
      const response = await fetch(`/meetings/${MEETING_ID}/recordings/${state.recordingId}/retry`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "{}" })
      const result = await response.json()
      if (!response.ok) throw Object.assign(new Error(result?.error?.message ?? "Retry could not start."), { code: result?.error?.code })
      dispatch({ type: "UPLOAD_COMPLETE" })
    } catch (error) {
      dispatch({ type: ["CONSENT_NOT_GRANTED", "CONSENT_EXPIRED", "RECORDING_POLICY_CHANGED", "RETENTION_RESTRICTED"].includes(error.code) ? "POLICY_STOP" : "ERROR", reason: error.message, error: error.message })
    }
  }

  async function processLocally() {
    let blob=captureRef.current.blob(); if(!blob||!state.leaseId)return
    const transcribes = state.allowedMimeTypes.includes(SPEECH_WAV_MIME_TYPE)
    if(!window.confirm(transcribes
      ? "Transcribe this recording?\n\nThe audio is converted and transcribed on this machine and is never sent elsewhere. If summaries are configured, the transcript text with anonymous speaker labels (not the audio or any voice data) is sent to the AI provider configured on this server (OpenAI or Anthropic's Claude) to write the summary and action plan."
      : "Upload this in-memory recording to the local development processor?"))return
    dispatch({type:"PROCESS_CONFIRM"})
    try {
      if (transcribes) blob = await toSpeechWav(blob)
      await uploadLocalRecording({
        blob,
        leaseId:state.leaseId,
        onCreated:(recordingId)=>dispatch({type:"UPLOAD_CREATED",recordingId}),
        onQueued:()=>dispatch({type:"UPLOAD_COMPLETE"}),
      })
    } catch(error){ dispatch({type:["RECORDING_LEASE_EXPIRED","CONSENT_NOT_GRANTED","RETENTION_RESTRICTED"].includes(error.code)?"POLICY_STOP":"ERROR",reason:error.message,error:error.message}) }
  }

  const awaitingConsent = state.phase === "awaiting-consent" || state.phase === "preflighting"
  return <main className="capture-shell">
    <header className="capture-nav">
      <button onClick={onBack} className="back-button"><ArrowLeft size={17} /> Executive ledger</button>
      <div className="capture-wordmark">NORTHSTAR / SECURE CAPTURE</div>
      <span className="dev-badge">DEVELOPMENT CAPTURE</span>
    </header>

    <section className="capture-hero">
      <div><p className="eyebrow">Q4 PRODUCT &amp; GO-TO-MARKET REVIEW</p><h1>Start a trusted record.</h1><p className="capture-intro">Consent and policy are checked before capture and re-checked while recording. After stopping, you choose whether to transcribe the recording and generate its summary and action plan.</p></div>
      <div className={`capture-status status-${state.phase}`} aria-live="polite"><i /> {state.phase.replaceAll("-", " ")}</div>
    </section>

    <section className="capture-grid">
      <div className="capture-stage">
        {awaitingConsent && <>
          <p className="stage-index">01 / CONSENT</p><h2>Every voice opts in.</h2>
          <p className="stage-copy">Each required participant must explicitly grant consent. A decline or withdrawal prevents capture.</p>
          <div className="participant-list">{participants.map((person) => <article key={person.id}>
            <div className="participant-avatar">{person.name.split(" ").map((part) => part[0]).join("")}</div>
            <div><b>{person.name}</b><small>{person.role} · required</small></div>
            <span className={`consent-state consent-${state.consents[person.id]}`}>{state.consents[person.id]}</span>
            <div className="consent-actions"><button onClick={() => setConsent(person.id, "granted")}><Check /> Grant</button><button onClick={() => setConsent(person.id, "declined")}>Decline</button></div>
          </article>)}</div>
          <button className="copper-button" disabled={!participants.every((person) => state.consents[person.id] === "granted")} onClick={() => preflight()}>Verify policy &amp; continue</button>
        </>}

        {state.phase === "requesting-microphone" && <div className="center-state"><Microphone size={38} /><p className="stage-index">02 / MICROPHONE</p><h2>Requesting device access…</h2><p>Policy authorization succeeded. Your browser will now ask which microphone to use.</p></div>}
        {state.phase === "ready" && <div className="center-state" data-capture-source={mockMode ? "synthetic-fixture" : "microphone"}><div className="mic-orbit">{mockMode ? <ShieldCheck size={40} /> : <Microphone size={40} />}</div><p className="stage-index">{mockMode ? "03 / SYNTHETIC TEST FIXTURE" : "03 / READY"}</p><h2>{mockMode ? "Synthetic fixture is ready." : "The room is ready."}</h2><CaptureTruthfulCopy mode={mockMode ? "synthetic" : "real"} phase="ready" /><button className="record-button" onClick={startRecording}><Record size={19} weight="fill" /> {mockMode ? "Run synthetic fixture" : "Begin recording"}</button></div>}
        {state.phase === "recording" && <div className="live-stage" data-capture-source={mockMode ? "synthetic-fixture" : "microphone"}><div className="live-pulse"><i /><span>{mockMode ? "SYNTHETIC TEST ACTIVE" : "RECORDING ACTIVE"}</span></div><div className="elapsed">{displayTime(elapsed)}</div><div className="signal" aria-label={mockMode ? "Synthetic fixture progress; no microphone input or audio" : "Microphone input active"} aria-hidden={mockMode ? "true" : undefined}>{[1,2,3,4,5,6,7,8,9,10,11,12].map((bar) => <i key={bar} style={{"--bar": `${20 + ((bar * 23) % 70)}%`}} />)}</div><CaptureTruthfulCopy mode={mockMode ? "synthetic" : "real"} phase="recording" /><button className="stop-button" onClick={userStop}><Stop size={18} weight="fill" /> {mockMode ? "Stop synthetic fixture" : "Stop recording"}</button></div>}
        {state.phase === "stopped" && <div className="center-state" data-capture-source={fixtureMode ? "synthetic-fixture" : "microphone"}><Check size={38} /><p className="stage-index">{fixtureMode ? "SYNTHETIC TEST COMPLETE" : "CAPTURE COMPLETE"}</p><h2>{fixtureMode ? "Synthetic fixture complete." : "Audio preserved locally."}</h2><CaptureTruthfulCopy mode={fixtureMode ? "synthetic" : "real"} phase="stopped" />{audioUrl && !fixtureMode && <audio className="audio-player" src={audioUrl} controls aria-label="Captured microphone audio review" />}<div className="capture-actions">{!fixtureMode && <button className="record-button" onClick={processLocally}><Waveform size={17}/> Process locally</button>}<button className="discard-button" onClick={discard}><Trash size={17} /> Discard permanently</button></div></div>}
        {["hashing","uploading","queued","processing"].includes(state.phase) && <div className="center-state"><Waveform size={40}/><p className="stage-index">{state.allowedMimeTypes.includes(SPEECH_WAV_MIME_TYPE) ? "LOCAL TRANSCRIPTION" : "LOCAL DETERMINISTIC PROCESSOR"}</p><h2>{state.phase === "hashing"?"Preparing and verifying audio…":state.phase === "uploading"?"Uploading to this machine's processor…":state.phase === "queued"?"Queued for processing…":state.allowedMimeTypes.includes(SPEECH_WAV_MIME_TYPE)?"Transcribing and summarizing…":"Building cited intelligence…"}</h2><div className="progress-track"><i style={{width:`${state.progress}%`}}/></div><p>{state.progress}% · {state.allowedMimeTypes.includes(SPEECH_WAV_MIME_TYPE) ? "speech is transcribed on this machine; long meetings take a few minutes" : "development fake, not real speech recognition or diarization"}</p></div>}
        {state.phase === "completed" && <MeetingIntelligenceResult result={processingResult} onDownload={async () => { const result = await downloadMeetingRecord({ meetingId: MEETING_ID }); if (!result.ok) window.alert(result.message) }} />}
        {state.phase === "failed" && <div className="center-state danger-state"><Warning size={42} /><p className="stage-index">PROCESSING FAILED</p><h2>The recording could not be processed.</h2><p>{processingResult?.recording?.retryAvailable ? "The audio is still held on this machine. You can try again; consent and policy are checked again first." : "The retry limit was reached or the audio is no longer available. Please record the meeting again."}</p>{processingResult?.recording?.retryAvailable ? <button className="copper-button" onClick={retryProcessing}>Retry processing</button> : <button className="copper-button" onClick={() => preflight()}>Start a new recording</button>}</div>}
        {state.phase === "discarded" && <div className="center-state"><ShieldCheck size={40} /><h2>Audio discarded.</h2><p>Microphone access ended and all in-memory chunks were cleared.</p><button className="copper-button" onClick={() => preflight()}>Start a new consent check</button></div>}
        {["blocked", "policy-stopped", "error"].includes(state.phase) && <div className="center-state danger-state"><Warning size={42} /><p className="stage-index">CAPTURE STOPPED</p><h2>{state.phase === "blocked" ? "Policy prevents recording." : "Recording cannot continue."}</h2><p>{state.error || state.stopReason}</p>{state.phase === "error" && <button className="copper-button" onClick={() => preflight()}>Try again</button>}</div>}
      </div>

      <aside className="capture-rail">
        <p className="eyebrow">TRUST CONTROLS</p>
        <dl><div><dt>Meeting policy</dt><dd><ShieldCheck /> Preflight enforced</dd></div><div><dt>{mockMode ? "Capture source" : "Microphone"}</dt><dd><Microphone aria-hidden="true" /> {mockMode ? "Synthetic fixture · no microphone/audio" : streamRef.current ? "Connected" : "Not active"}</dd></div><div><dt>Authorization lease</dt><dd>{state.authorizationExpiresAt ? `${displayTime(remaining)} remaining` : "Not issued"}</dd></div><div><dt>Storage</dt><dd>{mockMode ? "No audio retained" : "In-memory only"}</dd></div></dl>
        {state.phase === "recording" && <div className="withdraw-box sensitive-box"><b>Topic turned sensitive?</b><p>Stop now. The audio captured so far is discarded, the stop time is recorded, and capture can resume only after a new policy check.</p><button onClick={sensitiveStop}>Stop and discard: sensitive topic</button></div>}
        {state.phase === "recording" && <div className="withdraw-box"><b>Consent changed?</b><p>Any participant can withdraw. Capture stops immediately and audio is cleared.</p>{participants.map((person) => <button key={person.id} onClick={() => setConsent(person.id, "withdrawn")}>Withdraw for {person.name}</button>)}</div>}
        <small>{state.allowedMimeTypes.includes(SPEECH_WAV_MIME_TYPE) ? "Audio is transcribed on this machine by Whisper and never leaves it. When configured, only the transcript text and anonymous speaker labels are sent to the configured AI provider (OpenAI or Claude) to write the cited summary and action plan." : "Local deterministic processor is a clearly labeled fake. It demonstrates provenance, identity confidence, and citations; it does not claim real STT or diarization."}</small>
      </aside>
    </section>
  </main>
}
