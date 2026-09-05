const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_BOTS_PER_USER = config.coins.maxBotsPerUser;

function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[dashboard] ${req.method} ${req.path} failed:`, err);
      req.session.flash = { type: 'error', message: 'Something went wrong on our end — please try again.' };
      res.redirect(fallbackPath);
    }
  };
}

router.get('/dashboard', requireAuth, safe('/login', async (req, res) => {
  const deployments = await db.listDeploymentsForUser(req.user.id);
  const stats = await db.getDeploymentStatsForUser(req.user.id);
  const referralCount = await db.countReferrals(req.user.id);
  const referralLink = `${config.server.baseUrl}/register?ref=${req.user.referral_code}`;

  res.render('dashboard', {
    title: 'Dashboard',
    deployments: deployments.slice(0, 5),
    stats,
    slotsUsed: stats.active + stats.pending,
    slotsTotal: MAX_BOTS_PER_USER,
    referralCount,
    referralLink,
    referralBonus: config.coins.referralBonusCoins,
  });
}));

router.get('/topup', requireAuth, (req, res) => {
  res.render('topup', {
    title: 'Buy Coins',
    paymentLabel: config.payments.methodLabel,
    paymentNumber: config.payments.number,
    supportEmail: config.payments.supportEmail,
    smallExpiryDays: config.coins.smallPackageExpiryDays,
    largeExpiryDays: config.coins.largePackageExpiryDays,
  });
});

module.exports = router;
