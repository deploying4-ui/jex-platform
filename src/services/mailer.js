const nodemailer = require('nodemailer');
const config = require('../config');

const brevoConfigured = Boolean(config.brevo.apiKey && config.brevo.senderEmail);
const smtpConfigured = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
const isConfigured = brevoConfigured || smtpConfigured;

let smtpTransporter = null;
if (smtpConfigured) {
  smtpTransporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });
}

const siteName = config.branding.siteName;

/**
 * Low-level send. Tries Brevo's HTTP API first (works on hosts like
 * Render's free tier that block outbound SMTP ports 25/465/587), then
 * falls back to SMTP (nodemailer) if Brevo isn't configured, then to
 * console-logging in dev if neither is set up.
 */
async function sendRawEmail({ to, subject, text, html }) {
  if (brevoConfigured) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': config.brevo.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: config.brevo.senderName || siteName, email: config.brevo.senderEmail },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Brevo API send failed (${res.status}): ${body}`);
    }
    return { devMode: false, via: 'brevo' };
  }

  if (smtpTransporter) {
    await smtpTransporter.sendMail({
      from: config.smtp.from || `"${siteName}" <no-reply@example.com>`,
      to,
      subject,
      text,
      html,
    });
    return { devMode: false, via: 'smtp' };
  }

  // Dev fallback — nothing configured. Print instead of failing so
  // flows like register -> verify can still be tested end to end.
  console.log(`\n[mailer] No Brevo/SMTP configured — email to ${to}: ${subject}\n${text}\n`);
  return { devMode: true };
}

async function sendVerificationCode(email, code) {
  const subject = `${siteName} verification code: ${code}`;
  const text = `Your ${siteName} verification code is ${code}. It expires in 10 minutes.`;
  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:auto">
      <h2 style="margin-bottom:0">${siteName}</h2>
      <p>Your verification code is:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:4px">${code}</p>
      <p style="color:#666">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    </div>
  `;
  return sendRawEmail({ to: email, subject, text, html });
}

async function sendPasswordResetCode(email, code) {
  const subject = `${siteName} password reset code: ${code}`;
  const text = `Your ${siteName} password reset code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`;
  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:auto">
      <h2 style="margin-bottom:0">${siteName}</h2>
      <p>Your password reset code is:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:4px">${code}</p>
      <p style="color:#666">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    </div>
  `;
  return sendRawEmail({ to: email, subject, text, html });
}

async function sendNotification(email, subject, text, html) {
  return sendRawEmail({
    to: email,
    subject,
    text,
    html: html || `<div style="font-family:sans-serif;max-width:480px;margin:auto"><p>${text.replace(/\n/g, '<br>')}</p></div>`,
  });
}

module.exports = { sendVerificationCode, sendPasswordResetCode, sendNotification, isConfigured };
