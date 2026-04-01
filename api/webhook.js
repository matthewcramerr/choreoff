const Stripe = require('stripe');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');

console.log('[project-check] choreoff-main-v3');

const URLS = {
  memberVisitPaymentLink: 'STRIPE_139_ID',
  memberVisitStripe: 'https://buy.stripe.com/STRIPE_139',
  memberPortal: 'https://billing.stripe.com/p/login/00w7sE2KD5W22AScIO6oo00',
  site: 'https://choreoff.com',
  membershipMonthly: 'https://buy.stripe.com/STRIPE_29',
  membershipYearly: 'https://buy.stripe.com/STRIPE_261',
};

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getMember(supabase, email) {
  if (!email) return null;
  const { data } = await supabase.from('members').select('*').eq('email', email.toLowerCase().trim()).single();
  return data || null;
}

async function upsertMember(supabase, email, name, stripeSubId) {
  if (!email) return;
  const existing = await getMember(supabase, email);
  await supabase.from('customers').upsert({ email: email.toLowerCase().trim(), name, updated_at: new Date().toISOString() }, { onConflict: 'email' });
  if (existing) {
    await supabase.from('members').update({ status: 'Active', stripe_subscription_id: stripeSubId, updated_at: new Date().toISOString() }).eq('email', email.toLowerCase().trim());
    console.log('[Supabase] Member reactivated: ' + email);
  } else {
    await supabase.from('members').insert({ email: email.toLowerCase().trim(), name, stripe_subscription_id: stripeSubId, status: 'Active', date_joined: new Date().toISOString().split('T')[0] });
    console.log('[Supabase] Member added: ' + email);
  }
}

async function cancelMember(supabase, email) {
  if (!email) return;
  await supabase.from('members').update({ status: 'Cancelled', date_cancelled: new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() }).eq('email', email.toLowerCase().trim());
  console.log('[Supabase] Member cancelled: ' + email);
}

async function pastDueMember(supabase, email) {
  if (!email) return;
  await supabase.from('members').update({ status: 'Past Due', updated_at: new Date().toISOString() }).eq('email', email.toLowerCase().trim());
}

async function mail(resend, to, subject, html) {
  if (!to) return;
  try { await resend.emails.send({ from: 'ChoreOFF <info@choreoff.com>', to, subject, html }); console.log('[Email] Sent to ' + to); }
  catch (e) { console.error('[Email] Failed: ' + e.message); }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const stripe = new Stripe((process.env.STRIPE_SECRET_KEY || '').trim());
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
    if (event.type === 'customer.subscription.created') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      const email = cust.email || null;
      const name = (cust.name || 'there').trim();
      const subId = event.data.object.id;
      const interval = event.data.object.items?.data?.[0]?.plan?.interval || 'month';
      const isYearly = interval === 'year';
      console.log('[sub.created] email: ' + email + ' interval: ' + interval);
      if (!email) return res.status(200).json({ received: true });
      const existing = await getMember(supabase, email);
      await upsertMember(supabase, email, name, subId);
      if (!existing) {
        await mail(resend, email, 'Welcome to ChoreOFF 🎉',
          `<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">
            <h2 style="color:#2ab8b8">Welcome to ChoreOFF, ${name.split(' ')[0]}!</h2>
            <p>You're officially a ChoreOFF member. <strong>Bookmark this email.</strong></p>
            ${isYearly ? '<p style="background:#e8f8f8;padding:12px 16px;border-radius:8px;color:#1e9494;margin:16px 0"><strong>Annual member</strong> — you get the full year + 3 months free.</p>' : ''}
            <h3 style="margin-top:28px">Book your first visit ($139):</h3>
            <p><a href="${URLS.memberVisitStripe}" style="background:#2ab8b8;color:white;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:600;display:inline-block">Book a visit — $139 →</a></p>
            <h3 style="margin-top:28px">Manage or cancel anytime:</h3>
            <p><a href="${URLS.memberPortal}" style="color:#2ab8b8">Member portal →</a></p>
            <h3 style="margin-top:28px">Every visit includes:</h3>
            <ul style="color:#555;line-height:1.8"><li>Laundry — washed, dried, folded</li><li>Dishes — hand washed and put away</li><li>Floors &amp; surfaces — swept and wiped</li><li>Tidying &amp; light reset</li></ul>
            <p style="margin-top:20px;color:#888;font-size:0.9rem">Have your supplies ready — detergent, dish soap, cleaning products.</p>
            <p style="color:#888;font-size:0.9rem">Questions? Reply to this email.<br>— The ChoreOFF Team</p>
          </div>`
        );
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      const email = cust.email || null;
      const name = (cust.name || 'there').trim();
      console.log('[sub.deleted] email: ' + email);
      if (!email) return res.status(200).json({ received: true });
      await cancelMember(supabase, email);
      await mail(resend, email, 'Your ChoreOFF membership has been cancelled',
        `<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">
          <h2>Hi ${name.split(' ')[0]},</h2>
          <p>Your ChoreOFF membership has been cancelled. You won't be charged again.</p>
          <p>Rejoin anytime at <a href="${URLS.site}" style="color:#2ab8b8">choreoff.com</a>.</p>
          <p style="color:#888">— The ChoreOFF Team</p>
        </div>`
      );
    } else if (event.type === 'invoice.payment_failed') {
      const cust = await stripe.customers.retrieve(event.data.object.customer);
      const email = cust.email || null;
      const name = (cust.name || 'there').trim();
      console.log('[invoice.failed] email: ' + email);
      if (!email) return res.status(200).json({ received: true });
      await pastDueMember(supabase, email);
      await mail(resend, email, 'Action needed — ChoreOFF payment failed',
        `<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">
          <h2>Hi ${name.split(' ')[0]},</h2>
          <p>Your ChoreOFF membership payment didn't go through. Update your payment info to stay active:</p>
          <p><a href="${URLS.memberPortal}" style="background:#cc3322;color:white;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:600;display:inline-block">Update payment info →</a></p>
          <p style="color:#888">— The ChoreOFF Team</p>
        </div>`
      );
    } else if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const pl = s.payment_link || '';
      console.log('[checkout] payment_link: ' + pl);
      if (!pl.includes(URLS.memberVisitPaymentLink)) return res.status(200).json({ received: true });
      const email = s.customer_details?.email;
      const name = s.customer_details?.name || 'there';
      console.log('[checkout] email: ' + email);
      if (!email) return res.status(200).json({ received: true });
      const member = await getMember(supabase, email);
      const isActive = member && member.status === 'Active';
      if (!isActive) {
        console.log('[checkout] not active — refunding: ' + email);
        try { await stripe.refunds.create({ payment_intent: s.payment_intent }); } catch (e) { console.error('[refund fail]', e.message); }
        await mail(resend, email, 'Your ChoreOFF booking could not be confirmed',
          `<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">
            <h2>Hi ${name.split(' ')[0]},</h2>
            <p>No active membership found. The $139 visit price is for active members only. Your payment has been automatically refunded — allow 3-5 business days.</p>
            <p><a href="${URLS.membershipMonthly}" style="color:#2ab8b8;font-weight:600">Become a member — $29/month →</a></p>
            <p style="color:#888">— The ChoreOFF Team</p>
          </div>`
        );
      } else {
        console.log('[checkout] valid member booking: ' + email);
        await supabase.from('bookings').insert({ email: email.toLowerCase().trim(), name, booking_type: 'member', amount_paid: 139.00, stripe_payment_intent: s.payment_intent, status: 'Pending', city: 'Madison', market: 'Madison' });
        await mail(resend, 'info@choreoff.com', '💳 New member booking — ' + name, `<p>${name} (${email}) just booked a $139 member visit.</p>`);
      }
    } else {
      console.log('[event] unhandled: ' + event.type);
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[err] ' + e.message);
    return res.status(500).json({ error: 'internal error' });
  }
};

module.exports.config = { api: { bodyParser: false } };
