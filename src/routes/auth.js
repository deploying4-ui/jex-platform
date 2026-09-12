const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const googleAuth = require('../services/googleAuth');
const githubAuth = require('../services/githubAuth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Express 4 does NOT automatically catch a rejected promise thrown
// inside an async route handler — without this, any unexpected error
// leaves the request hanging forever with no response.
function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[auth] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(typeof fallbackPath === 'function' ? fallbackPath(req) : fallbackPath);
    }
  };
}

// ── Register ────────────────────────────────────────────

router.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('register', { title: 'Create account', ref: req.query.ref || '', googleEnabled: googleAuth.isConfigured(), githubEnabled: githubAuth.isConfigured() });
});

router.post('/register', authLimiter, safe('/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirmPassword || '');
  const refCode = String(req.body.ref || '').trim();

  if (!EMAIL_RE.test(email)) {
    flash(req, 'error', 'Enter a valid email address.');
    return res.redirect(`/register?ref=${encodeURIComponent(refCode)}`);
  }
  if (password.length < 8) {
    flash(req, 'error', 'Password must be at least 8 characters.');
    return res.redirect(`/register?ref=${encodeURIComponent(refCode)}`);
  }
  if (password !== confirmPassword) {
    flash(req, 'error', 'Passwords do not match.');
    return res.redirect(`/register?ref=${encodeURIComponent(refCode)}`);
  }

  const existing = await db.getUserByEmail(email);
  if (existing) {
    flash(req, 'error', 'An account with that email already exists. Try logging in.');
    return res.redirect('/login');
  }

  const referrer = refCode ? await db.getUserByReferralCode(refCode) : null;
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.createUser({
    email,
    passwordHash,
    referredBy: referrer ? referrer.id : null,
  });

  // Automatically mark user as verified without requiring OTP
  await db.markVerified(user.id);
  await db.addCoinsWithExpiry(user.id, settings.get().starterCoins, settings.get().starterCoinsExpiryDays);
  await db.rewardReferrerIfDue(user, settings.get().referralBonusCoins);

  req.session.userId = user.id;
  flash(req, 'success', `Account created! You've been credited ${settings.get().starterCoins} JC to get started.`);
  res.redirect('/dashboard');
}));

// ── Login / logout ──────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('login', { title: 'Log in', googleEnabled: googleAuth.isConfigured(), githubEnabled: githubAuth.isConfigured() });
});

router.post('/login', authLimiter, safe('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = await db.getUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    flash(req, 'error', 'Incorrect email or password.');
    return res.redirect('/login');
  }

  if (!user.verified) {
    await db.markVerified(user.id);
  }

  req.session.userId = user.id;
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Continue with Google ─────────────────────────────────

router.get('/auth/google', (req, res) => {
  if (!googleAuth.isConfigured()) {
    flash(req, 'error', 'Google sign-in is not set up yet.');
    return res.redirect('/login');
  }
  res.redirect(googleAuth.buildAuthorizeUrl(req.query.ref || ''));
});

router.get('/auth/google/callback', safe('/login', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    flash(req, 'error', 'Google sign-in was cancelled.');
    return res.redirect('/login');
  }

  const stateData = googleAuth.readState(state);
  if (!code || !stateData) {
    flash(req, 'error', 'That Google sign-in link expired — please try again.');
    return res.redirect('/login');
  }

  let profile;
  try {
    profile = await googleAuth.exchangeCodeForProfile(code);
  } catch (err) {
    console.error('[google-auth] failed:', err.message);
    flash(req, 'error', 'Google sign-in failed — please try again.');
    return res.redirect('/login');
  }

  let user = await db.getUserByEmail(profile.email);
  if (!user) {
    const referrer = stateData.ref ? await db.getUserByReferralCode(stateData.ref) : null;
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    user = await db.createUser({
      email: profile.email,
      passwordHash: placeholderHash,
      referredBy: referrer ? referrer.id : null,
    });
    await db.addCoinsWithExpiry(user.id, settings.get().starterCoins, settings.get().starterCoinsExpiryDays);
    await db.markVerified(user.id);
    await db.rewardReferrerIfDue(user, settings.get().referralBonusCoins);
  } else if (!user.verified) {
    await db.markVerified(user.id);
  }

  req.session.userId = user.id;
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
}));

// ── Continue with GitHub ─────────────────────────────────

router.get('/auth/github', (req, res) => {
  if (!githubAuth.isConfigured()) {
    flash(req, 'error', 'GitHub sign-in is not set up yet.');
    return res.redirect('/login');
  }
  res.redirect(githubAuth.buildAuthorizeUrl(req.query.ref || ''));
});

router.get('/auth/github/callback', safe('/login', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    flash(req, 'error', 'GitHub sign-in was cancelled.');
    return res.redirect('/login');
  }

  const stateData = githubAuth.readState(state);
  if (!code || !stateData) {
    flash(req, 'error', 'That GitHub sign-in link expired — please try again.');
    return res.redirect('/login');
  }

  let profile;
  try {
    profile = await githubAuth.exchangeCodeForProfile(code);
  } catch (err) {
    console.error('[github-auth] failed:', err.message);
    flash(req, 'error', err.message || 'GitHub sign-in failed — please try again.');
    return res.redirect('/login');
  }

  let user = await db.getUserByEmail(profile.email);
  if (!user) {
    const referrer = stateData.ref ? await db.getUserByReferralCode(stateData.ref) : null;
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    user = await db.createUser({
      email: profile.email,
      passwordHash: placeholderHash,
      referredBy: referrer ? referrer.id : null,
    });
    await db.addCoinsWithExpiry(user.id, settings.get().starterCoins, settings.get().starterCoinsExpiryDays);
    await db.markVerified(user.id);
    await db.rewardReferrerIfDue(user, settings.get().referralBonusCoins);
  } else if (!user.verified) {
    await db.markVerified(user.id);
  }

  req.session.userId = user.id;
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
}));

module.exports = router;
