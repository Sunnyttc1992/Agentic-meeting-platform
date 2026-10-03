# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Durable Product Decisions

- Before token or session limits could interrupt validated work, create a safe Git checkpoint. Exclude `node_modules/`, caches, `dist`/build artifacts, and all secrets unless the user explicitly requests otherwise.
- The approved prototype direction is the Executive Ledger experience: restrained graphite surfaces, warm metallic accents, editorial typography, evidence-linked intelligence, and executive-level information density. Preserve this visual language unless the user explicitly changes direction.
- Speech-to-text is local Whisper running on our own server (2026-10-03): meeting audio never leaves the machine. Do not switch to a cloud speech service without the user's explicit decision.
- The summary, decisions, risks, questions, and action plan are written by Claude through the Anthropic API (2026-10-03). Only transcript text, participant IDs, and the meeting date are sent; credentials stay server-side and never reach the browser.
- Local storage is durable (2026-10-03): meetings, consent, transcripts, action plans, and audit persist in a SQLite file in the Git-ignored `.data/` folder (built-in `node:sqlite`). Recording audio is encrypted with AES-256-GCM using a generated key file in `.data/keys/`. Never commit `.data/`. Production still moves to PostgreSQL, object storage, and KMS.
- Delivery for now is a working end-to-end pipeline restricted to this machine (loopback only) until Microsoft Entra sign-in replaces the development identity headers. Do not expose the API on a LAN or deploy it before Entra exists.
- Microsoft Teams is the first meeting-platform integration. Do not retain Zoom routes, UI, terminology, or claims. Keep the Teams connector explicitly unconnected until a production server-side Entra/OAuth application and secret-manager configuration exist.
