# Meeting Intelligence

The shared language for turning authorized conversations into traceable organizational knowledge without weakening the permissions of the source meeting.

## Organization and access

**Tenant**:
An isolated organization whose identities, policies, meetings, and knowledge cannot be addressed from another tenant.
_Avoid_: Workspace, account

**Principal**:
An authenticated user identity making a request within one Tenant.
_Avoid_: Caller, actor

**Participant**:
A Principal invited to or present in a Meeting, with a recorded relationship to that Meeting.
_Avoid_: Attendee, member

**Management Grant**:
An explicit organizational-policy grant allowing a manager to access qualifying subordinate meeting records; reporting lines alone do not grant access.
_Avoid_: Executive override, inherited access

## Capture and privacy

**Meeting**:
A scheduled or active conversation belonging to one Tenant and governed by one Meeting Classification.
_Avoid_: Session, call

**Meeting Classification**:
The policy-relevant category assigned before capture, including whether the meeting is eligible to be recorded.
_Avoid_: Meeting type, sensitivity label

**Never-record Category**:
An organization-defined sensitive category for which capture authorization cannot be issued.
_Avoid_: Blocklist tag, deletion category

**Consent Evidence**:
An attributable, timestamped record that a Participant agreed to recording under a stated policy version.
_Avoid_: Consent flag

**Recording Authorization**:
A short-lived policy decision proving that capture may begin for a specific Meeting after classification, consent, and permission checks.
_Avoid_: Recording status, permission token

**Recording Lease**:
A short-lived, opaque, single-use authorization bound to one Tenant, Meeting, organizer, policy version, MIME allowlist, and byte limit. It authorizes creation of one Recording, not arbitrary upload or processing.
_Avoid_: Upload token, reusable authorization

**Recording**:
One declared audio artifact created from a Recording Lease, whose bytes must match its declared media type, exact length, and SHA-256 digest before processing.
_Avoid_: Audio file, stream

**Speech Processor**:
A replaceable processor that derives Transcript Segments and cited Knowledge Assertions from an authorized Recording. A processor's provenance must distinguish deterministic development fakes from real speech recognition.
_Avoid_: Transcription service, AI magic

## Knowledge and lifecycle

**Transcript Segment**:
A time-bounded passage of recognized speech with speaker attribution and capture provenance.
_Avoid_: Transcript row, utterance

**Knowledge Assertion**:
A generated summary, decision, risk, question, or action item derived from one or more Transcript Citations.
_Avoid_: AI output, insight

**Transcript Citation**:
A durable reference from a Knowledge Assertion to the source Transcript Segment that supports it.
_Avoid_: Source link, evidence snippet

**Retention State**:
The lifecycle status governing whether meeting content is active, held, pending deletion, or deleted.
_Avoid_: Record status

**Audit Event**:
An append-only account of a sensitive operation, joined across a request by an Audit Correlation.
_Avoid_: Log entry, activity

**Audit Correlation**:
The identifier connecting authorization, retrieval, and downstream processing Audit Events for one request.
_Avoid_: Request ID, trace ID
