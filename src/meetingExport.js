import { privacyAccessHeaders } from "./privacyAccess.js"

const MESSAGES = Object.freeze({
  NO_MEETING_RECORD: "There is no processed recording to export yet. Record and process the meeting first.",
  EXPORT_FORBIDDEN: "Only meeting participants can export this record.",
  MEETING_FORBIDDEN: "You do not have access to this meeting.",
  MEETING_NOT_FOUND: "This meeting could not be found.",
  RETENTION_RESTRICTED: "This meeting's content is no longer available.",
})

// Downloads the server-rendered meeting record. The browser only receives a
// document the server already authorized and audited; nothing is assembled
// from client-side state.
export async function downloadMeetingRecord({ meetingId = "meeting-1", fetchImpl = fetch, documentImpl = globalThis.document, URLImpl = URL } = {}) {
  let response
  try {
    response = await fetchImpl(`/meetings/${encodeURIComponent(meetingId)}/export`, { headers: privacyAccessHeaders() })
  } catch {
    return { ok: false, message: "The meeting record could not be downloaded. Check that the local server is running." }
  }
  if (!response.ok) {
    const code = await response.json().then((body) => body?.error?.code).catch(() => null)
    return { ok: false, message: MESSAGES[code] ?? "The meeting record could not be downloaded." }
  }
  const disposition = response.headers.get("content-disposition") ?? ""
  const filename = /filename="([a-z0-9-]+\.md)"/.exec(disposition)?.[1] ?? "meeting-record.md"
  const url = URLImpl.createObjectURL(await response.blob())
  try {
    const link = documentImpl.createElement("a")
    link.href = url
    link.download = filename
    documentImpl.body.append(link)
    link.click()
    link.remove()
  } finally {
    URLImpl.revokeObjectURL(url)
  }
  return { ok: true, filename }
}
