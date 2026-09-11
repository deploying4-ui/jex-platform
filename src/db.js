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

// Turns "Jane.Doe99@gmail.com" into a valid starting-point username
// ("janedoe99") — letters/numbers/underscore only, lowercase, 3-20
// chars. Used both to backfill pre-existing rows and to seed a default
// for brand-new signups, so nobody's username field is ever blank.
function sanitizeUsername(raw) {
  const base = String(raw || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  const trimmed = base.slice(0, 20);
  return trimmed.length >= 3 ? trimmed : (trimmed + 'user').slice(0, 20);
}

async function generateUniqueUsername(seed) {
  const base = sanitizeUsername(seed);
  let candidate = base;
  let attempt = 0;
  // Loop instead of a single query — cheap, and the table is small
  // enough that collisions are rare, so this almost always runs once.
  while (true) {
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE username = $1`, [candidate]);
    if (!rows.length) return candidate;
    attempt += 1;
    const suffix = String(attempt);
    candidate = base.slice(0, 20 - suffix.length) + suffix;
  }
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

    CREATE TABLE IF NOT EXISTS heroku_accounts (
      id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      label       TEXT NOT NULL,
      api_key     TEXT NOT NULL,
      max_apps    INTEGER NOT NULL DEFAULT 10,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id),
      reference            TEXT UNIQUE NOT NULL,
      marz_uuid            TEXT,
      coins                INTEGER NOT NULL,
      amount_ugx           INTEGER NOT NULL,
      phone_number         TEXT,
      status               TEXT NOT NULL DEFAULT 'pending',
      provider             TEXT,
      provider_txn_id      TEXT,
      failure_message      TEXT,
      created_at           BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      subject     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticket_id     INTEGER NOT NULL REFERENCES support_tickets(id),
      is_admin      INTEGER NOT NULL DEFAULT 0,
      author_email  TEXT,
      body          TEXT NOT NULL,
      created_at    BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_requests (
      id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id              INTEGER NOT NULL REFERENCES users(id),
      name                 TEXT NOT NULL,
      owner                TEXT NOT NULL,
      repo                 TEXT NOT NULL,
      branch               TEXT NOT NULL DEFAULT 'main',
      tagline              TEXT,
      documentation_link   TEXT,
      session_helper_url   TEXT,
      cost_coins           INTEGER NOT NULL DEFAULT 10,
      status               TEXT NOT NULL DEFAULT 'pending',
      review_note          TEXT,
      slug                 TEXT,
      created_at           BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL
    );

    -- Community bots approved from bot_requests, merged into the deploy
    -- catalog alongside the curated entries in data/bots.json.
    CREATE TABLE IF NOT EXISTS bots (
      id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      slug                 TEXT UNIQUE NOT NULL,
      name                 TEXT NOT NULL,
      tagline              TEXT,
      owner                TEXT NOT NULL,
      repo                 TEXT NOT NULL,
      branch               TEXT NOT NULL DEFAULT 'main',
      initial              TEXT NOT NULL,
      accent               TEXT NOT NULL DEFAULT 'violet',
      css_class            TEXT NOT NULL DEFAULT 'b1',
      cost_coins           INTEGER NOT NULL DEFAULT 10,
      session_helper_url   TEXT,
      dev_user_id          INTEGER REFERENCES users(id),
      request_id           INTEGER REFERENCES bot_requests(id),
      created_at           BIGINT NOT NULL
    );
  `);

  // Additive-only migrations — an existing database from an earlier
  // version keeps working without a manual reset.
  await ensureColumn('users', 'coins', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'coins_expire_at', 'BIGINT');
  await ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'is_banned', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'referral_code', 'TEXT');
  await ensureColumn('users', 'referred_by', 'INTEGER');
  await ensureColumn('users', 'referral_rewarded_at', 'BIGINT');
  await ensureColumn('users', 'referral_coins_earned', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'last_claim_at', 'BIGINT');
  await ensureColumn('users', 'username', 'TEXT');
  await ensureColumn('deployments', 'coins_charged', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('deployments', 'last_charged_at', 'BIGINT');
  await ensureColumn('deployments', 'heroku_account_id', 'INTEGER');

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deployments_user_id ON deployments(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deployments_bot_slug_status ON deployments(bot_slug, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id ON support_messages(ticket_id)`);

  // Backfill referral codes for any pre-existing rows that predate the column.
  const { rows: missingCode } = await pool.query(`SELECT id FROM users WHERE referral_code IS NULL`);
  for (const row of missingCode) {
    await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [generateReferralCode(), row.id]);
  }

  // Same for username — pre-existing accounts get one derived from their
  // email so the field is never blank, and they can rename it from My Profile.
  const { rows: missingUsername } = await pool.query(`SELECT id, email FROM users WHERE username IS NULL`);
  for (const row of missingUsername) {
    const username = await generateUniqueUsername(row.email);
    await pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [username, row.id]);
  }
}

// ── Users ───────────────────────────────────────────────

async function createUser({ email, passwordHash, startingCoins = 0, referredBy = null }) {
  const username = await generateUniqueUsername(email);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, coins, referral_code, referred_by, username, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [email.toLowerCase().trim(), passwordHash, startingCoins, generateReferralCode(), referredBy, username, Date.now()]
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

async function getUserByUsername(username) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1`, [String(username || '').toLowerCase().trim()]);
  return rows[0] || null;
}

// Throws a friendly error (caller renders it as a flash message) rather
// than letting the unique-index violation bubble up as a raw PG error.
async function updateUsername(userId, username) {
  const clean = sanitizeUsername(username);
  if (clean !== String(username || '').toLowerCase().trim()) {
    const err = new Error('Username must be 3-20 characters: lowercase letters, numbers, and underscores only.');
    err.code = 'INVALID_USERNAME';
    throw err;
  }
  const existing = await getUserByUsername(clean);
  if (existing && existing.id !== userId) {
    const err = new Error('That username is already taken.');
    err.code = 'USERNAME_TAKEN';
    throw err;
  }
  await pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [clean, userId]);
  return getUserById(userId);
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

async function setBanned(userId, isBanned) {
  await pool.query(`UPDATE users SET is_banned = $1 WHERE id = $2`, [isBanned ? 1 : 0, userId]);
}

async function updatePassword(userId, passwordHash) {
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
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

// Rewards both sides of a referral, once, the first time the referred
// user verifies: the referrer gets `bonusCoins`, and the new user gets
// the same amount as a welcome-on-top-of-starter-coins bonus. Wrapped in
// a real transaction so the two credits and the rewarded_at flag always
// commit together.
async function rewardReferrerIfDue(newUser, bonusCoins) {
  if (!newUser.referred_by || newUser.referral_rewarded_at) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET coins = coins + $1, referral_coins_earned = referral_coins_earned + $1 WHERE id = $2`,
      [bonusCoins, newUser.referred_by]
    );
    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [bonusCoins, newUser.id]);
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

// Atomic daily-claim: only succeeds if the user has never claimed, or
// their last claim was >= periodHours ago. Same conditional-UPDATE
// pattern as deductCoinsIfSufficient so concurrent requests can't
// double-claim.
async function claimDailyCoins(userId, amount, periodHours = 24) {
  const cutoff = Date.now() - periodHours * 60 * 60 * 1000;
  const { rows } = await pool.query(
    `UPDATE users
     SET coins = coins + $1, last_claim_at = $2
     WHERE id = $3 AND (last_claim_at IS NULL OR last_claim_at <= $4)
     RETURNING id`,
    [amount, Date.now(), userId, cutoff]
  );
  return rows.length > 0;
}

// When the next claim becomes available for a user, or null if they can
// claim right now.
function nextClaimAt(user, periodHours = 24) {
  if (!user.last_claim_at) return null;
  const next = Number(user.last_claim_at) + periodHours * 60 * 60 * 1000;
  return next > Date.now() ? next : null;
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

async function createDeployment({ userId, botSlug, appName, herokuAppSetupId, coinsCharged = 0, herokuAccountId = null }) {
  const now = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO deployments (user_id, bot_slug, app_name, heroku_app_setup_id, coins_charged, last_charged_at, heroku_account_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $6, $6) RETURNING id`,
    [userId, botSlug, appName, herokuAppSetupId, coinsCharged, now, herokuAccountId]
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
  const [{ rows: userRows }, { rows: deployRows }, { rows: totalDeployRows }, { rows: coinRows }] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM users`),
    pool.query(`SELECT COUNT(*) AS n FROM deployments WHERE status = 'succeeded'`),
    pool.query(`SELECT COUNT(*) AS n FROM deployments`),
    pool.query(`SELECT COALESCE(SUM(coins), 0) AS n FROM users`),
  ]);
  return {
    users: parseInt(userRows[0].n, 10),
    activeDeployments: parseInt(deployRows[0].n, 10),
    totalDeployments: parseInt(totalDeployRows[0].n, 10),
    coinsInCirculation: parseInt(coinRows[0].n, 10),
  };
}

// ── Admin: user list ────────────────────────────────────

async function countAllUsers(search = '') {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM users WHERE email ILIKE $1`,
    [`%${search.trim()}%`]
  );
  return parseInt(rows[0].n, 10);
}

async function listUsers({ search = '', limit = 25, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT u.*,
       (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.id) AS referral_count,
       (SELECT COUNT(*) FROM deployments d WHERE d.user_id = u.id) AS deploy_count,
       (SELECT COUNT(*) FROM deployments d WHERE d.user_id = u.id AND d.status = 'succeeded') AS active_deploy_count
     FROM users u
     WHERE u.email ILIKE $1
     ORDER BY u.created_at DESC
     LIMIT $2 OFFSET $3`,
    [`%${search.trim()}%`, limit, offset]
  );
  return rows;
}

// ── Admin: deployment list (every deployment platform-wide) ─────

async function countAllDeployments({ search = '', status = '' } = {}) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n
     FROM deployments d JOIN users u ON u.id = d.user_id
     WHERE (d.app_name ILIKE $1 OR u.email ILIKE $1 OR d.bot_slug ILIKE $1)
       AND ($2 = '' OR d.status = $2)`,
    [`%${search.trim()}%`, status]
  );
  return parseInt(rows[0].n, 10);
}

async function listAllDeployments({ search = '', status = '', limit = 25, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT d.*, u.email AS user_email, u.username AS user_username
     FROM deployments d JOIN users u ON u.id = d.user_id
     WHERE (d.app_name ILIKE $1 OR u.email ILIKE $1 OR d.bot_slug ILIKE $1)
       AND ($2 = '' OR d.status = $2)
     ORDER BY d.created_at DESC
     LIMIT $3 OFFSET $4`,
    [`%${search.trim()}%`, status, limit, offset]
  );
  return rows;
}

async function getDeploymentStatusCounts() {
  const { rows } = await pool.query(`SELECT status, COUNT(*) AS n FROM deployments GROUP BY status`);
  const counts = { pending: 0, succeeded: 0, failed: 0, stopped: 0 };
  for (const row of rows) counts[row.status] = parseInt(row.n, 10);
  return counts;
}

// ── Payments (MarzPay coin top-ups) ─────────────────────

async function createPayment({ userId, reference, coins, amountUgx, phoneNumber }) {
  const now = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO payments (user_id, reference, coins, amount_ugx, phone_number, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6) RETURNING id`,
    [userId, reference, coins, amountUgx, phoneNumber, now]
  );
  return getPaymentById(rows[0].id);
}

async function getPaymentById(id) {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getPaymentByReference(reference) {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE reference = $1`, [reference]);
  return rows[0] || null;
}

async function updatePaymentStatus(id, { status, marzUuid, provider, providerTxnId, failureMessage }) {
  await pool.query(
    `UPDATE payments
     SET status = $1,
         marz_uuid = COALESCE($2, marz_uuid),
         provider = COALESCE($3, provider),
         provider_txn_id = COALESCE($4, provider_txn_id),
         failure_message = COALESCE($5, failure_message),
         updated_at = $6
     WHERE id = $7`,
    [status, marzUuid || null, provider || null, providerTxnId || null, failureMessage || null, Date.now(), id]
  );
}

/**
 * Atomically mark payment completed and credit coins (only once).
 */
async function completePaymentAndCredit(reference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE reference = $1 FOR UPDATE`,
      [reference]
    );
    const payment = rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    if (payment.status === 'completed') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_completed', payment };
    }
    if (payment.status === 'failed') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_failed', payment };
    }

    await client.query(
      `UPDATE payments SET status = 'completed', updated_at = $1 WHERE id = $2`,
      [Date.now(), payment.id]
    );
    await client.query(
      `UPDATE users SET coins = coins + $1 WHERE id = $2`,
      [payment.coins, payment.user_id]
    );
    await client.query('COMMIT');
    return { ok: true, payment };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listPaymentsForUser(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// ── Support tickets ──────────────────────────────────────

async function createTicket({ userId, authorEmail, subject, body }) {
  const now = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO support_tickets (user_id, subject, status, created_at, updated_at)
     VALUES ($1, $2, 'open', $3, $3) RETURNING id`,
    [userId, subject, now]
  );
  const ticketId = rows[0].id;
  await pool.query(
    `INSERT INTO support_messages (ticket_id, is_admin, author_email, body, created_at)
     VALUES ($1, 0, $2, $3, $4)`,
    [ticketId, authorEmail, body, now]
  );
  return getTicketById(ticketId);
}

async function getTicketById(id) {
  const { rows } = await pool.query(
    `SELECT t.*, u.email AS user_email
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     WHERE t.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function listTicketsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId]
  );
  return rows;
}

async function listAllTickets({ status = '', search = '', limit = 25, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(u.email ILIKE $${params.length} OR t.subject ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT t.*, u.email AS user_email
     FROM support_tickets t JOIN users u ON u.id = t.user_id
     ${where}
     ORDER BY t.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function countAllTickets({ status = '', search = '' } = {}) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search.trim()}%`);
    conditions.push(`(u.email ILIKE $${params.length} OR t.subject ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM support_tickets t JOIN users u ON u.id = t.user_id ${where}`,
    params
  );
  return Number(rows[0].n);
}

async function getMessagesForTicket(ticketId) {
  const { rows } = await pool.query(
    `SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [ticketId]
  );
  return rows;
}

async function addTicketMessage({ ticketId, isAdmin, authorEmail, body }) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO support_messages (ticket_id, is_admin, author_email, body, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [ticketId, isAdmin ? 1 : 0, authorEmail, body, now]
  );
  // A user replying reopens a closed ticket; an admin reply just bumps it.
  if (isAdmin) {
    await pool.query(`UPDATE support_tickets SET updated_at = $1 WHERE id = $2`, [now, ticketId]);
  } else {
    await pool.query(`UPDATE support_tickets SET updated_at = $1, status = 'open' WHERE id = $2`, [now, ticketId]);
  }
}

async function setTicketStatus(ticketId, status) {
  await pool.query(
    `UPDATE support_tickets SET status = $1, updated_at = $2 WHERE id = $3`,
    [status, Date.now(), ticketId]
  );
}

async function close() {
  await pool.end();
}
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));

// ── Heroku account pool ──────────────────────────────────
//
// Deploys can be spread across several Heroku accounts (each one has its
// own app-count ceiling on the free/eco tiers). Every deployment records
// which account it was created under, so every later action on that app
// (restart, scale, delete, rebuild) reuses the same account's key —
// mixing keys on one app would just get every request rejected.

async function listHerokuAccounts() {
  const { rows } = await pool.query(`
    SELECT a.*,
      (SELECT COUNT(*) FROM deployments d WHERE d.heroku_account_id = a.id AND d.status != 'failed') AS used_count
    FROM heroku_accounts a
    ORDER BY a.created_at DESC
  `);
  return rows;
}

async function getHerokuAccountById(id) {
  const { rows } = await pool.query(`SELECT * FROM heroku_accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function createHerokuAccount({ label, apiKey, maxApps }) {
  const { rows } = await pool.query(
    `INSERT INTO heroku_accounts (label, api_key, max_apps, is_active, created_at)
     VALUES ($1, $2, $3, 1, $4) RETURNING *`,
    [label, apiKey, maxApps, Date.now()]
  );
  return rows[0];
}

async function updateHerokuAccount(id, { label, apiKey, maxApps, isActive }) {
  const { rows } = await pool.query(
    `UPDATE heroku_accounts
     SET label = $1, api_key = COALESCE($2, api_key), max_apps = $3, is_active = $4
     WHERE id = $5 RETURNING *`,
    [label, apiKey || null, maxApps, isActive ? 1 : 0, id]
  );
  return rows[0] || null;
}

async function deleteHerokuAccount(id) {
  // Deployments already made under this account keep their
  // heroku_account_id — they just fall back to the legacy env-var key
  // (if any) for future actions once the account row is gone.
  await pool.query(`DELETE FROM heroku_accounts WHERE id = $1`, [id]);
}

// Picks the active account with the most free capacity (spreads load
// evenly rather than filling one account before touching the next).
async function pickAvailableHerokuAccount() {
  const { rows } = await pool.query(`
    SELECT a.*,
      (SELECT COUNT(*) FROM deployments d WHERE d.heroku_account_id = a.id AND d.status != 'failed') AS used_count
    FROM heroku_accounts a
    WHERE a.is_active = 1
    ORDER BY (a.max_apps - (SELECT COUNT(*) FROM deployments d WHERE d.heroku_account_id = a.id AND d.status != 'failed')) DESC
    LIMIT 1
  `);
  const candidate = rows[0];
  if (candidate && Number(candidate.used_count) < candidate.max_apps) return candidate;
  return null;
}

// Resolves the right API key for an existing deployment: its own
// account if it has one, otherwise the legacy single-key .env fallback
// (for deployments made before multi-account support existed).
async function resolveHerokuApiKey(deployment) {
  if (deployment.heroku_account_id) {
    const account = await getHerokuAccountById(deployment.heroku_account_id);
    if (account) return account.api_key;
  }
  return config.heroku.apiKey || null;
}

async function getHerokuPoolStats() {
  const accounts = await listHerokuAccounts();
  const activeAccounts = accounts.filter((a) => a.is_active);
  const totalCapacity = activeAccounts.reduce((sum, a) => sum + a.max_apps, 0);
  const totalUsed = accounts.reduce((sum, a) => sum + Number(a.used_count), 0);
  return {
    accounts,
    activeAccountCount: activeAccounts.length,
    totalCapacity,
    totalUsed,
    availableCapacity: Math.max(0, totalCapacity - totalUsed),
  };
}

// ── Bot requests (community devs asking to add their bot) ───────

async function createBotRequest({ userId, name, owner, repo, branch, tagline, documentationLink, sessionHelperUrl, costCoins }) {
  const now = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO bot_requests
      (user_id, name, owner, repo, branch, tagline, documentation_link, session_helper_url, cost_coins, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $10) RETURNING id`,
    [userId, name, owner, repo, branch || 'main', tagline || null, documentationLink || null, sessionHelperUrl || null, costCoins, now]
  );
  return getBotRequestById(rows[0].id);
}

async function getBotRequestById(id) {
  const { rows } = await pool.query(`SELECT * FROM bot_requests WHERE id = $1`, [id]);
  return rows[0] || null;
}

// A repo already in flight (pending/approved as a request) or already
// live in the community catalog — either way it can't be requested again.
async function findActiveBotRequestByRepo(owner, repo) {
  const { rows } = await pool.query(
    `SELECT * FROM bot_requests WHERE LOWER(owner) = LOWER($1) AND LOWER(repo) = LOWER($2) AND status IN ('pending', 'approved')`,
    [owner, repo]
  );
  return rows[0] || null;
}

async function listBotRequestsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM bot_requests WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function countBotRequests({ status = '' } = {}) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM bot_requests WHERE ($1 = '' OR status = $1)`,
    [status]
  );
  return parseInt(rows[0].n, 10);
}

async function listBotRequests({ status = '', limit = 25, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT br.*, u.email AS user_email, u.username AS user_username
     FROM bot_requests br JOIN users u ON u.id = br.user_id
     WHERE ($1 = '' OR br.status = $1)
     ORDER BY br.created_at DESC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );
  return rows;
}

async function updateBotRequestStatus(id, { status, reviewNote, slug }) {
  await pool.query(
    `UPDATE bot_requests SET status = $1, review_note = $2, slug = COALESCE($3, slug), updated_at = $4 WHERE id = $5`,
    [status, reviewNote || null, slug || null, Date.now(), id]
  );
  return getBotRequestById(id);
}

async function deleteBotRequest(id) {
  await pool.query(`DELETE FROM bot_requests WHERE id = $1`, [id]);
}

// ── Community bots (approved requests, merged into the deploy catalog) ──

async function createBot({ slug, name, tagline, owner, repo, branch, initial, accent, cssClass, costCoins, sessionHelperUrl, devUserId, requestId }) {
  const { rows } = await pool.query(
    `INSERT INTO bots (slug, name, tagline, owner, repo, branch, initial, accent, css_class, cost_coins, session_helper_url, dev_user_id, request_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [slug, name, tagline || null, owner, repo, branch || 'main', initial, accent, cssClass, costCoins, sessionHelperUrl || null, devUserId, requestId, Date.now()]
  );
  return rows[0];
}

// Rows shaped (camelCase, aliased) to match data/bots.json entries exactly,
// so botsService can merge the two lists without any translation step.
async function listCommunityBots() {
  const { rows } = await pool.query(`
    SELECT slug, name, tagline, owner, repo, branch, initial, accent,
           css_class AS "cssClass", cost_coins AS "costCoins", session_helper_url AS "sessionHelperUrl"
    FROM bots ORDER BY created_at DESC
  `);
  return rows;
}

async function getCommunityBotBySlug(slug) {
  const { rows } = await pool.query(`
    SELECT slug, name, tagline, owner, repo, branch, initial, accent,
           css_class AS "cssClass", cost_coins AS "costCoins", session_helper_url AS "sessionHelperUrl"
    FROM bots WHERE slug = $1
  `, [slug]);
  return rows[0] || null;
}

// ── Live-editable settings (admin) ──────────────────────
//
// Coin-economy numbers start from config.js/.env defaults but can be
// overridden here without a redeploy. Stored as plain text key/value
// pairs; src/services/settings.js handles typing + merging with defaults.

async function getAllSettings() {
  const { rows } = await pool.query(`SELECT key, value FROM settings`);
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function setSettings(pairs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(pairs)) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  init,
  close,
  pool, // exported so server.js can hand it to connect-pg-simple for session storage
  createUser,
  getUserById,
  getUserByEmail,
  getUserByUsername,
  getUserByReferralCode,
  setOtp,
  clearOtp,
  markVerified,
  setPlan,
  setAdmin,
  setBanned,
  updatePassword,
  updateUsername,
  addCoins,
  addCoinsWithExpiry,
  deductCoinsIfSufficient,
  claimDailyCoins,
  nextClaimAt,
  expireStaleCoins,
  rewardReferrerIfDue,
  countReferrals,
  countAllUsers,
  listUsers,
  countAllDeployments,
  listAllDeployments,
  getDeploymentStatusCounts,
  listHerokuAccounts,
  getHerokuAccountById,
  createHerokuAccount,
  updateHerokuAccount,
  deleteHerokuAccount,
  pickAvailableHerokuAccount,
  resolveHerokuApiKey,
  getHerokuPoolStats,

  // Bot requests
  createBotRequest,
  getBotRequestById,
  findActiveBotRequestByRepo,
  listBotRequestsForUser,
  countBotRequests,
  listBotRequests,
  updateBotRequestStatus,
  deleteBotRequest,

  // Community bots
  createBot,
  listCommunityBots,
  getCommunityBotBySlug,
  getAllSettings,
  setSettings,
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
  createPayment,
  getPaymentById,
  getPaymentByReference,
  updatePaymentStatus,
  completePaymentAndCredit,
  listPaymentsForUser,
  createTicket,
  getTicketById,
  listTicketsForUser,
  listAllTickets,
  countAllTickets,
  getMessagesForTicket,
  addTicketMessage,
  setTicketStatus,
};
