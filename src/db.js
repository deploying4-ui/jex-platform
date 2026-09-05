// Neon Postgres. Same exported function names as the old SQLite version
// so routes barely changed — every call site just gained an `await`.
//
// Neon requires SSL; `rejectUnauthorized: false` matches what Neon's own
// connection docs recommend for the pooled connection string (their certs
// chain to a CA your Node install may not have — this isn't "skip TLS",
// it's "don't fail on that specific chain check").

const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('./config');

if (!config.database.url) {
  console.warn(
    '[db] DATABASE_URL is not set. Add your Neon connection string to src/config.js ' +
    '(config.database.url) or a DATABASE_URL env var before starting the server.'
  );
}

const pool = new Pool({
  connectionString: config.database.url,
  ssl: { rejectUnauthorized: false },
});

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex'); // 8 hex chars
}

async function ensureColumn(table, column, definition) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (rows.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Runs schema creation + lightweight migrations. Call once at startup
// (server.js awaits this before app.listen) — every function below
// assumes the schema already exists.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email             TEXT UNIQUE NOT NULL,
      password_hash     TEXT NOT NULL,
      verified          INTEGER NOT NULL DEFAULT 0,
      otp_code          TEXT,
      otp_expires_at    BIGINT,
      otp_last_sent_at  BIGINT,
      plan              TEXT NOT NULL DEFAULT 'none',
      created_at        BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id),
      bot_slug             TEXT NOT NULL,
      app_name             TEXT NOT NULL,
      heroku_app_setup_id  TEXT,
      status               TEXT NOT NULL DEFAULT 'pending',
      heroku_app_url       TEXT,
      failure_message      TEXT,
      created_at           BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );
  `);

  await ensureColumn('users', 'last_free_claim_at', 'BIGINT');

  // Additive-only migrations — an existing database from an earlier
  // version keeps working without a manual reset.
  await ensureColumn('users', 'coins', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'coins_expire_at', 'BIGINT');
  await ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'referral_code', 'TEXT');
  await ensureColumn('users', 'referred_by', 'INTEGER');
  await ensureColumn('users', 'referral_rewarded_at', 'BIGINT');
  await ensureColumn('deployments', 'coins_charged', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('deployments', 'last_charged_at', 'BIGINT');

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deployments_user_id ON deployments(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deployments_bot_slug_status ON deployments(bot_slug, status)`);

  // Backfill referral codes for any pre-existing rows that predate the column.
  const { rows: missingCode } = await pool.query(`SELECT id FROM users WHERE referral_code IS NULL`);
  for (const row of missingCode) {
    await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [generateReferralCode(), row.id]);
  }
}

// ── Users ───────────────────────────────────────────────

async function createUser({ email, passwordHash, startingCoins = 0, referredBy = null }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, coins, referral_code, referred_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [email.toLowerCase().trim(), passwordHash, startingCoins, generateReferralCode(), referredBy, Date.now()]
  );
  return getUserById(rows[0].id);
}

async function getUserById(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase().trim()]);
  return rows[0] || null;
}

async function getUserByReferralCode(code) {
  if (!code) return null;
  const { rows } = await pool.query(`SELECT * FROM users WHERE referral_code = $1`, [code.trim()]);
  return rows[0] || null;
}

async function setOtp(userId, { code, expiresAt }) {
  await pool.query(
    `UPDATE users SET otp_code = $1, otp_expires_at = $2, otp_last_sent_at = $3 WHERE id = $4`,
    [code, expiresAt, Date.now(), userId]
  );
}

async function clearOtp(userId) {
  await pool.query(`UPDATE users SET otp_code = NULL, otp_expires_at = NULL WHERE id = $1`, [userId]);
}

async function markVerified(userId) {
  await pool.query(`UPDATE users SET verified = 1 WHERE id = $1`, [userId]);
}

async function setPlan(userId, plan) {
  await pool.query(`UPDATE users SET plan = $1 WHERE id = $2`, [plan, userId]);
}

async function setAdmin(userId, isAdmin) {
  await pool.query(`UPDATE users SET is_admin = $1 WHERE id = $2`, [isAdmin ? 1 : 0, userId]);
}

async function updatePassword(userId, passwordHash) {
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
}

// ── Settings (key/value) ─────────────────────────────────
// Small live-editable overrides — currently just the Heroku API key, so
// an admin can rotate it from the UI without touching config.js or
// redeploying. NULL/missing means "no override, use the config.js default".

async function getSetting(key) {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// ── Free JC claim ────────────────────────────────────────
// A small periodic top-up separate from purchases/referrals — 1 JC,
// claimable once every FREE_CLAIM_INTERVAL_DAYS. Doesn't touch
// coins_expire_at (addCoins, not addCoinsWithExpiry): this is a habitual
// trickle amount, not tied to the bigger package-expiry system.

function freeClaimEligibleAt(lastClaimAt, intervalDays) {
  if (!lastClaimAt) return 0; // never claimed -> eligible now
  return Number(lastClaimAt) + intervalDays * 24 * 60 * 60 * 1000;
}

async function claimFreeCoin(userId, amount, intervalDays) {
  const user = await getUserById(userId);
  const eligibleAt = freeClaimEligibleAt(user.last_free_claim_at, intervalDays);
  if (Date.now() < eligibleAt) {
    return { claimed: false, eligibleAt };
  }
  await pool.query(`UPDATE users SET coins = coins + $1, last_free_claim_at = $2 WHERE id = $3`, [
    amount,
    Date.now(),
    userId,
  ]);
  return { claimed: true, eligibleAt: null };
}

// Plain top-up — balance changes, expiry doesn't. Used for referral
// bonuses and for admin corrections where you don't want to touch expiry.
async function addCoins(userId, amount) {
  await pool.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [amount, userId]);
  return getUserById(userId);
}

// Adds coins AND pushes the expiry out — used for the starter grant and
// for purchased packages. If the account already has a later expiry
// than this grant would set, the later date wins (a purchase never
// shortens how long your existing balance is good for).
async function addCoinsWithExpiry(userId, amount, expiryDays) {
  const newExpiry = Date.now() + expiryDays * 24 * 60 * 60 * 1000;
  await pool.query(
    `UPDATE users
     SET coins = coins + $1,
         coins_expire_at = GREATEST(COALESCE(coins_expire_at, 0), $2)
     WHERE id = $3`,
    [amount, newExpiry, userId]
  );
  return getUserById(userId);
}

// Atomic check-then-deduct as a single conditional UPDATE, so it's safe
// under real concurrency — Postgres connections really do interleave,
// so the WHERE clause does the work.
async function deductCoinsIfSufficient(userId, amount) {
  const { rows } = await pool.query(
    `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING id`,
    [amount, userId]
  );
  return rows.length > 0;
}

// Sweeps every user whose coin balance has passed its expiry date and
// zeroes it out. Meant to be called periodically (see services/billing.js).
async function expireStaleCoins() {
  const { rows } = await pool.query(
    `UPDATE users
     SET coins = 0
     WHERE coins_expire_at IS NOT NULL AND coins_expire_at < $1 AND coins > 0
     RETURNING id`,
    [Date.now()]
  );
  return rows.length;
}

// Rewards the referrer once, the first time the referred user verifies.
// Wrapped in a real transaction (BEGIN/COMMIT on a dedicated client) so
// the coin credit and the rewarded_at flag always commit together.
async function rewardReferrerIfDue(newUser, bonusCoins) {
  if (!newUser.referred_by || newUser.referral_rewarded_at) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonusCoins, newUser.referred_by]);
    await client.query(`UPDATE users SET referral_rewarded_at = $1 WHERE id = $2`, [Date.now(), newUser.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function countReferrals(userId) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE referred_by = $1`, [userId]);
  return parseInt(rows[0].n, 10);
}

// ── Deployments ─────────────────────────────────────────
// Note what is *not* stored here: SESSION_ID and any other env values the
// user enters are forwarded straight to Heroku's API and never written to
// this database — only metadata about the deployment attempt is kept.
//
// status: 'pending' | 'succeeded' | 'failed' | 'stopped'
// 'stopped' means the app was scaled to zero dynos — either the user
// chose to stop it, or the renewal billing sweep couldn't collect the
// daily JC and paused it. The Heroku app itself still exists either way
// (nothing is deleted) until the user explicitly deletes it.

async function createDeployment({ userId, botSlug, appName, herokuAppSetupId, coinsCharged = 0 }) {
  const now = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO deployments (user_id, bot_slug, app_name, heroku_app_setup_id, coins_charged, last_charged_at, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $6, $6) RETURNING id`,
    [userId, botSlug, appName, herokuAppSetupId, coinsCharged, now]
  );
  return getDeploymentById(rows[0].id);
}

async function getDeploymentById(id) {
  const { rows } = await pool.query(`SELECT * FROM deployments WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function updateDeploymentStatus(id, { status, herokuAppUrl, failureMessage }) {
  await pool.query(
    `UPDATE deployments
     SET status = $1, heroku_app_url = $2, failure_message = $3, updated_at = $4
     WHERE id = $5`,
    [status, herokuAppUrl || null, failureMessage || null, Date.now(), id]
  );
}

async function touchDeploymentCharged(id) {
  await pool.query(`UPDATE deployments SET last_charged_at = $1, updated_at = $1 WHERE id = $2`, [Date.now(), id]);
}

async function deleteDeployment(id) {
  await pool.query(`DELETE FROM deployments WHERE id = $1`, [id]);
}

async function listDeploymentsForUser(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM deployments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getDeploymentStatsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS n FROM deployments WHERE user_id = $1 GROUP BY status`,
    [userId]
  );
  const stats = { total: 0, active: 0, inactive: 0, pending: 0 };
  for (const row of rows) {
    const n = parseInt(row.n, 10);
    stats.total += n;
    if (row.status === 'succeeded') stats.active += n;
    else if (row.status === 'failed' || row.status === 'stopped') stats.inactive += n;
    else stats.pending += n;
  }
  return stats;
}

async function countActiveDeploymentsForBot(botSlug) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM deployments WHERE bot_slug = $1 AND status = 'succeeded'`,
    [botSlug]
  );
  return parseInt(rows[0].n, 10);
}

// Deployments due for their next renewal charge — succeeded, and either
// never charged since creation or it's been >= renewalPeriodHours since
// the last charge.
async function getDeploymentsDueForRenewal(periodHours) {
  const { rows } = await pool.query(
    `SELECT * FROM deployments
     WHERE status = 'succeeded' AND $1 - last_charged_at >= $2`,
    [Date.now(), periodHours * 60 * 60 * 1000]
  );
  return rows;
}

async function getSiteStats() {
  const [{ rows: userRows }, { rows: deployRows }] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM users WHERE verified = 1`),
    pool.query(`SELECT COUNT(*) AS n FROM deployments WHERE status = 'succeeded'`),
  ]);
  return {
    users: parseInt(userRows[0].n, 10),
    activeDeployments: parseInt(deployRows[0].n, 10),
  };
}

async function close() {
  await pool.end();
}
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));

module.exports = {
  init,
  close,
  pool, // exported so server.js can hand it to connect-pg-simple for session storage
  createUser,
  getUserById,
  getUserByEmail,
  getUserByReferralCode,
  setOtp,
  clearOtp,
  markVerified,
  setPlan,
  setAdmin,
  updatePassword,
  getSetting,
  setSetting,
  freeClaimEligibleAt,
  claimFreeCoin,
  addCoins,
  addCoinsWithExpiry,
  deductCoinsIfSufficient,
  expireStaleCoins,
  rewardReferrerIfDue,
  countReferrals,
  createDeployment,
  getDeploymentById,
  updateDeploymentStatus,
  touchDeploymentCharged,
  deleteDeployment,
  listDeploymentsForUser,
  getDeploymentStatsForUser,
  getSiteStats,
  countActiveDeploymentsForBot,
  getDeploymentsDueForRenewal,
};
