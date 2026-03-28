const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Calendly webhook signature
  const signature = req.headers['calendly-webhook-signature'];
  if (process.env.CALENDLY_WEBHOOK_SECRET && signature) {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const rawBody = Buffer.concat(chunks);
    const hmac = crypto.createHmac('sha256', process.env.CALENDLY_WEBHOOK_SECRET);
    hmac.update(rawBody);
    const expected = hmac.digest('hex');
    if (signature !== expected) {
      console.error('[calendly] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    req.body = JSON.parse(rawBody.toString());
  }

  const supabase = getSupabase();
  const resend = new Resend(process.env.RESEND_API_KEY);
  const event = req.body;
  const eventType = event.event;
  const payload = event.payload;

  console.log('[calendly] event: ' + eventType);

  try {
    if (eventType === 'invitee.created') {
      // New booking made
      const invitee = payload.invitee;
      const scheduledEvent = payload.event;

      const email = invitee.email;
      const name = invitee.name;
      const phone = invitee.questions_and_answers?.find(q => q.question.toLowerCase().includes('phone'))?.answer || null;
      const address = invitee.questions_and_answers?.find(q => q.question.toLowerCase().includes('address'))?.answer || null;
      const scheduledAt = scheduledEvent.start_time;
      const calendlyEventId = scheduledEvent.uri?.split('/').pop();
      const calendlyInviteeId = invitee.uri?.split('/').pop();
      const eventName = scheduledEvent.name || '';
      const bookingType = eventName.toLowerCase().includes('member') ? 'member' : 'non_member';
      const amountPaid = bookingType === 'member' ? 129.00 : 149.00;

      console.log('[calendly] new booking: ' + email + ' type: ' + bookingType);

      // Upsert customer
      await supabase.from('customers').upsert({
        email: email.toLowerCase().trim(),
        name,
        phone,
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

      // Get customer id
      const { data: customer } = await supabase
        .from('customers')
        .select('id')
        .eq('email', email.toLowerCase().trim())
        .single();

      // Create booking record
      const { data: booking } = await supabase.from('bookings').insert({
        customer_id: customer?.id,
        email: email.toLowerCase().trim(),
        name,
        phone,
        address,
        booking_type: bookingType,
        amount_paid: amountPaid,
        calendly_event_id: calendlyEventId,
        calendly_invitee_id: calendlyInviteeId,
        scheduled_at: scheduledAt,
        status: 'Pending'
      }).select().single();

      console.log('[calendly] booking created: ' + booking?.id);

      // Send SMS to all active workers about new job
      // (Twilio integration - added when TWILIO vars are set)
      if (process.env.TWILIO_ACCOUNT_SID && booking) {
        const { data: workers } = await supabase
          .from('workers')
          .select('phone, name')
          .eq('status', 'Active');

        if (workers && workers.length > 0) {
          const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          const jobDate = new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          const claimUrl = process.env.WORKER_PORTAL_URL + '/claim/' + booking.id;

          for (const worker of workers) {
            try {
              await twilio.messages.create({
                body: `🏠 New ChoreOFF job available!\n📅 ${jobDate}\n📍 ${address || 'Address in portal'}\n💵 $50\n\nClaim it: ${claimUrl}\nFirst to claim gets it!`,
                from: process.env.TWILIO_PHONE,
                to: worker.phone
              });
              console.log('[SMS] Sent to worker: ' + worker.name);
            } catch (e) {
              console.error('[SMS] Failed for ' + worker.name + ': ' + e.message);
            }
          }
        }
      }

      // Send booking confirmation to customer
      await resend.emails.send({
        from: 'ChoreOFF <info@choreoff.com>',
        to: email,
        subject: 'Your ChoreOFF visit is confirmed ✅',
        html: '<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">' +
          '<h2 style="color:#2ab8b8">You\'re all set, ' + name + '!</h2>' +
          '<p>Your ChoreOFF home reset is confirmed.</p>' +
          '<h3>Booking details:</h3>' +
          '<p>📅 ' + new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</p>' +
          '<p>📍 ' + (address || 'Your provided address') + '</p>' +
          '<h3>Before we arrive:</h3>' +
          '<ul><li>Have detergent and dish soap ready</li><li>Any specific cleaning products you prefer</li><li>Leave access instructions in your notes if needed</li></ul>' +
          '<p>We\'ll send you a confirmation when a worker is assigned.</p>' +
          '<p>Questions? Reply to this email.</p>' +
          '<p>— The ChoreOFF Team</p></div>'
      });

    } else if (eventType === 'invitee.canceled') {
      // Booking cancelled
      const invitee = payload.invitee;
      const calendlyInviteeId = invitee.uri?.split('/').pop();

      await supabase.from('bookings')
        .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
        .eq('calendly_invitee_id', calendlyInviteeId);

      console.log('[calendly] booking cancelled: ' + calendlyInviteeId);
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[calendly err] ' + e.message);
    return res.status(500).json({ error: 'error' });
  }
};

module.exports.config = { api: { bodyParser: false } };
