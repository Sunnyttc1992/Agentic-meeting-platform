import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevelopmentPlatform, DEVELOPMENT_TENANTS } from './development.js'
import { createHttpHandler } from './http.js'
import { openConfiguredStorage } from './storage-config.js'
import { isLoopbackRequest, isMeetingApiPath, rejectNonLoopback } from './local-only.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultClientRoot = join(root, 'dist', 'client')
const types = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
})

function assetPath(clientRoot, pathname) {
  const target = normalize(join(clientRoot, pathname === '/' ? 'index.html' : pathname))
  return target.startsWith(`${clientRoot}\\`) || target === clientRoot ? target : null
}

function sendMalformedPath(response) {
  response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('Malformed request path')
}

function sendFile(response, path) {
  response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
  createReadStream(path).pipe(response)
}

// `platform` may be a platform or a promise of one (development setup seeds
// and recovers through storage, which is asynchronous).
export function createLocalPreviewServer({ clientRoot = defaultClientRoot, platform = createDevelopmentPlatform(), pipelineReadiness } = {}) {
  const apiReady = Promise.resolve(platform).then((ready) => createHttpHandler(ready, pipelineReadiness ? { pipelineReadiness } : undefined))
  apiReady.catch(() => {})
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return sendMalformedPath(response)
    }

    if (isMeetingApiPath(pathname)) {
      return isLoopbackRequest(request) ? (await apiReady)(request, response) : rejectNonLoopback(response)
    }

    const candidate = assetPath(clientRoot, pathname)
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return sendFile(response, candidate)
    if (['GET', 'HEAD'].includes(request.method ?? '') && existsSync(join(clientRoot, 'index.html'))) {
      return sendFile(response, join(clientRoot, 'index.html'))
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  })
}

function isEntrypoint() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isEntrypoint()) {
  const port = Number(process.env.PORT ?? 4173)
  // PostgreSQL when DATABASE_URL is set; otherwise the local SQLite file in .data/.
  const { storage, description } = await openConfiguredStorage({ root })
  const platform = await createDevelopmentPlatform({ storage })
  const server = createLocalPreviewServer({ platform })
  // Retention sweep: expired content is already unreadable; this deletes it.
  setInterval(async () => {
    for (const tenantId of DEVELOPMENT_TENANTS) {
      try { await platform.enforceRetention(tenantId) } catch (error) { console.error('Retention sweep failed:', error.code ?? error.message) }
    }
  }, 60_000).unref()
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local preview with meeting API (this machine only): http://localhost:${port} · storage: ${description}`)
  })
}
