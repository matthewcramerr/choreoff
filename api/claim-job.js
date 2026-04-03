const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { booking_id, worker_id } = req.body;
  if (!booking_id || !worker_id) return res.status(400).json({ error: 'Missing fields' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Verify worker exists and is APPROVED (Active)
    const { data: worker } = await supabase
      .from('workers').select('*')
      .eq('id', worker_id).single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    if (worker.status !== 'Active') {
      return res.status(403).json({ error: 'Your account is pending approval. Contact info@choreoff.com.' });
    }

    // Check job is available
    const { data: booking } = await supabase
      .from('bookings').select('*').eq('id', booking_id).single();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'Pending') return res.status(409).json({ error: 'Job already claimed' });

    // Atomic claim — only succeeds if still Pending
    const { data: updated, error } = await supabase
      .from('bookings')
      .update({
        worker_id,
        status: 'Assigned',
        worker_claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', booking_id)
      .eq('status', 'Pending')
      .select().single();

    if (error || !updated) {
      return res.status(409).json({ error: 'Job was just claimed by another worker' });
    }

    // Create payout record as Pending
    await supabase.from('payouts').insert({
      booking_id, worker_id, amount: 50.00, status: 'Pending'
    });

    const jobDate = booking.scheduled_at
      ? new Date(booking.scheduled_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'Date TBD';

    // SMS worker with FULL address (only after claim)
    if (process.env.TWILIO_ACCOUNT_SID && worker.phone) {
      try {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilio.messages.create({
          from: process.env.TWILIO_PHONE,
          body: `✅ Job claimed!\n\n📅 ${jobDate}\n📍 ${booking.address || 'See portal'}\n👤 ${booking.name || 'Customer'}\n📞 ${booking.phone || '—'}\n💵 $50 after admin review\n\nPortal: https://choreoff.com/worker`,
          to: worker.phone
        });
      } catch(e) { console.error('[claim SMS err]', e.message); }
    }

    // Email customer
    if (booking.email) {
      try {
        await resend.emails.send({
          from: 'ChoreOFF <info@choreoff.com>',
          to: booking.email,
          subject: 'A ChoreOFF worker has been assigned ✓',
          html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:40px 24px">
            <h2 style="font-size:1.3rem;margin-bottom:8px">Your worker is confirmed, ${(booking.name || 'there').split(' ')[0]}.</h2>
            <p style="color:#666;margin-bottom:20px">A ChoreOFF worker has been assigned for <strong>${jobDate}</strong>.</p>
            <div style="background:#e8f8f8;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #2ab8b8">
              <p style="margin:0;font-size:0.875rem;color:#555;line-height:1.7">✓ Have detergent, dish soap & supplies ready<br>✓ Dishwasher emptied before we arrive<br>✓ Laundry hamper with dirty clothes ready</p>
            </div>
            <p style="color:#888;font-size:0.85rem">— The ChoreOFF Team</p>
          </div>`
        });
      } catch(e) { console.error('[claim email err]', e.message); }
    }

    // Admin notification
    if (process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from: 'ChoreOFF <info@choreoff.com>',
          to: 'info@choreoff.com',
          subject: `✅ Job claimed by ${worker.name}`,
          html: `<div style="font-family:sans-serif;padding:20px"><p><strong>${worker.name}</strong> claimed job for <strong>${booking.name}</strong> on ${jobDate}.</p><p>Address: ${booking.address || '—'}</p></div>`
        });
      } catch(e) {}
    }

    console.log('[claim] Job', booking_id, 'claimed by', worker.name);
    return res.status(200).json({ success: true });

  } catch(e) {
    console.error('[claim err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
