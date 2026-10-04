// Applies PostgreSQL migrations as the schema owner, then grants the
// application role exactly the privileges it needs. The server itself never
// runs migrations and connects as the application role.
//
//   DATABASE_ADMIN_URL=postgres://ledger_owner:...@db.internal:5432/meeting_ledger?sslmode=require \
//   MEETING_DB_APP_ROLE=meeting_app npm run db:migrate
import pg from 'pg'
import { migratePostgres } from './adapters/postgres-schema.js'

const connectionString = process.env.DATABASE_ADMIN_URL
if (!connectionString) {
  console.error('Set DATABASE_ADMIN_URL to a connection for the role that owns the meeting tables.')
  process.exit(1)
}
const appRole = process.env.MEETING_DB_APP_ROLE ?? 'meeting_app'
const client = new pg.Client({ connectionString })
await client.connect()
try {
  const { applied } = await migratePostgres({ query: (text, params) => client.query(text, params), exec: (text) => client.query(text) }, { appRole })
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is already up to date.')
  console.log(`Granted least-privilege access to role "${appRole}".`)
} catch (error) {
  console.error(`Migration failed: ${error.code ?? ''} ${error.message}`)
  process.exitCode = 1
} finally {
  await client.end()
}
