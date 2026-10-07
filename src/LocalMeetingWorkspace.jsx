import { useEffect, useState } from 'react'
import { ArrowRight, Microphone, Plus, ShieldCheck, UsersThree } from '@phosphor-icons/react'
import { RecordingStudio } from './RecordingStudio.jsx'
import { MeetingChat } from './MeetingChat.jsx'
import { localRequest as request } from './localApi.js'

export function LocalMeetingWorkspace() {
  const [meetings, setMeetings] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [participants, setParticipants] = useState('')
  const [classification, setClassification] = useState('standard')
  const [creating, setCreating] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try { const data = await request('/meetings'); setMeetings(data.meetings ?? []); setError('') } catch (cause) { setError(cause.message) } finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])

  const createMeeting = async (event) => {
    event.preventDefault(); setCreating(true); setError('')
    try {
      const participantIds = participants.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
      const data = await request('/meetings', { method: 'POST', body: JSON.stringify({ title, participantIds, classification }) })
      setMeetings((current) => [data.meeting, ...current]); setSelected(data.meeting); setTitle(''); setParticipants('')
    } catch (cause) { setError(cause.message) } finally { setCreating(false) }
  }

  if (selected) return <RecordingStudio meeting={selected} onBack={() => { setSelected(null); refresh() }} />

  return <main className="workspace-shell">
    <header className="workspace-header"><div><p className="workspace-kicker">MEETING LEDGER / LOCAL WORKSPACE</p><h1>Start with a real meeting.</h1><p>Meetings, recording audio, transcripts, and results stay on this computer. This local prototype uses a development identity until company sign-in is added.</p></div><div className="workspace-posture"><ShieldCheck size={22}/><span><b>Local-only</b><small>Not shared on a network</small></span></div></header>
    <section className="workspace-grid">
      <form className="meeting-create" onSubmit={createMeeting}><p className="eyebrow">NEW MEETING</p><h2>Create a trusted record</h2><label>Meeting title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength="120" placeholder="Weekly product review" required /></label><label>Other participant IDs <small>Optional local aliases, comma-separated. You are included automatically.</small><input value={participants} onChange={(event) => setParticipants(event.target.value)} placeholder="sam, taylor" /></label><label>Classification<select value={classification} onChange={(event) => setClassification(event.target.value)}><option value="standard">Standard</option><option value="internal">Internal</option></select></label><button className="copper-button" disabled={creating}>{creating ? 'Creating…' : <><Plus size={16}/> Create meeting</>}</button>{error && <p className="workspace-error">{error}</p>}</form>
      <section className="meeting-list"><div className="meeting-list-head"><div><p className="eyebrow">YOUR LOCAL RECORDS</p><h2>Meetings</h2></div><button onClick={refresh} disabled={loading}>Refresh</button></div>{loading ? <p className="workspace-muted">Loading local records…</p> : meetings.length === 0 ? <div className="workspace-empty"><Microphone size={29}/><h3>No meetings yet</h3><p>Create your first meeting, obtain participant consent, then record from this computer.</p></div> : <div className="meeting-cards">{meetings.map((meeting) => <button key={meeting.id} className="meeting-card" onClick={() => setSelected(meeting)}><span className="meeting-card-mark"><UsersThree size={18}/></span><span><b>{meeting.title}</b><small>{meeting.participantIds.length} participant{meeting.participantIds.length === 1 ? '' : 's'} · {meeting.classification}</small><em>{meeting.recordingStatus.replaceAll('-', ' ')}</em></span><ArrowRight size={18}/></button>)}</div>}</section>
    </section>
    <MeetingChat />
  </main>
}
