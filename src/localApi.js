// Same-origin requests to this computer's meeting API with the local
// development identity. Every request carries a correlation ID, and a failure
// reports only a safe message plus that reference.
const headers = () => ({ 'content-type': 'application/json', 'x-tenant-id': 'northstar', 'x-user-id': 'alex', 'x-correlation-id': crypto.randomUUID() })

export async function localRequest(path, options = {}) {
  const requestHeaders = { ...headers(), ...(options.headers ?? {}) }
  const reference = requestHeaders['x-correlation-id']
  let response
  try {
    response = await fetch(path, { ...options, headers: requestHeaders })
  } catch {
    throw new Error(`Could not reach the local server. Refresh the page once and try again. Reference: ${reference}`)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload?.error?.message ?? `The local server returned ${response.status}.`
    throw new Error(`${message} Reference: ${payload?.correlationId ?? reference}`)
  }
  return payload
}
