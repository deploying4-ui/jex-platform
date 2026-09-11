const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const mailer = require('../services/mailer');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function safe(fallbackPath, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[support] ${req.method} ${req.path} failed:`, err);
      flash(req, 'error', 'Something went wrong on our end — please try again.');
      res.redirect(typeof fallbackPath === 'function' ? fallbackPath(req) : fallbackPath);
    }
  };
}

const ticketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use('/support', requireAuth);

router.get('/support', safe('/dashboard', async (req, res) => {
  const tickets = await db.listTicketsForUser(req.user.id);
  res.render('support', {
    title: 'Support',
    tickets,
    whatsappSupportUrl: config.payments.whatsappSupportUrl,
    supportEmail: config.payments.supportEmail,
  });
}));

router.post('/support', ticketLimiter, safe('/support', async (req, res) => {
  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 5000);

  if (!subject || !body) {
    flash(req, 'error', 'Please fill in both a subject and a message.');
    return res.redirect('/support');
  }

  const ticket = await db.createTicket({
    userId: req.user.id,
    authorEmail: req.user.email,
    subject,
    body,
  });

  if (config.payments.supportEmail) {
    mailer.sendNotification(
      config.payments.supportEmail,
      `New support ticket #${ticket.id}: ${subject}`,
      `From: ${req.user.email}\n\n${body}\n\nReply in the admin dashboard: /admin/support/${ticket.id}`
    ).catch((err) => console.error('[support] notify email failed:', err));
  }

  flash(req, 'success', 'Ticket submitted — we\'ll get back to you soon.');
  res.redirect(`/support/${ticket.id}`);
}));

router.get('/support/:id', safe('/support', async (req, res) => {
  const ticket = await db.getTicketById(req.params.id);
  if (!ticket || ticket.user_id !== req.user.id) {
    flash(req, 'error', 'Ticket not found.');
    return res.redirect('/support');
  }
  const messages = await db.getMessagesForTicket(ticket.id);
  res.render('support-ticket', { title: `Ticket #${ticket.id}`, ticket, messages, isAdminView: false });
}));

router.post('/support/:id/reply', ticketLimiter, safe((req) => `/support/${req.params.id}`, async (req, res) => {
  const ticket = await db.getTicketById(req.params.id);
  if (!ticket || ticket.user_id !== req.user.id) {
    flash(req, 'error', 'Ticket not found.');
    return res.redirect('/support');
  }
  const body = String(req.body.body || '').trim().slice(0, 5000);
  if (!body) {
    flash(req, 'error', 'Message cannot be empty.');
    return res.redirect(`/support/${ticket.id}`);
  }
  await db.addTicketMessage({ ticketId: ticket.id, isAdmin: false, authorEmail: req.user.email, body });

  if (config.payments.supportEmail) {
    mailer.sendNotification(
      config.payments.supportEmail,
      `Reply on ticket #${ticket.id}: ${ticket.subject}`,
      `From: ${req.user.email}\n\n${body}\n\nReply in the admin dashboard: /admin/support/${ticket.id}`
    ).catch((err) => console.error('[support] notify email failed:', err));
  }

  flash(req, 'success', 'Reply sent.');
  res.redirect(`/support/${ticket.id}`);
}));

module.exports = router;
