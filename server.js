const express    = require('express');
const axios      = require('axios');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
require('dotenv').config();

const app = express();
const db  = new Database('licenses.db');

// ─── Database Setup ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    key                TEXT UNIQUE NOT NULL,
    plan               TEXT NOT NULL,
    email              TEXT NOT NULL,
    flw_tx_ref         TEXT UNIQUE NOT NULL,
    flw_transaction_id TEXT,
    activated          INTEGER DEFAULT 0,
    machine_id         TEXT,
    created_at         TEXT DEFAULT (datetime('now')),
    activated_at       TEXT
  )
`);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  process.env.WEBSITE_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Plan Config ──────────────────────────────────────────────────────────────
const PLANS = {
  standard:   { name: 'Standard',   amount: 4.99,  currency: 'USD' },
  pro:        { name: 'Pro',        amount: 12.99, currency: 'USD' },
  enterprise: { name: 'Enterprise', amount: 49.99, currency: 'USD' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateLicenseKey() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `ONYX-${seg()}-${seg()}-${seg()}`;
}

function generateTxRef() {
  return `ONYX-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function sendLicenseEmail(email, licenseKey, planName) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from:    `"OnyxLock" <${process.env.SMTP_USER}>`,
    to:      email,
    subject: `Your OnyxLock ${planName} License Key`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;background:#0d0d1a;color:#e8e8f0;padding:2rem;border-radius:12px;">
        <h2 style="color:#d4a017;">OnyxLock ${planName}</h2>
        <p>Thank you for your purchase! Here is your license key:</p>
        <div style="background:#1a1a2e;border:1px solid #d4a017;border-radius:8px;padding:1rem;text-align:center;margin:1.5rem 0;">
          <code style="font-size:1.4rem;letter-spacing:2px;color:#d4a017;">${licenseKey}</code>
        </div>
        <p style="font-size:0.9rem;color:#aaa;">
          Open OnyxLock → enter this key in the "Already have a license key?" field → click <strong>Activate</strong>.
        </p>
        <p style="font-size:0.8rem;color:#666;">This key activates on one machine only. Keep it safe.</p>
      </div>
    `,
  });
}

// ─── X (Twitter) Linked-Account Setup ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS x_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    x_id          TEXT UNIQUE NOT NULL,
    x_handle      TEXT NOT NULL,
    x_name        TEXT,
    app_username  TEXT UNIQUE NOT NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    last_login_at TEXT
  )
`);

// In-memory PKCE/state store — fine for a single Render instance.
// Entries are short-lived (cleared after use or after 10 minutes).
const oauthStates = new Map();
function cleanupOauthStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    if (now - v.createdAt > 10 * 60 * 1000) oauthStates.delete(k);
  }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateAppUsername(xHandle) {
  const base = 'onyx_' + xHandle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
  const exists = (name) => db.prepare('SELECT 1 FROM x_users WHERE app_username = ?').get(name);
  let candidate = base;
  let attempt = 0;
  while (exists(candidate)) {
    attempt++;
    candidate = `${base}${crypto.randomInt(100, 999)}`;
    if (attempt > 20) { candidate = `${base}${Date.now()}`; break; }
  }
  return candidate;
}

// Small HTML page shown inside the OAuth popup once linking finishes.
// It writes the result into document.title; the desktop app's popup window
// watches for that title change and reads the result from it — no extra
// redirect back into the app is needed.
function renderResultPage(success, record, errorMsg) {
  const payload = success
    ? { success: true, x_id: record.x_id, x_handle: record.x_handle, app_username: record.app_username }
    : { success: false, error: errorMsg || 'Login failed' };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="background:#0E1014;color:#DCDCDC;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
    <div style="text-align:center;">
      <p style="font-size:1.1rem;">${success ? `Connected as <strong style="color:#F0B90B;">@${record.x_handle}</strong>` : (errorMsg || 'Login failed')}</p>
      <p style="color:#646E7D;font-size:0.85rem;">You can close this window.</p>
    </div>
    <script>document.title = "ONYX_AUTH_RESULT:${encoded}";</script>
  </body></html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// X login — the desktop app opens this URL in a popup window
app.get('/api/auth/x/login', (req, res) => {
  cleanupOauthStates();

  if (!process.env.X_CLIENT_ID || !process.env.X_CALLBACK_URL) {
    return res.status(500).send('X login is not configured on the server yet.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

  oauthStates.set(state, { codeVerifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.X_CLIENT_ID,
    redirect_uri: process.env.X_CALLBACK_URL,
    scope: 'users.read tweet.read',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`https://twitter.com/i/oauth2/authorize?${params.toString()}`);
});

// X redirects back here after the user approves
app.get('/api/auth/x/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.send(renderResultPage(false, null, 'Login was cancelled.'));

  const stored = oauthStates.get(state);
  if (!stored) return res.send(renderResultPage(false, null, 'This login link expired — please try again.'));
  oauthStates.delete(state);

  try {
    const basicAuth = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post(
      'https://api.twitter.com/2/oauth2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.X_CALLBACK_URL,
        code_verifier: stored.codeVerifier,
      }).toString(),
      { headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data.access_token;

    const meRes = await axios.get('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const xUser = meRes.data.data; // { id, name, username }

    let record = db.prepare('SELECT * FROM x_users WHERE x_id = ?').get(xUser.id);
    if (!record) {
      const appUsername = generateAppUsername(xUser.username);
      db.prepare(
        `INSERT INTO x_users (x_id, x_handle, x_name, app_username, last_login_at) VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(xUser.id, xUser.username, xUser.name, appUsername);
      record = db.prepare('SELECT * FROM x_users WHERE x_id = ?').get(xUser.id);
    } else {
      db.prepare(`UPDATE x_users SET last_login_at = datetime('now'), x_handle = ?, x_name = ? WHERE x_id = ?`)
        .run(xUser.username, xUser.name, xUser.id);
    }

    console.log(`X linked: @${xUser.username} -> ${record.app_username}`);
    res.send(renderResultPage(true, record));
  } catch (err) {
    console.error('X OAuth error:', err.response?.data || err.message);
    res.send(renderResultPage(false, null, 'Something went wrong linking your X account.'));
  }
});

// Admin: list every linked user (protect with ADMIN_KEY header)
app.get('/api/admin/x-users', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.sendStatus(401);
  const users = db.prepare(
    'SELECT id, x_id, x_handle, x_name, app_username, created_at, last_login_at FROM x_users ORDER BY created_at DESC'
  ).all();
  res.json({ count: users.length, users });
});



// 1. Create payment — website calls this when user clicks "Get Plan"
//    Frontend must collect email first (show a small modal before redirecting)
app.post('/create-checkout', async (req, res) => {
  const { plan, email, name } = req.body;

  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  if (!email)       return res.status(400).json({ error: 'Email is required' });

  const txRef = generateTxRef();

  try {
    db.prepare(`INSERT INTO licenses (key, plan, email, flw_tx_ref) VALUES (?, ?, ?, ?)`)
      .run('PENDING', plan, email, txRef);
  } catch {
    return res.status(500).json({ error: 'Could not create payment record' });
  }

  try {
    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref:       txRef,
        amount:       PLANS[plan].amount,
        currency:     PLANS[plan].currency,
        redirect_url: `${process.env.WEBSITE_URL}/payment-callback`,
        customer:     { email, name: name || 'OnyxLock Customer' },
        customizations: {
          title:       'OnyxLock',
          description: `${PLANS[plan].name} Plan`,
          logo:        `${process.env.WEBSITE_URL}/logo.png`,
        },
        meta: { plan },
      },
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );

    const link = response.data?.data?.link;
    if (!link) return res.status(500).json({ error: 'No payment link returned' });
    res.json({ url: link, tx_ref: txRef });
  } catch (err) {
    console.error('Flutterwave error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// 2. Payment callback — Flutterwave redirects user here after checkout
//    Add /payment-callback as a page on your website that calls /status/:txRef to show the key
app.get('/payment-callback', async (req, res) => {
  const { status, tx_ref, transaction_id } = req.query;

  if (status !== 'successful' && status !== 'completed') {
    return res.redirect(`${process.env.WEBSITE_URL}?payment=failed`);
  }

  try {
    const verify = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } }
    );

    const txData = verify.data?.data;
    if (!txData || txData.status !== 'successful') {
      return res.redirect(`${process.env.WEBSITE_URL}?payment=failed`);
    }

    const existing = db.prepare('SELECT * FROM licenses WHERE flw_tx_ref = ?').get(tx_ref);
    if (!existing) return res.redirect(`${process.env.WEBSITE_URL}?payment=failed`);

    // Already processed
    if (existing.key !== 'PENDING') {
      return res.redirect(`${process.env.WEBSITE_URL}?payment=success&tx_ref=${tx_ref}`);
    }

    const licenseKey = generateLicenseKey();
    db.prepare(`UPDATE licenses SET key = ?, flw_transaction_id = ? WHERE flw_tx_ref = ?`)
      .run(licenseKey, transaction_id, tx_ref);

    await sendLicenseEmail(existing.email, licenseKey, PLANS[existing.plan]?.name || existing.plan);
    console.log(`License issued: ${licenseKey} → ${existing.email}`);

    res.redirect(`${process.env.WEBSITE_URL}?payment=success&tx_ref=${tx_ref}`);
  } catch (err) {
    console.error('Callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.WEBSITE_URL}?payment=error`);
  }
});

// 3. Flutterwave webhook — backup in case user closes browser before redirect fires
app.post('/flw-webhook', async (req, res) => {
  const hash = req.headers['verif-hash'];
  if (hash !== process.env.FLW_WEBHOOK_HASH) return res.sendStatus(401);

  const { event, data } = req.body;
  if (event !== 'charge.completed' || data?.status !== 'successful') return res.sendStatus(200);

  const existing = db.prepare('SELECT * FROM licenses WHERE flw_tx_ref = ?').get(data.tx_ref);
  if (!existing || existing.key !== 'PENDING') return res.sendStatus(200);

  const licenseKey = generateLicenseKey();
  db.prepare(`UPDATE licenses SET key = ?, flw_transaction_id = ? WHERE flw_tx_ref = ?`)
    .run(licenseKey, String(data.id), data.tx_ref);

  try {
    await sendLicenseEmail(existing.email, licenseKey, PLANS[existing.plan]?.name || existing.plan);
    console.log(`Webhook license issued: ${licenseKey} → ${existing.email}`);
  } catch (e) {
    console.error('Webhook email failed:', e.message);
  }

  res.sendStatus(200);
});

// 4. Validate license — called by OnyxLock C# app
app.post('/validate', (req, res) => {
  const { key, machine_id } = req.body;
  if (!key || !machine_id)
    return res.status(400).json({ valid: false, reason: 'Missing key or machine_id' });

  const license = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!license || license.key === 'PENDING')
    return res.json({ valid: false, reason: 'License key not found' });

  if (license.activated && license.machine_id !== machine_id)
    return res.json({ valid: false, reason: 'Key already activated on another machine' });

  if (!license.activated) {
    db.prepare(`UPDATE licenses SET activated = 1, machine_id = ?, activated_at = datetime('now') WHERE key = ?`)
      .run(machine_id, key);
  }

  res.json({ valid: true, plan: license.plan, email: license.email });
});

// 5. Poll for key readiness (success page uses this)
app.get('/status/:txRef', (req, res) => {
  const license = db.prepare(
    "SELECT key, plan FROM licenses WHERE flw_tx_ref = ? AND key != 'PENDING'"
  ).get(req.params.txRef);

  if (!license) return res.json({ ready: false });
  res.json({ ready: true, key: license.key, plan: license.plan });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OnyxLock server running on port ${PORT}`));
