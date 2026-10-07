import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChatCircleText, PaperPlaneRight, Trash } from '@phosphor-icons/react'
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

export function ChatTurn({ turn, embeddingModel = null }) {
  const note = turn.status === 'not-covered' && turn.answer ? null : STATUS_NOTES[turn.status]
  return <article className="chat-turn">
    <p className="chat-question">{turn.question}</p>
    {turn.answer && turn.status !== 'unsupported' && <p className="chat-answer">{turn.answer}</p>}
    {note && <p className="chat-note">{note}</p>}
    {turn.sources.length > 0 && <ol className="chat-sources" aria-label="Sources">{turn.sources.map((source, index) => <li key={source.label}>
      <details><summary><span className="chat-source-label">{index + 1}</span><b>{source.meetingTitle}</b><small>{[KIND_LABELS[source.kind] ?? 'Note', Number.isFinite(source.startMs) ? clock(source.startMs) : null, shortDate(source.meetingCreatedAt)].filter(Boolean).join(' · ')}</small></summary><p>{source.text}</p></details>
    </li>)}</ol>}
    {turn.provider && turn.status === 'answered' && <small className="chat-provenance">Written by {turn.provider}{turn.model ? ` (${turn.model})` : ''} from the sources above.</small>}
    {embeddingModel && turn.retrieval === 'keyword' && <small className="chat-provenance">Meaning-based search was unavailable for this question, so only keyword matches were used.</small>}
  </article>
}

const EXAMPLES = [
  'What did we decide in our recent meetings?',
  'Which risks or blockers are still open?',
  'Who agreed to do what, and by when?',
]

// "Ask your meetings" has its own page (#/ask), laid out like the recording
// studio: the conversation in the main column, how answers are made in the
// rail, and a composer that stays in reach at the bottom.
export function AskMeetingsPage({ onBack }) {
  const [turns, setTurns] = useState([])
  const [provider, setProvider] = useState(null)
  const [embeddingModel, setEmbeddingModel] = useState(null)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    localRequest('/chat/messages')
      .then((data) => { setTurns(data.turns ?? []); setProvider(data.provider ?? null); setEmbeddingModel(data.embeddingModel ?? null) })
      .catch((cause) => setError(cause.message))
      .finally(() => setLoaded(true))
  }, [])
  useEffect(() => { if (turns.length || asking) endRef.current?.scrollIntoView({ block: 'nearest' }) }, [turns.length, asking])

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
  const useExample = (text) => { setQuestion(text); inputRef.current?.focus() }

  return <main className="capture-shell ask-shell">
    <header className="capture-nav">
      <button onClick={onBack} className="back-button"><ArrowLeft size={17} /> Meetings</button>
      <div className="capture-wordmark">MEETING LEDGER / ASK</div>
      <span className="dev-badge">LOCAL WORKSPACE</span>
    </header>

    <section className="capture-hero">
      <div><p className="eyebrow">ASK YOUR MEETINGS</p><h1>What was decided?</h1><p className="capture-intro">Ask about decisions, owners, risks, and open questions across your meetings. Every answer cites the meeting moments it comes from.</p></div>
    </section>

    <section className="capture-grid">
      <div className="ask-main">
        <div className="chat-thread" aria-live="polite">
          {loaded && turns.length === 0 && !asking && <div className="ask-empty">
            <ChatCircleText size={30} />
            <h2>Start with a question.</h2>
            <p>Try one of these, or ask in your own words.</p>
            <div className="ask-examples">{EXAMPLES.map((text) => <button key={text} type="button" onClick={() => useExample(text)}>{text}</button>)}</div>
          </div>}
          {turns.map((turn) => <ChatTurn key={turn.id} turn={turn} embeddingModel={embeddingModel} />)}
          {asking && <p className="chat-note">Searching your meetings…</p>}
          <div ref={endRef} />
        </div>
        <form className="chat-form ask-composer" onSubmit={ask}>
          <textarea ref={inputRef} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) ask(event) }} maxLength={1000} rows={2} placeholder="What did we decide about the vendor renewal?" aria-label="Question" />
          <button className="copper-button" disabled={asking || !question.trim()}><PaperPlaneRight size={15}/> Ask</button>
        </form>
        {error && <p className="workspace-error">{error}</p>}
      </div>

      <aside className="capture-rail">
        <p className="eyebrow">HOW ANSWERS ARE MADE</p>
        <dl>
          <div><dt>Scope</dt><dd>Every meeting you can open, checked at each question</dd></div>
          <div><dt>Search</dt><dd>{embeddingModel ? `Keyword and meaning (${embeddingModel}, on this computer)` : 'Keyword matching'}</dd></div>
          <div><dt>Answers</dt><dd>{provider ? `Written by ${provider}, citing their sources` : 'Off: matching excerpts only'}</dd></div>
          <div><dt>History</dt><dd>{turns.length} saved {turns.length === 1 ? 'question' : 'questions'}</dd></div>
        </dl>
        {turns.length > 0 && <button className="ask-clear" onClick={clear}><Trash size={13}/> Clear history</button>}
        <small>{provider
          ? `Your question, the matching excerpts, and your last few questions are sent to ${provider} to write the answer. Audio never leaves this computer. Saved questions disappear when a meeting they used is deleted or you lose access to it.`
          : 'Nothing is sent to an AI provider. Set MEETING_CHAT_PROVIDER on the server to have answers written. Saved questions disappear when a meeting they used is deleted or you lose access to it.'}</small>
      </aside>
    </section>
  </main>
}
