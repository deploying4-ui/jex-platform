require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const config = require('./src/config');
const db = require('./src/db');
const { seedAdmin } = require('./src/services/seedAdmin');
const billing = require('./src/services/billing');
const authRoutes = require('./src/routes/auth');
const dashboardRoutes = require('./src/routes/dashboard');
const deployRoutes = require('./src/routes/deploy');
const myBotsRoutes = require('./src/routes/myBots');
const accountRoutes = require('./src/routes/account');
const adminRoutes = require('./src/routes/admin');
const botsService = require('./src/services/bots');

const app = express();

// Last-resort net: logs anything that still slips past the try/catch
// wrapping in the route files, so a silent hang always leaves a trace
// in the server logs instead of vanishing with no evidence.
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});

// Render (and most PaaS) sit behind a reverse proxy that sets
// X-Forwarded-For. Without this, express-rate-limit can't reliably
// identify individual clients and throws on every request.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Logs every request with how long it took to respond — the cheapest
// way to tell "the request never arrived", "it arrived and hung", and
// "it arrived and was just slow" apart from server logs alone.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const marker = ms > 5000 ? ' [SLOW]' : '';
    console.log(`[req] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)${marker}`);
  });
  next();
});

app.use(
  session({
    store: new pgSession({
      pool: db.pool, // reuses the same Neon connection pool db.js already opened
      tableName: 'user_sessions',
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 15, // sweep expired sessions every 15 min
    }),
    secret: config.server.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: config.server.nodeEnv === 'production',
    },
  })
);

// Consume the one-shot flash message set by routes via req.session.flash,
// and expose a few globals every view can use without each route having
// to pass them individually.
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  res.locals.siteName = config.branding.siteName;
  res.locals.teamName = config.branding.teamName;
  res.locals.currentPath = req.path;
  res.locals.whatsappSupportUrl = config.payments.whatsappSupportUrl;
  res.locals.tutorialUrl = config.tutorialUrl;
  delete req.session.flash;
  next();
});

app.get('/', async (req, res, next) => {
  if (req.session.userId) return res.redirect('/dashboard');
  try {
    const [stats, bots] = await Promise.all([
      db.getSiteStats(),
      Promise.resolve(botsService.listBots()),
    ]);
    res.render('home', {
      title: 'Deploy WhatsApp bots in seconds',
      stats,
      bots,
      supportEmail: config.payments.supportEmail,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/terms', (req, res) => {
  res.render('legal', {
    title: 'Terms of Service',
    heading: 'Terms of Service',
    updated: 'September 2026',
    bodyView: 'terms-body',
    supportEmail: config.payments.supportEmail,
  });
});

app.get('/privacy', (req, res) => {
  res.render('legal', {
    title: 'Privacy Policy',
    heading: 'Privacy Policy',
    updated: 'September 2026',
    bodyView: 'privacy-body',
    supportEmail: config.payments.supportEmail,
  });
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(deployRoutes);
app.use(myBotsRoutes);
app.use(accountRoutes);
app.use(adminRoutes);

app.use((req, res) => res.status(404).render('404', { title: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500', { title: 'Something went wrong' });
});

const PORT = config.server.port;

async function start() {
  try {
    await db.init(); // creates/migrates schema on the Neon database
  } catch (err) {
    console.error('[db] failed to initialize schema — check config.database.url:', err.message);
    process.exit(1);
  }

  try {
    await seedAdmin();
  } catch (err) {
    console.error('[admin] seed failed:', err);
  }

  billing.start(); // periodic renewal charges + coin-expiry sweep

  app.listen(PORT, () => {
    console.log(`${config.branding.siteName} running on http://localhost:${PORT}`);
  });
}

start();
