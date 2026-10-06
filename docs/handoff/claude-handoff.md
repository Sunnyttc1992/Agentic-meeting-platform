# Handoff for Claude

Read this whole file, then AGENTS.md, before changing the project.

## Current project state

- Repository: D:\Data Science Project\smart-meeting-platform
- Branch: master
- Last committed implementation checkpoint: b5931f7 Add local offline diarization worker
- Current in-progress, uncommitted work: scripts/setup-windows-diarization.sh, an executable Git-Bash setup wizard; a small worker correction that prefers Community-1's exclusive diarization output; and a README link to the wizard.
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
- python -m py_compile server/diarize_worker.py: passed before the exclusive-track-only logic correction; rerun it.
- A fresh local preview started on 127.0.0.1:4174; GET / returned 200 and authenticated GET /pipeline/readiness returned 200. It reported loopback-only scope, local Whisper available/cached, no Anthropic credential, and Teams disconnected.
- Native browser automation is currently unavailable because its computer-use kernel cannot write its assets. Use local HTTP checks unless that environment issue changes.

## Immediate next action

Review and commit the current wizard, README, worker, and handoff changes as a small checkpoint after running:

    python -m py_compile server/diarize_worker.py
    bash -n scripts/setup-windows-diarization.sh
    npm test
    npm run build
    npm run test:sites

Do not run the wizard yourself: it opens a browser and requires the user's Hugging Face account and an interactive one-time token. Ask the user to run this from Git Bash in the repository:

    bash scripts/setup-windows-diarization.sh

The model card is gated, CC-BY-4.0, and its current offline instructions specify Git LFS and an interactive Hugging Face token prompt. The wizard never writes that token to .env, source, audit, or logs. It writes only the virtual-environment Python, local model directory, and temporary-directory paths to .env.

## After the user provisions the model

1. Restart only the loopback preview server and process a consented, non-sensitive short test recording.
2. Measure CPU runtime first; do not enable a GPU path until its runtime/VRAM behavior is measured on this Windows host. The current worker intentionally uses pyannote's CPU default.
3. Confirm the worker succeeds while offline and that its temporary directory is empty afterwards.
4. Record model Git revision, package versions, model file hashes, license notice, and timings in the protected operator inventory created by the wizard.
5. Build a human correction/mapping UI only after a separate review. It must be per-meeting, reversible, audited without voice embeddings/audio/transcript text, and never provide automatic identity, attendance, authorization, or action ownership.

## Non-negotiable constraints

- No cloud speech-to-text; Whisper runs locally.
- Claude receives only transcript text, participant IDs, and meeting date; credentials stay server-side.
- No secret values in the browser, source control, .env.example, audit events, terminal output, or handoff.
- No voiceprints, speaker enrollment, or automatic name assignment.
- Do not expose the API on the LAN, deploy it, or add Entra/Teams connectivity without a new user decision.
- Keep .openai/hosting.json, worker/index.js, scripts/prepare-sites-build.mjs, and tests/sites-worker.test.mjs intact.
- Commit only scoped, validated changes. Never commit .data/, .cache/, dist/, node_modules/, or real credentials.
