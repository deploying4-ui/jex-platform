const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
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
      console.error(`[account] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(fallbackPath);
    }
  };
}

router.get('/my-coins', requireAuth, safe('/dashboard', async (req, res) => {
  const referralCount = await db.countReferrals(req.user.id);
  const eligibleAt = db.freeClaimEligibleAt(req.user.last_free_claim_at, config.coins.freeClaimIntervalDays);
  res.render('my-coins', {
    title: 'My Coins',
    referralCount,
    deployCost: config.coins.deployCostCoins,
    renewalCost: config.coins.renewalCostCoins,
    renewalHours: config.coins.renewalPeriodHours,
    referralBonus: config.coins.referralBonusCoins,
    freeClaimCoins: config.coins.freeClaimCoins,
    freeClaimIntervalDays: config.coins.freeClaimIntervalDays,
    freeClaimReady: Date.now() >= eligibleAt,
    freeClaimEligibleAt: eligibleAt,
  });
}));

router.post('/my-coins/claim', requireAuth, safe('/my-coins', async (req, res) => {
  const result = await db.claimFreeCoin(req.user.id, config.coins.freeClaimCoins, config.coins.freeClaimIntervalDays);
  if (result.claimed) {
    flash(req, 'success', `Claimed ${config.coins.freeClaimCoins} JC — next claim in ${config.coins.freeClaimIntervalDays} days.`);
  } else {
    const hoursLeft = Math.ceil((result.eligibleAt - Date.now()) / (60 * 60 * 1000));
    flash(req, 'error', `Not yet — you can claim again in about ${hoursLeft}h.`);
  }
  res.redirect('/my-coins');
}));

router.get('/my-profile', requireAuth, (req, res) => {
  res.render('profile', { title: 'My Profile' });
});

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
