import { join } from 'node:path'
import { readAudioKeyFile } from './adapters/audio-encryption.js'
import { connectPostgresStorage } from './adapters/postgres.js'
import { openLocalDurableStorage } from './adapters/sqlite.js'

// Chooses the storage backend from the environment:
// - DATABASE_URL set: self-hosted PostgreSQL. MEETING_AUDIO_KEY_FILE is then
//   required; a missing key is a configuration error, never a reason to
//   generate a new key that would make earlier audio unreadable.
// - otherwise: the local SQLite file in MEETING_DATA_DIR (default .data/).
// Returns a description safe to log (never a connection string or key).
export async function openConfiguredStorage({ env = process.env, root }) {
  if (env.DATABASE_URL) {
    if (!env.MEETING_AUDIO_KEY_FILE) throw new Error('MEETING_AUDIO_KEY_FILE is required with DATABASE_URL: point it at the 32-byte recording audio key.')
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX ?? 10) })
    const { storage } = await connectPostgresStorage({ pool, audioKey: readAudioKeyFile(env.MEETING_AUDIO_KEY_FILE) })
    return { storage, description: 'PostgreSQL (DATABASE_URL)' }
  }
  const directory = env.MEETING_DATA_DIR ?? join(root, '.data')
  return { storage: openLocalDurableStorage({ directory }).storage, description: `local SQLite (${directory})` }
}
