import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalPreviewServer } from './local-preview.js'

const organizer = { tenantId: 'northstar', userId: 'alex' }
const participant = { tenantId: 'northstar', userId: 'sam' }

function headers(actor, correlationId) {
  return {
    'content-type': 'application/json',
    'x-tenant-id': actor.tenantId,
    'x-user-id': actor.userId,
    'x-correlation-id': correlationId,
  }
}

async function withPreview(run) {
  const clientRoot = await mkdtemp(join(tmpdir(), 'meeting-preview-'))
  await writeFile(join(clientRoot, 'index.html'), '<!doctype html><title>Meeting preview</title>')
  await writeFile(join(clientRoot, 'app.js'), 'window.previewReady = true')
  const server = createLocalPreviewServer({ clientRoot })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(clientRoot, { recursive: true, force: true })
  }
}

const consent = (actor) => {
  const now = Date.now()
  return {
    participantId: actor.userId,
    capturedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    policyVersion: 'v1',
    decision: 'granted',
    method: 'explicit',
  }
}

test('local preview serves the client and its same-origin recording API', async () => {
  await withPreview(async (base) => {
    const shell = await fetch(`${base}/`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /Meeting preview/)

    const asset = await fetch(`${base}/app.js`)
    assert.equal(asset.status, 200)
    assert.match(await asset.text(), /previewReady/)

    for (const actor of [organizer, participant]) {
      const response = await fetch(`${base}/meetings/meeting-1/consent`, {
        method: 'POST', headers: headers(actor, `consent-${actor.userId}`), body: JSON.stringify(consent(actor)),
      })
      assert.equal(response.status, 204)
    }
    const preflight = await fetch(`${base}/meetings/meeting-1/recording/preflight`, {
      method: 'POST', headers: headers(organizer, 'preview-preflight'), body: '{}',
    })
    assert.equal(preflight.status, 200)
    assert.equal((await preflight.json()).status, 'authorized')

    const unknownApi = await fetch(`${base}/meetings/meeting-1/unknown`, {
      headers: headers(organizer, 'preview-missing-route'),
    })
    assert.equal(unknownApi.status, 404)
    assert.equal((await unknownApi.json()).error.code, 'NOT_FOUND')

    const briefing = await fetch(`${base}/management-briefing`, {
      headers: headers({ tenantId: 'northstar', userId: 'outsider' }, 'preview-briefing'),
    })
    assert.equal(briefing.status, 200)
    assert.deepEqual(await briefing.json(), {
      briefing: { counts: { decisions: 0, risks: 0, blockers: 0, openActions: 0 }, decisions: [], risks: [], blockers: [], actions: [] },
    })

    const readiness = await fetch(`${base}/pipeline/readiness`, {
      headers: headers(organizer, 'preview-pipeline-readiness'),
    })
    assert.equal(readiness.status, 200)
    const readinessBody = await readiness.json()
    assert.equal(readinessBody.scope, 'loopback-only')
    assert.equal(typeof readinessBody.whisper.runtimeAvailable, 'boolean')
    assert.equal(typeof readinessBody.whisper.modelCacheReady, 'boolean')
    assert.equal(typeof readinessBody.anthropic.credentialsConfigured, 'boolean')
    assert.equal(readinessBody.teams.connection, 'not-connected')
  })
})

test('local preview rejects malformed paths without falling back and continues serving the shell and API', async () => {
  await withPreview(async (base) => {
    const malformed = await fetch(`${base}/%ZZ`)
    assert.equal(malformed.status, 400)
    assert.equal(await malformed.text(), 'Malformed request path')

    const shell = await fetch(`${base}/`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /Meeting preview/)

    for (const actor of [organizer, participant]) {
      const response = await fetch(`${base}/meetings/meeting-1/consent`, {
        method: 'POST', headers: headers(actor, `malformed-path-consent-${actor.userId}`), body: JSON.stringify(consent(actor)),
      })
      assert.equal(response.status, 204)
    }
    const preflight = await fetch(`${base}/meetings/meeting-1/recording/preflight`, {
      method: 'POST', headers: headers(organizer, 'malformed-path-preflight'), body: '{}',
    })
    assert.equal(preflight.status, 200)
    assert.equal((await preflight.json()).status, 'authorized')
  })
})
