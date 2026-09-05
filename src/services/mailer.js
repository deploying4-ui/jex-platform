const nodemailer = require('nodemailer');
const config = require('../config');

const isConfigured = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
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

  if (!transporter) {
    // Dev fallback — no SMTP configured yet. Print the code so the
    // register -> verify flow can still be tested end to end.
    console.log(`\n[mailer] SMTP not configured — verification code for ${email}: ${code}\n`);
    return { devMode: true };
  }

  await transporter.sendMail({
    from: config.smtp.from || `"${siteName}" <no-reply@example.com>`,
    to: email,
    subject,
    text,
    html,
  });
  return { devMode: false };
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

  if (!transporter) {
    console.log(`\n[mailer] SMTP not configured — password reset code for ${email}: ${code}\n`);
    return { devMode: true };
  }

  await transporter.sendMail({
    from: config.smtp.from || `"${siteName}" <no-reply@example.com>`,
    to: email,
    subject,
    text,
    html,
  });
  return { devMode: false };
}

module.exports = { sendVerificationCode, sendPasswordResetCode, isConfigured };
