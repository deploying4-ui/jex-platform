# jex-platform

A client portal for deploying **Vesper-Xmd**, **Jexploit Bot**, **Nexus-1MD**,
and **Malvin-XD** — users register, verify by email (or continue with
Google), land on a dashboard, pick a bot, fill in its config, and the
platform deploys it. Nothing in the product says "Heroku" anywhere —
that's the real infrastructure underneath (see "About the Heroku
naming" below), but it's branded jex-platform throughout.

## The JC economy

- **New signup**: `STARTER_COINS` (10 JC), valid for `STARTER_COINS_EXPIRY_DAYS`
  (30 days) — unused JC from this grant expires if it sits that long.
- **Deploying** any bot: flat `DEPLOY_COST_COINS` (10 JC), charged up
  front, refunded automatically if the build fails.
- **Staying deployed**: `RENEWAL_COST_COINS` (1 JC) every
  `RENEWAL_PERIOD_HOURS` (24h). A background sweep (`src/services/billing.js`)
  checks this every 30 minutes; if a renewal can't be collected, that
  app is scaled to zero dynos (stopped, not deleted) and marked
  `stopped` until the user tops up and hits "Resume" in My Bots.
- **Referrals**: `REFERRAL_BONUS_COINS` (5 JC) to the referrer once the
  invitee verifies their email.
- **Buying more**: 100 / 200 / 500 JC packages last `SMALL_PACKAGE_EXPIRY_DAYS`
  (30 days); 700 / 900 JC packages last `LARGE_PACKAGE_EXPIRY_DAYS` (60
  days). All of this is manual — there's no payment gateway, a user
  pays to `PAYMENT_NUMBER`, emails proof, and an admin credits their
  account from `/admin` (which lets you pick which expiry window
  applies to that credit).

**One simplification worth knowing about:** coin expiry is tracked as a
single `coins_expire_at` timestamp per user, not per individual
purchase. Buying a second package always extends that one date to
whichever is later — it doesn't track "these 500 JC expire on date A,
those 700 JC expire on date B" as separate entries. For how this
platform is used (buy occasionally, spend down before buying again)
that difference rarely matters; if you specifically need every
purchase to expire independently, that's a real but bigger rework (a
proper coin-ledger table) — say so and I'll build it.

## What's new in this pass

- **Four bots** — Malvin-XD added (`data/bots.json`), each with its own
  pairing-site link (`sessionHelperUrl` per bot; Vesper-Xmd and
  Jexploit Bot share the one in `config.js`)
- **My Bots** (`/my-bots`) — every deployment, each with a ⋮ menu:
  edit session ID, restart (kill + restart dynos, no rebuild), redeploy
  (rebuild from the bot's latest code, config untouched), stop/resume,
  delete (calls Heroku's delete, confirms first, cannot be undone)
- **My Coins** (`/my-coins`) — balance, expiry date, and a plain-language
  breakdown of deploy/renewal/referral costs
- **My Profile** (`/my-profile`) — username/email (read-only), JC
  balance, referral code, member-since, change password
- **Corner menu** — the sidebar is gone; every page now has a slim top
  bar with a ⋮ button top-right holding every destination (Dashboard,
  Deploy Bot, My Bots, My Coins, Buy Coins, My Profile, Support,
  Tutorial, Admin if applicable, Sign out)
- **New palette** — coral/teal on near-black, gradient CTAs, per-bot
  accent colors
- **Support & tutorial links** — `WHATSAPP_SUPPORT_URL` and `TUTORIAL_URL`
  in `config.js`, surfaced in the corner menu
- **Footer** — "Made with ♥ by Kevin Tech" (`TEAM_NAME` in `config.js`)
- Restored from an earlier round that hadn't made it into this zip:
  **Continue with Google** (`src/services/googleAuth.js`) and the
  Express-4 `safe()` error-handling wrapper on every route file (an
  unexpected failure now shows a real message instead of hanging)

## About the Heroku naming

`HEROKU_API_KEY` stays literal in `config.js` because that's genuinely
what it is — a real Heroku account API key, and renaming the variable
wouldn't change anything a user sees. Everywhere a *user* would
encounter the word (buttons, page copy, flash messages, the deploy
form) now says "jex-platform" instead. `data/manifest-cache/` is empty
for now — it's a fallback cache for `jexhost.json` (one file per bot
slug) if a live GitHub fetch ever fails; the old `app.json` caches were
removed when every bot's manifest moved to `jexhost.json`.

## Setup

```bash
cd jex-platform
npm install
node server.js
```

Everything (Heroku key, Neon database, admin login, SMTP) is already in
`src/config.js` from earlier rounds. New values worth knowing about:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — blank, so the Google
  button stays hidden until you add them (Google Cloud Console → OAuth
  client ID → Web application → redirect URI `BASE_URL + /auth/google/callback`)
- `WHATSAPP_SUPPORT_URL`, `TUTORIAL_URL` — already filled in with what
  you sent
- Coin/pricing numbers are all named constants in `config.js` under
  the "Coin economy" section — change the numbers there, nothing else
  needs touching

## The renewal-billing job — please test this one specifically

`src/services/billing.js` is the highest-stakes piece of this update —
it's the one background process that moves JC and can stop a live bot
without anyone clicking anything. It's defensive (each deployment is
handled in its own try/catch, so one bad row can't abort the sweep or
crash the server), but it's also the one part of this codebase I
genuinely cannot test end-to-end myself. Watch your server logs for
lines starting `[billing]` for the first few days, and if a bot gets
stopped unexpectedly, that's the first place to look.

## Project layout

```
server.js                  entry point — session store, view engine, starts billing.js
src/config.js               all settings + real values in one place
src/db.js                   Postgres (Neon) — schema, migrations, all queries
src/services/heroku.js      Heroku Platform API (app-setups, config-vars, builds, dynos)
src/services/billing.js     renewal-charge sweep + coin-expiry sweep (runs every 30 min)
src/services/googleAuth.js  Google OAuth (Continue with Google)
src/services/bots.js        bot registry + live jexhost.json fetch/parse + per-bot pairing URL
src/services/mailer.js      nodemailer, with a console-log dev fallback
src/services/otp.js         6-digit code generation/expiry/cooldown
src/services/seedAdmin.js   creates/promotes the admin account on boot
src/middleware/auth.js      requireAuth, requireAdmin
src/routes/auth.js          register, verify, login, logout, Google OAuth
src/routes/dashboard.js     dashboard, buy-coins page
src/routes/deploy.js        bot picker, deploy form + trigger, status polling, session-ID update
src/routes/myBots.js        My Bots list + restart/redeploy/stop/resume/delete
src/routes/account.js       My Coins, My Profile, change password
src/routes/admin.js         user lookup, add/remove JC with expiry control
src/views/                  EJS templates
src/public/                 CSS + client-side JS
data/bots.json              all 4 bots (name, repo, branch, icon, cost, pairing URL)
data/manifest-cache/        cached jexhost.json per bot, used if the live GitHub fetch fails
```

## Not built yet

- Real payment automation — topping up is still pay → email proof → admin credits it
- Per-purchase coin expiry (see the JC economy note above)
- A community/chat tab, notifications
- Streaming the real Heroku build log (status page shows setup-level
  state, not raw build output)
