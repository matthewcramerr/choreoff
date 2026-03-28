const Stripe = require('stripe');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

console.log('[project-check] choreoff-main-v2');

const URLS = {
  memberVisitPaymentLink: 'fZu6oAdph4RY2AS5gm6oo03',
  memberVisitStripe: 'https://buy.stripe.com/fZu6oAdph4RY2AS5gm6oo03',
  memberPortal: 'https://billing.stripe.com/p/login/00w7sE2KD5W22AScIO6oo00',
  site: 'https://choreoff.com',
};

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

async function getMember(supabase, email) {
  if (!email) return null;
  const { data } = await supabase
    .from('members')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .single();
  return data || null;
}

async function upsertMember(supabase, email, name, stripeSubId) {
  if (!email) return;
  const existing = await getMember(supabase, email);

  // Also upsert customer record
  await supabase.from('customers').upsert({
    email: email.toLowerCase().trim(),
    name,
    updated_at: new Date().toISOString()
  }, { onConflict: 'email' });

  if (existing) {
    await supabase.from('members')
      .update({ status: 'Active', stripe_subscription_id: stripeSubId, updated_at: new Date().toISOString() })
      .eq('email', email.toLowerCase().trim());
    console.log('[Supabase] Member reactivated: ' + email);
  } else {
    await supabase.from('members').insert({
      email: email.toLowerCase().trim(),
      name,
      stripe_subscription_id: stripeSubId,
      status: 'Active',
      date_joined: new Date().toISOString().split('T')[0]
    });
    console.log('[Supabase] Member added: ' + email);
  }
}

async function cancelMember(supabase, email) {
  if (!email) return;
  await supabase.from('members')
    .update({ status: 'Cancelled', date_cancelled: new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() })
    .eq('email', email.toLowerCase().trim());
  console.log('[Supabase] Member cancelled: ' + email);
}

async function pastDueMember(supabase, email) {
  if (!email) return;
  await supabase.from('members')
    .update({ status: 'Past Due', updated_at: new Date().toISOString() })
    .eq('email', email.toLowerCase().trim());
}

async function mail(resend, to, subject, html) {
  if (!to) { console.log('[Email] Skipping — no email'); return; }
  try {
    const r = await resend.emails.send({ from: 'ChoreOFF <info@choreoff.com>', to, subject, html });
    console.log('[Email] Sent to ' + to + ': ' + JSON.stringify(r));
  } catch (e) {
    console.error('[Email] Failed: ' + e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);
  const supabase = getSupabase();
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    event = stripe.webhooks.constructEvent(Buffer.concat(chunks), sig, (process.env.STRIPE_WEBHOOK_SECRET || '').trim());
  } catch (e) {
    console.error('[sig] ' + e.message);
    return res.status(400).json({ error: e.message });
  }

  console.log('[event] ' + event.type);

  try {
    // ── New member subscribes ──────────────────────────────
    if (event.type === 'customer.subscription.created') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      const email = cust.email || null;
      const name = (cust.name || 'there').trim();
      const subId = event.data.object.id;
      console.log('[sub.created] email: ' + email);
      if (!email) return res.status(200).json({ received: true });

      const existing = await getMember(supabase, email);
      await upsertMember(supabase, email, name, subId);

      if (!existing) {
        await mail(resend, email, 'Welcome to ChoreOFF 🎉',
          '<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">' +
          '<h2 style="color:#2ab8b8">Welcome to ChoreOFF, ' + name + '!</h2>' +
          '<p>You are officially a ChoreOFF member. <strong>Bookmark this email.</strong></p>' +
          '<h3>Book your first visit ($129):</h3>' +
          '<p><a href="' + URLS.memberVisitStripe + '" style="background:#2ab8b8;color:white;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:600;display:inline-block">Book a $129 visit →</a></p>' +
          '<h3>Manage or cancel anytime:</h3>' +
          '<p><a href="' + URLS.memberPortal + '" style="color:#2ab8b8">Member portal</a></p>' +
          '<h3>Every visit includes:</h3>' +
          '<ul><li>Laundry</li><li>Dishes</li><li>Floors &amp; surfaces</li><li>Tidying &amp; light reset</li></ul>' +
          '<p>Have your supplies ready — detergent, dish soap, cleaning products.</p>' +
          '<p>Questions? Reply to this email.</p>' +
          '<p>— The ChoreOFF Team</p></div>');
      }

    // ── Member cancels ─────────────────────────────────────
    } else if (event.type === 'customer.subscription.deleted') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      const email = cust.email || null;
      console.log('[sub.deleted] email: ' + email);
      if (!email) return res.status(200).json({ received: true });
      await cancelMember(supabase, email);

    // ── Payment failed ─────────────────────────────────────
    } else if (event.type === 'invoice.payment_failed') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      const email = cust.email || null;
      const name = (cust.name || 'there').trim();
      console.log('[invoice.failed] email: ' + email);
      if (!email) return res.status(200).json({ received: true });
      await pastDueMember(supabase, email);
      await mail(resend, email, 'Action needed — ChoreOFF payment failed',
        '<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">' +
        '<h2>Hi ' + name + ',</h2>' +
        '<p>Your ChoreOFF membership payment did not go through.</p>' +
        '<p><a href="' + URLS.memberPortal + '" style="color:#2ab8b8">Update your payment info here →</a></p>' +
        '<p>— The ChoreOFF Team</p></div>');

    // ── $129 member visit checkout ─────────────────────────
    } else if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const pl = s.payment_link || '';
      console.log('[checkout] payment_link: ' + pl);
      if (!pl.includes(URLS.memberVisitPaymentLink)) return res.status(200).json({ received: true });

      const email = s.customer_details && s.customer_details.email;
      const name = (s.customer_details && s.customer_details.name) || 'there';
      console.log('[checkout] email: ' + email);
      if (!email) return res.status(200).json({ received: true });

      const member = await getMember(supabase, email);
      const isActive = member && member.status === 'Active';

      if (!isActive) {
        console.log('[checkout] not active — refunding: ' + email);
        try { await stripe.refunds.create({ payment_intent: s.payment_intent }); } catch (e) { console.error('refund fail: ' + e.message); }
        await mail(resend, email, 'Your ChoreOFF booking could not be confirmed',
          '<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">' +
          '<h2>Hi ' + name + ',</h2>' +
          '<p>No active membership found. The $129 visit price is for active members only.</p>' +
          '<p>Your payment has been automatically refunded — allow 3-5 business days.</p>' +
          '<p><a href="' + URLS.site + '" style="color:#2ab8b8">Become a member for $19/month →</a></p>' +
          '<p>— The ChoreOFF Team</p></div>');
      } else {
        console.log('[checkout] valid member booking: ' + email);
        // Log booking to Supabase
        await supabase.from('bookings').insert({
          email: email.toLowerCase().trim(),
          name,
          booking_type: 'member',
          amount_paid: 129.00,
          stripe_payment_intent: s.payment_intent,
          status: 'Pending'
        });
        await mail(resend, 'info@choreoff.com', 'New member booking — ' + name,
          '<p>' + name + ' (' + email + ') just booked a $129 member visit. Check Calendly for scheduling.</p>');
      }

    } else {
      console.log('[event] unhandled: ' + event.type);
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[err] ' + e.message);
    return res.status(500).json({ error: 'error' });
  }
};

module.exports.config = { api: { bodyParser: false } };
