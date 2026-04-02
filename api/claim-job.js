const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const twilio = require('twilio');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { booking_id, worker_id } = req.body;
  if (!booking_id || !worker_id) return res.status(400).json({ error: 'Missing fields' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Check job is still available
    const { data: booking } = await supabase.from('bookings').select('*').eq('id', booking_id).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'Pending') return res.status(409).json({ error: 'Job already claimed' });

    const { data: worker } = await supabase.from('workers').select('*').eq('id', worker_id).single();
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // Atomic claim — only succeeds if still Pending
    const { data: updated, error } = await supabase
      .from('bookings')
      .update({ worker_id, status: 'Assigned', worker_claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', booking_id)
      .eq('status', 'Pending')
      .select().single();

    if (error || !updated) return res.status(409).json({ error: 'Job already claimed' });

    // Create payout record
    await supabase.from('payouts').insert({ booking_id, worker_id, amount: 50.00, status: 'Pending' });

    const jobDate = booking.scheduled_at
      ? new Date(booking.scheduled_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'your scheduled time';

    // SMS worker with FULL address (only after claiming)
    if (process.env.TWILIO_ACCOUNT_SID && worker.phone) {
      try {
        const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await tw.messages.create({
          from: process.env.TWILIO_PHONE,
          body: `✅ Job claimed!\n\n📅 ${jobDate}\n📍 ${booking.address || 'See portal for address'}\n👤 ${booking.name || 'Customer'}\n📞 ${booking.phone || '—'}\n💵 $50 upon completion\n\nPortal: https://choreoff.com/worker`,
          to: worker.phone
        });
        console.log('[claim SMS] Full details sent to worker:', worker.name);
      } catch(e) { console.error('[claim SMS err]', e.message); }
    }

    // Email customer — worker assigned notification
    if (process.env.RESEND_API_KEY && booking.email) {
      try {
        await resend.emails.send({
          from: 'ChoreOFF <info@choreoff.com>',
          to: booking.email,
          subject: 'A ChoreOFF worker has been assigned to your visit ✓',
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px">
            <h2 style="font-size:1.4rem;margin-bottom:8px">Your worker is confirmed, ${(booking.name || 'there').split(' ')[0]}.</h2>
            <p style="color:#666;margin-bottom:24px">A ChoreOFF worker has been assigned to your visit on <strong>${jobDate}</strong>.</p>
            <div style="background:#e8f8f8;border-radius:12px;padding:20px;margin-bottom:24px;border:1px solid #2ab8b8">
              <p style="margin:0 0 4px;font-weight:600;color:#1e9494">Before they arrive:</p>
              <p style="margin:0;color:#555;font-size:0.875rem;line-height:1.7">✓ Have detergent, dish soap & cleaning products ready<br>✓ Make sure the entryway is accessible<br>✓ Any specific requests? Reply to this email</p>
            </div>
            ${booking.address ? `<p style="margin-bottom:20px;font-size:0.9rem">📍 <strong>${booking.address}</strong></p>` : ''}
            <p style="color:#888;font-size:0.85rem">Need to reschedule? Do so at least 24 hours in advance.<br>Questions? Reply to this email.<br>— The ChoreOFF Team</p>
          </div>`
        });
        console.log('[claim email] Worker assigned sent to:', booking.email);
      } catch(e) { console.error('[claim email err]', e.message); }
    }

    // Admin notification
    if (process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from: 'ChoreOFF <info@choreoff.com>',
          to: 'info@choreoff.com',
          subject: `✅ Job claimed by ${worker.name}`,
          html: `<div style="font-family:sans-serif;padding:24px;max-width:480px"><p><strong>${worker.name}</strong> claimed the job for <strong>${booking.name}</strong> on ${jobDate}.</p><p>Address: ${booking.address || '—'}</p><a href="https://choreoff.com/admin" style="color:#2ab8b8">View in Admin →</a></div>`
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
