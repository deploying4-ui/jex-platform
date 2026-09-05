// Central config — the DEFAULTS block below is the primary source of
// truth. .env is only consulted as a fallback for anything left blank
// here, and a hardcoded literal is the last resort if neither is set.
//
// ⚠️ These are test/dev credentials — fine for local testing, but don't
// commit real production secrets into this file. If you fill in real
// values here, add src/config.js to .gitignore.
//
// Note on naming: HEROKU_API_KEY is exactly what it says — a real
// Heroku account API key — because that's genuinely what powers
// deploys underneath. Nothing in the *product* (what a user sees on
// the site) says "Heroku" anywhere; it's all branded "jex-platform" in
// the UI, views, and README. Renaming this one config key wouldn't
// change anything a user sees, so it stays literal for clarity.

const env = process.env;

// ── Primary values (edit these directly) ─────────────────
const DEFAULTS = {
  PORT: 3000,
  BASE_URL: 'http://localhost:3000',
  SESSION_SECRET: 'd8773cd3f9659fa2e8422cf030e394107afd2d9a6a6e7a0d8a54c3137a46035a',

  SITE_NAME: 'Jexploit platform',
  TEAM_NAME: 'Kevin Tech',

  HEROKU_API_KEY: 'HRKU-AAfdk91YX8u03AJCMPrFT3qlEtfZvmSpmVgS3_hxreSg_____wIOS1tBacb7',

  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'mxdevzw@gmail.com',
  SMTP_PASS: 'kalxkavfbkyhiatk',
  SMTP_FROM: '"Jexploit platform" <mxdevzw@gmail.com>',

  ADMIN_EMAIL: 'devkelvin903@gmail.com',
  ADMIN_PASSWORD: 'Kelvin##??256',

  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',

  GITHUB_CLIENT_ID: 'Ov23liO5JIX05eQTqjXb',
  GITHUB_CLIENT_SECRET: '534f351fa5eb3372566a3f882b5c9e431ee66b0d',

  // ── Coin economy (JC = Jexploit Coins) ──────────────────
  STARTER_COINS: 10,
  STARTER_COINS_EXPIRY_DAYS: 30,     // the free signup grant expires after this many days if unused
  REFERRAL_BONUS_COINS: 5,
  DEPLOY_COST_COINS: 10,             // flat cost to deploy any bot (also mirrored per-bot in data/bots.json)
  RENEWAL_COST_COINS: 1,             // charged every RENEWAL_PERIOD_HOURS to keep a deployed bot running
  RENEWAL_PERIOD_HOURS: 24,
  FREE_CLAIM_COINS: 1,               // claimable for free, once every FREE_CLAIM_INTERVAL_DAYS
  FREE_CLAIM_INTERVAL_DAYS: 4,
  SMALL_PACKAGE_EXPIRY_DAYS: 30,     // 100 / 200 / 500 JC purchases
  LARGE_PACKAGE_EXPIRY_DAYS: 60,     // 700 / 900 JC purchases
  MAX_BOTS_PER_USER: 50,

  PAYMENT_METHOD_LABEL: 'MasterCard',
  PAYMENT_NUMBER: '+256742932677',
  SUPPORT_EMAIL: 'techkevin93@gmail.com',
  WHATSAPP_SUPPORT_URL: 'https://whatsapp.com/channel/0029VbDgozMG3R3qDeaUv91B',
  TUTORIAL_URL: 'https://youtube.com/@kelvindev-f1x?si=twHVU-yKVa0eXtm3',

  // Fallback pairing site for bots that don't set their own in
  // data/bots.json (Vesper-Xmd and Jexploit Bot both use this one).
  SESSION_HELPER_URL: 'https://xploitdevkevin-pairing-site.onrender.com/',

  DATABASE_URL:
    'postgresql://neondb_owner:npg_W4ClLPINgmi0@ep-snowy-rain-aw8rwhfm-pooler.c-12.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
};

// value = DEFAULTS entry if set, else process.env, else hardFallback
function pick(key, hardFallback = '') {
  const def = DEFAULTS[key];
  if (def !== undefined && def !== '') return def;
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return hardFallback;
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  server: {
    port: num(pick('PORT'), 3000),
    baseUrl: pick('BASE_URL', 'http://localhost:3000'),
    nodeEnv: env.NODE_ENV || 'development', // deployment-context only — stays env-driven
    sessionSecret: pick('SESSION_SECRET', 'dev-secret-change-me'),
  },

  branding: {
    siteName: pick('SITE_NAME', 'Bot Deploy'),
    teamName: pick('TEAM_NAME') || pick('SITE_NAME', 'Bot Deploy'),
  },

  heroku: {
    apiKey: pick('HEROKU_API_KEY'),
  },

  smtp: {
    host: pick('SMTP_HOST'),
    port: num(pick('SMTP_PORT'), 587),
    secure: bool(pick('SMTP_SECURE')),
    user: pick('SMTP_USER'),
    pass: pick('SMTP_PASS'),
    from: pick('SMTP_FROM'),
  },

  admin: {
    email: pick('ADMIN_EMAIL'),
    password: pick('ADMIN_PASSWORD'),
  },

  google: {
    clientId: pick('GOOGLE_CLIENT_ID'),
    clientSecret: pick('GOOGLE_CLIENT_SECRET'),
  },

  coins: {
    starterCoins: num(pick('STARTER_COINS'), 10),
    starterCoinsExpiryDays: num(pick('STARTER_COINS_EXPIRY_DAYS'), 30),
    referralBonusCoins: num(pick('REFERRAL_BONUS_COINS'), 5),
    deployCostCoins: num(pick('DEPLOY_COST_COINS'), 10),
    renewalCostCoins: num(pick('RENEWAL_COST_COINS'), 1),
    renewalPeriodHours: num(pick('RENEWAL_PERIOD_HOURS'), 24),
    freeClaimCoins: num(pick('FREE_CLAIM_COINS'), 1),
    freeClaimIntervalDays: num(pick('FREE_CLAIM_INTERVAL_DAYS'), 4),
    smallPackageExpiryDays: num(pick('SMALL_PACKAGE_EXPIRY_DAYS'), 30),
    largePackageExpiryDays: num(pick('LARGE_PACKAGE_EXPIRY_DAYS'), 60),
    maxBotsPerUser: num(pick('MAX_BOTS_PER_USER'), 50),
  },

  payments: {
    methodLabel: pick('PAYMENT_METHOD_LABEL', 'Mobile Money'),
    number: pick('PAYMENT_NUMBER'),
    supportEmail: pick('SUPPORT_EMAIL', 'support@example.com'),
    whatsappSupportUrl: pick('WHATSAPP_SUPPORT_URL'),
  },

  tutorialUrl: pick('TUTORIAL_URL'),
  sessionHelperUrl: pick('SESSION_HELPER_URL'),

  oauth: {
    google: {
      clientId: pick('GOOGLE_CLIENT_ID'),
      clientSecret: pick('GOOGLE_CLIENT_SECRET'),
      enabled: Boolean(pick('GOOGLE_CLIENT_ID') && pick('GOOGLE_CLIENT_SECRET')),
    },
    github: {
      clientId: pick('GITHUB_CLIENT_ID'),
      clientSecret: pick('GITHUB_CLIENT_SECRET'),
      enabled: Boolean(pick('GITHUB_CLIENT_ID') && pick('GITHUB_CLIENT_SECRET')),
    },
  },

  database: {
    url: pick('DATABASE_URL'),
  },
};

module.exports = config;
