// Thin wrapper around Heroku's Platform API.
//
// We use the /app-setups endpoint — the same one behind every "Deploy to
// Heroku" button. Given a source tarball URL (the bot's repo) plus env
// var overrides (SESSION_ID, app name, etc.), Heroku itself reads the
// app.json baked into that tarball, provisions any addons/buildpacks it
// declares, creates the app, sets the config vars, and kicks off the
// build — so this file doesn't need to duplicate any of that logic.
//
// Deploys can be spread across several Heroku accounts (see the
// heroku_accounts table / admin "Heroku" page), so every function here
// takes the API key to use as an explicit first argument rather than
// reading one fixed key off config — callers resolve the right key per
// deployment via db.resolveHerokuApiKey().
//
// Docs: https://devcenter.heroku.com/articles/platform-api-reference#app-setup

const config = require('../config');

const HEROKU_API = 'https://api.heroku.com';

function assertConfigured(apiKey) {
  if (!apiKey) {
    const err = new Error(
      'No Heroku API key available for this action. Add one from Admin → Heroku, or set HEROKU_API_KEY in .env.'
    );
    err.code = 'HEROKU_NOT_CONFIGURED';
    throw err;
  }
}

function headers(apiKey) {
  return {
    Accept: 'application/vnd.heroku+json; version=3',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function herokuRequest(apiKey, pathname, options = {}) {
  const res = await fetch(`${HEROKU_API}${pathname}`, {
    ...options,
    headers: headers(apiKey),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.message || data.id || `Heroku API error (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.herokuBody = data;
    throw err;
  }
  return data;
}

/**
 * Kick off a deploy.
 * @param {string} apiKey - the Heroku account to deploy under
 * @param {string} sourceBlobUrl - tarball URL for the bot's repo/branch
 * @param {string} appName - desired Heroku app name (may be auto-suffixed by Heroku if taken)
 * @param {object} env - key/value overrides, e.g. { SESSION_ID: '...' }
 */
async function createAppSetup(apiKey, { sourceBlobUrl, appName, env }) {
  assertConfigured(apiKey);
  const body = {
    source_blob: { url: sourceBlobUrl },
    overrides: { env },
  };
  if (appName) body.app = { name: appName };
  return herokuRequest(apiKey, '/app-setups', { method: 'POST', body: JSON.stringify(body) });
}

/** Poll the status of a previously-created app setup. */
async function getAppSetup(apiKey, appSetupId) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/app-setups/${appSetupId}`);
}

/**
 * Fetches a build's metadata, including `output_stream_url` — a
 * plain-text HTTP stream of the actual `npm install`/build output
 * (the same thing `heroku builds:output` shows), separate from the
 * app-setups status object which only ever gives a one-line summary.
 * The URL is only live while the build is running; once it finishes
 * the stream just ends.
 */
async function getBuild(apiKey, appName, buildId) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/apps/${appName}/builds/${buildId}`);
}

/**
 * Update config vars on an app that's already deployed — e.g. a fresh
 * SESSION_ID after the old one expired. Heroku only touches the keys
 * you send here; every other existing config var on the app is left
 * alone. Setting a config var triggers a new release, which restarts
 * the app's dynos automatically — no separate restart call needed.
 */
async function updateConfigVars(apiKey, appName, vars) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/apps/${appName}/config-vars`, {
    method: 'PATCH',
    body: JSON.stringify(vars),
  });
}

/** Restarts every dyno on the app (kills them; the formation manager brings them straight back up). */
async function restartApp(apiKey, appName) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/apps/${appName}/dynos`, { method: 'DELETE' });
}

/**
 * Scales the web dyno formation. quantity: 0 stops the app (dynos shut
 * down, nothing is deleted, no compute is billed while at 0), quantity: 1
 * resumes it. Used for the "Stop app" action and for the renewal-billing
 * sweep pausing an app that couldn't be charged.
 */
async function scaleWebDyno(apiKey, appName, quantity) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/apps/${appName}/formation`, {
    method: 'PATCH',
    body: JSON.stringify({ updates: [{ type: 'web', quantity }] }),
  });
}

/** Permanently deletes the app. There's no undo on Heroku's side. */
async function deleteApp(apiKey, appName) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/apps/${appName}`, { method: 'DELETE' });
}

/**
 * Rebuilds the app from the latest code at sourceBlobUrl, leaving all
 * existing config vars untouched — for pulling in an upstream fix to
 * the bot's code without re-entering SESSION_ID or anything else.
 */
async function createBuild(apiKey, appName, sourceBlobUrl) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/apps/${appName}/builds`, {
    method: 'POST',
    body: JSON.stringify({ source_blob: { url: sourceBlobUrl } }),
  });
}

/**
 * Opens a Heroku log session for an app — the same primitive behind
 * `heroku logs`. With tail:true the returned logplex_url is a
 * text/event-stream you keep open for live logs; with tail:false it's
 * a one-shot snapshot of the last `lines` entries. Used for the "View
 * logs" page so users can see their bot's runtime output/errors
 * without needing Heroku CLI access.
 */
async function createLogSession(apiKey, appName, { lines = 200, tail = false, dyno = 'web.1', source = 'app' } = {}) {
  assertConfigured(apiKey);
  return herokuRequest(apiKey, `/apps/${appName}/log-sessions`, {
    method: 'POST',
    body: JSON.stringify({ dyno, lines, source, tail }),
  });
}

/**
 * Checks that a key actually works, for the "Validate" button on the
 * admin Heroku page — hits the cheapest authenticated endpoint there
 * is (the account's own info) rather than anything that could create
 * or touch an app.
 */
async function verifyApiKey(apiKey) {
  if (!apiKey) return { valid: false, error: 'No API key provided.' };
  try {
    const account = await herokuRequest(apiKey, '/account');
    return { valid: true, email: account.email };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  createAppSetup,
  getAppSetup,
  getBuild,
  updateConfigVars,
  restartApp,
  scaleWebDyno,
  deleteApp,
  createBuild,
  createLogSession,
  verifyApiKey,
  // True if there's at least a legacy fallback key in .env — accounts
  // added from Admin → Heroku are checked separately (they're async,
  // DB-backed), this only covers the single-key config path.
  isConfigured: () => Boolean(config.heroku.apiKey),
};
