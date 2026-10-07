import { invariant } from '../errors.js'

// Versioned PostgreSQL schema for meeting-ledger-v1. Migrations run once, in
// order, under an advisory lock (so two servers starting together cannot race),
// each in its own transaction, by an administrative role that owns the tables.
// The application connects as a separate, non-owner, non-superuser role that
// receives only the privileges below: row-level security keyed to
// \`app.tenant_id\` is then enforced by the database itself, independently of
// the application's own tenant checks.
// The first migration's tables are frozen: its SQL is generated from this list
// and must never change once applied. Later tables are added per migration.
const V1_TENANT_TABLES = Object.freeze(['meetings', 'recordings', 'recording_content', 'transcript_segments', 'knowledge_assertions', 'commitments', 'audit_events', 'outbox_events'])
const TENANT_TABLES = Object.freeze([...V1_TENANT_TABLES, 'chat_turns'])
const rowLevelSecurity = (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));`
const MIGRATION_LOCK = 7_274_201

export const POSTGRES_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: '001_meeting_ledger_v1',
    sql: `
CREATE TABLE meetings (
  tenant_id text NOT NULL, id text NOT NULL, row_seq bigserial, doc jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE recordings (
  tenant_id text NOT NULL, id text NOT NULL, meeting_id text NOT NULL, row_seq bigserial, doc jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX recordings_by_meeting ON recordings (tenant_id, meeting_id, row_seq);
CREATE TABLE recording_content (
  tenant_id text NOT NULL, recording_id text NOT NULL, key_version integer NOT NULL,
  nonce bytea NOT NULL, tag bytea NOT NULL, ciphertext bytea NOT NULL,
  PRIMARY KEY (tenant_id, recording_id),
  FOREIGN KEY (tenant_id, recording_id) REFERENCES recordings (tenant_id, id)
);
CREATE TABLE transcript_segments (seq bigserial PRIMARY KEY, tenant_id text NOT NULL, meeting_id text NOT NULL, doc jsonb NOT NULL);
CREATE INDEX transcript_segments_by_meeting ON transcript_segments (tenant_id, meeting_id, seq);
CREATE TABLE knowledge_assertions (seq bigserial PRIMARY KEY, tenant_id text NOT NULL, meeting_id text NOT NULL, doc jsonb NOT NULL);
CREATE INDEX knowledge_assertions_by_meeting ON knowledge_assertions (tenant_id, meeting_id, seq);
CREATE TABLE commitments (
  tenant_id text NOT NULL, meeting_id text NOT NULL, assertion_id text NOT NULL, row_seq bigserial, doc jsonb NOT NULL,
  PRIMARY KEY (tenant_id, meeting_id, assertion_id)
);
CREATE TABLE audit_events (
  tenant_id text NOT NULL, sequence bigint NOT NULL, meeting_id text, doc jsonb NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
);
CREATE INDEX audit_events_by_meeting ON audit_events (tenant_id, meeting_id, sequence);
CREATE TABLE outbox_events (
  tenant_id text NOT NULL, idempotency_key text NOT NULL, row_seq bigserial, doc jsonb NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- The audit trail is append-only for every role, including the table owner.
CREATE FUNCTION meeting_ledger_reject_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END
$$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION meeting_ledger_reject_audit_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_ledger_reject_audit_change();
${V1_TENANT_TABLES.map(rowLevelSecurity).join('\n')}
`,
  }),
  Object.freeze({
    version: '002_chat_turns',
    sql: `
CREATE TABLE chat_turns (seq bigserial PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, doc jsonb NOT NULL);
CREATE INDEX chat_turns_by_user ON chat_turns (tenant_id, user_id, seq);
${rowLevelSecurity('chat_turns')}
`,
  }),
])

// The oldest schema this server still serves. A database on it works, except
// that saved chat reports CHAT_NOT_MIGRATED until the migrations are run.
const MINIMUM_SERVING_MIGRATION = '001_meeting_ledger_v1'

export const LATEST_POSTGRES_MIGRATION = POSTGRES_MIGRATIONS.at(-1).version

const quoteIdentifier = (name) => {
  invariant(typeof name === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(name), 'INVALID_STORAGE_ADAPTER', 'Database role names must be lower-case identifiers', 500)
  return `"${name}"`
}

// Applies pending migrations and grants the application role exactly what it
// needs: read/write on tenant tables, but only SELECT and INSERT on the audit
// trail. `client` needs `query(text, params)` and `exec(text)`.
export async function migratePostgres(client, { appRole = null } = {}) {
  await client.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK])
  const applied = []
  try {
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((row) => row.version))
    const unknown = [...done].filter((version) => !POSTGRES_MIGRATIONS.some((migration) => migration.version === version))
    invariant(unknown.length === 0, 'UNSUPPORTED_STORAGE_MODEL', 'The database has migrations this server does not know; refusing to run against a newer schema', 500)
    for (const migration of POSTGRES_MIGRATIONS) {
      if (done.has(migration.version)) continue
      await client.exec('BEGIN')
      try {
        await client.exec(migration.sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version])
        await client.exec('COMMIT')
      } catch (error) {
        await client.exec('ROLLBACK')
        throw error
      }
      applied.push(migration.version)
    }
    if (appRole) {
      const role = quoteIdentifier(appRole)
      const writable = TENANT_TABLES.filter((table) => table !== 'audit_events')
      await client.exec(`
GRANT SELECT, INSERT, UPDATE, DELETE ON ${writable.join(', ')} TO ${role};
GRANT SELECT, INSERT ON audit_events TO ${role};
GRANT SELECT ON schema_migrations TO ${role};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM ${role};`)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK])
  }
  return Object.freeze({ applied })
}

// Used by the application role at startup: refuses a database that is behind
// (not migrated) or ahead (migrated by a newer server) of this code.
export async function assertPostgresSchemaCurrent(client) {
  let versions = []
  try {
    versions = (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((row) => row.version)
  } catch {
    // No migrations table (or no access to it) means an unmigrated database.
  }
  const known = POSTGRES_MIGRATIONS.map((migration) => migration.version)
  const servable = known.slice(known.indexOf(MINIMUM_SERVING_MIGRATION))
  invariant(versions.length > 0 && servable.includes(versions.at(-1)) && versions.every((version, index) => version === known[index]),
    'UNSUPPORTED_STORAGE_MODEL', 'The database schema does not match this server; run the database migrations first', 500)
}

// Row-level security means nothing for a superuser, a role with BYPASSRLS, or
// the tables' owner (who could disable it). The application must therefore
// connect as a separate least-privilege role; refuse to start otherwise.
export async function assertLeastPrivilegeRole(client) {
  const role = (await client.query('SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0]
  invariant(role && !role.rolsuper && !role.rolbypassrls, 'INSECURE_DATABASE_ROLE', 'The application must not connect as a superuser or a role that bypasses row-level security', 500)
  const owned = (await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'meetings' AND tableowner = current_user")).rows[0].n
  invariant(owned === 0, 'INSECURE_DATABASE_ROLE', 'The application must not connect as the owner of the meeting tables', 500)
}
