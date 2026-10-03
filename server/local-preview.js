import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevelopmentPlatform } from './development.js'
import { createHttpHandler } from './http.js'
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

export function createLocalPreviewServer({ clientRoot = defaultClientRoot, platform = createDevelopmentPlatform(), pipelineReadiness } = {}) {
  const api = createHttpHandler(platform, pipelineReadiness ? { pipelineReadiness } : undefined)
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return sendMalformedPath(response)
    }

    if (isMeetingApiPath(pathname)) {
      return isLoopbackRequest(request) ? api(request, response) : rejectNonLoopback(response)
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
  const server = createLocalPreviewServer()
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local preview with meeting API (this machine only): http://localhost:${port}`)
  })
}
