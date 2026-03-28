const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { booking_id, worker_id, photo_url } = req.body;
  if (!booking_id || !worker_id) return res.status(400).json({ error: 'Missing fields' });

  const supabase = getSupabase();
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Mark job complete
    await supabase.from('bookings').update({
      status: 'Completed',
      photo_url,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', booking_id).eq('worker_id', worker_id);

    // Mark payout as paid
    await supabase.from('payouts').update({
      status: 'Paid',
      paid_at: new Date().toISOString()
    }).eq('booking_id', booking_id);

    // Update worker stats
    await supabase.rpc('increment_worker_stats', { worker_id_input: worker_id });

    // Get booking details
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .single();

    // Send follow-up email to customer
    if (booking) {
      await resend.emails.send({
        from: 'ChoreOFF <info@choreoff.com>',
        to: booking.email,
        subject: 'How was your ChoreOFF visit? 🏠',
        html: '<div style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">' +
          '<h2 style="color:#2ab8b8">Hope everything looks great, ' + booking.name + '!</h2>' +
          '<p>Your ChoreOFF home reset is complete. We\'d love to hear how it went.</p>' +
          '<p>Quick questions:</p>' +
          '<ul>' +
          '<li>What did you like most about the service?</li>' +
          '<li>Is there anything we could improve?</li>' +
          '<li>Was the pricing fair for what you received?</li>' +
          '<li>Is there one thing you wish we could add to our service?</li>' +
          '</ul>' +
          '<p>Just reply to this email — we read every response.</p>' +
          (booking.booking_type === 'non_member' ?
            '<p style="background:#f0fafa;padding:16px;border-radius:8px;border-left:4px solid #2ab8b8"><strong>Loved it?</strong> Save $20 every visit as a member for just $19/month. <a href="https://choreoff.com" style="color:#2ab8b8">Join here →</a></p>' : '') +
          '<p>Thank you for choosing ChoreOFF!</p>' +
          '<p>— The ChoreOFF Team</p></div>'
      });

      // Mark follow-up sent
      await supabase.from('bookings')
        .update({ follow_up_sent: true })
        .eq('id', booking_id);
    }

    console.log('[complete] Job ' + booking_id + ' completed');
    return res.status(200).json({ success: true });

  } catch (e) {
    console.error('[complete err] ' + e.message);
    return res.status(500).json({ error: 'error' });
  }
};
