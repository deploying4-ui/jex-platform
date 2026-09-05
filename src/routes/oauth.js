const express = require('express');
const passport = require('../services/passport');
const config = require('../config');

const router = express.Router();

function flash(req, type, message) {
  req.session.flash = { type, message };
}

router.get('/auth/google', (req, res, next) => {
  if (!config.oauth.google.enabled) {
    flash(req, 'error', 'Google sign-in is not set up yet.');
    return res.redirect('/login');
  }
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

router.get(
  '/auth/google/callback',
  (req, res, next) => {
    if (!config.oauth.google.enabled) return res.redirect('/login');
    passport.authenticate('google', { session: false }, (err, user) => {
      if (err || !user) {
        flash(req, 'error', err?.message || 'Google sign-in failed. Try again.');
        return res.redirect('/login');
      }
      req.session.userId = user.id;
      res.redirect('/dashboard');
    })(req, res, next);
  }
);

router.get('/auth/github', (req, res, next) => {
  if (!config.oauth.github.enabled) {
    flash(req, 'error', 'GitHub sign-in is not set up yet.');
    return res.redirect('/login');
  }
  passport.authenticate('github', { session: false })(req, res, next);
});

router.get(
  '/auth/github/callback',
  (req, res, next) => {
    if (!config.oauth.github.enabled) return res.redirect('/login');
    passport.authenticate('github', { session: false }, (err, user) => {
      if (err || !user) {
        flash(req, 'error', err?.message || 'GitHub sign-in failed. Try again.');
        return res.redirect('/login');
      }
      req.session.userId = user.id;
      res.redirect('/dashboard');
    })(req, res, next);
  }
);

module.exports = router;
