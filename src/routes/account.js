const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const { requireAuth } = require('../middleware/auth');
const { getLevel } = require('../services/levels');

const router = express.Router();

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[account] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(fallbackPath);
    }
  };
}

router.get('/my-coins', requireAuth, safe('/dashboard', async (req, res) => {
  const s = settings.get();
  const referralCount = await db.countReferrals(req.user.id);
  const isPremium = req.user.plan === 'premium';
  res.render('my-coins', {
    title: 'My Coins',
    referralCount,
    deployCost: s.deployCostCoins,
    renewalCost: isPremium ? s.premiumRenewalCostCoins : s.renewalCostCoins,
    standardRenewalCost: s.renewalCostCoins,
    isPremium,
    renewalHours: s.renewalPeriodHours,
    referralBonus: s.referralBonusCoins,
  });
}));

router.get('/my-profile', requireAuth, safe('/dashboard', async (req, res) => {
  const referralCount = await db.countReferrals(req.user.id);
  const deployStats = await db.getDeploymentStatsForUser(req.user.id);
  const level = getLevel({ activeDeployments: deployStats.active, referralCount });
  const referralLink = `${config.server.baseUrl}/register?ref=${req.user.referral_code}`;

  res.render('profile', {
    title: 'My Profile',
    referralCount,
    deployStats,
    level,
    referralLink,
    referralBonus: settings.get().referralBonusCoins,
    referralCoinsEarned: req.user.referral_coins_earned || 0,
  });
}));

router.post('/my-profile/username', requireAuth, safe('/my-profile', async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!username) {
    flash(req, 'error', 'Enter a username.');
    return res.redirect('/my-profile');
  }
  try {
    await db.updateUsername(req.user.id, username);
    flash(req, 'success', 'Username updated.');
  } catch (err) {
    flash(req, 'error', err.message || 'Could not update your username.');
  }
  res.redirect('/my-profile');
}));

router.post('/my-profile/password', requireAuth, safe('/my-profile', async (req, res) => {
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  const match = await bcrypt.compare(currentPassword, req.user.password_hash);
  if (!match) {
    flash(req, 'error', 'Current password is incorrect.');
    return res.redirect('/my-profile');
  }
  if (newPassword.length < 8) {
    flash(req, 'error', 'New password must be at least 8 characters.');
    return res.redirect('/my-profile');
  }
  if (newPassword !== confirmPassword) {
    flash(req, 'error', 'New passwords do not match.');
    return res.redirect('/my-profile');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.updatePassword(req.user.id, passwordHash);
  flash(req, 'success', 'Password updated.');
  res.redirect('/my-profile');
}));

module.exports = router;
