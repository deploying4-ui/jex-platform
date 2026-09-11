// Lets community developers ask to have their own WhatsApp bot added to
// the platform's deploy catalog. A repo proves ownership and supplies
// everything the platform needs — display info AND the env-var
// manifest — through a single `jexhost.json` file at its root. Curated
// catalog bots still use Heroku's standard app.json; community bots
// approved from here read jexhost.json instead (see rawManifestUrl in
// services/bots.js).

const express = require('express');
const db = require('../db');
const botsService = require('../services/bots');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[bot-requests] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(typeof fallbackPath === 'function' ? fallbackPath(req) : fallbackPath);
    }
  };
}

const REPO_RE = /^([a-zA-Z0-9-]+)\/([a-zA-Z0-9._-]+)$/;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch (_err) {
    return null; // malformed JSON — treated the same as "not found"
  }
}

router.get('/request-bot', requireAuth, safe('/dashboard', async (req, res) => {
  const requests = await db.listBotRequestsForUser(req.user.id);
  res.render('request-bot', { title: 'Request a Bot', requests });
}));

router.post('/request-bot', requireAuth, safe('/request-bot', async (req, res) => {
  const repoInput = String(req.body.repo || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const branch = String(req.body.branch || 'main').trim() || 'main';
  const costCoins = Math.min(500, Math.max(1, parseInt(req.body.costCoins, 10) || 10));

  const match = repoInput.match(REPO_RE);
  if (!match) {
    flash(req, 'error', 'Enter the repo as owner/repository, e.g. yourname/your-bot.');
    return res.redirect('/request-bot');
  }
  const [, owner, repo] = match;

  const activeRequest = await db.findActiveBotRequestByRepo(owner, repo);
  if (activeRequest) {
    flash(req, 'error', 'That repository already has a pending or approved request.');
    return res.redirect('/request-bot');
  }

  const catalog = await botsService.listBots();
  const alreadyListed = catalog.some(
    (b) => b.owner.toLowerCase() === owner.toLowerCase() && b.repo.toLowerCase() === repo.toLowerCase()
  );
  if (alreadyListed) {
    flash(req, 'error', 'That repository is already on the platform.');
    return res.redirect('/request-bot');
  }

  const jexhost = await fetchJson(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/jexhost.json`);
  if (!jexhost) {
    flash(req, 'error', `Could not find a valid jexhost.json in ${owner}/${repo} on branch "${branch}".`);
    return res.redirect('/request-bot');
  }

  const ownerEmail = String(jexhost['owner-verification'] || '').toLowerCase().trim();
  if (!ownerEmail || ownerEmail !== req.user.email.toLowerCase()) {
    flash(req, 'error', 'The "owner-verification" email in jexhost.json must match your account email.');
    return res.redirect('/request-bot');
  }

  const name = String(jexhost['bot-name'] || '').trim();
  if (!name) {
    flash(req, 'error', 'jexhost.json is missing "bot-name".');
    return res.redirect('/request-bot');
  }

  await db.createBotRequest({
    userId: req.user.id,
    name,
    owner,
    repo,
    branch,
    tagline: jexhost.tagline || null,
    documentationLink: jexhost['documentation-link'] || null,
    sessionHelperUrl: jexhost['session-helper-url'] || null,
    costCoins,
  });

  flash(req, 'success', `Request for "${name}" submitted — you'll hear back once an admin reviews it.`);
  res.redirect('/request-bot');
}));

router.post('/request-bot/:id/cancel', requireAuth, safe('/request-bot', async (req, res) => {
  const request = await db.getBotRequestById(req.params.id);
  if (!request || request.user_id !== req.user.id) {
    flash(req, 'error', 'Request not found.');
    return res.redirect('/request-bot');
  }
  if (request.status !== 'pending') {
    flash(req, 'error', 'Only pending requests can be withdrawn.');
    return res.redirect('/request-bot');
  }
  await db.deleteBotRequest(request.id);
  flash(req, 'success', 'Request withdrawn.');
  res.redirect('/request-bot');
}));

module.exports = router;
