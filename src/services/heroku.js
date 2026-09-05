// Thin wrapper around Heroku's Platform API.
//
// We use the /app-setups endpoint — the same one behind every "Deploy to
// Heroku" button. Given a source tarball URL (the bot's repo) plus env
// var overrides (SESSION_ID, app name, etc.), Heroku itself reads the
// app.json baked into that tarball, provisions any addons/buildpacks it
// declares, creates the app, sets the config vars, and kicks off the
// build — so this file doesn't need to duplicate any of that logic.
//
// Docs: https://devcenter.heroku.com/articles/platform-api-reference#app-setup

const config = require('../config');
const db = require('../db');

const HEROKU_API = 'https://api.heroku.com';
const SETTING_KEY = 'heroku_api_key';

// An admin-set key in the database always wins over the config.js
// default — that's what lets the key be rotated live from /admin with
// no redeploy. Falls back to config.js if nothing's been set in the DB.
async function getApiKey() {
  const override = await db.getSetting(SETTING_KEY);
  return override || config.heroku.apiKey || '';
}

async function isConfigured() {
  return Boolean(await getApiKey());
}

// For the admin panel: which key is actually in effect right now and
// where it came from, without ever returning the key itself.
async function getKeyStatus() {
  const override = await db.getSetting(SETTING_KEY);
  if (override) return { configured: true, source: 'database' };
  if (config.heroku.apiKey) return { configured: true, source: 'config' };
  return { configured: false, source: 'none' };
}

async function setApiKeyOverride(newKey) {
  await db.setSetting(SETTING_KEY, newKey);
}

async function assertConfigured() {
  const key = await getApiKey();
  if (!key) {
    const err = new Error(
      'No Heroku API key is set yet. Add one from Admin, or set HEROKU_API_KEY in config.js.'
    );
    err.code = 'HEROKU_NOT_CONFIGURED';
    throw err;
  }
  return key;
}

async function headers() {
  const key = await assertConfigured();
  return {
    Accept: 'application/vnd.heroku+json; version=3',
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function herokuRequest(pathname, options = {}) {
  const res = await fetch(`${HEROKU_API}${pathname}`, {
    ...options,
    headers: await headers(),
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
 * @param {string} sourceBlobUrl - tarball URL for the bot's repo/branch
 * @param {string} appName - desired Heroku app name (may be auto-suffixed by Heroku if taken)
 * @param {object} env - key/value overrides, e.g. { SESSION_ID: '...' }
 */
async function createAppSetup({ sourceBlobUrl, appName, env }) {
  const body = {
    source_blob: { url: sourceBlobUrl },
    overrides: { env },
  };
  if (appName) body.app = { name: appName };
  return herokuRequest('/app-setups', { method: 'POST', body: JSON.stringify(body) });
}

/** Poll the status of a previously-created app setup. */
async function getAppSetup(appSetupId) {
  return herokuRequest(`/app-setups/${appSetupId}`);
}

/**
 * Update config vars on an app that's already deployed — e.g. a fresh
 * SESSION_ID after the old one expired. Heroku only touches the keys
 * you send here; every other existing config var on the app is left
 * alone. Setting a config var triggers a new release, which restarts
 * the app's dynos automatically — no separate restart call needed.
 */
async function updateConfigVars(appName, vars) {
  return herokuRequest(`/apps/${appName}/config-vars`, {
    method: 'PATCH',
    body: JSON.stringify(vars),
  });
}

/** Restarts every dyno on the app (kills them; the formation manager brings them straight back up). */
async function restartApp(appName) {
  return herokuRequest(`/apps/${appName}/dynos`, { method: 'DELETE' });
}

/**
 * Scales the web dyno formation. quantity: 0 stops the app (dynos shut
 * down, nothing is deleted, no compute is billed while at 0), quantity: 1
 * resumes it. Used for the "Stop app" action and for the renewal-billing
 * sweep pausing an app that couldn't be charged.
 */
async function scaleWebDyno(appName, quantity) {
  return herokuRequest(`/apps/${appName}/formation`, {
    method: 'PATCH',
    body: JSON.stringify({ updates: [{ type: 'web', quantity }] }),
  });
}

/** Permanently deletes the app. There's no undo on Heroku's side. */
async function deleteApp(appName) {
  return herokuRequest(`/apps/${appName}`, { method: 'DELETE' });
}

/**
 * Rebuilds the app from the latest code at sourceBlobUrl, leaving all
 * existing config vars untouched — for pulling in an upstream fix to
 * the bot's code without re-entering SESSION_ID or anything else.
 */
async function createBuild(appName, sourceBlobUrl) {
  return herokuRequest(`/apps/${appName}/builds`, {
    method: 'POST',
    body: JSON.stringify({ source_blob: { url: sourceBlobUrl } }),
  });
}

module.exports = {
  createAppSetup,
  getAppSetup,
  updateConfigVars,
  restartApp,
  scaleWebDyno,
  deleteApp,
  createBuild,
  isConfigured,
  getKeyStatus,
  setApiKeyOverride,
};
