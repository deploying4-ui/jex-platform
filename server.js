require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const config = require('./src/config');
const db = require('./src/db');
const { seedAdmin } = require('./src/services/seedAdmin');
const billing = require('./src/services/billing');
const settings = require('./src/services/settings');
const authRoutes = require('./src/routes/auth');
const dashboardRoutes = require('./src/routes/dashboard');
const deployRoutes = require('./src/routes/deploy');
const myBotsRoutes = require('./src/routes/myBots');
const botRequestsRoutes = require('./src/routes/botRequests');
const accountRoutes = require('./src/routes/account');
const adminRoutes = require('./src/routes/admin');
const paymentsRoutes = require('./src/routes/payments');
const supportRoutes = require('./src/routes/support');
const botsService = require('./src/services/bots');
const logStream = require('./src/services/logStream');

const app = express();

// A plain http.Server so the live-logs WebSocket (src/services/logStream.js)
// can attach to the same 'upgrade' event Express is already listening on —
// app.listen() further down creates one of these implicitly anyway, this
// just gives us a handle to it before that happens.
const server = http.createServer(app);
logStream.attachLogsWebSocket(server);

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
      settings: settings.get(),
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
app.use(botRequestsRoutes);
app.use(accountRoutes);
app.use(adminRoutes);
app.use(paymentsRoutes);
app.use(supportRoutes);

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
    await settings.init(db); // load admin-overridable coin settings into memory
  } catch (err) {
    console.error('[settings] failed to load — falling back to config.js/.env defaults:', err.message);
  }

  try {
    await seedAdmin();
  } catch (err) {
    console.error('[admin] seed failed:', err);
  }

  billing.start(); // periodic renewal charges + coin-expiry sweep

  if (config.marzpay.apiKey && !config.marzpay.webhookSecret) {
    console.warn(
      '[marzpay] WARNING: MarzPay is configured but MARZPAY_WEBHOOK_SECRET is not set — ' +
      'incoming payment webhooks are NOT signature-verified. Enable webhook signing in your ' +
      'MarzPay dashboard and set MARZPAY_WEBHOOK_SECRET to close this gap before accepting real payments.'
    );
  }

  if (!config.brevo.apiKey && config.smtp.host) {
    console.warn(
      '[mailer] WARNING: no BREVO_API_KEY set — falling back to SMTP (' + config.smtp.host + '). ' +
      'Render\'s free tier blocks outbound SMTP ports (25/465/587), so emails will silently ' +
      'time out there. Set BREVO_API_KEY (Brevo → Settings → SMTP & API → API Keys) to send ' +
      'over HTTPS instead, or upgrade off the free tier if you\'re staying on SMTP.'
    );
  }

  server.listen(PORT, () => {
    console.log(`${config.branding.siteName} running on ${config.server.baseUrl} (port ${PORT})`);
  });
}

start();
