const express = require('express');
const db = require('../db');
const config = require('../config');
const heroku = require('../services/heroku');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use('/admin', requireAuth, requireAdmin);

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[admin] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(typeof fallbackPath === 'function' ? fallbackPath(req) : fallbackPath);
    }
  };
}

router.get('/admin', safe('/dashboard', async (req, res) => {
  let lookup = null;
  const email = String(req.query.email || '').trim();
  if (email) {
    const found = await db.getUserByEmail(email);
    if (found) {
      lookup = {
        ...found,
        referralCount: await db.countReferrals(found.id),
        deployStats: await db.getDeploymentStatsForUser(found.id),
      };
    }
  }
  const herokuKeyStatus = await heroku.getKeyStatus();
  res.render('admin', { title: 'Admin', searchedEmail: email, lookup, herokuKeyStatus });
}));

router.post('/admin/add-coins', safe('/admin', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const amount = parseInt(req.body.amount, 10);
  const expiry = String(req.body.expiry || 'none'); // 'none' | 'small' | 'large'

  if (!email || !Number.isFinite(amount) || amount === 0) {
    flash(req, 'error', 'Enter a valid email and a non-zero coin amount.');
    return res.redirect(`/admin?email=${encodeURIComponent(email)}`);
  }

  const user = await db.getUserByEmail(email);
  if (!user) {
    flash(req, 'error', 'No user with that email.');
    return res.redirect('/admin');
  }

  if (amount > 0 && expiry === 'small') {
    await db.addCoinsWithExpiry(user.id, amount, config.coins.smallPackageExpiryDays);
  } else if (amount > 0 && expiry === 'large') {
    await db.addCoinsWithExpiry(user.id, amount, config.coins.largePackageExpiryDays);
  } else {
    await db.addCoins(user.id, amount);
  }

  flash(req, 'success', `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} JC ${amount > 0 ? 'to' : 'from'} ${email}.`);
  res.redirect(`/admin?email=${encodeURIComponent(email)}`);
}));

router.post('/admin/set-admin', safe('/admin', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const makeAdmin = req.body.make_admin === '1';

  const user = await db.getUserByEmail(email);
  if (!user) {
    flash(req, 'error', 'No user with that email.');
    return res.redirect('/admin');
  }

  if (user.id === req.user.id && !makeAdmin) {
    flash(req, 'error', "You can't remove your own admin access — have another admin do it, so nobody gets locked out.");
    return res.redirect(`/admin?email=${encodeURIComponent(email)}`);
  }

  await db.setAdmin(user.id, makeAdmin);
  flash(req, 'success', `${email} is ${makeAdmin ? 'now' : 'no longer'} an admin.`);
  res.redirect(`/admin?email=${encodeURIComponent(email)}`);
}));

router.post('/admin/heroku-key', safe('/admin', async (req, res) => {
  const newKey = String(req.body.heroku_api_key || '').trim();
  if (!newKey) {
    flash(req, 'error', 'Paste a key first.');
    return res.redirect('/admin');
  }
  await heroku.setApiKeyOverride(newKey);
  flash(req, 'success', 'Heroku API key updated — takes effect immediately, no redeploy needed.');
  res.redirect('/admin');
}));

module.exports = router;
