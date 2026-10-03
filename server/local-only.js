// Until Entra sign-in replaces the development identity headers, the meeting
// API is reachable only from this machine. Both the socket address and the
// Host header must be loopback: the Host check stops a web page from reaching
// the API through DNS rebinding (a public name that resolves to 127.0.0.1).
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isMeetingApiPath(pathname) {
  return pathname.startsWith('/meetings/') || pathname.startsWith('/integrations/')
    || ['/ai/retrieve', '/commitments', '/management-briefing', '/audit/integrity', '/pipeline/readiness'].includes(pathname)
}

export function isLoopbackRequest(request) {
  const host = String(request.headers?.host ?? '').toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress) && LOOPBACK_HOSTNAMES.has(hostname)
}

export function rejectNonLoopback(response) {
  response.writeHead(403, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { code: 'LOCAL_ONLY', message: 'The meeting API is available only on this machine until enterprise sign-in is configured' } }))
}
