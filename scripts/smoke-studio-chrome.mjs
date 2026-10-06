// Browser smoke test for the recording studio: drives headless Chrome with
// Chrome's fake microphone (a test tone) and prints each screen plus browser
// errors. Usage: node scripts/smoke-studio-chrome.mjs [url] [--process]
// Without --process it stops before anything is uploaded. With --process it
// uploads and transcribes the tone, so point it at a throwaway server with no
// DATABASE_URL in its environment (use run-studio-browser-smoke.ps1), never at
// a server holding real meetings.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const APP = process.argv[2] ?? 'http://localhost:4174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'studio-cdp-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' })
process.once('exit', () => chrome.kill())

let target
for (let i = 0; i < 40 && !target; i += 1) {
  await sleep(250)
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch {}
}
if (!target) { console.log('Chrome did not start'); chrome.kill(); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
  if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`)
  if (msg.method === 'Page.javascriptDialogOpening') { logs.push('dialog accepted: ' + msg.params.message.slice(0, 80)); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } })) }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const entry = msg.params.entry
    // The studio intentionally preflights before consent to discover the
    // consent requirement. That first 403 is handled in the UI, not a browser
    // failure. Any later failure prevents the expected next state and fails
    // the smoke sequence below.
    if (!(entry.url?.includes('/recording/preflight') && entry.text.includes('403'))) logs.push(`log: ${entry.text} ${entry.url ?? ''}`)
  }
})
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
const waitFor = async (expression, label) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate(expression)) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
const screen = async (label) => {
  const text = await evaluate(`document.querySelector('.capture-shell, main, body')?.innerText.replace(/\\s+/g, ' ').slice(0, 700)`)
  console.log(`\n[${label}] ${text}`)
}
const click = async (pattern) => {
  const result = await evaluate(`(() => { const re = new RegExp(${JSON.stringify(pattern)}, 'i'); const b = [...document.querySelectorAll('button')].find((x) => re.test(x.innerText) && !x.disabled); if (!b) return 'NOT FOUND: ' + ${JSON.stringify(pattern)} + ' | buttons: ' + [...document.querySelectorAll('button')].map((x) => x.innerText.trim() + (x.disabled ? '(disabled)' : '')).filter(Boolean).join(' / '); b.click(); return 'clicked ' + b.innerText.trim() })()`)
  console.log(`  -> ${result}`)
  if (String(result).startsWith('NOT FOUND:')) throw new Error(result)
}

const setInput = async (selector, value) => {
  const result = await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return 'NOT FOUND: ' + ${JSON.stringify(selector)}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return 'set ' + input.name
  })()`)
  console.log(`  -> ${result}`)
  if (String(result).startsWith('NOT FOUND:')) throw new Error(result)
}

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
await send('Browser.grantPermissions', { origin: new URL(APP).origin, permissions: ['audioCapture'] }).catch(() => {})
await send('Page.navigate', { url: APP })
await waitFor(`!!document.querySelector('.workspace-shell')`, 'the local meeting workspace')
await screen('workspace opened')
await setInput('.meeting-create input[required]', 'Browser smoke meeting')
await setInput('.meeting-create input:not([required])', 'smoke-participant')
await click('Create meeting')
await waitFor(`!!document.querySelector('.capture-shell')`, 'the selected meeting studio')
await waitFor(`document.querySelectorAll('.participant-list button').length >= 2`, 'participant consent controls')
await screen('studio opened')
for (let i = 0; i < 2; i += 1) {
  console.log('  -> ' + await evaluate(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => /^\\s*Grant/i.test(x.innerText))[${i}]; if (!b) return 'no Grant #${i}'; b.click(); return 'clicked Grant #${i}' })()`))
  await sleep(1200)
}
await click('Verify policy')
await sleep(3500)
await screen('after policy check')
await click('Begin recording')
await sleep(5000)
await screen('while recording')
await click('Stop recording')
await sleep(2500)
await screen('after stop')
if (process.argv.includes('--process')) {
  await click('Process locally')
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000)
    const t = await evaluate("document.querySelector('.capture-shell')?.innerText.replace(/\\s+/g, ' ') ?? ''")
    if (/COMPLETE|FAILED|CAPTURE STOPPED|ERROR/.test(t) && !/QUEUED|UPLOADING|HASHING|PROCESSING ·/.test(t) && !/CAPTURE COMPLETE/.test(t)) break
  }
  await screen('after processing')
}
const hasAudio = await evaluate(`!!document.querySelector('audio.audio-player')?.src`)
console.log(`\naudio player present with a source: ${hasAudio}`)
console.log(`\nBrowser errors/warnings (${logs.length}):\n${logs.join('\n') || '(none)'}`)
ws.close(); chrome.kill()
if (logs.length > 0) process.exitCode = 1
