# Never-record and sensitive-topic preflight

## Policy objective

Prevent prohibited content from being captured, rather than relying on deletion after capture. Organization-configured categories may include harassment complaints/investigations, employee-relations or discipline, compensation negotiations, privileged legal discussions, and other categories approved by the organization.

These categories are policy inputs, not legal conclusions. Counsel must configure jurisdiction-specific consent modes, participant notice, privilege handling, retention, and any exceptions.

## Preflight inputs

- Tenant policy and emergency-stop state.
- Meeting title, agenda, organizer-provided classification, calendar sensitivity, invited groups, integration/source, and declared purpose.
- Participant attestations and consent status required by the configured jurisdiction profile.
- Explicit case/matter labels from HR, legal, compliance, or privacy systems; only minimum necessary labels are exposed.

Do not send raw HR/legal matter details or participant allegations to an LLM for classification. Deterministic labels and approved rules take precedence. If an ML classifier is used on low-risk metadata, uncertainty or sensitive-category detection yields `REVIEW_REQUIRED`, never automatic permission.

## Preflight states

```text
DRAFT -> CLASSIFICATION_REQUIRED -> CONSENT_REQUIRED -> RECORDING_AUTHORIZED
                                  -> NEVER_RECORD
                                  -> REVIEW_REQUIRED
                                  -> POLICY_STOPPED
```

- `RECORDING_AUTHORIZED`: a short-lived, meeting-bound recording lease may be issued only after all required checks pass.
- `NEVER_RECORD`: no microphone/conferencing capture, buffers, transcription, indexing, or model processing may start.
- `REVIEW_REQUIRED`: fail closed; authorized privacy/legal workflow decides without exposing meeting content.
- `POLICY_STOPPED`: emergency policy prevents authorization regardless of prior scheduling decisions.

## Capture controls

- Display a persistent, unmistakable recording indicator and provide participant-accessible consent/stop controls.
- Capture service validates the signed lease before accepting each stream and periodically during recording.
- Client-side buffering before authorization is prohibited. Transport buffers must be bounded, encrypted, and discarded on denial.
- Meeting classification changes invalidate the lease immediately.

## Sensitive topic detected during recording

1. Any participant or authorized policy signal can request immediate stop; no organizer approval is required to halt capture.
2. Stop accepting audio frames and visibly confirm recording stopped.
3. Cancel queued transcription, summarization, indexing, and agent jobs.
4. Seal pre-stop artifacts in `QUARANTINED_PENDING_DISPOSITION`; remove them from all ordinary reads/search/AI.
5. Emit audit events without sensitive narrative text.
6. Apply configured disposition: delete captured material or retain restricted evidence where policy/legal hold requires. Legal hold blocks destruction but never expands visibility.
7. Resume only through a new preflight and new consent/authorization lease; never silently resume.

Prototype implementation (2026-10-06): `POST /meetings/{id}/recording/stop` with `{"reason": "sensitive-topic" | "participant-request"}`, callable by any participant (outsiders get an opaque 404). It revokes the active lease, appends a content-free `captureStops` boundary (`at`, reason code, whether a lease was revoked) to the meeting, quarantines any not-yet-published recording made under that lease, and deletes its audio unless the meeting is under legal hold. It emits a `recording.stop` audit event with the reason code. Consent withdrawal records the same boundary with `CONSENT_WITHDRAWN`. The studio's "Stop and discard: sensitive topic" control discards in-browser audio before calling the server. Limitation: a stop raised from another device reaches an open studio only at its next lease renewal; the server already refuses that capture's upload.

False negatives are the highest-risk failure. Calendar/agenda screening supplements, but does not replace, participant controls and organization policy.
