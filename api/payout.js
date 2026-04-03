// api/payout.js
// Manual payout trigger — admin fallback only, used when approve-payout's Stripe transfer failed.
// Normal flow: approve-payout.js handles everything including stats.
// This endpoint ONLY retries the Stripe transfer — it does NOT re-increment worker stats.
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require admin key for manual payout
  const adminKey = req.headers['x-admin-key'] || req.body?.admin_key;
  if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { booking_id, worker_id } = req.body;
  if (!booking_id || !worker_id) return res.status(400).json({ error: 'Missing fields' });

  console.log('[payout] Manual payout requested — booking:', booking_id, '| worker:', worker_id);

  const stripe = Stripe((process.env.STRIPE_SECRET_KEY || '').trim());
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Validate booking: must exist, belong to this worker, and be admin-approved (Completed)
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, status, worker_id')
      .eq('id', booking_id)
      .single();

    if (!booking) {
      console.log('[payout] Booking not found:', booking_id);
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (booking.worker_id !== worker_id) {
      console.warn('[payout] worker_id mismatch — request:', worker_id, '| booking:', booking.worker_id);
      return res.status(403).json({ error: 'Worker does not own this booking' });
    }
    if (booking.status !== 'Completed') {
      console.log('[payout] Booking not in Completed state:', booking.status);
      return res.status(409).json({ error: 'Booking must be admin-approved (Completed) before payout. Status: ' + booking.status });
    }

    // Get worker
    const { data: worker } = await supabase
      .from('workers')
      .select('id, name, email, status, stripe_connect_id')
      .eq('id', worker_id)
      .single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    if (worker.status !== 'Active') return res.status(403).json({ error: 'Worker is not active' });

    // Check if already paid
    const { data: existing } = await supabase
      .from('payouts')
      .select('id, status')
      .eq('booking_id', booking_id)
      .eq('status', 'Paid')
      .single();

    if (existing) {
      console.log('[payout] Already paid — booking:', booking_id);
      return res.status(200).json({ success: true, message: 'Already paid' });
    }

    if (!worker.stripe_connect_id) {
      console.log('[payout] No Stripe Connect account for:', worker.email);
      await supabase.from('payouts').update({
        status: 'Manual_Pending',
        updated_at: new Date().toISOString()
      }).eq('booking_id', booking_id);
      return res.status(200).json({ success: true, status: 'Manual_Pending', message: 'No Stripe Connect account — mark for manual payment' });
    }

    // Retry Stripe transfer only
    try {
      const transfer = await stripe.transfers.create({
        amount: 5000, // $50 in cents
        currency: 'usd',
        destination: worker.stripe_connect_id,
        metadata: { booking_id, worker_id, platform: 'choreoff', source: 'manual_retry' }
      });

      await supabase.from('payouts').update({
        status: 'Paid',
        stripe_transfer_id: transfer.id,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('booking_id', booking_id);

      // NOTE: Worker stats (jobs_completed, total_earned) are NOT updated here.
      // approve-payout.js already incremented them when the job was approved.

      console.log('[payout] Stripe transfer sent:', transfer.id, '→', worker.email);
      return res.status(200).json({ success: true, status: 'Paid', transfer_id: transfer.id });

    } catch (stripeErr) {
      console.error('[payout] Stripe transfer failed:', stripeErr.message);
      await supabase.from('payouts').update({
        status: 'Failed',
        error_message: stripeErr.message,
        updated_at: new Date().toISOString()
      }).eq('booking_id', booking_id);
      return res.status(200).json({ success: false, status: 'Failed', error: stripeErr.message });
    }

  } catch (e) {
    console.error('[payout err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
