const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const heroku = require('../services/heroku');
const mailer = require('../services/mailer');
const botsService = require('../services/bots');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getLevel } = require('../services/levels');

const router = express.Router();

const USERS_PER_PAGE = 25;
const TICKETS_PER_PAGE = 25;
const DEPLOYMENTS_PER_PAGE = 25;
const BOT_REQUESTS_PER_PAGE = 25;
const ACCENTS = ['coral', 'teal', 'violet', 'gold'];
const CSS_CLASSES = ['b1', 'b2', 'b3', 'b4'];

router.use('/admin', requireAuth, requireAdmin);

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[admin] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(typeof fallbackPath === 'function' ? fallbackPath(req) : fallbackPath);
    }
  };
}

router.get('/admin', safe('/dashboard', async (req, res) => {
  let lookup = null;
  const email = String(req.query.email || '').trim();
  if (email) {
    const found = await db.getUserByEmail(email);
    if (found) {
      const referralCount = await db.countReferrals(found.id);
      const deployStats = await db.getDeploymentStatsForUser(found.id);
      lookup = {
        ...found,
        referralCount,
        deployStats,
        level: getLevel({ activeDeployments: deployStats.active, referralCount }),
      };
    }
  }
  res.render('admin', { title: 'Admin', searchedEmail: email, lookup });
}));

router.post('/admin/add-coins', safe('/admin', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const amount = parseInt(req.body.amount, 10);
  const expiry = String(req.body.expiry || 'none'); // 'none' | 'small' | 'large'

  if (!email || !Number.isFinite(amount) || amount === 0) {
    flash(req, 'error', 'Enter a valid email and a non-zero coin amount.');
    return res.redirect(`/admin?email=${encodeURIComponent(email)}`);
  }

  const user = await db.getUserByEmail(email);
  if (!user) {
    flash(req, 'error', 'No user with that email.');
    return res.redirect('/admin');
  }

  if (amount > 0 && expiry === 'small') {
    await db.addCoinsWithExpiry(user.id, amount, settings.get().smallPackageExpiryDays);
  } else if (amount > 0 && expiry === 'large') {
    await db.addCoinsWithExpiry(user.id, amount, settings.get().largePackageExpiryDays);
  } else {
    await db.addCoins(user.id, amount);
  }

  flash(req, 'success', `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} JC ${amount > 0 ? 'to' : 'from'} ${email}.`);
  res.redirect(`/admin?email=${encodeURIComponent(email)}`);
}));

// Promote a normal user to admin, or demote an admin back to a normal
// user. A safety rail stops the last admin account from demoting itself
// with nobody left to reverse it.
router.post('/admin/set-role', safe('/admin', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const makeAdmin = req.body.role === 'admin';

  const user = await db.getUserByEmail(email);
  if (!user) {
    flash(req, 'error', 'No user with that email.');
    return res.redirect('/admin');
  }

  if (!makeAdmin && user.id === req.user.id) {
    flash(req, 'error', "You can't demote your own account.");
    return res.redirect(`/admin?email=${encodeURIComponent(email)}`);
  }

  await db.setAdmin(user.id, makeAdmin);
  flash(req, 'success', `${email} is now ${makeAdmin ? 'an admin' : 'a normal user'}.`);
  res.redirect(req.body.from === 'users' ? '/admin/users' : `/admin?email=${encodeURIComponent(email)}`);
}));

router.post('/admin/set-ban', safe('/admin', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const banned = req.body.banned === 'true';

  const user = await db.getUserByEmail(email);
  if (!user) {
    flash(req, 'error', 'No user with that email.');
    return res.redirect('/admin');
  }

  if (banned && user.id === req.user.id) {
    flash(req, 'error', "You can't ban your own account.");
    return res.redirect(`/admin?email=${encodeURIComponent(email)}`);
  }
  if (banned && user.is_admin) {
    flash(req, 'error', 'Demote this admin before banning them.');
    return res.redirect(req.body.from === 'users' ? '/admin/users' : `/admin?email=${encodeURIComponent(email)}`);
  }

  await db.setBanned(user.id, banned);
  flash(req, banned ? 'error' : 'success', `${email} has been ${banned ? 'banned' : 'unbanned'}.`);
  res.redirect(req.body.from === 'users' ? '/admin/users' : `/admin?email=${encodeURIComponent(email)}`);
}));

// Toggle premium plan — reuses the existing (previously unused) `plan`
// column rather than adding a new one.
router.post('/admin/set-plan', safe('/admin', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const plan = req.body.plan === 'premium' ? 'premium' : 'none';

  const user = await db.getUserByEmail(email);
  if (!user) {
    flash(req, 'error', 'No user with that email.');
    return res.redirect('/admin');
  }

  await db.setPlan(user.id, plan);
  flash(req, 'success', `${email} is now on the ${plan === 'premium' ? 'Premium' : 'standard'} plan.`);
  res.redirect(req.body.from === 'users' ? '/admin/users' : `/admin?email=${encodeURIComponent(email)}`);
}));

router.get('/admin/users', safe('/dashboard', async (req, res) => {
  const search = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * USERS_PER_PAGE;

  const [users, total] = await Promise.all([
    db.listUsers({ search, limit: USERS_PER_PAGE, offset }),
    db.countAllUsers(search),
  ]);

  res.render('admin-users', {
    title: 'All Users',
    users,
    search,
    page,
    totalPages: Math.max(1, Math.ceil(total / USERS_PER_PAGE)),
    total,
  });
}));

// ── Deployments (every bot deployed platform-wide) ───────

router.get('/admin/deployments', safe('/dashboard', async (req, res) => {
  const search = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * DEPLOYMENTS_PER_PAGE;

  const [deployments, total, statusCounts] = await Promise.all([
    db.listAllDeployments({ search, status, limit: DEPLOYMENTS_PER_PAGE, offset }),
    db.countAllDeployments({ search, status }),
    db.getDeploymentStatusCounts(),
  ]);

  res.render('admin-deployments', {
    title: 'Deployments',
    deployments,
    search,
    status,
    page,
    totalPages: Math.max(1, Math.ceil(total / DEPLOYMENTS_PER_PAGE)),
    total,
    statusCounts,
  });
}));

router.post('/admin/deployments/:id/stop', safe('/admin/deployments', async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment) {
    flash(req, 'error', 'That deployment no longer exists.');
    return res.redirect('/admin/deployments');
  }
  try {
    const apiKey = await db.resolveHerokuApiKey(deployment);
    await heroku.scaleWebDyno(apiKey, deployment.app_name, 0);
    await db.updateDeploymentStatus(deployment.id, { status: 'stopped', herokuAppUrl: deployment.heroku_app_url });
    flash(req, 'success', `${deployment.app_name} stopped.`);
  } catch (err) {
    flash(req, 'error', `Could not stop on Heroku: ${err.message}`);
  }
  res.redirect('/admin/deployments');
}));

router.post('/admin/deployments/:id/resume', safe('/admin/deployments', async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment) {
    flash(req, 'error', 'That deployment no longer exists.');
    return res.redirect('/admin/deployments');
  }
  try {
    const apiKey = await db.resolveHerokuApiKey(deployment);
    await heroku.scaleWebDyno(apiKey, deployment.app_name, 1);
    await db.updateDeploymentStatus(deployment.id, { status: 'succeeded', herokuAppUrl: deployment.heroku_app_url });
    await db.touchDeploymentCharged(deployment.id);
    flash(req, 'success', `${deployment.app_name} is starting back up.`);
  } catch (err) {
    flash(req, 'error', `Could not resume on Heroku: ${err.message}`);
  }
  res.redirect('/admin/deployments');
}));

router.post('/admin/deployments/:id/delete', safe('/admin/deployments', async (req, res) => {
  const deployment = await db.getDeploymentById(req.params.id);
  if (!deployment) {
    flash(req, 'error', 'That deployment no longer exists.');
    return res.redirect('/admin/deployments');
  }
  try {
    const apiKey = await db.resolveHerokuApiKey(deployment);
    if (apiKey) await heroku.deleteApp(apiKey, deployment.app_name);
  } catch (err) {
    if (err.status !== 404) {
      flash(req, 'error', `Could not delete on Heroku: ${err.message}`);
      return res.redirect('/admin/deployments');
    }
  }
  await db.deleteDeployment(deployment.id);
  flash(req, 'success', `${deployment.app_name} deleted.`);
  res.redirect('/admin/deployments');
}));

// ── Heroku account pool ──────────────────────────────────

router.get('/admin/heroku', safe('/dashboard', async (req, res) => {
  const pool = await db.getHerokuPoolStats();
  res.render('admin-heroku', { title: 'Heroku Accounts', ...pool });
}));

router.post('/admin/heroku', safe('/admin/heroku', async (req, res) => {
  const label = String(req.body.label || '').trim();
  const apiKey = String(req.body.api_key || '').trim();
  const maxApps = Math.max(1, parseInt(req.body.max_apps, 10) || 10);

  if (!label || !apiKey) {
    flash(req, 'error', 'Give the account a label and its API key.');
    return res.redirect('/admin/heroku');
  }

  await db.createHerokuAccount({ label, apiKey, maxApps });
  flash(req, 'success', `Added "${label}" to the Heroku pool.`);
  res.redirect('/admin/heroku');
}));

router.post('/admin/heroku/:id/update', safe('/admin/heroku', async (req, res) => {
  const existing = await db.getHerokuAccountById(req.params.id);
  if (!existing) {
    flash(req, 'error', 'That account no longer exists.');
    return res.redirect('/admin/heroku');
  }
  const label = String(req.body.label || existing.label).trim();
  const apiKey = String(req.body.api_key || '').trim(); // blank = keep existing
  const maxApps = Math.max(1, parseInt(req.body.max_apps, 10) || existing.max_apps);
  const isActive = req.body.is_active === 'on';

  await db.updateHerokuAccount(existing.id, { label, apiKey, maxApps, isActive });
  flash(req, 'success', `Updated "${label}".`);
  res.redirect('/admin/heroku');
}));

router.post('/admin/heroku/:id/delete', safe('/admin/heroku', async (req, res) => {
  const existing = await db.getHerokuAccountById(req.params.id);
  if (existing) {
    await db.deleteHerokuAccount(existing.id);
    flash(req, 'success', `Removed "${existing.label}" from the pool.`);
  }
  res.redirect('/admin/heroku');
}));

router.post('/admin/heroku/:id/validate', safe('/admin/heroku', async (req, res) => {
  const existing = await db.getHerokuAccountById(req.params.id);
  if (!existing) {
    flash(req, 'error', 'That account no longer exists.');
    return res.redirect('/admin/heroku');
  }
  const result = await heroku.verifyApiKey(existing.api_key);
  if (result.valid) {
    flash(req, 'success', `"${existing.label}" is valid — authenticated as ${result.email}.`);
  } else {
    flash(req, 'error', `"${existing.label}" failed validation: ${result.error}`);
  }
  res.redirect('/admin/heroku');
}));

// ── Bot requests (community devs asking to add their bot) ────

router.get('/admin/bot-requests', safe('/dashboard', async (req, res) => {
  const status = String(req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * BOT_REQUESTS_PER_PAGE;

  const [requests, total, pendingCount] = await Promise.all([
    db.listBotRequests({ status, limit: BOT_REQUESTS_PER_PAGE, offset }),
    db.countBotRequests({ status }),
    db.countBotRequests({ status: 'pending' }),
  ]);

  res.render('admin-bot-requests', {
    title: 'Bot Requests',
    requests,
    status,
    page,
    totalPages: Math.max(1, Math.ceil(total / BOT_REQUESTS_PER_PAGE)),
    total,
    pendingCount,
  });
}));

router.post('/admin/bot-requests/:id/approve', safe('/admin/bot-requests', async (req, res) => {
  const request = await db.getBotRequestById(req.params.id);
  if (!request || request.status !== 'pending') {
    flash(req, 'error', 'That request is no longer pending.');
    return res.redirect('/admin/bot-requests');
  }

  const costCoins = Math.min(500, Math.max(1, parseInt(req.body.costCoins, 10) || request.cost_coins));
  const slug = await botsService.generateUniqueSlug(request.name);
  const catalogSize = (await botsService.listBots()).length;

  await db.createBot({
    slug,
    name: request.name,
    tagline: request.tagline,
    owner: request.owner,
    repo: request.repo,
    branch: request.branch,
    initial: request.name.trim().charAt(0).toUpperCase() || 'B',
    accent: ACCENTS[catalogSize % ACCENTS.length],
    cssClass: CSS_CLASSES[catalogSize % CSS_CLASSES.length],
    costCoins,
    sessionHelperUrl: request.session_helper_url,
    devUserId: request.user_id,
    requestId: request.id,
  });

  await db.updateBotRequestStatus(request.id, { status: 'approved', slug });
  flash(req, 'success', `"${request.name}" approved and added to the deploy catalog.`);
  res.redirect('/admin/bot-requests');
}));

router.post('/admin/bot-requests/:id/reject', safe('/admin/bot-requests', async (req, res) => {
  const request = await db.getBotRequestById(req.params.id);
  if (!request || request.status !== 'pending') {
    flash(req, 'error', 'That request is no longer pending.');
    return res.redirect('/admin/bot-requests');
  }
  const note = String(req.body.reviewNote || '').trim() || 'No reason given.';
  await db.updateBotRequestStatus(request.id, { status: 'rejected', reviewNote: note });
  flash(req, 'success', `"${request.name}" rejected.`);
  res.redirect('/admin/bot-requests');
}));

// ── Coin-economy settings ────────────────────────────────

router.get('/admin/settings', safe('/dashboard', (req, res) => {
  res.render('admin-settings', { title: 'Settings', values: settings.get() });
}));

router.post('/admin/settings', safe('/admin/settings', async (req, res) => {
  await settings.update(db, req.body);
  flash(req, 'success', 'Settings saved — changes are live immediately, no restart needed.');
  res.redirect('/admin/settings');
}));

// ── Support tickets ───────────────────────────────────────

router.get('/admin/support', safe('/dashboard', async (req, res) => {
  const status = String(req.query.status || '').trim();
  const search = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * TICKETS_PER_PAGE;

  const [tickets, total] = await Promise.all([
    db.listAllTickets({ status, search, limit: TICKETS_PER_PAGE, offset }),
    db.countAllTickets({ status, search }),
  ]);

  res.render('admin-support', {
    title: 'Support Tickets',
    tickets,
    total,
    status,
    search,
    page,
    totalPages: Math.max(1, Math.ceil(total / TICKETS_PER_PAGE)),
  });
}));

router.get('/admin/support/:id', safe('/admin/support', async (req, res) => {
  const ticket = await db.getTicketById(req.params.id);
  if (!ticket) {
    flash(req, 'error', 'Ticket not found.');
    return res.redirect('/admin/support');
  }
  const messages = await db.getMessagesForTicket(ticket.id);
  res.render('support-ticket', { title: `Ticket #${ticket.id}`, ticket, messages, isAdminView: true });
}));

router.post('/admin/support/:id/reply', safe((req) => `/admin/support/${req.params.id}`, async (req, res) => {
  const ticket = await db.getTicketById(req.params.id);
  if (!ticket) {
    flash(req, 'error', 'Ticket not found.');
    return res.redirect('/admin/support');
  }
  const body = String(req.body.body || '').trim().slice(0, 5000);
  if (!body) {
    flash(req, 'error', 'Message cannot be empty.');
    return res.redirect(`/admin/support/${ticket.id}`);
  }
  await db.addTicketMessage({ ticketId: ticket.id, isAdmin: true, authorEmail: req.user.email, body });

  mailer.sendNotification(
    ticket.user_email,
    `Re: ${ticket.subject} (Ticket #${ticket.id})`,
    `${body}\n\n— ${config.branding.siteName} Support`
  ).catch((err) => console.error('[admin] notify user failed:', err));

  flash(req, 'success', 'Reply sent.');
  res.redirect(`/admin/support/${ticket.id}`);
}));

router.post('/admin/support/:id/status', safe((req) => `/admin/support/${req.params.id}`, async (req, res) => {
  const ticket = await db.getTicketById(req.params.id);
  if (!ticket) {
    flash(req, 'error', 'Ticket not found.');
    return res.redirect('/admin/support');
  }
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  await db.setTicketStatus(ticket.id, status);
  flash(req, 'success', `Ticket marked ${status}.`);
  res.redirect(`/admin/support/${ticket.id}`);
}));

module.exports = router;
