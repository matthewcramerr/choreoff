// api/payout.js
// Manual payout trigger — only used if approve-payout's Stripe transfer failed
// Normal flow: approve-payout handles everything. This is an admin fallback.
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

  const stripe = Stripe((process.env.STRIPE_SECRET_KEY || '').trim());
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { booking_id, worker_id } = req.body;
  if (!booking_id || !worker_id) return res.status(400).json({ error: 'Missing fields' });

  try {
    // Get worker
    const { data: worker } = await supabase
      .from('workers')
      .select('*')
      .eq('id', worker_id)
      .single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // Check if already paid
    const { data: existing } = await supabase
      .from('payouts')
      .select('id')
      .eq('booking_id', booking_id)
      .eq('status', 'Paid')
      .single();

    if (existing) return res.status(200).json({ message: 'Already paid' });

    let transferId = null;
    let payoutStatus = 'Manual_Pending';

    // If worker has Stripe Connect — do automatic transfer
    if (worker.stripe_connect_id) {
      try {
        const transfer = await stripe.transfers.create({
          amount: 5000, // $50 in cents
          currency: 'usd',
          destination: worker.stripe_connect_id,
          metadata: { booking_id, worker_id, platform: 'choreoff' }
        });
        transferId = transfer.id;
        payoutStatus = 'Paid';
        console.log('[payout] Stripe transfer sent:', transfer.id, '→', worker.email);
      } catch (stripeErr) {
        console.error('[payout] Stripe transfer failed:', stripeErr.message);
        payoutStatus = 'Failed';
      }
    } else {
      console.log('[payout] No Connect account — manual payout needed for:', worker.email);
    }

    // Update payout record
    await supabase.from('payouts').update({
      status: payoutStatus,
      stripe_transfer_id: transferId,
      paid_at: payoutStatus === 'Paid' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }).eq('booking_id', booking_id);

    // Update worker total earned if paid
    if (payoutStatus === 'Paid') {
      await supabase
        .from('workers')
        .update({
          jobs_completed: (worker.jobs_completed || 0) + 1,
          total_earned: (parseFloat(worker.total_earned) || 0) + 50,
          updated_at: new Date().toISOString()
        })
        .eq('id', worker_id);
    }

    return res.status(200).json({ success: true, status: payoutStatus, transfer_id: transferId });

  } catch (e) {
    console.error('[payout err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
