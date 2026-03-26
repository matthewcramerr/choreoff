const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google } = require('googleapis');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// Environment variables needed:
// STRIPE_SECRET_KEY - your Stripe secret key
// STRIPE_WEBHOOK_SECRET - webhook signing secret from Stripe
// GOOGLE_SERVICE_ACCOUNT_JSON - the full JSON content of your service account key
// GMAIL_USER - info@choreoff.com
// GMAIL_APP_PASSWORD - Gmail app password
// SHEET_ID - 16FYwFL9hW3UQcGlkblu54dZ6-iuuV8dk38eod45dQ5U
// MEMBER_PRICE_ID - Stripe price ID for $129 member visit payment link
// MEMBERSHIP_PRICE_ID - Stripe price ID for $19/month membership

const SHEET_ID = process.env.SHEET_ID;
const MEMBER_VISIT_PAYMENT_LINK = 'fZu6oAdph4RY2AS5gm6oo03';

// Initialize Google Sheets
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Send welcome email to new member
async function sendWelcomeEmail(email, name) {
  await resend.emails.send({
    from: 'ChoreOFF <info@choreoff.com>',
    to: email,
    subject: "Welcome to ChoreOFF — here's everything you need 🎉",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #2ab8b8;">Welcome to ChoreOFF, ${name}!</h2>
        <p>You're officially a ChoreOFF member. Here's everything in one place — <strong>bookmark this email.</strong></p>
        <h3>Your member booking link ($129/visit):</h3>
        <p>👉 <a href="https://buy.stripe.com/fZu6oAdph4RY2AS5gm6oo03" style="color: #2ab8b8;">Book your $129 visit</a></p>
        <p>After paying, you'll be redirected to schedule your visit.</p>
        <h3>Manage or cancel your membership:</h3>
        <p>👉 <a href="https://billing.stripe.com/p/login/00w7sE2KD5W22AScIO6oo00" style="color: #2ab8b8;">Member portal</a></p>
        <p>Log in with your email anytime to update payment info or cancel — no phone calls, no hassle.</p>
        <h3>What's included every visit:</h3>
        <ul>
          <li>Laundry</li>
          <li>Dishes</li>
          <li>Floors &amp; surfaces</li>
          <li>Tidying &amp; light reset</li>
        </ul>
        <p>Just make sure your supplies are ready before we arrive — detergent, dish soap, and any cleaning products.</p>
        <p>Questions? Reply to this email.</p>
        <p>— The ChoreOFF Team</p>
      </div>
    `,
  });
}

// Send rejection email for non-members trying to use $129 link
async function sendRejectionEmail(email, name) {
  await resend.emails.send({
    from: 'ChoreOFF <info@choreoff.com>',
    to: email,
    subject: "Your ChoreOFF booking couldn't be confirmed",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #0e0e0e;">Hi ${name},</h2>
        <p>It looks like you don't have an active ChoreOFF membership. The $129 visit price is exclusive to active members.</p>
        <p>Your payment has been automatically refunded — it should appear within 3-5 business days.</p>
        <p>To access member pricing, <a href="https://choreoff.vercel.app" style="color: #2ab8b8;">visit our site</a> and become a member for just $19/month.</p>
        <p>— The ChoreOFF Team</p>
      </div>
    `,
  });
}

// Send payment failure email
async function sendPaymentFailedEmail(email, name) {
  await resend.emails.send({
    from: 'ChoreOFF <info@choreoff.com>',
    to: email,
    subject: 'Action needed — ChoreOFF payment failed',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #0e0e0e;">Hi ${name},</h2>
        <p>Your ChoreOFF membership payment didn't go through. To keep your member pricing and access, please update your payment info.</p>
        <p>👉 <a href="https://billing.stripe.com/p/login/00w7sE2KD5W22AScIO6oo00" style="color: #2ab8b8;">Update payment info</a></p>
        <p>If you have any questions, just reply to this email.</p>
        <p>— The ChoreOFF Team</p>
      </div>
    `,
  });
}

// Look up member by email in Google Sheets
async function getMemberByEmail(sheets, email) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A:D',
  });

  const rows = response.data.values || [];
  // Skip header row
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].toLowerCase() === email.toLowerCase()) {
      return {
        rowIndex: i + 1, // 1-indexed for Sheets API
        email: rows[i][0],
        name: rows[i][1],
        dateJoined: rows[i][2],
        status: rows[i][3],
      };
    }
  }
  return null;
}

// Add new member to Google Sheets
async function addMember(sheets, email, name, dateJoined) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A:D',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[email, name, dateJoined, 'Active']],
    },
  });
}

// Update member status in Google Sheets
async function updateMemberStatus(sheets, rowIndex, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Sheet1!D${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[status]],
    },
  });
}

// Send welcome email to new member
async function sendWelcomeEmail(transporter, email, name) {
  await transporter.sendMail({
    from: `"ChoreOFF" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Welcome to ChoreOFF — here\'s everything you need 🎉',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #2ab8b8;">Welcome to ChoreOFF, ${name}!</h2>
        <p>You're officially a ChoreOFF member. Here's everything in one place — <strong>bookmark this email.</strong></p>
        
        <h3>Your member booking link ($129/visit):</h3>
        <p>👉 <a href="https://buy.stripe.com/fZu6oAdph4RY2AS5gm6oo03" style="color: #2ab8b8;">Book your $129 visit</a></p>
        <p>After paying, you'll be redirected to schedule your visit.</p>
        
        <h3>Manage or cancel your membership:</h3>
        <p>👉 <a href="https://billing.stripe.com/p/login/00w7sE2KD5W22AScIO6oo00" style="color: #2ab8b8;">Member portal</a></p>
        <p>Log in with your email anytime to update payment info or cancel — no phone calls, no hassle.</p>
        
        <h3>What's included every visit:</h3>
        <ul>
          <li>Laundry</li>
          <li>Dishes</li>
          <li>Floors &amp; surfaces</li>
          <li>Tidying &amp; light reset</li>
        </ul>
        
        <p>Just make sure your supplies are ready before we arrive — detergent, dish soap, and any cleaning products.</p>
        
        <p>Questions? Reply to this email.</p>
        <p>— The ChoreOFF Team</p>
      </div>
    `,
  });
}

// Send rejection email for non-members trying to use $129 link
async function sendRejectionEmail(transporter, email, name) {
  await transporter.sendMail({
    from: `"ChoreOFF" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Your ChoreOFF booking couldn\'t be confirmed',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #0e0e0e;">Hi ${name},</h2>
        <p>It looks like you don't have an active ChoreOFF membership. The $129 visit price is exclusive to active members.</p>
        <p>Your payment has been automatically refunded — it should appear within 3-5 business days.</p>
        <p>To access member pricing, <a href="https://choreoff.vercel.app" style="color: #2ab8b8;">visit our site</a> and become a member for just $19/month.</p>
        <p>— The ChoreOFF Team</p>
      </div>
    `,
  });
}

// Send payment failure email
async function sendPaymentFailedEmail(transporter, email, name) {
  await transporter.sendMail({
    from: `"ChoreOFF" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Action needed — ChoreOFF payment failed',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #0e0e0e;">Hi ${name},</h2>
        <p>Your ChoreOFF membership payment didn't go through. To keep your member pricing and access, please update your payment info.</p>
        <p>👉 <a href="https://billing.stripe.com/p/login/00w7sE2KD5W22AScIO6oo00" style="color: #2ab8b8;">Update payment info</a></p>
        <p>If you have any questions, just reply to this email.</p>
        <p>— The ChoreOFF Team</p>
      </div>
    `,
  });
}

// Main webhook handler
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const sheets = getSheetsClient();

  try {
    switch (event.type) {

      case 'customer.subscription.created': {
        const subscription = event.data.object;
        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;
        const name = customer.name || 'there';
        const dateJoined = new Date().toISOString().split('T')[0];
        await addMember(sheets, email, name, dateJoined);
        await sendWelcomeEmail(email, name);
        console.log(`New member added: ${email}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;
        const member = await getMemberByEmail(sheets, email);
        if (member) {
          await updateMemberStatus(sheets, member.rowIndex, 'Cancelled');
          console.log(`Member cancelled: ${email}`);
        }
        break;
      }

      case 'charge.succeeded': {
        const charge = event.data.object;
        if (!charge.payment_link || !charge.payment_link.includes(MEMBER_VISIT_PAYMENT_LINK)) {
          break;
        }
        const email = charge.billing_details?.email || charge.customer_email;
        const name = charge.billing_details?.name || 'there';
        if (!email) break;
        const member = await getMemberByEmail(sheets, email);
        if (!member || member.status !== 'Active') {
          await stripe.refunds.create({ charge: charge.id });
          await sendRejectionEmail(email, name);
          console.log(`Non-member refunded: ${email}`);
        } else {
          await resend.emails.send({
            from: 'ChoreOFF <info@choreoff.com>',
            to: 'info@choreoff.com',
            subject: `New member booking — ${name}`,
            html: `<p>${name} (${email}) just booked a $129 member visit.</p>`,
          });
          console.log(`Valid member booking: ${email}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customer = await stripe.customers.retrieve(invoice.customer);
        const email = customer.email;
        const name = customer.name || 'there';
        await sendPaymentFailedEmail(email, name);
        console.log(`Payment failed email sent: ${email}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Required for Stripe webhook signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};
