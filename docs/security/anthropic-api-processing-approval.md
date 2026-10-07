# Anthropic API processing approval packet

**Status:** Draft — Claude-generated meeting intelligence is not approved for real meeting content until this packet is completed.

- **Prepared:** 2026-10-06
- **Decision owner:** _Name / role_
- **Security owner:** _Name / role_
- **Privacy or legal owner:** _Name / role_

## Decision requested

Approve or reject use of the first-party Anthropic API to derive a cited executive summary, decisions, risks, open questions, and action plan from authorized Meeting transcripts. This is a processor review, not a blanket approval for every Anthropic product or feature.

The application must remain in transcript-only mode for real meetings unless the approval record below is complete. An `ANTHROPIC_API_KEY` must stay unset or empty until then.

## Exact application boundary

`server/intelligence.js` makes one server-side Messages API request for one authorized recording. The request contains:

| Sent to Anthropic | Never sent by this integration |
| --- | --- |
| Timestamped transcript text | Audio or audio bytes |
| Anonymous per-meeting speaker labels (`SPEAKER_00`, ...), added 2026-10-06 | Voice embeddings, voiceprints, or raw diarization worker labels |
| Transcript segment IDs and offsets | Participant names |
| Participant IDs | Tenant, Meeting, Recording, or lease IDs |
| Meeting date | Consent evidence, encryption keys, credentials, audit records, or other Meetings |
| System instructions and JSON output schema | Browser-held secrets |

Treat transcript content and participant IDs as potentially personal and confidential data even when they are pseudonymous. The server sends no Files API uploads, Batch API jobs, prompt-caching requests, web search/fetch, third-party tools, Managed Agents, code-execution requests, or production feedback/bug reports. The current request uses structured output and Anthropic's server-side fallback feature; model or feature changes require a fresh privacy review.

Before and after the provider call, audio remains local and Whisper transcribes locally. The platform validates model output, requires transcript citations, withholds unsupported items, and stores approved output locally. The provider response is untrusted input; it never authorizes access or changes policy.

## Meeting chat (second data flow, added 2026-10-06)

Meeting chat (`server/chat.js`, `askChat` in `server/platform.js`) is a separate, wider flow than a summary and is off unless `MEETING_CHAT_PROVIDER` names `anthropic`. One question sends one request with:

| Sent | Never sent |
| --- | --- |
| The question (at most 1,000 characters) | Audio, voice data, or raw diarization labels |
| Up to 12 excerpts (each at most 400 characters) from meetings the asker may read at that moment, each labelled `E1`, `E2`, ... with an anonymous meeting letter, the meeting date, and its kind (transcript line with time and anonymous speaker label, or decision, action, risk, question, summary) | Tenant, meeting, recording, segment, or assertion IDs; meeting titles; participant names |
| Up to 4 recent and up to 2 related older question-and-answer pairs from the same user's saved chat (related turns are chosen locally by embedding similarity), only while that user can still read every meeting they drew on and only within the chat retention period | Excerpts from meetings the asker cannot read, other users' chats, consent, audit, or keys |
| Instructions and a strict JSON output schema | Browser-held secrets |

Before sending, excerpts and earlier turns pass the chat guardrail layer: emails, phone numbers, and ID, case, card, and long account numbers are replaced with placeholders (names are not detected). Excerpts can come from several meetings in one request, so approving summaries does not approve chat. The platform keeps only citations that point at excerpts it sent; an answer without valid citations is withheld. Saved turns are deleted with any meeting they drew on.

## Provider evidence to review

The following summarizes current vendor documentation, verified 2026-10-06. It is not legal advice or a substitute for the signed agreement applicable to this organization.

| Topic | Current documented posture | Approval implication |
| --- | --- | --- |
| Training | Anthropic's Commercial Terms state it may not train models on Customer Content from Services. | Use a commercial organization/API account, not a consumer product; prohibit transcript-bearing feedback and bug reports. |
| Default API retention | API inputs and outputs are ordinarily deleted within 30 days. Exceptions include agreed terms, legal requirements, and Usage Policy enforcement. Flagged content may be retained longer. | Explicitly accept the default retention/exceptions or obtain another approved arrangement. |
| Zero data retention (ZDR) | ZDR requires organization-level approval from Anthropic. Eligible Messages API prompts/responses are not stored at rest after response, but safety classifier results remain; legal and misuse exceptions can still apply. | If 30-day retention is unacceptable, engage Anthropic sales/account management and confirm the organization, model, and feature eligibility before enabling the API. |
| Features | Files and Batch Processing are not ZDR eligible. Prompt caching has separate controls and retention characteristics. | Keep the current no-Files/no-Batch/no-cache configuration unless separately approved. |
| Geography | Default inference routing is global. Anthropic documents an `inference_geo: us` control; workspace data at rest is currently US-only and workspace geography is irreversible after creation. | Record the required processing geography. Do not claim local, EU-only, or US-only processing without the corresponding configuration and agreement. |
| Contract and security | The DPA describes the customer as controller and Anthropic as processor, incorporates SCCs, and references subprocessors and security measures. The public Trust Center exposes reports and scope information. | Legal/privacy must review the current DPA, subprocessors, data-transfer basis, and applicable report scope before approval. |

## Required approval decisions

The named owners must answer every item before enabling a production API key.

- [ ] **Purpose and scope:** Approve only summarized intelligence from recordable, consented Meetings. List prohibited classifications and meeting types: _._
- [ ] **Data fields:** Approve the exact outbound fields in the table above; acknowledge that transcript text can contain sensitive or personal information.
- [ ] **Account and contract:** Identify the Anthropic commercial organization, signed terms/DPA version, and legal owner: _._
- [ ] **Retention:** Select one: _default API retention accepted_ / _ZDR required and contract confirmed_ / _other approved written term_. Record exception handling: _._
- [ ] **Model eligibility:** Approve the configured model (`claude-sonnet-5-5` unless changed) and confirm it is permitted under the selected retention profile. Model changes require a new review.
- [ ] **Geography and transfers:** Select _global routing acknowledged_ or record the approved configured region/control and cross-border-transfer basis: _._
- [ ] **Subprocessors and assurance:** Review the current Anthropic subprocessor list and Trust Center materials; record the reviewer, date, and review cadence: _._
- [ ] **Feature boundary:** Prohibit Files, Batches, prompt caching, code execution, web search/fetch, third-party tools, Managed Agents, and transcript-bearing feedback/bug reports unless separately approved.
- [ ] **Security operations:** Keep the API key server-only in protected local configuration; prohibit browser exposure, source-control storage, audit logging, or support-ticket inclusion. Define key custodian and rotation/revocation owner: _._
- [ ] **Lifecycle and incidents:** Confirm internal retention, legal hold, participant notice/consent, output review, provider incident escalation, and offboarding procedures: _._

## Technical conditions to enable the API

1. Keep the server loopback-only until Microsoft Entra identity is implemented.
2. Use a commercial Anthropic organization key in the server's protected local `.env`; never use `VITE_` variables or paste the key into this document.
3. Preserve the current payload minimization and no-feature-expansion boundary described above.
4. Exercise the first API call only with a short, synthetic, non-sensitive recording and verify that citations, withholding, audit behavior, and transcript-only fallback work as expected.
5. Record approval completion in the project change log, then set `ANTHROPIC_API_KEY` locally. Do not commit the key or `.env`.

## Approval record

| Field | Record |
| --- | --- |
| Decision | _Approved / rejected / approved with conditions_ |
| Effective date and review date | _._ |
| Approved classifications / exclusions | _._ |
| Retention profile and exceptions | _._ |
| Geography / transfer basis | _._ |
| Anthropic organization / contract reference | _._ |
| Privacy/legal approver | _._ |
| Security approver | _._ |
| Technical owner | _._ |
| Conditions or required follow-up | _._ |

## Sources

- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [API data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- [Commercial data retention FAQ](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
- [Zero data retention FAQ](https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to)
- [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)
- [Data Processing Addendum](https://www.anthropic.com/legal/data-processing-addendum)
- [Anthropic Trust Center](https://trust.anthropic.com/) and [subprocessors](https://trust.anthropic.com/subprocessors)
