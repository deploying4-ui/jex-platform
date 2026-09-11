const crypto = require('crypto');
const config = require('../config');

const BASE_URL = 'https://wallet.wearemarz.com/api/v1';

function getAuthHeader() {
  const key = config.marzpay.apiKey;
  const secret = config.marzpay.apiSecret;
  if (!key || !secret) {
    throw new Error('MarzPay API key/secret not configured. Set MARZPAY_API_KEY and MARZPAY_API_SECRET.');
  }
  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Initiate a mobile-money collection.
 * @param {object} opts
 * @param {number} opts.amount - Amount in UGX (integer)
 * @param {string} opts.phoneNumber - e.g. +2567XXXXXXXX
 * @param {string} opts.reference - UUID v4
 * @param {string} opts.description
 * @param {string} opts.callbackUrl
 * @param {Array}  opts.metadata - optional array of objects
 */
async function collectMoney({ amount, phoneNumber, reference, description, callbackUrl, metadata }) {
  const body = {
    amount: Number(amount),
    phone_number: phoneNumber,
    country: config.marzpay.country || 'UG',
    reference,
    description: description || 'JC coin top-up',
    callback_url: callbackUrl,
  };
  if (metadata && metadata.length) {
    body.metadata = metadata;
  }

  const res = await fetch(`${BASE_URL}/collect-money`, {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') {
    const msg = data.message || data.error || `MarzPay error ${res.status}`;
    const err = new Error(msg);
    err.response = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Optional: verify webhook signature when signing is enabled in MarzPay dashboard.
 */
function verifyWebhookSignature(rawBody, timestamp, signatureHeader) {
  const secret = config.marzpay.webhookSecret;
  if (!secret) return true; // signing not configured — accept

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const match = String(signatureHeader || '').match(/v1=([a-f0-9]+)/);
  const received = match ? match[1] : '';
  if (!received || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function generateReference() {
  return crypto.randomUUID();
}

module.exports = {
  collectMoney,
  verifyWebhookSignature,
  generateReference,
  isConfigured: () => Boolean(config.marzpay.apiKey && config.marzpay.apiSecret),
};
