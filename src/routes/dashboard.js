const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const marzpay = require('../services/marzpay');
const { requireAuth } = require('../middleware/auth');
const { getLevel } = require('../services/levels');

const router = express.Router();

function slotLimitFor(user) {
  const s = settings.get();
  return s.maxBotsPerUser + (user && user.plan === 'premium' ? s.premiumBonusSlots : 0);
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[dashboard] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(fallbackPath);
    }
  };
}

router.get('/dashboard', requireAuth, safe('/login', async (req, res) => {
  const s = settings.get();
  const deployments = await db.listDeploymentsForUser(req.user.id);
  const stats = await db.getDeploymentStatsForUser(req.user.id);
  const referralCount = await db.countReferrals(req.user.id);
  const referralLink = `${config.server.baseUrl}/register?ref=${req.user.referral_code}`;
  const level = getLevel({ activeDeployments: stats.active, referralCount });
  const claimWaitUntil = db.nextClaimAt(req.user, s.dailyClaimPeriodHours);

  res.render('dashboard', {
    title: 'Dashboard',
    deployments: deployments.slice(0, 5),
    stats,
    slotsUsed: stats.active + stats.pending,
    slotsTotal: slotLimitFor(req.user),
    referralCount,
    referralLink,
    referralBonus: s.referralBonusCoins,
    level,
    dailyClaimCoins: s.dailyClaimCoins,
    claimWaitUntil, // null = can claim now; timestamp = must wait until then
  });
}));

router.post('/dashboard/claim', requireAuth, safe('/dashboard', async (req, res) => {
  const s = settings.get();
  const claimed = await db.claimDailyCoins(req.user.id, s.dailyClaimCoins, s.dailyClaimPeriodHours);
  if (claimed) {
    flash(req, 'success', `+${s.dailyClaimCoins} JC claimed! Come back in ${s.dailyClaimPeriodHours}h for more.`);
  } else {
    flash(req, 'error', "You've already claimed today — come back later.");
  }
  res.redirect('/dashboard');
}));

router.get('/topup', requireAuth, (req, res) => {
  const s = settings.get();
  res.render('topup', {
    title: 'Buy Coins',
    marzConfigured: marzpay.isConfigured(),
    packages: config.coinPackages,
    paymentLabel: config.payments.methodLabel,
    paymentNumber: config.payments.number,
    minipayNumber: config.payments.minipayNumber,
    minipayAppUrl: config.payments.minipayAppUrl,
    supportEmail: config.payments.supportEmail,
    smallExpiryDays: s.smallPackageExpiryDays,
    largeExpiryDays: s.largePackageExpiryDays,
  });
});

module.exports = router;
