import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DomainError } from './errors.js'
import { createRateLimiter, rateLimitClass } from './rate-limit.js'
import { isLoopbackRequest, rejectNonLoopback } from './local-only.js'
import { createPipelineReadiness } from './pipeline-readiness.js'

const MAX_JSON_BYTES = 16 * 1024

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const errorBody = (code, message, correlationId) => ({ error: { code, message }, correlationId })
const opaqueMeetingNotFoundBody = Object.freeze({ error: Object.freeze({ code: 'MEETING_NOT_FOUND', message: 'Meeting not found' }) })

const header = (request, name) => {
  const value = request.headers[name]
  if (Array.isArray(value)) throw new DomainError('INVALID_HEADER', `${name} must occur once`, 400)
  return typeof value === 'string' ? value.trim() : value
}

const principalFrom = (request) => ({
  tenantId: header(request, 'x-tenant-id'),
  userId: header(request, 'x-user-id'),
  roles: String(header(request, 'x-user-roles') ?? '').split(',').map((role) => role.trim()).filter(Boolean),
})

async function readJson(request) {
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415)
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_JSON_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 'JSON body is too large', 413)
    chunks.push(chunk)
  }
  if (length === 0) throw new DomainError('INVALID_JSON', 'A JSON body is required', 400)
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('not an object')
    return body
  } catch {
    throw new DomainError('INVALID_JSON', 'Body must be a valid JSON object', 400)
  }
}

async function readBytes(request, maxBytes) {
  const chunks=[]; let length=0
  for await (const chunk of request) { length+=chunk.length; if(length>maxBytes) throw new DomainError('PAYLOAD_TOO_LARGE','Audio body is too large',413); chunks.push(chunk) }
  return Buffer.concat(chunks)
}

function strictObject(body, allowed, required) {
  const keys = Object.keys(body)
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new DomainError('INVALID_REQUEST', 'Request body has missing or unexpected fields', 400)
  }
}

function validateConsent(body) {
  strictObject(body, ['participantId', 'capturedAt', 'expiresAt', 'policyVersion', 'decision', 'method'], ['participantId', 'capturedAt', 'expiresAt', 'policyVersion', 'decision', 'method'])
  for (const field of ['participantId', 'capturedAt', 'expiresAt', 'policyVersion', 'decision', 'method']) {
    if (typeof body[field] !== 'string' || body[field].trim() === '') throw new DomainError('INVALID_REQUEST', `${field} must be a non-empty string`, 400)
  }
  if (!['granted', 'declined', 'withdrawn'].includes(body.decision) || body.method !== 'explicit') {
    throw new DomainError('INVALID_REQUEST', 'decision and method must use the approved consent values', 400)
  }
  return body
}

function auditAnchorFrom(searchParams) {
  const keys = [...searchParams.keys()]
  if (keys.some((key) => key !== 'anchorSequence' && key !== 'anchorHash')) throw new DomainError('INVALID_REQUEST', 'Unexpected audit integrity parameter', 400)
  const sequence = searchParams.get('anchorSequence')
  const hash = searchParams.get('anchorHash')
  if (sequence === null && hash === null) return null
  if (sequence === null || hash === null || !/^[1-9][0-9]{0,15}$/.test(sequence)) throw new DomainError('INVALID_AUDIT_ANCHOR', 'Audit anchor requires anchorSequence and anchorHash together', 400)
  return { sequence: Number(sequence), hash }
}

function validatePreflight(body) {
  strictObject(body, [], [])
  return body
}

function validateAiRetrieve(body) {
  strictObject(body, ['query', 'limit'], ['query'])
  if (typeof body.query !== 'string') throw new DomainError('INVALID_REQUEST', 'query must be a string', 400)
  if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 8)) {
    throw new DomainError('INVALID_REQUEST', 'limit must be an integer from 1 to 8', 400)
  }
  return body
}

function validateMeetingCreate(body) {
  strictObject(body, ['title', 'participantIds', 'classification'], ['title', 'participantIds', 'classification'])
  if (typeof body.title !== 'string' || body.title.trim().length < 1 || body.title.trim().length > 120) throw new DomainError('INVALID_REQUEST', 'title must be 1 to 120 characters', 400)
  if (!Array.isArray(body.participantIds) || body.participantIds.length > 24 || body.participantIds.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id))) throw new DomainError('INVALID_REQUEST', 'participantIds must be up to 24 local identifiers', 400)
  if (!['standard', 'internal'].includes(body.classification)) throw new DomainError('INVALID_REQUEST', 'classification must be standard or internal', 400)
  return { title: body.title.trim(), participantIds: [...new Set(body.participantIds.map((id) => id.trim()).filter(Boolean))], classification: body.classification }
}

export function createHttpHandler(platform, { pipelineReadiness = createPipelineReadiness(), rateLimiter = createRateLimiter() } = {}) {
  return async (request, response) => {
    let correlationId = randomUUID()
    let isPrivacyAccessRead = false
    try {
      const url = new URL(request.url, 'http://localhost')
      // Reject at the transport boundary before parsing development identity
      // headers, so this local-only endpoint never becomes externally useful.
      if (request.method === 'GET' && url.pathname === '/pipeline/readiness' && !isLoopbackRequest(request)) return rejectNonLoopback(response)
      const suppliedCorrelationId = header(request, 'x-correlation-id')
      if (!suppliedCorrelationId) throw new DomainError('INVALID_HEADER', 'x-correlation-id is required', 400)
      // Throttle before any platform work. Throttled requests are deliberately
      // not audited one by one, so a flood cannot amplify into the audit log.
      const limit = rateLimiter.check(`${header(request, 'x-tenant-id') ?? ''}:${header(request, 'x-user-id') ?? ''}`, rateLimitClass(request.method, url.pathname))
      if (!limit.allowed) {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(limit.retryAfterSeconds) })
        return response.end(JSON.stringify(errorBody('RATE_LIMITED', 'Too many requests; please wait and try again', suppliedCorrelationId)))
      }
      correlationId = suppliedCorrelationId
      const commitmentsRead = request.method === 'GET' && url.pathname === '/commitments'
      const managementBriefingRead = request.method === 'GET' && url.pathname === '/management-briefing'
      const knowledgeMatch = url.pathname.match(/^\/meetings\/([^/]+)\/knowledge$/)
      const privacyAccessMatch = url.pathname.match(/^\/meetings\/([^/]+)\/privacy-access$/)
      const consentMatch = url.pathname.match(/^\/meetings\/([^/]+)\/consent$/)
      const preflightMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recording\/preflight$/)
      const authorizationStatusMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recording\/authorization-status$/)
      const stopMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recording\/stop$/)
      const recordingsMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recordings$/)
      const bytesMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recordings\/([^/]+)\/bytes$/)
      const processMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recordings\/([^/]+)\/process$/)
      const exportMatch = url.pathname.match(/^\/meetings\/([^/]+)\/export$/)
      const retryMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recordings\/([^/]+)\/retry$/)
      const statusMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recordings\/([^/]+)$/)
      const deleteMatch = url.pathname.match(/^\/meetings\/([^/]+)\/recordings$/)
      const teamsImportMatch = url.pathname.match(/^\/meetings\/([^/]+)\/integrations\/microsoft-teams\/import$/)
      if (request.method === 'GET' && url.pathname === '/meetings') return json(response, 200, { meetings: await platform.listMeetings(principalFrom(request), correlationId) })
      if (request.method === 'POST' && url.pathname === '/meetings') {
        const body = validateMeetingCreate(await readJson(request)
        )
        const actor = principalFrom(request)
        const participantIds = [...new Set([actor.userId, ...body.participantIds])]
        const record = await platform.createMeeting(actor, { id: randomUUID(), tenantId: actor.tenantId, organizerId: actor.userId, participantIds, requiredParticipantIds: participantIds, classification: body.classification, consentPolicyVersion: 'v1', title: body.title, createdAt: new Date().toISOString() }, correlationId)
        return json(response, 201, { meeting: { id: record.id, title: record.title, organizerId: record.organizerId, participantIds: record.participantIds, classification: record.classification, createdAt: record.createdAt } })
      }
      if (request.method === 'GET' && url.pathname === '/pipeline/readiness') {
        const teamsReadiness = await platform.getTeamsReadiness(principalFrom(request), correlationId)
        return json(response, 200, pipelineReadiness.inspect({ teamsReadiness }))
      }
      if (request.method === 'GET' && url.pathname === '/integrations/microsoft-teams/readiness') return json(response, 200, await platform.getTeamsReadiness(principalFrom(request), correlationId))
      if (request.method === 'GET' && url.pathname === '/audit/integrity') return json(response, 200, await platform.verifyAuditIntegrity(principalFrom(request), { anchor: auditAnchorFrom(url.searchParams) }, correlationId))
      if (managementBriefingRead) return json(response, 200, await platform.getManagementBriefing(principalFrom(request), correlationId))
      if (commitmentsRead) return json(response, 200, await platform.queryCommitments(principalFrom(request), url.searchParams.get('query') ?? '', correlationId))
      if (request.method === 'GET' && knowledgeMatch) return json(response, 200, await platform.getMeetingKnowledge(principalFrom(request), knowledgeMatch[1], correlationId))
      isPrivacyAccessRead = request.method === 'GET' && Boolean(privacyAccessMatch)
      if (isPrivacyAccessRead) return json(response, 200, await platform.getMeetingPrivacyAccess(principalFrom(request), privacyAccessMatch[1], correlationId))
      if (request.method === 'POST' && consentMatch) {
        const body = validateConsent(await readJson(request))
        await platform.recordConsent(principalFrom(request), consentMatch[1], body, correlationId)
        response.writeHead(204)
        return response.end()
      }
      if (request.method === 'POST' && preflightMatch) {
        validatePreflight(await readJson(request))
        const authorization = await platform.authorizeRecording(principalFrom(request), preflightMatch[1], correlationId)
        return json(response, 200, { status: authorization.status, leaseId: authorization.leaseId, authorizationExpiresAt: authorization.authorizationExpiresAt, allowedMimeTypes: authorization.allowedMimeTypes, maxBytes: authorization.maxBytes })
      }
      if (request.method === 'GET' && authorizationStatusMatch) return json(response, 200, await platform.getRecordingAuthorizationStatus(principalFrom(request), authorizationStatusMatch[1], correlationId))
      if (request.method === 'POST' && stopMatch) {
        const body = await readJson(request)
        strictObject(body, ['reason'], ['reason'])
        return json(response, 200, await platform.stopCapture(principalFrom(request), stopMatch[1], body, correlationId))
      }
      if (request.method === 'GET' && recordingsMatch) return json(response, 200, await platform.listRecordings(principalFrom(request), recordingsMatch[1], correlationId))
      if (request.method === 'POST' && recordingsMatch) { const body=await readJson(request); strictObject(body,['leaseId','contentType','byteLength','sha256'],['leaseId','contentType','byteLength','sha256']); return json(response,201,await platform.createRecording(principalFrom(request),recordingsMatch[1],body,correlationId)) }
      if (request.method === 'PUT' && bytesMatch) { const contentType=String(header(request,'content-type')??'').toLowerCase(); const rawLength=header(request,'content-length'); const contentLength=rawLength===undefined?NaN:Number(rawLength); const bytes=await readBytes(request,platform.maxRecordingBytes); return json(response,200,await platform.uploadRecording(principalFrom(request),bytesMatch[1],bytesMatch[2],{contentType,contentLength,bytes},correlationId)) }
      if (request.method === 'GET' && exportMatch) {
        const record = await platform.exportMeetingRecord(principalFrom(request), exportMatch[1], correlationId)
        response.writeHead(200, {
          'content-type': record.contentType,
          'content-disposition': `attachment; filename="${record.filename}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        return response.end(record.body)
      }
      if (request.method === 'POST' && retryMatch) { validatePreflight(await readJson(request)); return json(response,202,await platform.retryProcessing(principalFrom(request),retryMatch[1],retryMatch[2],correlationId)) }
      if (request.method === 'POST' && processMatch) { validatePreflight(await readJson(request)); return json(response,202,await platform.startProcessing(principalFrom(request),processMatch[1],processMatch[2],correlationId)) }
      if (request.method === 'GET' && statusMatch) return json(response,200,await platform.getRecording(principalFrom(request),statusMatch[1],statusMatch[2],correlationId))
      if (request.method === 'DELETE' && deleteMatch) return json(response,200,await platform.deleteMeetingContent(principalFrom(request),deleteMatch[1],correlationId))
      if (request.method === 'POST' && teamsImportMatch) return json(response, 202, await platform.prepareTeamsImport(principalFrom(request), teamsImportMatch[1], await readJson(request), correlationId))
      if (request.method === 'POST' && url.pathname === '/ai/retrieve') {
        const body = validateAiRetrieve(await readJson(request))
        return json(response, 200, { context: await platform.retrieveMeetingContext(principalFrom(request), body, correlationId) })
      }
      return json(response, 404, errorBody('NOT_FOUND', 'Route not found', correlationId))
    } catch (error) {
      if (isPrivacyAccessRead && error instanceof DomainError && error.status === 404 && error.code === 'MEETING_NOT_FOUND') {
        return json(response, 404, opaqueMeetingNotFoundBody)
      }
      const status = error instanceof DomainError ? error.status : 500
      return json(response, status, errorBody(error.code ?? 'INTERNAL_ERROR', status === 500 ? 'Internal server error' : error.message, correlationId))
    }
  }
}

export function createHttpServer(platform, options) {
  return createServer(createHttpHandler(platform, options))
}
