# Production launch gate

This service must remain loopback-only until every applicable gate below has an accountable owner and recorded approval. Passing tests or a successful local preview does not satisfy these gates.

## Infrastructure

- [ ] Named Windows production host and service account approved.
- [ ] PostgreSQL runs with TLS, `meeting_app` least privilege, RLS, encrypted backups, and a tested restore.
- [ ] Recording-audio key is outside the repository, ACL-restricted, escrowed, and its key version is recorded.
- [ ] Retention sweep, daily `VACUUM (ANALYZE)`, backup rotation, restore reconciliation, disk/connection/audit alerts, and an operational owner are scheduled.
- [ ] Loopback-only binding remains enabled until Entra sign-in is validated. A network exposure review approves any later binding change.

## Identity and meeting integration

- [ ] Organization approves Microsoft Entra rollout and supplies tenant ID, app/client ID, redirect URI, permitted audiences, and a server-side certificate or secret through its secret manager.
- [ ] Entra sign-in, issuer/audience validation, tenant mapping, token expiry/revocation, and authorization tests are implemented and validated against the production tenant.
- [ ] Microsoft Teams is connected only after an Entra application and approved delegated/application permissions exist. No client secret reaches the browser.

## External model and privacy approvals

- [ ] The applicable OpenAI or Anthropic approval packet is signed for real meetings, including allowed data, provider retention, incident handling, and deletion expectations.
- [ ] The provider credential is stored only in the server-side secret manager. The configured provider is verified with synthetic data first.
- [ ] Participant notice, consent language, retention periods, legal-hold process, and support/escalation owner are approved.
- [ ] Any future vector/embedding index has tenant isolation, deletion/backup reconciliation, and an approved data-flow review before it receives meeting text.

## Evidence required before launch

- [ ] Current full automated suite, production build, and Sites packaging pass from the release commit.
- [ ] A consented synthetic end-to-end run proves recording, local transcription, diarization, permitted summary processing, citations, retrieval, stop/discard, deletion, audit integrity, backup, and restore reconciliation. `npm run smoke:browser` is the isolated browser capture portion only; it does not replace the complete processing/restore drill.
- [ ] Security owner signs the release evidence and records the release commit, environment, time, and rollback plan in the protected operations record.

## Repeatable technical evidence

From a clean release checkout, run the following before the security review:

```powershell
npm run verify:release -- --preview=4173
```

The command runs the full automated suite, build, and Sites packaging check; verifies the required output files; checks an already-running loopback preview when `--preview` is supplied; and prints a JSON evidence record without reading or printing `.env`, connection strings, passwords, API keys, audio-key bytes, transcript text, or meeting data. Capture that output in the protected operations record with the release commit. A `technical-evidence-passed` verdict does **not** complete any manual launch gate above.

For a browser-level synthetic capture check that cannot use the configured database, run:

```powershell
npm run smoke:browser
```

It starts a temporary SQLite-backed loopback server **without loading `.env`**, drives headless Chrome through creating a meeting, consent, policy check, microphone capture, and stop/review, then stops the server and deletes its temporary SQLite data. To also exercise local Whisper using synthetic audio, run `npm run smoke:browser -- -ProcessRecording`; it asserts a completed local transcript with at least one segment. Never point the smoke runner at a server that holds real meetings.

Do not record or process real meeting content, enable Teams, or expose the API externally until all relevant boxes are complete.
