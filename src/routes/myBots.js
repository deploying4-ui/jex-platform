const express = require('express');
const db = require('../db');
const botsService = require('../services/bots');
const heroku = require('../services/heroku');
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
  const bots = botsService.listBots();
  const withBotInfo = deployments.map((d) => ({
    ...d,
    bot: bots.find((b) => b.slug === d.bot_slug) || null,
  }));
  res.render('my-bots', { title: 'My Bots', deployments: withBotInfo });
}));

router.post('/my-bots/:id/restart', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  if (!await heroku.isConfigured()) {
    flash(req, 'error', 'jex-platform is not connected to a deploy account yet.');
    return res.redirect('/my-bots');
  }
  await heroku.restartApp(deployment.app_name);
  flash(req, 'success', `${deployment.app_name} is restarting.`);
  res.redirect('/my-bots');
}));

// Rebuilds from the latest code in the bot's repo — config vars
// (including SESSION_ID) are left exactly as they are.
router.post('/my-bots/:id/redeploy', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  const bot = botsService.getBotBySlug(deployment.bot_slug);
  if (!bot) {
    flash(req, 'error', 'This bot is no longer in the catalog, so it can\'t be rebuilt automatically.');
    return res.redirect('/my-bots');
  }
  if (!await heroku.isConfigured()) {
    flash(req, 'error', 'jex-platform is not connected to a deploy account yet.');
    return res.redirect('/my-bots');
  }
  await heroku.createBuild(deployment.app_name, botsService.tarballUrl(bot));
  flash(req, 'success', `Rebuilding ${deployment.app_name} from the latest code.`);
  res.redirect('/my-bots');
}));

router.post('/my-bots/:id/stop', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  if (await heroku.isConfigured()) {
    await heroku.scaleWebDyno(deployment.app_name, 0);
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

  if (!await heroku.isConfigured()) {
    flash(req, 'error', 'jex-platform is not connected to a deploy account yet.');
    return res.redirect('/my-bots');
  }
  await heroku.scaleWebDyno(deployment.app_name, 1);
  await db.updateDeploymentStatus(deployment.id, { status: 'succeeded', herokuAppUrl: deployment.heroku_app_url });
  await db.touchDeploymentCharged(deployment.id); // renewal clock restarts from now
  flash(req, 'success', `${deployment.app_name} is starting back up.`);
  res.redirect('/my-bots');
}));

router.post('/my-bots/:id/delete', requireAuth, safe('/my-bots', async (req, res) => {
  const deployment = await loadOwnedDeployment(req, res);
  if (!deployment) return;

  if (await heroku.isConfigured()) {
    try {
      await heroku.deleteApp(deployment.app_name);
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
