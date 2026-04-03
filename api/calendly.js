const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const twilio = require('twilio');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    const eventType = body.event || body.payload?.event;
    const payload = body.payload || body;
    console.log('[calendly] event:', eventType);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (eventType === 'invitee.created') {
      const invitee = payload.invitee || {};
      const scheduledEvent = payload.scheduled_event || payload.event_details || {};
      const email = invitee.email || payload.email;
      const name = invitee.name || payload.name || 'there';

      if (!email) {
        console.error('[calendly err] No email. Keys:', Object.keys(payload).join(', '));
        return res.status(200).json({ received: true, warning: 'no email' });
      }

      const questions = invitee.questions_and_answers || payload.questions_and_answers || [];
      const phone = questions.find(q => q.question?.toLowerCase().includes('phone'))?.answer || null;
      const address = questions.find(q => q.question?.toLowerCase().includes('address'))?.answer || null;

      const eventName = (scheduledEvent.name || payload.event_type_name || '').toLowerCase();
      const bookingType = eventName.includes('member') ? 'member' : 'non_member';
      const amountPaid = bookingType === 'member' ? 139 : 179;

      // Parse city from address
      let city = null;
      if (address) {
        const parts = address.split(',');
        if (parts.length >= 2) city = parts[parts.length - 2]?.trim() || null;
      }
      const market = city || 'unknown';

      const calendlyInviteeId = (invitee.uri || '').split('/').pop();
      const scheduledAt = scheduledEvent.start_time || scheduledEvent.start || null;
      const jobDate = scheduledAt
        ? new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'Date TBD';
      const jobDateLong = scheduledAt
        ? new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'your scheduled time';

      console.log('[calendly] booking:', email, '| type:', bookingType, '| market:', market);

      // Upsert customer
      await supabase.from('customers').upsert({
        email: email.toLowerCase().trim(), name, phone, updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

      const { data: customer } = await supabase.from('customers').select('id').eq('email', email.toLowerCase().trim()).single();

      // Check returning customer
      const { data: prevBookings } = await supabase.from('bookings').select('id').eq('email', email.toLowerCase().trim()).limit(1);
      const isReturning = prevBookings && prevBookings.length > 0;

      // Save booking
      const { data: booking } = await supabase.from('bookings').upsert({
        customer_id: customer?.id || null,
        email: email.toLowerCase().trim(),
        name, phone, address, city, market,
        booking_type: bookingType,
        amount_paid: amountPaid,
        calendly_invitee_id: calendlyInviteeId,
        scheduled_at: scheduledAt,
        status: 'Pending'
      }, { onConflict: 'calendly_invitee_id' }).select().single();

      console.log('[calendly] booking saved:', booking?.id);

      // SMS workers in same market only
      if (process.env.TWILIO_ACCOUNT_SID) {
        try {
          const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          const { data: workers } = await supabase
            .from('workers')
            .select('phone, name, market, city')
            .eq('status', 'Active')
            .or(`market.ilike.%${market}%,city.ilike.%${city}%`);

          for (const w of (workers || [])) {
            if (!w.phone) continue;
            await tw.messages.create({
              from: process.env.TWILIO_PHONE,
              body: `🏠 New ChoreOFF job in ${city}!\n📅 ${jobDate}\n💵 $50 — First to claim gets it\nhttps://choreoff.com/worker`,
              to: w.phone
            });
            console.log('[SMS] Sent to worker:', w.name);
          }
          if (!workers?.length) console.log('[SMS] No workers in market:', market);
        } catch (smsErr) { console.error('[SMS err]', smsErr.message); }
      }

      // Emails
      if (process.env.RESEND_API_KEY) {
        const resend = new Resend(process.env.RESEND_API_KEY);

        // Admin notification
        try {
          await resend.emails.send({
            from: 'ChoreOFF <info@choreoff.com>',
            to: 'info@choreoff.com',
            subject: `${isReturning ? '🔄 Returning' : '🆕 New'} booking — ${name} ($${amountPaid})`,
            html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
              <h2 style="color:#2ab8b8">${isReturning ? '🔄 Returning Customer' : '🆕 New Booking'}</h2>
              <table style="width:100%;font-size:0.9rem;border-collapse:collapse">
                <tr><td style="padding:6px 0;color:#888;width:110px">Customer</td><td><strong>${name}</strong></td></tr>
                <tr><td style="padding:6px 0;color:#888">Email</td><td>${email}</td></tr>
                <tr><td style="padding:6px 0;color:#888">Phone</td><td>${phone || '—'}</td></tr>
                <tr><td style="padding:6px 0;color:#888">Address</td><td><strong>${address || '—'}</strong></td></tr>
                <tr><td style="padding:6px 0;color:#888">Date</td><td><strong>${jobDateLong}</strong></td></tr>
                <tr><td style="padding:6px 0;color:#888">Type</td><td>${bookingType === 'member' ? 'Member Visit' : 'One-Time Reset'}</td></tr>
                <tr><td style="padding:6px 0;color:#888">Amount</td><td><strong style="color:#2ab8b8">$${amountPaid}</strong></td></tr>
                <tr><td style="padding:6px 0;color:#888">Market</td><td>${market}</td></tr>
              </table>
              <br><a href="https://choreoff.com/admin" style="background:#0e0e0e;color:white;padding:12px 24px;border-radius:100px;text-decoration:none;font-size:0.875rem;font-weight:600">View in Admin →</a>
            </div>`
          });
        } catch(e) { console.error('[admin notify err]', e.message); }

        // Customer confirmation
        try {
          await resend.emails.send({
            from: 'ChoreOFF <info@choreoff.com>',
            to: email,
            subject: 'Your ChoreOFF visit is confirmed ✓',
            html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px">
              <h2 style="font-size:1.4rem;margin-bottom:8px">You're all set, ${name.split(' ')[0]}.</h2>
              <p style="color:#666;margin-bottom:24px">Your ChoreOFF visit is confirmed for <strong>${jobDateLong}</strong>.</p>
              <div style="background:#f5f5f2;border-radius:12px;padding:20px;margin-bottom:24px">
                <p style="margin:0 0 8px;font-weight:600">What we'll do:</p>
                <p style="margin:0;color:#555;line-height:1.8;font-size:0.9rem">✓ Laundry &nbsp;·&nbsp; ✓ Dishes &nbsp;·&nbsp; ✓ Floors & surfaces &nbsp;·&nbsp; ✓ Tidying & reset</p>
              </div>
              ${address ? `<p style="margin-bottom:16px;font-size:0.9rem">📍 <strong>${address}</strong></p>` : ''}
              <p style="color:#666;font-size:0.9rem;margin-bottom:24px">Have your supplies ready — detergent, dish soap, and cleaning products. We'll handle everything else.</p>
              ${isReturning ? '<p style="color:#2ab8b8;font-size:0.875rem;margin-bottom:16px">👋 Welcome back! Thanks for being a ChoreOFF regular.</p>' : ''}
              <p style="color:#888;font-size:0.85rem">Questions? Reply to this email.<br>— The ChoreOFF Team</p>
            </div>`
          });
          console.log('[email] Confirmation sent to:', email);
        } catch(e) { console.error('[confirm err]', e.message); }
      }

      return res.status(200).json({ success: true, booking_id: booking?.id });

    } else if (eventType === 'invitee.canceled') {
      const invitee = payload.invitee || {};
      const calendlyInviteeId = (invitee.uri || '').split('/').pop();

      const { data: booking } = await supabase
        .from('bookings')
        .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
        .eq('calendly_invitee_id', calendlyInviteeId)
        .select().single();

      // Notify worker if job was already claimed
      if (booking?.worker_id && process.env.TWILIO_ACCOUNT_SID) {
        try {
          const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          const { data: worker } = await supabase.from('workers').select('phone').eq('id', booking.worker_id).single();
          if (worker?.phone) {
            await tw.messages.create({
              from: process.env.TWILIO_PHONE,
              body: `⚠️ ChoreOFF: A job on your schedule has been cancelled by the customer. Check the portal for new jobs:\nhttps://choreoff.com/worker`,
              to: worker.phone
            });
          }
        } catch(e) { console.error('[cancel SMS err]', e.message); }
      }

      console.log('[calendly] cancelled:', calendlyInviteeId);
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ received: true });
  } catch(e) {
    console.error('[calendly err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
