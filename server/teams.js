import { DomainError, invariant } from './errors.js'

export const MICROSOFT_TEAMS_INTEGRATION_ID = 'microsoft-teams'

const TEAMS_MEETING_ID = /^[A-Za-z0-9_-]{6,128}$/

function safeRedirectUri(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try { url = new URL(value) } catch { return null }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
  if (url.username || url.password || url.hash) return null
  return url.toString()
}

function configuredString(value) {
  return typeof value === 'string' && value.trim().length >= 6
}

/**
 * This intentionally exposes readiness only. Entra client secrets, service
 * credentials, Graph tokens, notification secrets, meeting URLs, and media
 * bytes belong in a production secret manager and server-side adapter.
 */
export function teamsReadiness(config = {}) {
  const clientIdConfigured = configuredString(config.entraClientId)
  const tenantConfigured = configuredString(config.entraTenantId)
  const redirectUriConfigured = Boolean(safeRedirectUri(config.redirectUri))
  const status = clientIdConfigured && tenantConfigured && redirectUriConfigured
    ? 'administrator-setup-required'
    : 'not-configured'
  return Object.freeze({
    integration: MICROSOFT_TEAMS_INTEGRATION_ID,
    status,
    connection: 'not-connected',
    oauth: Object.freeze({
      mode: 'server-side-entra-authorization-code-pkce',
      clientIdConfigured,
      tenantConfigured,
      redirectUriConfigured,
      secretsAcceptedHere: false,
    }),
    capabilities: Object.freeze({
      meetingMetadata: false,
      cloudRecordingImport: false,
      liveBotCapture: false,
      changeNotificationIngestion: false,
    }),
    importGuardrails: Object.freeze([
      'An authorized organizer must initiate the import.',
      'The destination meeting must pass the current recording policy and every required consent check first.',
      'Only opaque Teams meeting identifiers may cross this handoff; URLs, tokens, and media bytes are rejected.',
      'A future server adapter must re-check Entra authorization, policy, and source ownership before retrieving approved cloud recordings.',
    ]),
  })
}

export function teamsImportHandoff(input) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_TEAMS_IMPORT', 'Microsoft Teams import request must be an object', 400)
  const keys = Object.keys(input)
  invariant(keys.length === 2 && keys.every((key) => ['teamsMeetingId', 'source'].includes(key)), 'INVALID_TEAMS_IMPORT', 'Microsoft Teams import request has missing or unexpected fields', 400)
  invariant(typeof input.teamsMeetingId === 'string' && TEAMS_MEETING_ID.test(input.teamsMeetingId), 'INVALID_TEAMS_MEETING_ID', 'Microsoft Teams meeting identifier has an invalid format', 400)
  invariant(input.source === 'cloud-recording', 'INVALID_TEAMS_IMPORT_SOURCE', 'Only the approved Teams cloud-recording handoff is supported', 400)
  return Object.freeze({ teamsMeetingId: input.teamsMeetingId, source: input.source })
}

export class MicrosoftTeamsIntegrationAdapter {
  constructor({ config = {} } = {}) { this.config = Object.freeze({ ...config }) }

  readiness() { return teamsReadiness(this.config) }

  prepareImport(input) {
    const handoff = teamsImportHandoff(input)
    // Validated provider references deliberately never leave this adapter or
    // reach audit serialization while the connector remains unconfigured.
    void handoff
    throw new DomainError('TEAMS_NOT_CONNECTED', 'Microsoft Teams is not connected. An administrator must complete production server-side Entra and secret-manager setup.', 409)
  }
}
