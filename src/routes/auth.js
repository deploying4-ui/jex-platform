const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const otp = require('../services/otp');
const mailer = require('../services/mailer');
const googleAuth = require('../services/googleAuth');
const githubAuth = require('../services/githubAuth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STARTER_COINS = config.coins.starterCoins;
const STARTER_COINS_EXPIRY_DAYS = config.coins.starterCoinsExpiryDays;
const REFERRAL_BONUS_COINS = config.coins.referralBonusCoins;

function flash(req, type, message) {
  req.session.flash = { type, message };
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // generous — this only needs to stop abuse, not slow down normal testing
  standardHeaders: true,
  legacyHeaders: false,
  // Render (and most PaaS) sit behind a reverse proxy that sets
  // X-Forwarded-For. express-rate-limit's built-in validator can throw
  // on that header's presence if it isn't fully convinced `trust proxy`
  // is configured safely — `app.set('trust proxy', 1)` in server.js IS
  // correct for a single-hop proxy like Render, but `validate: false`
  // skips that extra (and here, unnecessary) safety check entirely, so
  // a false positive there can't take down every POST request.
  validate: false,
  // Without a custom handler, going over the limit returns a bare,
  // unstyled 429 response — which looks exactly like "the form just
  // did nothing" if you don't notice the tiny text. This makes it a
  // real page with a real message instead.
  handler: (req, res) => {
    flash(req, 'error', 'Too many attempts in a short time — please wait a few minutes and try again.');
    const back = req.body?.email
      ? `/verify?email=${encodeURIComponent(String(req.body.email))}`
      : req.originalUrl.startsWith('/verify') || req.originalUrl.startsWith('/login')
      ? req.originalUrl
      : '/register';
    res.redirect(back);
  },
});

// The code is saved to the database BEFORE this runs, so even if the
// mail server is slow, down, or rejects the send, the user can still
// verify — this just stops a flaky SMTP call from hanging or breaking
// the request. Failures are logged server-side for you to notice.
async function trySendCode(email, code) {
  try {
    await mailer.sendVerificationCode(email, code);
    return true;
  } catch (err) {
    console.error('[mailer] failed to send verification code:', err.message);
    return false;
  }
}

// Express 4 does NOT automatically catch a rejected promise thrown
// inside an async route handler — without this, any unexpected error
// leaves the request hanging forever with no response. This wraps a
// handler so any such failure logs the real error and still sends the
// user a real page instead of a silent hang.
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
  if (existing && existing.verified) {
    flash(req, 'error', 'An account with that email already exists. Try logging in.');
    return res.redirect('/login');
  }

  let user = existing;
  if (!user) {
    const referrer = refCode ? await db.getUserByReferralCode(refCode) : null;
    const passwordHash = await bcrypt.hash(password, 10);
    user = await db.createUser({
      email,
      passwordHash,
      referredBy: referrer ? referrer.id : null,
    });
    // Starter grant expires after STARTER_COINS_EXPIRY_DAYS if unused.
    await db.addCoinsWithExpiry(user.id, STARTER_COINS, STARTER_COINS_EXPIRY_DAYS);
  }

  const { code, expiresAt } = otp.buildOtp();
  await db.setOtp(user.id, { code, expiresAt });
  const sent = await trySendCode(email, code);

  req.session.pendingEmail = email;
  flash(
    req,
    sent ? 'success' : 'error',
    sent
      ? `We sent a 6-digit code to ${email}.`
      : `Your account is ready, but that verification email didn't go out just now — tap "Resend code" below in a moment.`
  );
  // Email is carried in the URL as well as the session, so the verify
  // page still knows who it's verifying even if the session cookie
  // doesn't round-trip for some reason (new tab, slow network, etc.).
  res.redirect(`/verify?email=${encodeURIComponent(email)}`);
}));

// ── Verify ──────────────────────────────────────────────

router.get('/verify', (req, res) => {
  const email = req.query.email || req.session.pendingEmail || '';
  res.render('verify', { title: 'Verify your email', email, supportEmail: config.payments.supportEmail });
});

router.post('/verify', authLimiter, safe(
  (req) => `/verify?email=${encodeURIComponent(String(req.body.email || ''))}`,
  async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();

    const user = await db.getUserByEmail(email);
    if (!user) {
      flash(req, 'error', 'We could not find that account. Please register again.');
      return res.redirect('/register');
    }
    if (otp.isExpired(user.otp_expires_at)) {
      flash(req, 'error', 'That code expired. Request a new one below.');
      return res.redirect(`/verify?email=${encodeURIComponent(email)}`);
    }
    if (code !== user.otp_code) {
      flash(req, 'error', 'That code is incorrect.');
      return res.redirect(`/verify?email=${encodeURIComponent(email)}`);
    }

    await db.markVerified(user.id);
    await db.clearOtp(user.id);
    await db.rewardReferrerIfDue(user, REFERRAL_BONUS_COINS);
    delete req.session.pendingEmail;
    req.session.userId = user.id;
    flash(req, 'success', `Email verified — you've been credited ${STARTER_COINS} JC to get started (good for ${STARTER_COINS_EXPIRY_DAYS} days).`);
    res.redirect('/dashboard');
  }
));

router.post('/verify/resend', authLimiter, safe(
  (req) => `/verify?email=${encodeURIComponent(String(req.body.email || ''))}`,
  async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await db.getUserByEmail(email);
    if (!user) {
      flash(req, 'error', 'We could not find that account.');
      return res.redirect('/register');
    }
    if (!otp.canResend(user.otp_last_sent_at)) {
      const wait = otp.secondsUntilResend(user.otp_last_sent_at);
      flash(req, 'error', `Please wait ${wait}s before requesting another code.`);
      return res.redirect(`/verify?email=${encodeURIComponent(email)}`);
    }

    const { code, expiresAt } = otp.buildOtp();
    await db.setOtp(user.id, { code, expiresAt });
    const sent = await trySendCode(email, code);

    flash(
      req,
      sent ? 'success' : 'error',
      sent ? 'New code sent.' : 'Could not send the email just now — please try again in a moment.'
    );
    res.redirect(`/verify?email=${encodeURIComponent(email)}`);
  }
));

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
    const { code, expiresAt } = otp.buildOtp();
    await db.setOtp(user.id, { code, expiresAt });
    await trySendCode(email, code);
    req.session.pendingEmail = email;
    flash(req, 'error', 'Verify your email first — we just sent a fresh code.');
    return res.redirect(`/verify?email=${encodeURIComponent(email)}`);
  }

  req.session.userId = user.id;
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Continue with Google ─────────────────────────────────
// Same destination as email/password: existing email -> log in,
// new email -> create the account. Google has already verified the
// address, so there's no OTP step for this path.

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
    // No password is ever set for a Google-created account — this is a
    // long random value bcrypt hashes just like a real password would,
    // so it's not guessable and the password-login path simply can't
    // match it.
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    user = await db.createUser({
      email: profile.email,
      passwordHash: placeholderHash,
      referredBy: referrer ? referrer.id : null,
    });
    await db.addCoinsWithExpiry(user.id, STARTER_COINS, STARTER_COINS_EXPIRY_DAYS);
    await db.markVerified(user.id); // Google already verified this email
    await db.rewardReferrerIfDue(user, REFERRAL_BONUS_COINS);
  } else if (!user.verified) {
    // Account existed from an abandoned email/password signup — Google
    // just proved the same address, so unblock it here too.
    await db.markVerified(user.id);
  }

  req.session.userId = user.id;
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
}));

// ── Continue with GitHub ─────────────────────────────────
// Same pattern as Google above: existing email -> log in, new email ->
// create the account, no OTP step since GitHub already proved the email.

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
    await db.addCoinsWithExpiry(user.id, STARTER_COINS, STARTER_COINS_EXPIRY_DAYS);
    await db.markVerified(user.id); // GitHub already verified this email
    await db.rewardReferrerIfDue(user, REFERRAL_BONUS_COINS);
  } else if (!user.verified) {
    await db.markVerified(user.id);
  }

  req.session.userId = user.id;
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
}));

// ── Forgot password ──────────────────────────────────────

router.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('forgot-password', { title: 'Reset your password' });
});

router.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const user = await db.getUserByEmail(email);
  if (user) {
    const { code, expiresAt } = otp.buildOtp();
    await db.setOtp(user.id, { code, expiresAt });
    try {
      await mailer.sendPasswordResetCode(email, code);
    } catch (err) {
      console.error('[mailer] failed to send password reset code:', err.message);
    }
  }
  // Always respond ok, whether or not the account exists — don't leak that.
  res.json({ ok: true });
});

router.post('/api/auth/verify-reset-code', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();

  const user = await db.getUserByEmail(email);
  if (!user || !user.otp_code || otp.isExpired(user.otp_expires_at) || code !== user.otp_code) {
    return res.status(400).json({ valid: false, error: 'Incorrect or expired code.' });
  }
  res.json({ valid: true });
});

router.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const password = String(req.body.password || '');

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const user = await db.getUserByEmail(email);
  if (!user || !user.otp_code || otp.isExpired(user.otp_expires_at) || code !== user.otp_code) {
    return res.status(400).json({ error: 'Incorrect or expired code.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await db.updatePassword(user.id, passwordHash);
  await db.clearOtp(user.id);
  res.json({ ok: true });
});

module.exports = router;
