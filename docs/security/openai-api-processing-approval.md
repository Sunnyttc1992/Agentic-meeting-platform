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
