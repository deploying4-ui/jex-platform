const express = require('express');
const db = require('../db');
const botsService = require('../services/bots');
const heroku = require('../services/heroku');
const logStream = require('../services/logStream');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Same Express-4 safety net as auth.js — an unexpected failure here
// (a Heroku hiccup, a DB blip) shows a real message instead of hanging.
function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[my-bots] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(typeof fallbackPath === 'function' ? fallbackPath(req) : fallbackPath);
    }
  };
}

async function loadOwnedDeployment(req, res) {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment || deployment.user_id !== req.user.id) {
    res.status(404).render('404', { title: 'Not found' });
    return null;
  }
  return deployment;
}

router.get('/my-bots', requireAuth, safe('/dashboard', async (req, res) => {
  const deployments = await db.listDeploymentsForUser(req.user.id);
  const bots = await botsService.listBots();
  const withBotInfo = deployments.map((d) => ({
    ...d,
    bot: bots.find((b) => b.slug === d.bot_slug) || null,
  }));
  res.render('my-bots', { title: 'My Bots', deployments: withBotInfo });
}));

// ── Logs ──────────────────────────────────────────────────
// Live console output/errors for a deployed bot, streamed straight
// from Heroku — so a user doesn't need CLI access to see why their
// bot crashed or what it's currently doing.

router.get('/my-bots/:id/logs', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  const bot = await botsService.getBotBySlug(deployment.bot_slug);
  res.render('bot-logs', {
    title: `Logs — ${deployment.app_name}`,
    deployment,
    bot,
    logToken: logStream.signLogToken(deployment.id),
  });
}));

// Fresh token for the client to (re)open the WebSocket with — issued
// only after the same ownership check as every other /my-bots route,
// so the raw socket upgrade never has to touch the session store.
router.get('/api/logs/:id/token', requireAuth, async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment || deployment.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ token: logStream.signLogToken(deployment.id) });
});

// One-shot snapshot of recent logs — used for the initial page load
// (instant) and as a fallback if the browser/proxy can't hold a
// WebSocket open.
router.get('/api/logs/:id', requireAuth, async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment || deployment.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const apiKey = await db.resolveHerokuApiKey(deployment);
    if (!apiKey) throw new Error('No deploy account linked to this app');

    const session = await heroku.createLogSession(apiKey, deployment.app_name, { tail: false, lines: 200 });
    if (!session.logplex_url) throw new Error('Heroku did not return a log snapshot');

    const raw = await fetch(session.logplex_url).then((r) => r.text());
    const logs = raw.split('\n').filter(Boolean).map(logStream.processLogLine).filter(Boolean);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/my-bots/:id/restart', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  const apiKey = await db.resolveHerokuApiKey(deployment);
  await heroku.restartApp(apiKey, deployment.app_name);
  flash(req, 'success', `${deployment.app_name} is restarting.`);
  res.redirect('/my-bots');
}));

// Rebuilds from the latest code in the bot's repo — config vars
// (including SESSION_ID) are left exactly as they are.
router.post('/my-bots/:id/redeploy', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  const bot = await botsService.getBotBySlug(deployment.bot_slug);
  if (!bot) {
    flash(req, 'error', 'This bot is no longer in the catalog, so it can\'t be rebuilt automatically.');
    return res.redirect('/my-bots');
  }
  const apiKey = await db.resolveHerokuApiKey(deployment);
  await heroku.createBuild(apiKey, deployment.app_name, botsService.tarballUrl(bot));
  flash(req, 'success', `Rebuilding ${deployment.app_name} from the latest code.`);
  res.redirect('/my-bots');
}));

router.post('/my-bots/:id/stop', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  const apiKey = await db.resolveHerokuApiKey(deployment);
  if (apiKey) {
    await heroku.scaleWebDyno(apiKey, deployment.app_name, 0);
  }
  await db.updateDeploymentStatus(deployment.id, {
    status: 'stopped',
    failureMessage: 'Stopped by you.',
  });
  flash(req, 'success', `${deployment.app_name} stopped.`);
  res.redirect('/my-bots');
}));

router.post('/my-bots/:id/resume', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  const apiKey = await db.resolveHerokuApiKey(deployment);
  await heroku.scaleWebDyno(apiKey, deployment.app_name, 1);
  await db.updateDeploymentStatus(deployment.id, { status: 'succeeded', herokuAppUrl: deployment.heroku_app_url });
  await db.touchDeploymentCharged(deployment.id); // renewal clock restarts from now
  flash(req, 'success', `${deployment.app_name} is starting back up.`);
  res.redirect('/my-bots');
}));

router.post('/my-bots/:id/delete', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  const apiKey = await db.resolveHerokuApiKey(deployment);
  if (apiKey) {
    try {
      await heroku.deleteApp(apiKey, deployment.app_name);
    } catch (err) {
      // If it's already gone on Heroku's side, don't block deleting our
      // own record — anything else, surface it and stop.
      if (err.status !== 404) {
        flash(req, 'error', `Could not delete on Heroku: ${err.message}`);
        return res.redirect('/my-bots');
      }
    }
  }
  await db.deleteDeployment(deployment.id);
  flash(req, 'success', `${deployment.app_name} deleted.`);
  res.redirect('/my-bots');
}));

module.exports = router;
