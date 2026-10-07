import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChatCircleText, PaperPlaneRight, Trash, X } from '@phosphor-icons/react'
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

// Sentences are split the same way the server's grounding check splits them,
// so a flagged index marks the right sentence.
const sentencesOf = (text) => String(text ?? '').split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean)
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

function GroundedAnswer({ answer, grounding }) {
  const flagged = new Set(grounding?.unsupportedSentences ?? [])
  if (flagged.size === 0) return <p className="chat-answer">{answer}</p>
  return <p className="chat-answer">{sentencesOf(answer).map((sentence, index) => <span key={index}>{index > 0 ? ' ' : ''}{flagged.has(index) ? <mark className="chat-unverified" title="Could not be matched to the cited sources">{sentence}</mark> : sentence}</span>)}</p>
}

function groundingWarning(grounding) {
  const statements = grounding?.unsupportedSentences?.length ?? 0
  const numbers = grounding?.unsupportedNumbers?.length ?? 0
  if (!statements && !numbers) return null
  const parts = [statements ? plural(statements, 'highlighted statement', 'highlighted statements') : null, numbers ? `the ${numbers === 1 ? 'number' : 'numbers'} ${grounding.unsupportedNumbers.join(', ')}` : null].filter(Boolean)
  return `Check before relying on it: ${parts.join(' and ')} could not be matched to the sources below.`
}

export function ChatTurn({ turn, embeddingModel = null, onForget = null }) {
  const note = turn.status === 'not-covered' && turn.answer ? null : STATUS_NOTES[turn.status]
  const warning = turn.status === 'answered' ? groundingWarning(turn.grounding) : null
  return <article className="chat-turn">
    <div className="chat-turn-head"><p className="chat-question">{turn.question}</p>{onForget && <button className="chat-forget" onClick={() => onForget(turn)} title="Forget this question and its answer"><X size={12}/> Forget</button>}</div>
    {turn.answer && turn.status !== 'unsupported' && <GroundedAnswer answer={turn.answer} grounding={turn.status === 'answered' ? turn.grounding : null} />}
    {warning && <p className="chat-note chat-warning">{warning}</p>}
    {note && <p className="chat-note">{note}</p>}
    {turn.sources.length > 0 && <ol className="chat-sources" aria-label="Sources">{turn.sources.map((source, index) => <li key={source.label}>
      <details><summary><span className="chat-source-label">{index + 1}</span><b>{source.meetingTitle}</b><small>{[KIND_LABELS[source.kind] ?? 'Note', Number.isFinite(source.startMs) ? clock(source.startMs) : null, shortDate(source.meetingCreatedAt)].filter(Boolean).join(' · ')}</small></summary><p>{source.text}</p></details>
    </li>)}</ol>}
    {turn.provider && turn.status === 'answered' && <small className="chat-provenance">Written by {turn.provider}{turn.model ? ` (${turn.model})` : ''} from the sources above.</small>}
    {turn.memory?.recalled > 0 && <small className="chat-provenance">Also drew on {plural(turn.memory.recalled, 'related earlier question', 'related earlier questions')} from your history.</small>}
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
  const [retentionDays, setRetentionDays] = useState(null)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    localRequest('/chat/messages')
      .then((data) => { setTurns(data.turns ?? []); setProvider(data.provider ?? null); setEmbeddingModel(data.embeddingModel ?? null); setRetentionDays(data.retentionDays ?? null) })
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
  const forget = async (turn) => {
    if (!window.confirm('Forget this question and its answer? This cannot be undone.')) return
    try { await localRequest(`/chat/messages/${turn.id}`, { method: 'DELETE' }); setTurns((current) => current.filter((item) => item.id !== turn.id)) } catch (cause) { setError(cause.message) }
  }

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
          {turns.map((turn) => <ChatTurn key={turn.id} turn={turn} embeddingModel={embeddingModel} onForget={forget} />)}
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
          <div><dt>Safeguards</dt><dd>Contact details and ID numbers are removed before sending; answers are checked against their sources</dd></div>
          <div><dt>Memory</dt><dd>{plural(turns.length, 'saved question', 'saved questions')}{retentionDays ? `, kept ${retentionDays} days` : ''}; recent and related earlier questions inform follow-ups</dd></div>
        </dl>
        {turns.length > 0 && <button className="ask-clear" onClick={clear}><Trash size={13}/> Clear history</button>}
        <small>{provider
          ? `Your question, the matching excerpts, and your last few questions are sent to ${provider} to write the answer. Audio never leaves this computer. Saved questions disappear when a meeting they used is deleted or you lose access to it.`
          : 'Nothing is sent to an AI provider. Set MEETING_CHAT_PROVIDER on the server to have answers written. Saved questions disappear when a meeting they used is deleted or you lose access to it.'}</small>
      </aside>
    </section>
  </main>
}
