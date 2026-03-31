const { createClient } = require(’@supabase/supabase-js’);
const { Resend } = require(‘resend’);
const twilio = require(‘twilio’);

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
if (req.method !== ‘POST’) return res.status(405).json({ error: ‘Method not allowed’ });

try {
const body = req.body;

```
// Calendly sends payload in different shapes — handle both
const eventType = body.event || body.payload?.event;
const payload = body.payload || body;

console.log('[calendly] event:', eventType);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

if (eventType === 'invitee.created') {
  // Extract invitee data — handle nested payload
  const invitee = payload.invitee || {};
  const scheduledEvent = payload.scheduled_event || payload.event_details || {};

  const email = invitee.email || payload.email;
  const name = invitee.name || payload.name || 'there';

  if (!email) {
    console.error('[calendly err] No email found in payload');
    console.log('[calendly debug] payload keys:', Object.keys(payload));
    return res.status(200).json({ received: true, warning: 'no email' });
  }

  // Extract phone + address from questions
  const questions = invitee.questions_and_answers || payload.questions_and_answers || [];
  const phone = questions.find(q =>
    q.question?.toLowerCase().includes('phone')
  )?.answer || null;
  const address = questions.find(q =>
    q.question?.toLowerCase().includes('address')
  )?.answer || null;

  // Determine booking type from payment link or event name
  const eventName = (scheduledEvent.name || payload.event_type_name || '').toLowerCase();
  const bookingType = eventName.includes('member') ? 'member' : 'non_member';
  const amountPaid = bookingType === 'member' ? 139 : 179;

  const calendlyInviteeId = (invitee.uri || '').split('/').pop();
  const scheduledAt = scheduledEvent.start_time || scheduledEvent.start || null;

  console.log('[calendly] booking: ' + email + ' type: ' + bookingType + ' address: ' + address);

  // Upsert customer
  await supabase.from('customers').upsert({
    email: email.toLowerCase().trim(),
    name,
    phone,
    updated_at: new Date().toISOString()
  }, { onConflict: 'email' });

  // Get customer ID
  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('email', email.toLowerCase().trim())
    .single();

  // Create booking
  const { data: booking } = await supabase.from('bookings').upsert({
    customer_id: customer?.id || null,
    email: email.toLowerCase().trim(),
    name,
    phone,
    address,
    city: 'Madison',
    booking_type: bookingType,
    amount_paid: amountPaid,
    calendly_invitee_id: calendlyInviteeId,
    scheduled_at: scheduledAt,
    status: 'Pending'
  }, { onConflict: 'calendly_invitee_id' }).select().single();

  console.log('[calendly] booking saved, id: ' + booking?.id);

  // SMS all active workers
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );

      const { data: workers } = await supabase
        .from('workers')
        .select('phone, name')
        .eq('status', 'Active')
        .eq('city', 'Madison');

      const jobDate = scheduledAt
        ? new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'Date TBD';

      const claimUrl = 'https://choreoff.com/worker';

      for (const worker of (workers || [])) {
        if (!worker.phone) continue;
        await twilioClient.messages.create({
          from: process.env.TWILIO_PHONE,
          body: `🏠 New ChoreOFF job!\n📅 ${jobDate}\n📍 ${address ? address.split(',')[0] + ' (full address after claim)' : 'Madison, WI'}\n💵 $50\n\nClaim it: ${claimUrl}\nFirst to claim gets it!`,
          to: worker.phone
        });
        console.log('[SMS] Sent to worker: ' + worker.name);
      }
    } catch (smsErr) {
      console.error('[SMS err]', smsErr.message);
    }
  }

  // Send booking confirmation email to customer
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const jobDate = scheduledAt
        ? new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'your scheduled time';

      await resend.emails.send({
        from: 'ChoreOFF <info@choreoff.com>',
        to: email,
        subject: 'Your ChoreOFF visit is confirmed ✓',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
            <h2 style="font-size:1.4rem;margin-bottom:8px">You're all set, ${name.split(' ')[0]}.</h2>
            <p style="color:#666;margin-bottom:24px">Your ChoreOFF visit is confirmed for <strong>${jobDate}</strong>.</p>
            <div style="background:#f5f5f2;border-radius:12px;padding:20px;margin-bottom:24px">
              <p style="margin:0 0 8px;font-weight:600">What we'll do:</p>
              <p style="margin:0;color:#555;font-size:0.9rem;line-height:1.6">Laundry · Dishes · Floors & surfaces · Tidying & reset</p>
            </div>
            ${address ? `<p style="margin-bottom:16px">📍 <strong>${address}</strong></p>` : ''}
            <p style="color:#666;font-size:0.9rem;margin-bottom:24px">Make sure you have supplies ready — detergent, dish soap, and any cleaning products. We'll handle the rest.</p>
            <p style="color:#888;font-size:0.85rem">Questions? Reply to this email.<br>— The ChoreOFF Team</p>
          </div>
        `
      });
      console.log('[email] Confirmation sent to: ' + email);
    } catch (emailErr) {
      console.error('[email err]', emailErr.message);
    }
  }

  return res.status(200).json({ success: true, booking_id: booking?.id });

} else if (eventType === 'invitee.canceled') {
  const invitee = payload.invitee || {};
  const calendlyInviteeId = (invitee.uri || '').split('/').pop();

  await supabase
    .from('bookings')
    .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
    .eq('calendly_invitee_id', calendlyInviteeId);

  console.log('[calendly] booking cancelled: ' + calendlyInviteeId);
  return res.status(200).json({ success: true });
}

return res.status(200).json({ received: true });
```

} catch (e) {
console.error(’[calendly err]’, e.message);
return res.status(500).json({ error: e.message });
}
};