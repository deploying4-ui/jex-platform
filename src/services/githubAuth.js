// Minimal GitHub OAuth2 (authorization code flow) — same pattern as
// googleAuth.js, no passport dependency, just native fetch (Node 18+).

const crypto = require('crypto');
const config = require('../config');

const AUTH_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';

const clientId = config.oauth.github.clientId;
const clientSecret = config.oauth.github.clientSecret;
const redirectUri = `${config.server.baseUrl}/auth/github/callback`;

const STATE_SECRET = config.server.sessionSecret;

function sign(payload) {
  return crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
}

function isConfigured() {
  return config.oauth.github.enabled;
}

function buildAuthorizeUrl(ref) {
  const payload = JSON.stringify({ ref: ref || '', nonce: crypto.randomBytes(16).toString('hex') });
  const state = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state,
    allow_signup: 'true',
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) throw new Error(`GitHub token exchange failed (${tokenRes.status})`);
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(tokenData.error_description || 'GitHub sign-in was cancelled.');

  const authHeader = { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'jex-platform' };

  const userRes = await fetch(USER_URL, { headers: authHeader });
  if (!userRes.ok) throw new Error(`GitHub profile fetch failed (${userRes.status})`);
  const user = await userRes.json();

  // GitHub only puts email on the profile if the user made it public —
  // otherwise it's only available via the emails endpoint (needs the
  // user:email scope, which we requested above).
  let email = user.email;
  if (!email) {
    const emailsRes = await fetch(EMAILS_URL, { headers: authHeader });
    if (emailsRes.ok) {
      const emails = await emailsRes.json();
      const primary = emails.find((e) => e.primary) || emails[0];
      email = primary?.email || null;
    }
  }

  if (!email) {
    throw new Error('Your GitHub email is private. Make it public on GitHub, or sign up with email instead.');
  }
  return { email: String(email).toLowerCase() };
}

module.exports = { isConfigured, buildAuthorizeUrl, readState, exchangeCodeForProfile };
