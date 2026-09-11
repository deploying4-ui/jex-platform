const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

const BOTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'bots.json'), 'utf8')
);

// The curated catalog (data/bots.json) plus any community bots approved
// through the bot-request flow (stored in the DB, since a live Render
// filesystem can't durably persist edits to a bundled JSON file).
// Community bots are flagged `isCommunity: true` — not used for the
// manifest lookup (every bot reads jexhost.json now), just handy for
// the UI to tell them apart if it ever wants to.
async function listBots() {
  const community = await db.listCommunityBots();
  return [...BOTS, ...community.map((b) => ({ ...b, isCommunity: true }))];
}

async function getBotBySlug(slug) {
  const staticBot = BOTS.find((b) => b.slug === slug);
  if (staticBot) return staticBot;
  const communityBot = await db.getCommunityBotBySlug(slug);
  return communityBot ? { ...communityBot, isCommunity: true } : null;
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'bot';
}

// Guarantees a slug that's unique across both the static catalog and
// the community bots table — appending -2, -3, etc. on collision.
async function generateUniqueSlug(name) {
  const community = await db.listCommunityBots();
  const taken = new Set([...BOTS.map((b) => b.slug), ...community.map((b) => b.slug)]);
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

// Each bot can declare its own pairing site in data/bots.json; bots
// that leave it blank (Vesper-Xmd, Jexploit Bot) fall back to the
// shared one in config.
function getSessionHelperUrl(bot) {
  return bot.sessionHelperUrl || config.sessionHelperUrl || '';
}

// Every bot's env-var manifest now lives in jexhost.json — the same
// file that identifies/verifies ownership for community bot requests.
// Curated catalog bots need it added to their repos too (previously
// they only had a Heroku app.json); see jexhost.example.json for the
// template to hand their owners.
function rawManifestUrl(bot) {
  return `https://raw.githubusercontent.com/${bot.owner}/${bot.repo}/${bot.branch}/jexhost.json`;
}

function tarballUrl(bot) {
  return `https://github.com/${bot.owner}/${bot.repo}/tarball/${bot.branch}`;
}

function cachedManifestPath(bot) {
  return path.join(__dirname, '..', '..', 'data', 'manifest-cache', `${bot.slug}.json`);
}

/**
 * Fetch a bot's manifest straight from GitHub so the deploy form always
 * reflects whatever the repo currently declares. Falls back to the
 * bundled copy (data/manifest-cache/) if the live fetch fails for any
 * reason — offline dev, GitHub rate limits, etc. Community bots have no
 * bundled cache (they're not known until a request is approved), so a
 * failed live fetch for one just surfaces an empty env list rather than
 * throwing.
 */
async function getManifest(bot) {
  try {
    const res = await fetch(rawManifestUrl(bot), { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const manifest = await res.json();
      return { manifest, source: 'live' };
    }
  } catch (_err) {
    // fall through to cache
  }
  const cachePath = cachedManifestPath(bot);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return { manifest: cached, source: 'cache' };
  }
  return { manifest: { env: {} }, source: 'unavailable' };
}

/**
 * Normalize jexhost.json's `env` block into a flat array the view can loop
 * over. SESSION_ID and APP_NAME are always guaranteed to be present (and
 * required) regardless of how the manifest itself flags them, since the
 * deploy form always needs both.
 */
function buildEnvFields(manifest) {
  const declared = manifest.env || {};
  const fields = Object.entries(declared).map(([key, def]) => ({
    key,
    description: def.description || '',
    default: def.value || '',
    required: key === 'SESSION_ID' ? true : Boolean(def.required),
  }));

  if (!fields.some((f) => f.key === 'SESSION_ID')) {
    fields.unshift({
      key: 'SESSION_ID',
      description: 'The paired WhatsApp session string for this bot.',
      default: '',
      required: true,
    });
  }

  return fields;
}

module.exports = { listBots, getBotBySlug, getManifest, buildEnvFields, tarballUrl, getSessionHelperUrl, generateUniqueSlug };
