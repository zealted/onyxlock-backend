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

// ─── Routes ───────────────────────────────────────────────────────────────────

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
