const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');

// Creates the admin account from ADMIN_EMAIL / ADMIN_PASSWORD on first
// boot. If that account already exists, this only makes sure the
// is_admin flag is set — it never touches the stored password, so
// restarting the server doesn't clobber a password you've since
// changed some other way.
async function seedAdmin() {
  const email = config.admin.email;
  const password = config.admin.password;
  if (!email || !password) {
    console.log('[admin] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin seed.');
    return;
  }

  const existing = await db.getUserByEmail(email);
  if (existing) {
    if (!existing.is_admin) await db.setAdmin(existing.id, true);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await db.createUser({ email, passwordHash, startingCoins: 0 });
  await db.markVerified(admin.id);
  await db.setAdmin(admin.id, true);
  console.log(`[admin] Created admin account for ${email}`);
}

module.exports = { seedAdmin };
