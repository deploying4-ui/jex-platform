const express = require('express');
const db = require('../db');
const config = require('../config');
const botsService = require('../services/bots');
const heroku = require('../services/heroku');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const APP_NAME_RE = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/; // platform app-name rules, 3-30 chars
const MAX_BOTS_PER_USER = config.coins.maxBotsPerUser;

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Express 4 does NOT auto-catch a rejected promise inside an async
// route handler — without this, an unexpected failure just hangs the
// request with no response. See src/routes/auth.js for the same helper.
function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[deploy] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(typeof fallbackPath === 'function' ? fallbackPath(req) : fallbackPath);
    }
  };
}

// ── Step: pick a bot ─────────────────────────────────────

router.get('/deploy', requireAuth, safe('/dashboard', async (req, res) => {
  const bots = await Promise.all(
    botsService.listBots().map(async (bot) => ({
      ...bot,
      activeCount: await db.countActiveDeploymentsForBot(bot.slug),
    }))
  );
  res.render('deploy-picker', { title: 'Deploy a bot', bots });
}));

// ── Step: configure ──────────────────────────────────────

router.get('/deploy/:slug', requireAuth, safe('/deploy', async (req, res) => {
  const bot = botsService.getBotBySlug(req.params.slug);
  if (!bot) return res.status(404).render('404', { title: 'Not found' });

  const { manifest } = await botsService.getManifest(bot);
  const envFields = botsService.buildEnvFields(manifest);

  res.render('deploy', {
    title: `Deploy ${bot.name}`,
    bot,
    manifest,
    envFields,
    canAfford: req.user.coins >= bot.costCoins,
    sessionHelperUrl: botsService.getSessionHelperUrl(bot),
  });
}));

// ── Step: submit ─────────────────────────────────────────

router.post('/deploy/:slug', requireAuth, safe((req) => `/deploy/${req.params.slug}`, async (req, res) => {
  const bot = botsService.getBotBySlug(req.params.slug);
  if (!bot) return res.status(404).render('404', { title: 'Not found' });

  const stats = await db.getDeploymentStatsForUser(req.user.id);
  if (stats.active + stats.pending >= MAX_BOTS_PER_USER) {
    flash(req, 'error', `You've used all ${MAX_BOTS_PER_USER} of your bot slots.`);
    return res.redirect(`/deploy/${bot.slug}`);
  }

  const appName = String(req.body.app_name || '').trim().toLowerCase();
  if (!APP_NAME_RE.test(appName)) {
    flash(req, 'error', 'App name must be 3-30 characters: lowercase letters, numbers and dashes, starting with a letter.');
    return res.redirect(`/deploy/${bot.slug}`);
  }

  const { manifest } = await botsService.getManifest(bot);
  const envFields = botsService.buildEnvFields(manifest);

  const env = {};
  for (const field of envFields) {
    const value = String(req.body[`env_${field.key}`] || '').trim();
    if (field.required && !value) {
      flash(req, 'error', `${field.key} is required.`);
      return res.redirect(`/deploy/${bot.slug}`);
    }
    if (value) env[field.key] = value;
  }

  if (!await heroku.isConfigured()) {
    flash(req, 'error', 'jex-platform is not connected to a deploy account yet — deploys are disabled for now.');
    return res.redirect(`/deploy/${bot.slug}`);
  }

  // Reserve the coins before deploying so two simultaneous attempts
  // can't both pass the balance check and overdraw the account.
  const charged = await db.deductCoinsIfSufficient(req.user.id, bot.costCoins);
  if (!charged) {
    flash(req, 'error', `You need ${bot.costCoins} JC to deploy ${bot.name} — you have ${req.user.coins}.`);
    return res.redirect('/topup');
  }

  try {
    const setup = await heroku.createAppSetup({
      sourceBlobUrl: botsService.tarballUrl(bot),
      appName,
      env,
    });

    const deployment = await db.createDeployment({
      userId: req.user.id,
      botSlug: bot.slug,
      appName: setup.app?.name || appName,
      herokuAppSetupId: setup.id,
      coinsCharged: bot.costCoins,
    });

    res.redirect(`/deploy/status/${deployment.id}`);
  } catch (err) {
    // Deploy never went through (or was rejected outright) — refund.
    await db.addCoins(req.user.id, bot.costCoins);
    flash(req, 'error', `jex-platform couldn't start the deploy: ${err.message}`);
    res.redirect(`/deploy/${bot.slug}`);
  }
}));

// ── Step: status ─────────────────────────────────────────

router.get('/deploy/status/:id', requireAuth, safe('/dashboard', async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment || deployment.user_id !== req.user.id) {
    return res.status(404).render('404', { title: 'Not found' });
  }
  const bot = botsService.getBotBySlug(deployment.bot_slug);
  res.render('deploy-status', { title: 'Deploying', deployment, bot });
}));

// Lets a user push a fresh SESSION_ID to an already-deployed bot without
// paying for a new deploy — the platform just restarts the existing app
// with the updated config var.
router.post('/deploy/status/:id/redeploy', requireAuth, safe((req) => `/deploy/status/${req.params.id}`, async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment || deployment.user_id !== req.user.id) {
    return res.status(404).render('404', { title: 'Not found' });
  }
  if (deployment.status !== 'succeeded') {
    flash(req, 'error', 'You can only update the session ID on a running deployment.');
    return res.redirect(`/deploy/status/${deployment.id}`);
  }

  const sessionId = String(req.body.session_id || '').trim();
  if (!sessionId) {
    flash(req, 'error', 'Enter a session ID.');
    return res.redirect(`/deploy/status/${deployment.id}`);
  }

  if (!await heroku.isConfigured()) {
    flash(req, 'error', 'jex-platform is not connected to a deploy account yet.');
    return res.redirect(`/deploy/status/${deployment.id}`);
  }

  try {
    await heroku.updateConfigVars(deployment.app_name, { SESSION_ID: sessionId });
    flash(req, 'success', 'Session ID updated — the app is restarting with the new value now.');
  } catch (err) {
    flash(req, 'error', `jex-platform couldn't apply that update: ${err.message}`);
  }
  res.redirect(`/deploy/status/${deployment.id}`);
}));

// Polled by the client-side script on the status page.
router.get('/api/deploy/status/:id', requireAuth, async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment || deployment.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (deployment.status === 'pending' && deployment.heroku_app_setup_id) {
    try {
      const setup = await heroku.getAppSetup(deployment.heroku_app_setup_id);
      const buildStatus = setup.build?.status; // 'pending' | 'succeeded' | 'failed'
      const setupStatus = setup.status; // 'pending' | 'succeeded' | 'failed'

      if (setupStatus === 'succeeded') {
        await db.updateDeploymentStatus(deployment.id, {
          status: 'succeeded',
          herokuAppUrl: setup.app?.web_url || null,
        });
        await db.touchDeploymentCharged(deployment.id); // renewal clock starts now
      } else if (setupStatus === 'failed' || buildStatus === 'failed') {
        // Refund on failure — the user didn't get a working bot out of it.
        await db.addCoins(deployment.user_id, deployment.coins_charged);
        await db.updateDeploymentStatus(deployment.id, {
          status: 'failed',
          failureMessage: setup.failure_message || 'The build failed.',
        });
      }
    } catch (err) {
      // Transient API hiccup — leave status as pending, client will retry.
    }
  }

  const fresh = await db.getDeploymentById(deployment.id);
  res.json({
    status: fresh.status,
    appName: fresh.app_name,
    appUrl: fresh.heroku_app_url,
    failureMessage: fresh.failure_message,
  });
});

module.exports = router;
