// Coin-economy numbers live in config.js/.env as defaults, but an admin
// can override any of them from Admin → Settings without a redeploy.
// Overrides are stored in the `settings` table; this module loads them
// once at boot into an in-memory cache (so every request reads a plain
// object, no DB round-trip) and refreshes the cache whenever an admin
// saves a change.

const config = require('../config');

// key -> { path: [config section, config key], parse: fn }
const FIELDS = {
  starterCoins: { section: 'coins', key: 'starterCoins', parse: Number },
  starterCoinsExpiryDays: { section: 'coins', key: 'starterCoinsExpiryDays', parse: Number },
  referralBonusCoins: { section: 'coins', key: 'referralBonusCoins', parse: Number },
  deployCostCoins: { section: 'coins', key: 'deployCostCoins', parse: Number },
  renewalCostCoins: { section: 'coins', key: 'renewalCostCoins', parse: Number },
  renewalPeriodHours: { section: 'coins', key: 'renewalPeriodHours', parse: Number },
  smallPackageExpiryDays: { section: 'coins', key: 'smallPackageExpiryDays', parse: Number },
  largePackageExpiryDays: { section: 'coins', key: 'largePackageExpiryDays', parse: Number },
  maxBotsPerUser: { section: 'coins', key: 'maxBotsPerUser', parse: Number },
  dailyClaimCoins: { section: 'coins', key: 'dailyClaimCoins', parse: Number },
  dailyClaimPeriodHours: { section: 'coins', key: 'dailyClaimPeriodHours', parse: Number },
  premiumRenewalCostCoins: { section: 'coins', key: 'premiumRenewalCostCoins', parse: Number },
  premiumBonusSlots: { section: 'coins', key: 'premiumBonusSlots', parse: Number },
};

let cache = null;

function defaults() {
  const out = {};
  for (const [name, field] of Object.entries(FIELDS)) {
    out[name] = config[field.section][field.key];
  }
  return out;
}

async function init(db) {
  const stored = await db.getAllSettings();
  const merged = defaults();
  for (const [name, field] of Object.entries(FIELDS)) {
    if (stored[name] !== undefined && stored[name] !== '') {
      const parsed = field.parse(stored[name]);
      if (Number.isFinite(parsed)) merged[name] = parsed;
    }
  }
  cache = merged;
  return cache;
}

// Synchronous — safe to call from anywhere, always returns the
// currently-active values (defaults until init() has run once, which
// server.js does before app.listen()).
function get() {
  return cache || defaults();
}

// `updates` is a plain object of { fieldName: newValue }. Only known
// fields are accepted; anything else is silently ignored rather than
// letting a stray form field write an arbitrary settings row.
async function update(db, updates) {
  const toSave = {};
  const next = { ...get() };
  for (const [name, raw] of Object.entries(updates)) {
    const field = FIELDS[name];
    if (!field) continue;
    const parsed = field.parse(raw);
    if (!Number.isFinite(parsed) || parsed < 0) continue;
    toSave[name] = parsed;
    next[name] = parsed;
  }
  await db.setSettings(toSave);
  cache = next;
  return cache;
}

function fieldNames() {
  return Object.keys(FIELDS);
}

module.exports = { init, get, update, fieldNames };
