const Stripe = require('stripe');
const { google } = require('googleapis');
const { Resend } = require('resend');

const URLS = {
  memberVisitPaymentLink: 'fZu6oAdph4RY2AS5gm6oo03',
  memberVisitStripe: 'https://buy.stripe.com/fZu6oAdph4RY2AS5gm6oo03',
  memberPortal: 'https://billing.stripe.com/p/login/00w7sE2KD5W22AScIO6oo00',
  site: 'https://choreoff.vercel.app',
};

function validateEnv() {
  const required = ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','GOOGLE_SERVICE_ACCOUNT_JSON','SHEET_ID','RESEND_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error('Missing env vars: ' + missing.join(', '));
}

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function getMember(sh, email) {
  const r = await sh.spreadsheets.values.get({ spreadsheetId: process.env.SHEET_ID, range: 'Sheet1!A:D' });
  const rows = r.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].trim().toLowerCase() === email.trim().toLowerCase()) {
      return { rowIndex: i + 1, email: rows[i][0], name: rows[i][1], status: (rows[i][3] || '').trim() };
    }
  }
  return null;
}

async function addMember(sh, email, name, date) {
  await sh.spreadsheets.values.append({ spreadsheetId: process.env.SHEET_ID, range: 'Sheet1!A:D', valueInputOption: 'RAW', requestBody: { values: [[email, name, date, 'Active']] } });
}

async function setStatus(sh, row, status) {
  await sh.spreadsheets.values.update({ spreadsheetId: process.env.SHEET_ID, range: 'Sheet1!D' + row, valueInputOption: 'RAW', requestBody: { values: [[status]] } });
}

async function mail(resend, to, subject, html) {
  try {
    const r = await resend.emails.send({ from: 'ChoreOFF <info@choreoff.com>', to, subject, html });
    console.log('[mail] sent to ' + to + ': ' + JSON.stringify(r));
  } catch (e) {
    console.error('[mail] failed: ' + e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'no' });

  try { validateEnv(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    event = stripe.webhooks.constructEvent(Buffer.concat(chunks), sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[sig] ' + e.message);
    return res.status(400).json({ error: e.message });
  }

  console.log('[event] ' + event.type);
  const sh = getSheetsClient();

  try {
    if (event.type === 'customer.subscription.created') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      const email = cust.email;
      const name = (cust.name || 'there').trim();
      console.log('[sub.created] ' + email);
      const ex = await getMember(sh, email);
      if (ex) {
        await setStatus(sh, ex.rowIndex, 'Active');
      } else {
        await addMember(sh, email, name, new Date().toISOString().split('T')[0]);
        await mail(resend, email, 'Welcome to ChoreOFF',
          '<div style="font-family:sans-serif;padding:40px"><h2 style="color:#2ab8b8">Welcome ' + name + '!</h2><p>Bookmark this email.</p><p><b>Book a visit ($129):</b> <a href="' + URLS.memberVisitStripe + '">click here</a></p><p><b>Manage membership:</b> <a href="' + URLS.memberPortal + '">portal</a></p><p>Every visit includes: Laundry, Dishes, Floors, Tidying. Have supplies ready.</p><p>- ChoreOFF Team</p></div>');
      }

    } else if (event.type === 'customer.subscription.deleted') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      console.log('[sub.deleted] ' + cust.email);
      const m = await getMember(sh, cust.email);
      if (m) await setStatus(sh, m.rowIndex, 'Cancelled');

    } else if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const pl = s.payment_link || '';
      console.log('[checkout] ' + pl);
      if (pl.includes(URLS.memberVisitPaymentLink)) {
        const email = s.customer_details && s.customer_details.email;
        const name = (s.customer_details && s.customer_details.name) || 'there';
        if (email) {
          const m = await getMember(sh, email);
          if (!m || m.status.toLowerCase() !== 'active') {
            console.log('[checkout] refunding ' + email);
            try { await stripe.refunds.create({ payment_intent: s.payment_intent }); } catch (e) { console.error('refund fail: ' + e.message); }
            await mail(resend, email, 'Booking not confirmed', '<p>Hi ' + name + ', no active membership found. Refunded. <a href="' + URLS.site + '">Join here</a>.</p>');
          } else {
            console.log('[checkout] valid ' + email);
            await mail(resend, 'info@choreoff.com', 'Member booking: ' + name, '<p>' + name + ' (' + email + ') booked a $129 visit.</p>');
          }
        }
      }

    } else if (event.type === 'invoice.payment_failed') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      await mail(resend, cust.email, 'Payment failed - ChoreOFF', '<p>Hi ' + (cust.name || 'there') + ', payment failed. <a href="' + URLS.memberPortal + '">Update here</a>.</p>');
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[err] ' + e.message);
    return res.status(500).json({ error: 'error' });
  }
};

module.exports.config = { api: { bodyParser: false } };
