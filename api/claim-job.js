const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { booking_id, worker_id } = req.body;

  if (!booking_id || !worker_id) {
    return res.status(400).json({ error: 'Missing booking_id or worker_id' });
  }

  const supabase = getSupabase();
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Check job is still available
    const { data: booking } = await supabase
      .from('bookings')
      .select('*, customers(*)')
      .eq('id', booking_id)
      .single();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'Pending') return res.status(409).json({ error: 'Job already claimed' });

    // Get worker
    const { data: worker } = await supabase
      .from('workers')
      .select('*')
      .eq('id', worker_id)
      .single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // Assign job to worker (atomic update)
    const { data: updated, error } = await supabase
      .from('bookings')
      .update({
        worker_id,
        status: 'Assigned',
        worker_claimed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', booking_id)
      .eq('status', 'Pending') // only if still pending (race condition protection)
      .select()
      .single();

    if (error || !updated) {
      return res.status(409).json({ error: 'Job was just claimed by another worker' });
    }

    // Create payout record
    await supabase.from('payouts').insert({
      booking_id,
      worker_id,
      amount: 50.00,
      status: 'Pending'
    });

    // SMS worker confirmation
    if (process.env.TWILIO_ACCOUNT_SID) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const jobDate = new Date(booking.scheduled_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      await twilio.messages.create({
        body: `✅ Job confirmed!\n📅 ${jobDate}\n📍 ${booking.address}\n💵 $50 upon completion\n\nComplete job: ${process.env.WORKER_PORTAL_URL}/complete/${booking_id}`,
        from: process.env.TWILIO_PHONE,
        to: worker.phone
      });
    }

    // Email customer with worker assignment
    await resend.emails.send({
      from: 'ChoreOFF <info@choreoff.com>',
      to: booking.email,
      subject: 'Your ChoreOFF worker is assigned!',
      html: '<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">' +
        '<h2 style="color:#2ab8b8">Your worker is on the way!</h2>' +
        '<p>Hi ' + booking.name + ', your ChoreOFF home reset has been assigned.</p>' +
        '<p>Your worker <strong>' + worker.name + '</strong> will arrive at your scheduled time.</p>' +
        '<p>If you need to reschedule, please do so at least 24 hours in advance.</p>' +
        '<p>— The ChoreOFF Team</p></div>'
    });

    console.log('[claim] Job ' + booking_id + ' claimed by worker ' + worker.name);
    return res.status(200).json({ success: true, message: 'Job claimed successfully' });

  } catch (e) {
    console.error('[claim err] ' + e.message);
    return res.status(500).json({ error: 'error' });
  }
};
