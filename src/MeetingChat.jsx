import { useEffect, useRef, useState } from 'react'
import { ChatCircleText, PaperPlaneRight, Trash } from '@phosphor-icons/react'
import { localRequest } from './localApi.js'

// Questions over every meeting the user can open. The server finds matching
// excerpts (authorizing each meeting first) and, when a chat provider is
// configured, asks it to write a cited answer. History is saved per user and
// disappears when a meeting it drew on is deleted or no longer accessible.
const STATUS_NOTES = {
  'no-sources': 'No meeting you can open mentions that. Try different words, such as a project, vendor, or topic.',
  'sources-only': 'Written answers are not configured on this server, so here are the matching excerpts.',
  'not-covered': 'The matching excerpts do not answer this question.',
  unsupported: 'An answer was written but could not be tied to your meetings, so it was withheld.',
}
const KIND_LABELS = { transcript: 'Transcript', decision: 'Decision', action: 'Action', risk: 'Risk', question: 'Open question', summary: 'Summary', finding: 'Finding' }
const clock = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const shortDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null

export function ChatTurn({ turn }) {
  const note = turn.status === 'not-covered' && turn.answer ? null : STATUS_NOTES[turn.status]
  return <article className="chat-turn">
    <p className="chat-question">{turn.question}</p>
    {turn.answer && turn.status !== 'unsupported' && <p className="chat-answer">{turn.answer}</p>}
    {note && <p className="chat-note">{note}</p>}
    {turn.sources.length > 0 && <ol className="chat-sources" aria-label="Sources">{turn.sources.map((source, index) => <li key={source.label}>
      <details><summary><span className="chat-source-label">{index + 1}</span><b>{source.meetingTitle}</b><small>{[KIND_LABELS[source.kind] ?? 'Note', Number.isFinite(source.startMs) ? clock(source.startMs) : null, shortDate(source.meetingCreatedAt)].filter(Boolean).join(' · ')}</small></summary><p>{source.text}</p></details>
    </li>)}</ol>}
    {turn.provider && turn.status === 'answered' && <small className="chat-provenance">Written by {turn.provider}{turn.model ? ` (${turn.model})` : ''} from the sources above.</small>}
  </article>
}

export function MeetingChat() {
  const [turns, setTurns] = useState([])
  const [provider, setProvider] = useState(null)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const endRef = useRef(null)

  useEffect(() => {
    localRequest('/chat/messages')
      .then((data) => { setTurns(data.turns ?? []); setProvider(data.provider ?? null) })
      .catch((cause) => setError(cause.message))
      .finally(() => setLoaded(true))
  }, [])
  useEffect(() => { if (turns.length) endRef.current?.scrollIntoView({ block: 'nearest' }) }, [turns.length])

  const ask = async (event) => {
    event?.preventDefault()
    const text = question.trim()
    if (!text || asking) return
    setAsking(true); setError('')
    try {
      const data = await localRequest('/chat/messages', { method: 'POST', body: JSON.stringify({ question: text }) })
      setTurns((current) => [...current, data.turn]); setQuestion('')
    } catch (cause) { setError(cause.message) } finally { setAsking(false) }
  }
  const clear = async () => {
    if (!window.confirm('Delete your saved chat history? This cannot be undone.')) return
    try { await localRequest('/chat/messages', { method: 'DELETE' }); setTurns([]) } catch (cause) { setError(cause.message) }
  }

  return <section className="meeting-chat" aria-label="Ask your meetings">
    <div className="meeting-list-head"><div><p className="eyebrow">ASK YOUR MEETINGS</p><h2>What was decided?</h2></div>{turns.length > 0 && <button onClick={clear}><Trash size={12}/> Clear history</button>}</div>
    <p className="chat-disclosure">{provider
      ? `Searches every meeting you can open. Your question, the matching excerpts, and your last few questions are sent to ${provider} to write a cited answer. Audio never leaves this computer.`
      : 'Searches every meeting you can open and shows the matching excerpts. Written answers are off on this server (set MEETING_CHAT_PROVIDER to enable them).'}</p>
    <div className="chat-thread" aria-live="polite">
      {loaded && turns.length === 0 && !asking && <div className="workspace-empty chat-empty"><ChatCircleText size={27}/><p>Ask about decisions, owners, risks, or open questions across your meetings.</p></div>}
      {turns.map((turn) => <ChatTurn key={turn.id} turn={turn} />)}
      {asking && <p className="chat-note">Searching your meetings…</p>}
      <div ref={endRef} />
    </div>
    <form className="chat-form" onSubmit={ask}>
      <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) ask(event) }} maxLength={1000} rows={2} placeholder="What did we decide about the vendor renewal?" aria-label="Question" />
      <button className="copper-button" disabled={asking || !question.trim()}><PaperPlaneRight size={15}/> Ask</button>
    </form>
    {error && <p className="workspace-error">{error}</p>}
  </section>
}
