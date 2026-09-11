// Minimal Google OAuth2 (authorization code flow) — no passport dependency,
// just native fetch (Node 18+). auth.js expects exactly this interface:
// isConfigured(), buildAuthorizeUrl(ref), readState(state), exchangeCodeForProfile(code).

const crypto = require('crypto');
const config = require('../config');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const clientId = config.oauth.google.clientId;
const clientSecret = config.oauth.google.clientSecret;
const redirectUri = `${config.server.baseUrl}/auth/google/callback`;

// Used to sign the `state` param so we can trust the referral code round-tripped
// through Google without needing server-side storage for it.
const STATE_SECRET = config.server.sessionSecret;

function sign(payload) {
  return crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
}

function isConfigured() {
  return config.oauth.google.enabled;
}

function buildAuthorizeUrl(ref) {
  const payload = JSON.stringify({ ref: ref || '', nonce: crypto.randomBytes(16).toString('hex') });
  const state = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

function readState(state) {
  try {
    const [encoded, sig] = String(state || '').split('.');
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!sig || sign(payload) !== sig) return { ref: '' };
    const data = JSON.parse(payload);
    return { ref: data.ref || '' };
  } catch {
    return { ref: '' };
  }
}

async function exchangeCodeForProfile(code) {
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed (${tokenRes.status})`);
  const tokenData = await tokenRes.json();

  const profileRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) throw new Error(`Google profile fetch failed (${profileRes.status})`);
  const profile = await profileRes.json();

  if (!profile.email) throw new Error('Google account has no email to sign up with.');
  return { email: String(profile.email).toLowerCase() };
}

module.exports = { isConfigured, buildAuthorizeUrl, readState, exchangeCodeForProfile };
