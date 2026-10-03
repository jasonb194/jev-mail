'use strict';

let sqlClient;
let schemaReady;

function sql() {
  if (!sqlClient) {
    const { neon } = require('@neondatabase/serverless');
    if (!process.env.DATABASE_URL) throw new Error('Missing required environment variable: DATABASE_URL');
    sqlClient = neon(process.env.DATABASE_URL);
  }
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const query = sql();
      await query`CREATE TABLE IF NOT EXISTS jev_users (
        google_sub TEXT PRIMARY KEY, email TEXT NOT NULL, settings JSONB NOT NULL,
        google_refresh_token TEXT, provider_api_key TEXT,
        revision INTEGER NOT NULL DEFAULT 1, next_run_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await query`ALTER TABLE jev_users ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1`;
      await query`ALTER TABLE jev_users ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ`;
      await query`ALTER TABLE jev_users ADD COLUMN IF NOT EXISTS next_run_time TIMESTAMPTZ`;
      await query`ALTER TABLE jev_users ADD COLUMN IF NOT EXISTS run_started_at TIMESTAMPTZ`;
      await query`ALTER TABLE jev_users ADD COLUMN IF NOT EXISTS run_source TEXT`;
      await query`ALTER TABLE jev_users ADD COLUMN IF NOT EXISTS gmail_cooldown_until TIMESTAMPTZ`;
      await query`ALTER TABLE jev_users ADD COLUMN IF NOT EXISTS gmail_cooldown_step INTEGER NOT NULL DEFAULT 0`;
      await query`CREATE TABLE IF NOT EXISTS jev_runs (
        id BIGSERIAL PRIMARY KEY, google_sub TEXT NOT NULL REFERENCES jev_users(google_sub) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ NOT NULL, source TEXT NOT NULL,
        outcome TEXT NOT NULL, succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        deferred INTEGER NOT NULL DEFAULT 0, gmail_quota BOOLEAN NOT NULL DEFAULT FALSE,
        cooldown_minutes INTEGER
      )`;
      await query`CREATE INDEX IF NOT EXISTS jev_runs_user_started_idx ON jev_runs (google_sub, started_at DESC)`;
      await query`CREATE TABLE IF NOT EXISTS jev_oauth_states (
        state_hash TEXT PRIMARY KEY, code_verifier TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await query`CREATE INDEX IF NOT EXISTS jev_oauth_states_created_at_idx ON jev_oauth_states (created_at)`;
      await query`DELETE FROM jev_oauth_states WHERE created_at < NOW() - INTERVAL '15 minutes'`;
    })().catch((error) => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

function normalizeUser(row) {
  if (!row) return null;
  let settings = row.settings;
  if (typeof settings === 'string') settings = JSON.parse(settings);
  return { subject: row.google_sub, email: row.email, settings, refreshToken: row.google_refresh_token, providerApiKey: row.provider_api_key, revision: row.revision, nextRunAt: row.next_run_at || row.next_run_time || null };
}

async function userById(subject) {
  await ensureSchema();
  const rows = await sql()`SELECT google_sub, email, settings, google_refresh_token, provider_api_key, revision, next_run_at, next_run_time FROM jev_users WHERE google_sub = ${subject} LIMIT 1`;
  return normalizeUser(rows[0]);
}

async function upsertUser({ subject, email, settings, refreshToken }) {
  await ensureSchema();
  await sql()`INSERT INTO jev_users (google_sub, email, settings, google_refresh_token, updated_at)
    VALUES (${subject}, ${email}, ${JSON.stringify(settings)}::jsonb, ${refreshToken}, NOW())
    ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email,
      google_refresh_token = COALESCE(EXCLUDED.google_refresh_token, jev_users.google_refresh_token), updated_at = NOW()`;
  const rows = await sql()`SELECT settings FROM jev_users WHERE google_sub = ${subject} LIMIT 1`;
  const saved = rows[0] && (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings);
  if (saved && saved.enabled === true) await sql()`UPDATE jev_users SET next_run_at = NOW() WHERE google_sub = ${subject} AND google_refresh_token IS NOT NULL`;
}

async function saveUserSettings({ subject, email, settings, expectedRevision, providerApiKey }) {
  await ensureSchema();
  let rows;
  if (providerApiKey === undefined) {
    rows = await sql()`INSERT INTO jev_users (google_sub, email, settings, revision, updated_at)
      VALUES (${subject}, ${email}, ${JSON.stringify(settings)}::jsonb, 1, NOW())
      ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, settings = EXCLUDED.settings,
        revision = jev_users.revision + 1, updated_at = NOW()
      WHERE jev_users.revision = ${expectedRevision} RETURNING google_sub, email, settings, google_refresh_token, provider_api_key, revision`;
  } else {
    rows = await sql()`INSERT INTO jev_users (google_sub, email, settings, provider_api_key, revision, updated_at)
      VALUES (${subject}, ${email}, ${JSON.stringify(settings)}::jsonb, ${providerApiKey}, 1, NOW())
      ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, settings = EXCLUDED.settings,
        provider_api_key = EXCLUDED.provider_api_key, revision = jev_users.revision + 1, updated_at = NOW()
      WHERE jev_users.revision = ${expectedRevision} RETURNING google_sub, email, settings, google_refresh_token, provider_api_key, revision`;
  }
  const saved = normalizeUser(rows[0]);
  if (saved && saved.refreshToken && saved.settings.enabled) await sql()`UPDATE jev_users SET next_run_at = NOW() WHERE google_sub = ${subject}`;
  if (saved && !saved.settings.enabled) await sql()`UPDATE jev_users SET next_run_at = NULL WHERE google_sub = ${subject}`;
  return saved;
}

async function putOAuthState(stateHash, verifier) {
  await ensureSchema();
  await sql()`DELETE FROM jev_oauth_states WHERE created_at < NOW() - INTERVAL '15 minutes'`;
  await sql()`INSERT INTO jev_oauth_states (state_hash, code_verifier) VALUES (${stateHash}, ${verifier})`;
}

async function takeOAuthState(stateHash) {
  await ensureSchema();
  const rows = await sql()`DELETE FROM jev_oauth_states WHERE state_hash = ${stateHash}
    AND created_at >= NOW() - INTERVAL '15 minutes' RETURNING code_verifier`;
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].code_verifier); } catch (_) { return { verifier: rows[0].code_verifier, returnTo: '/' }; }
}

async function disconnectUser(subject) {
  await ensureSchema();
  await sql()`UPDATE jev_users SET google_refresh_token = NULL, next_run_at = NULL, run_started_at = NULL, run_source = NULL,
    gmail_cooldown_until = NULL, gmail_cooldown_step = 0, updated_at = NOW() WHERE google_sub = ${subject}`;
}

async function claimDueUsers(limit = 1) {
  await ensureSchema();
  return sql()`WITH due AS (
      SELECT google_sub FROM jev_users WHERE google_refresh_token IS NOT NULL
        AND COALESCE((settings->>'enabled')::boolean, false) = true
        AND (next_run_at IS NULL OR next_run_at <= NOW())
        AND (gmail_cooldown_until IS NULL OR gmail_cooldown_until <= NOW())
        AND (run_started_at IS NULL OR run_started_at < NOW() - INTERVAL '6 minutes')
      ORDER BY next_run_at NULLS FIRST LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE jev_users AS users SET next_run_at = NOW() + INTERVAL '1 minute', updated_at = NOW()
    FROM due WHERE users.google_sub = due.google_sub
    RETURNING users.google_sub`;
}

async function scheduleNextRun(subject, intervalMinutes) {
  await ensureSchema();
  await sql()`UPDATE jev_users SET next_run_at = NOW() + (${intervalMinutes} * INTERVAL '1 minute'), updated_at = NOW() WHERE google_sub = ${subject}`;
}

async function claimRun(subject, source) {
  await ensureSchema();
  const rows = await sql()`UPDATE jev_users SET run_started_at = NOW(), run_source = ${source}, updated_at = NOW()
    WHERE google_sub = ${subject} AND (run_started_at IS NULL OR run_started_at < NOW() - INTERVAL '6 minutes')
    RETURNING google_sub`;
  return rows.length > 0;
}

async function finishRun(subject, entry) {
  await ensureSchema();
  await sql()`INSERT INTO jev_runs (google_sub, started_at, ended_at, source, outcome, succeeded, failed, deferred, gmail_quota, cooldown_minutes)
    VALUES (${subject}, ${new Date(entry.startedAt)}, ${new Date(entry.endedAt)}, ${entry.source}, ${entry.outcome},
      ${entry.succeeded || 0}, ${entry.failed || 0}, ${entry.deferred || 0}, ${entry.gmailQuota === true}, ${entry.cooldownMinutes || null})`;
  await sql()`DELETE FROM jev_runs WHERE google_sub = ${subject}
    AND id NOT IN (SELECT id FROM jev_runs WHERE google_sub = ${subject} ORDER BY ended_at DESC LIMIT 100)`;
}

async function latestRun(subject) {
  await ensureSchema();
  const rows = await sql()`SELECT started_at, ended_at, source, outcome, succeeded, failed, deferred, gmail_quota, cooldown_minutes
    FROM jev_runs WHERE google_sub = ${subject} ORDER BY ended_at DESC LIMIT 1`;
  return rows[0] || null;
}

async function recentRuns(subject, limit = 20) {
  await ensureSchema();
  return sql()`SELECT started_at, ended_at, source, outcome, succeeded, failed, deferred, gmail_quota, cooldown_minutes
    FROM jev_runs WHERE google_sub = ${subject} ORDER BY started_at DESC LIMIT ${limit}`;
}

async function runningRun(subject) {
  await ensureSchema();
  const rows = await sql()`SELECT run_started_at, run_source FROM jev_users WHERE google_sub = ${subject}
    AND run_started_at >= NOW() - INTERVAL '6 minutes' LIMIT 1`;
  return rows[0] ? { source: rows[0].run_source, startedAt: new Date(rows[0].run_started_at).getTime() } : null;
}

async function cooldownState(subject) {
  await ensureSchema();
  const rows = await sql()`SELECT gmail_cooldown_until FROM jev_users WHERE google_sub = ${subject} LIMIT 1`;
  const until = rows[0] && rows[0].gmail_cooldown_until ? new Date(rows[0].gmail_cooldown_until).getTime() : null;
  return { active: until !== null && until > Date.now(), until: until !== null && until > Date.now() ? until : null };
}

async function recordQuotaError(subject, durations) {
  await ensureSchema();
  const safe = Array.isArray(durations) && durations.length === 3 ? durations : [15, 30, 60];
  await sql()`UPDATE jev_users SET
    gmail_cooldown_until = NOW() + ((CASE WHEN gmail_cooldown_step <= 0 THEN ${safe[0]} WHEN gmail_cooldown_step = 1 THEN ${safe[1]} ELSE ${safe[2]} END) * INTERVAL '1 minute'),
    gmail_cooldown_step = LEAST(gmail_cooldown_step + 1, 2), updated_at = NOW()
    WHERE google_sub = ${subject}`;
}

async function clearQuotaCooldown(subject) {
  await ensureSchema();
  await sql()`UPDATE jev_users SET gmail_cooldown_until = NULL, gmail_cooldown_step = 0, updated_at = NOW() WHERE google_sub = ${subject}`;
}

async function clearRunStarted(subject) {
  await ensureSchema();
  await sql()`UPDATE jev_users SET run_started_at = NULL, run_source = NULL, updated_at = NOW() WHERE google_sub = ${subject}`;
}

module.exports = { ensureSchema, userById, upsertUser, saveUserSettings, putOAuthState, takeOAuthState, disconnectUser, claimDueUsers, scheduleNextRun, claimRun, finishRun, latestRun, recentRuns, runningRun, cooldownState, recordQuotaError, clearQuotaCooldown, clearRunStarted };
