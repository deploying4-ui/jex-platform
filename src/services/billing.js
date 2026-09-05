// Two periodic jobs, run on a plain setInterval inside this process —
// no external job queue needed at this scale.
//
//  1. Renewal sweep: every deployed bot costs `renewalCostCoins` JC per
//     `renewalPeriodHours` to stay running. Whenever a deployment falls
//     due, this tries to deduct that from the owner's balance. If they
//     can't cover it, the app is scaled to zero dynos (stopped, not
//     deleted) and marked 'stopped' so the dashboard reflects it.
//  2. Coin-expiry sweep: zeroes out any balance whose coins_expire_at
//     has passed.
//
// This is the highest-stakes background job in the app — it moves real
// JC and can stop a user's live bot — so every deployment is handled in
// its own try/catch: one bad row logs an error and moves on instead of
// aborting the whole sweep, and the interval callback itself is wrapped
// so a thrown error can never crash the server process.

const db = require('../db');
const heroku = require('../services/heroku');
const config = require('../config');

const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes

async function chargeOrStop(deployment) {
  const charged = await db.deductCoinsIfSufficient(deployment.user_id, config.coins.renewalCostCoins);

  if (charged) {
    await db.touchDeploymentCharged(deployment.id);
    return;
  }

  // Couldn't collect the renewal — pause the app rather than leaving it
  // running unpaid. Nothing is deleted; the user can top up and restart
  // it themselves from "My Bots".
  if (await heroku.isConfigured()) {
    try {
      await heroku.scaleWebDyno(deployment.app_name, 0);
    } catch (err) {
      console.error(`[billing] failed to stop ${deployment.app_name} on Heroku:`, err.message);
      // Still mark it stopped in our own records even if the Heroku
      // call failed — better to under-bill than to keep charging for
      // an app we can no longer confirm the state of.
    }
  }
  await db.updateDeploymentStatus(deployment.id, {
    status: 'stopped',
    failureMessage: `Paused — not enough JC for the ${config.coins.renewalCostCoins} JC / ${config.coins.renewalPeriodHours}h renewal. Top up and restart it from My Bots.`,
  });
}

async function runRenewalSweep() {
  const due = await db.getDeploymentsDueForRenewal(config.coins.renewalPeriodHours);
  for (const deployment of due) {
    try {
      await chargeOrStop(deployment);
    } catch (err) {
      console.error(`[billing] renewal charge failed for deployment ${deployment.id}:`, err);
    }
  }
  if (due.length) console.log(`[billing] renewal sweep processed ${due.length} deployment(s)`);
}

async function runExpirySweep() {
  try {
    const count = await db.expireStaleCoins();
    if (count) console.log(`[billing] expired JC balance for ${count} account(s)`);
  } catch (err) {
    console.error('[billing] coin-expiry sweep failed:', err);
  }
}

let handle = null;

function start() {
  if (handle) return; // already running
  const tick = () => {
    runRenewalSweep().catch((err) => console.error('[billing] renewal sweep crashed:', err));
    runExpirySweep().catch((err) => console.error('[billing] expiry sweep crashed:', err));
  };
  // Give the server a minute to finish booting before the first sweep.
  setTimeout(tick, 60 * 1000);
  handle = setInterval(tick, SWEEP_INTERVAL_MS);
}

function stop() {
  if (handle) clearInterval(handle);
  handle = null;
}

module.exports = { start, stop, runRenewalSweep, runExpirySweep };
