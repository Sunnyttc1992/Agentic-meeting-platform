# OpenAI API processing approval packet

**Status:** Draft. OpenAI-generated meeting intelligence is not approved for real meeting content until this packet is completed. Synthetic test recordings only.

## Decision requested

Approve or reject use of the OpenAI API (Responses API) to derive a cited executive summary, decisions, risks, open questions, and action plan from authorized meeting transcripts. This is the same processing as the Anthropic packet, with a different processor; it does not approve any other OpenAI product or feature.

Until this packet is complete, `OPENAI_API_KEY` may be set only for synthetic test recordings, and must be removed afterwards.

## Exact application boundary

`server/intelligence-openai.js` makes one server-side `responses.create` request for one authorized recording. It uses the same instructions, output schema, and transcript rendering as the Claude adapter (`server/intelligence.js`).

| Sent to OpenAI | Never sent by this integration |
| --- | --- |
| Timestamped transcript text | Audio or audio bytes |
| Anonymous per-meeting speaker labels (`SPEAKER_00`, ...) | Voice embeddings, voiceprints, or raw diarization worker labels |
| Transcript segment IDs and offsets | Participant names |
| Participant IDs | Tenant, meeting, recording, or lease IDs |
| Meeting date | Consent evidence, encryption keys, credentials, audit records, or other meetings |
| Instructions and strict JSON output schema | Browser-held secrets |

Request settings:

- `store: false`. The installed SDK documents that responses are otherwise stored for at least 30 days for later retrieval.
- Strict structured output (`text.format` with `type: json_schema`, `strict: true`).
- No tools, file uploads, vector stores, conversations, background mode, or batch jobs.

The platform treats the response as untrusted: it re-checks every citation, owner, deadline, status, and speaker label, and withholds unsupported items. A refusal, truncated reply, or unfinished response fails closed.


## Review before summarizing (added 2026-10-08)

By default no summary request is sent during processing: the organizer first sees the full transcript and then chooses Summarize, which sends the request described above (with confirmed speaker names, as in regeneration). Each summary request is therefore an explicit organizer action.

## Summary regeneration (added 2026-10-07)

When an organizer rewrites a processed recording's summary, the same summary request is sent again from the stored transcript, with one difference: a speaker that a meeting participant confirmed is shown as `SPEAKER_01, confirmed as <participant ID>` (user decision 2026-10-07). Unconfirmed speakers stay anonymous. The result is validated exactly like the first summary; the organizer triggers each rewrite explicitly.

## Meeting chat (second data flow, added 2026-10-06)

Meeting chat (`server/chat.js`, `askChat` in `server/platform.js`) is a separate, wider flow than a summary and is off unless `MEETING_CHAT_PROVIDER` names `openai`. One question sends one request with:

| Sent | Never sent |
| --- | --- |
| The question (at most 1,000 characters) | Audio, voice data, or raw diarization labels |
| Up to 12 excerpts (each at most 400 characters) from meetings the asker may read at that moment, each labelled `E1`, `E2`, ... with an anonymous meeting letter, the meeting date, and its kind (transcript line with time and speaker, or decision, action, risk, question, summary). The speaker is an anonymous label unless a meeting participant confirmed it, in which case it is that participant's ID marked `(confirmed)` (user decision 2026-10-07) | Tenant, meeting, recording, segment, or assertion IDs; meeting titles; unconfirmed speaker identities |
| Up to 4 recent and up to 2 related older question-and-answer pairs from the same user's saved chat (related turns are chosen locally by embedding similarity), only while that user can still read every meeting they drew on and only within the chat retention period | Excerpts from meetings the asker cannot read, other users' chats, consent, audit, or keys |
| Instructions and a strict JSON output schema | Browser-held secrets |

Before sending, excerpts and earlier turns pass the chat guardrail layer: emails, phone numbers, and ID, case, card, and long account numbers are replaced with placeholders (names are not detected). Excerpts can come from several meetings in one request, so approving summaries does not approve chat. The platform keeps only citations that point at excerpts it sent; an answer without valid citations is withheld. Saved turns are deleted with any meeting they drew on.

Request settings are the same as above: `store: false`, strict structured output, no tools.

## Required approval decisions

- [ ] **Purpose and scope:** approve only summarized intelligence from recordable, consented meetings. Record prohibited classifications and meeting types.
- [ ] **Data fields:** approve the exact outbound fields above.
- [ ] **Retention:** review OpenAI's current API data-retention terms for this account (including abuse-monitoring retention and any zero-data-retention eligibility) and record the accepted profile.
- [ ] **Training:** confirm from the current business terms that API inputs and outputs are not used for training for this account.
- [ ] **Model eligibility:** approve the configured model (`gpt-5.5` unless `OPENAI_SUMMARY_MODEL` changes it). Model changes require a new review.
- [ ] **Contract, region, and transfers:** review the data processing addendum, subprocessors, and data-residency options.
- [ ] **Feature boundary:** prohibit stored responses, tools, file uploads, and feedback containing transcripts unless separately approved.

## Approval record

| Field | Value |
| --- | --- |
| Decision | _Approved / rejected / approved with conditions_ |
| Retention profile | _._ |
| Privacy/legal approver | _._ |
| Security approver | _._ |
| Date | _._ |
