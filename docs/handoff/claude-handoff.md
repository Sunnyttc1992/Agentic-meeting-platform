# Handoff for Claude

Read this whole file, then AGENTS.md, before changing the project.

## Current project state

- Repository: D:\Data Science Project\smart-meeting-platform
- Branch: master
- Last committed implementation checkpoint: 771c4ec Add Windows diarization provisioning wizard
- The diarization worker, Windows provisioning wizard, worker correction, README link, and this handoff are committed. The worktree should be clean except for the intentionally untracked local-only paths listed below.
- Do not commit unrelated pre-existing untracked paths: .copilot/, .github/skills/secret-handling/, .npmrc, .prototype-seed/, .squad/, .vscode/, design-qa.md, or implementation-1440x1024.png.

The user explicitly approved the local pyannote Community-1 pilot. Microsoft Entra remains deferred until the company decides on rollout. PostgreSQL remains self-hosted and local on Windows; do not switch to Supabase or another hosted database. The app stays loopback-only.

## What has been completed

1. Windows PostgreSQL operations guide, backup script, and repeatable setup flow.
2. Anthropic API processing approval packet. It documents the allowed outbound data and requires organizational approval before real meeting use.
3. Entra rollout deferral recorded in AGENTS.md.
4. Local diarization research in docs/architecture/local-speaker-diarization-options.md.
5. Local offline diarization adapter:
   - server/diarization.js creates a per-job temporary directory, invokes a Python worker without a shell, validates a strict bounded JSON result, and removes plaintext temporary input/output in finally.
   - server/diarize_worker.py loads only an operator-provisioned local model. It sets offline/telemetry-disable environment flags and emits anonymous time ranges. It now prefers Community-1's exclusive diarization track for transcript reconciliation.
   - server/speech.js applies the anonymous label with the greatest timestamp overlap. It assigns no identity or confidence.
   - The platform remains the enforcement boundary: a participant identity can only originate from separately authorized exact roster evidence.
   - The adapter is inactive unless both DIARIZATION_PYTHON and DIARIZATION_MODEL_DIR are set.
6. The two time-sensitive storage tests now use a fixed clock rather than expiring with the real date.

## Validation already performed

- npm test: 178 passing tests after the fixed-clock correction.
- npm run build: passed.
- npm run test:sites: passed.
- bash -n scripts/setup-windows-diarization.sh: passed.
- python -m py_compile server/diarize_worker.py: passed (rerun 2026-10-06 after the exclusive-track-only correction).
- 2026-10-06 recheck: npm test 178/178, npm run build, npm run test:sites 4/4, and bash -n on the wizard all passed.
- A fresh local preview started on 127.0.0.1:4174; GET / returned 200 and authenticated GET /pipeline/readiness returned 200. It reported loopback-only scope, local Whisper available/cached, no Anthropic credential, and Teams disconnected.
- Native browser automation is currently unavailable because its computer-use kernel cannot write its assets. Use local HTTP checks unless that environment issue changes.

## Diarization pilot status (2026-10-06)

The user provisioned Community-1 with the wizard. Assets live outside the repository in D:/MeetingLedger/diarization (runtime/, speaker-diarization-community-1/ at revision 3533c8cf, tmp/, community-1-inventory.txt). .env sets DIARIZATION_PYTHON, DIARIZATION_MODEL_DIR, and MEETING_DIARIZATION_TEMP_DIR. No Hugging Face token was found in .env, the inventory, or the model's Git config.

Wizard fixes made during provisioning:
- From PowerShell, plain `bash` opens WSL, where Windows paths don't resolve. The wizard now exits early outside Git Bash. Run it with `& "C:\Program Files\Gitinash.exe" scripts/setup-windows-diarization.sh`.
- Pasted Windows paths (backslashes, quotes) are normalized.
- VS Code's terminal routes Git credential prompts to an editor pop-up via GIT_ASKPASS. The clone now unsets that, so the prompt stays in the terminal (not yet exercised interactively).
- The worker decodes the server's validated PCM WAV with Python's `wave` module and passes an in-memory waveform to pyannote. FFmpeg is not installed on this host and is no longer needed.

Validation on a synthetic two-voice Windows TTS WAV (35.4 s; no real meeting audio):
- Worker on CPU (torch 2.14.1+cpu, 8 threads, no CUDA): 21.9 s cold; 16.0 s inference (real-time factor 0.45).
- Full in-memory pipeline (local Whisper + pyannote, Claude deliberately disabled): completed in 36.9 s. 7/7 segments were attributed to the correct voice with anonymous labels, verifiedParticipantId=null, identityConfidence=null, binding unverified-diarization-only.
- The diarization temporary directory was empty afterwards. Offline was enforced by the worker's HF offline environment flags; no firewall-level test was done.
- Timings, licence notice, and worker commit were appended to the operator inventory.
- The loopback preview was restarted on 127.0.0.1:4174 with diarization active (storage: PostgreSQL via DATABASE_URL). /pipeline/readiness now reports diarization status.

## Next actions

1. Optional: test with one consented, non-sensitive real recording through the UI. CPU diarization of a one-hour meeting is estimated at about 27 minutes in addition to Whisper.
2. Do not enable a GPU path until its runtime/VRAM behavior is measured on this host.
3. Done (2026-10-06): /pipeline/readiness reports diarization.configured, runtimeAvailable, and modelReady as booleans only (file-existence checks; no paths, no Python start).
4. Build a human correction/mapping UI only after a separate review. It must be per-meeting, reversible, audited without voice embeddings/audio/transcript text, and never provide automatic identity, attendance, authorization, or action ownership.

## Non-negotiable constraints

- No cloud speech-to-text; Whisper runs locally.
- Claude receives only transcript text, participant IDs, and meeting date; credentials stay server-side.
- No secret values in the browser, source control, .env.example, audit events, terminal output, or handoff.
- No voiceprints, speaker enrollment, or automatic name assignment.
- Do not expose the API on the LAN, deploy it, or add Entra/Teams connectivity without a new user decision.
- Keep .openai/hosting.json, worker/index.js, scripts/prepare-sites-build.mjs, and tests/sites-worker.test.mjs intact.
- Commit only scoped, validated changes. Never commit .data/, .cache/, dist/, node_modules/, or real credentials.
