import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConfiguredStorage } from './storage-config.js'

test('PostgreSQL configuration refuses a missing audio-key setting before opening storage', async () => {
  await assert.rejects(
    openConfiguredStorage({ env: { DATABASE_URL: 'postgres://meeting_app@localhost/meeting_ledger' }, root: tmpdir() }),
    /MEETING_AUDIO_KEY_FILE is required/,
  )
})

test('PostgreSQL configuration never creates a replacement key when the configured file is unavailable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-ledger-config-'))
  const missingKey = join(directory, 'missing-audio.key')
  try {
    await assert.rejects(
      openConfiguredStorage({
        env: { DATABASE_URL: 'postgres://meeting_app@localhost/meeting_ledger', MEETING_AUDIO_KEY_FILE: missingKey },
        root: directory,
      }),
      { code: 'INVALID_STORAGE_KEY' },
    )
    assert.equal(existsSync(missingKey), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

