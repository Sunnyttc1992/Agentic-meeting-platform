// Per-principal request limits (AUTH-10). Expensive or data-moving operations
// get tight budgets: processing and retry spend model calls, export moves a
// whole meeting record. Status polling and ordinary reads get room for the
// studio's 350 ms poll. Windows are fixed per minute and kept in memory; a
// multi-instance deployment needs a shared store (for example Redis) instead.
export const RATE_LIMITS_PER_MINUTE = Object.freeze({
  processing: 6,
  capture: 30,
  export: 10,
  ai: 30,
  standard: 600,
})
const WINDOW_MS = 60_000
const MAX_TRACKED_KEYS = 10_000

export function rateLimitClass(method, pathname) {
  if (method === 'POST' && /^\/meetings\/[^/]+\/recordings\/[^/]+\/(process|retry)$/.test(pathname)) return 'processing'
  if (method === 'POST' && /^\/meetings\/[^/]+\/recording\/preflight$/.test(pathname)) return 'capture'
  if (method !== 'GET' && /^\/meetings\/[^/]+\/recordings(\/[^/]+\/bytes)?$/.test(pathname)) return 'capture'
  if (method === 'GET' && /^\/meetings\/[^/]+\/export$/.test(pathname)) return 'export'
  if (pathname === '/ai/retrieve') return 'ai'
  return 'standard'
}

export function createRateLimiter({ limits = RATE_LIMITS_PER_MINUTE, now = () => Date.now() } = {}) {
  const windows = new Map()
  const prune = (at) => { for (const [key, entry] of windows) if (at - entry.start >= WINDOW_MS) windows.delete(key) }
  return Object.freeze({
    check(principalKey, limitClass) {
      const at = now()
      const key = `${limitClass}\u0000${principalKey}`
      let entry = windows.get(key)
      if (!entry || at - entry.start >= WINDOW_MS) {
        if (!entry && windows.size >= MAX_TRACKED_KEYS) prune(at)
        // Still full after pruning: refuse new keys rather than grow without
        // bound, so a flood of fabricated identities cannot exhaust memory.
        if (!entry && windows.size >= MAX_TRACKED_KEYS) return { allowed: false, retryAfterSeconds: Math.ceil(WINDOW_MS / 1000) }
        entry = { start: at, count: 0 }
        windows.set(key, entry)
      }
      entry.count += 1
      const limit = limits[limitClass] ?? limits.standard
      if (entry.count <= limit) return { allowed: true }
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + WINDOW_MS - at) / 1000)) }
    },
  })
}
