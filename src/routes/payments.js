const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const marzpay = require('../services/marzpay');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Payment attempts cost real requests to MarzPay and touch real money —
// limit per IP so this can't be hammered.
const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function normalizeUgPhone(raw) {
  let p = String(raw || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('0')) p = '+256' + p.slice(1);
  if (p.startsWith('256') && !p.startsWith('+')) p = '+' + p;
  if (!p.startsWith('+256')) return null;
  // Uganda mobile: +2567XXXXXXXX (12 digits after +)
  if (!/^\+2567\d{8}$/.test(p)) return null;
  return p;
}

// ── Initiate top-up ─────────────────────────────────────

router.post('/topup/pay', requireAuth, payLimiter, async (req, res) => {
  if (!marzpay.isConfigured()) {
    flash(req, 'error', 'Automatic payments are not configured yet. Contact support.');
    return res.redirect('/topup');
  }

  const packageId = String(req.body.packageId || '');
  const phoneRaw = String(req.body.phone || '');
  const pkg = config.coinPackages.find((p) => String(p.coins) === packageId);

  if (!pkg) {
    flash(req, 'error', 'Please select a valid coin package.');
    return res.redirect('/topup');
  }

  const phone = normalizeUgPhone(phoneRaw);
  if (!phone) {
    flash(req, 'error', 'Enter a valid Uganda mobile number (e.g. 07XX XXX XXX or +2567…).');
    return res.redirect('/topup');
  }

  // Guard against double-submits firing two mobile money prompts —
  // if there's already a pending request from the last 90s, send them
  // back to that one instead of starting a new charge.
  const recent = await db.listPaymentsForUser(req.user.id, 1);
  const last = recent[0];
  if (last && last.status === 'pending' && Date.now() - Number(last.created_at) < 90 * 1000) {
    flash(req, 'error', 'A payment request is already in progress — check your phone or wait a moment before retrying.');
    return res.redirect(`/topup/status/${last.id}`);
  }

  const reference = marzpay.generateReference();
  const callbackUrl = `${config.server.baseUrl}/webhooks/marzpay`;

  let payment;
  try {
    payment = await db.createPayment({
      userId: req.user.id,
      reference,
      coins: pkg.coins,
      amountUgx: pkg.amountUgx,
      phoneNumber: phone,
    });
  } catch (err) {
    console.error('[payments] createPayment failed:', err);
    flash(req, 'error', 'Could not start payment. Please try again.');
    return res.redirect('/topup');
  }

  try {
    const result = await marzpay.collectMoney({
      amount: pkg.amountUgx,
      phoneNumber: phone,
      reference,
      description: `${pkg.coins} JC top-up — ${config.branding.siteName}`,
      callbackUrl,
      metadata: [
        { orderId: reference },
        { userId: String(req.user.id) },
        { coins: String(pkg.coins) },
        { email: req.user.email, isPII: true },
      ],
    });

    const marzUuid = result?.data?.transaction?.uuid || null;
    if (marzUuid) {
      await db.updatePaymentStatus(payment.id, {
        status: 'pending',
        marzUuid,
        provider: result?.data?.collection?.provider || null,
      });
    }

    flash(req, 'success', `Payment request sent to ${phone}. Approve the prompt on your phone. Coins will appear automatically once paid.`);
    return res.redirect(`/topup/status/${payment.id}`);
  } catch (err) {
    console.error('[payments] MarzPay collect failed:', err.message, err.response || '');
    await db.updatePaymentStatus(payment.id, {
      status: 'failed',
      failureMessage: err.message,
    });
    flash(req, 'error', err.message || 'Payment provider rejected the request. Try again or use a different number.');
    return res.redirect('/topup');
  }
});

// ── Payment status page ─────────────────────────────────

router.get('/topup/status/:id', requireAuth, async (req, res) => {
  const payment = await db.getPaymentById(req.params.id);
  if (!payment || payment.user_id !== req.user.id) {
    return res.status(404).render('404', { title: 'Not found' });
  }
  // Refresh user coins in case webhook already credited
  const user = await db.getUserById(req.user.id);
  res.render('topup-status', {
    title: 'Payment status',
    payment,
    user,
  });
});

// JSON poll endpoint for the status page
router.get('/topup/status/:id/json', requireAuth, async (req, res) => {
  const payment = await db.getPaymentById(req.params.id);
  if (!payment || payment.user_id !== req.user.id) {
    return res.status(404).json({ error: 'not_found' });
  }
  const user = await db.getUserById(req.user.id);
  res.json({
    status: payment.status,
    coins: payment.coins,
    balance: user.coins,
    failure_message: payment.failure_message,
  });
});

// ── MarzPay webhook (no auth — verified by signature if configured) ──

router.post('/webhooks/marzpay', express.json({ type: '*/*' }), async (req, res) => {
  // Always acknowledge quickly so MarzPay does not retry unnecessarily
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const timestamp = req.headers['x-marzpay-timestamp'] || '';
  const signature = req.headers['x-marzpay-signature'] || '';

  if (config.marzpay.webhookSecret) {
    if (!marzpay.verifyWebhookSignature(rawBody, timestamp, signature)) {
      console.warn('[marzpay webhook] invalid signature');
      return res.status(401).send('Invalid signature');
    }
  } else {
    // No MARZPAY_WEBHOOK_SECRET set — signature is NOT verified, so
    // anyone who obtains a payment reference could fake a completed
    // event and credit themselves coins. Set MARZPAY_WEBHOOK_SECRET
    // (enable signing in the MarzPay dashboard) to close this gap.
    console.warn('[marzpay webhook] WARNING: processing unverified webhook — MARZPAY_WEBHOOK_SECRET is not set');
  }

  const payload = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const eventType = payload.event_type || '';
  const txn = payload.transaction || {};
  const collection = payload.collection || {};
  const reference = txn.reference;

  console.log(`[marzpay webhook] event=${eventType} reference=${reference} status=${txn.status}`);

  if (!reference) {
    return res.status(200).json({ received: true });
  }

  try {
    const payment = await db.getPaymentByReference(reference);
    if (!payment) {
      console.warn('[marzpay webhook] unknown reference', reference);
      return res.status(200).json({ received: true });
    }

    if (eventType === 'collection.completed' || txn.status === 'completed') {
      const result = await db.completePaymentAndCredit(reference);
      if (result.ok) {
        console.log(`[marzpay webhook] credited ${result.payment.coins} JC to user ${result.payment.user_id}`);
      } else {
        console.log(`[marzpay webhook] skip credit: ${result.reason}`);
      }
      await db.updatePaymentStatus(payment.id, {
        status: 'completed',
        provider: collection.provider || txn.provider,
        providerTxnId: collection.provider_transaction_id || null,
        marzUuid: txn.uuid,
      });
    } else if (eventType === 'collection.failed' || txn.status === 'failed' || txn.status === 'cancelled') {
      await db.updatePaymentStatus(payment.id, {
        status: 'failed',
        provider: collection.provider || txn.provider,
        providerTxnId: collection.provider_transaction_id || null,
        marzUuid: txn.uuid,
        failureMessage: `Payment ${txn.status || 'failed'}`,
      });
    }
  } catch (err) {
    console.error('[marzpay webhook] processing error:', err);
    // Still return 200 so MarzPay does not keep retrying a permanent error
  }

  res.status(200).json({ received: true });
});

module.exports = router;
