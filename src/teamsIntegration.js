import { privacyAccessHeaders } from "./privacyAccess.js"

const READINESS = new Set(["not-configured", "administrator-setup-required"])

export function sanitizeTeamsReadiness(payload) {
  const oauth = payload?.oauth
  const capabilities = payload?.capabilities
  if (
    payload?.integration !== "microsoft-teams" || !READINESS.has(payload.status) ||
    payload.connection !== "not-connected" || oauth?.mode !== "server-side-entra-authorization-code-pkce" ||
    typeof oauth.clientIdConfigured !== "boolean" || typeof oauth.tenantConfigured !== "boolean" ||
    typeof oauth.redirectUriConfigured !== "boolean" || oauth.secretsAcceptedHere !== false || !capabilities ||
    ["meetingMetadata", "cloudRecordingImport", "liveBotCapture", "changeNotificationIngestion"].some((key) => capabilities[key] !== false)
  ) return null

  // Readiness state is deliberately value-free: client, tenant, callback, and
  // provider identifiers never become browser state or an input form.
  return Object.freeze({
    status: payload.status,
    clientIdConfigured: oauth.clientIdConfigured,
    tenantConfigured: oauth.tenantConfigured,
    redirectUriConfigured: oauth.redirectUriConfigured,
  })
}

export async function loadTeamsReadiness({ fetchImpl = fetch, correlationId } = {}) {
  try {
    const response = await fetchImpl("/integrations/microsoft-teams/readiness", {
      method: "GET",
      headers: privacyAccessHeaders(correlationId),
    })
    if (!response.ok) return { status: "unavailable" }
    const data = sanitizeTeamsReadiness(await response.json())
    return data ? { status: "ready", data } : { status: "unavailable" }
  } catch {
    return { status: "unavailable" }
  }
}
