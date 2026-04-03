const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const Stripe = require('stripe');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require admin key
  const adminKey = req.headers['x-admin-key'] || req.body?.admin_key;
  if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { booking_id, action, admin_note } = req.body;
  // action: 'approve' or 'reject'
  if (!booking_id || !action) return res.status(400).json({ error: 'Missing booking_id or action' });

  console.log('[approve-payout] action:', action, '| booking:', booking_id);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Get booking
    const { data: booking } = await supabase
      .from('bookings').select('*')
      .eq('id', booking_id).single();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'Completed_Pending_Review') {
      return res.status(409).json({ error: 'Job is not pending review. Status: ' + booking.status });
    }

    // Get worker
    const { data: worker } = await supabase
      .from('workers').select('*')
      .eq('id', booking.worker_id).single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // ── REJECT ───────────────────────────────────────────
    if (action === 'reject') {
      await supabase.from('bookings').update({
        status: 'Assigned', // send back to assigned so worker can resubmit
        photo_url: null,
        completed_at: null,
        admin_note: admin_note || 'Rejected by admin',
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      await supabase.from('payouts').update({
        status: 'Rejected',
        admin_note: admin_note || 'Rejected by admin',
        updated_at: new Date().toISOString()
      }).eq('booking_id', booking_id);

      // Notify worker via SMS
      if (process.env.TWILIO_ACCOUNT_SID && worker.phone) {
        try {
          const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilio.messages.create({
            from: process.env.TWILIO_PHONE,
            body: `ChoreOFF: Your completion photo for job on ${booking.scheduled_at ? new Date(booking.scheduled_at).toLocaleDateString() : 'recent job'} was not approved.${admin_note ? ' Note: ' + admin_note : ''} Please resubmit via the worker portal: https://choreoff.com/worker`,
            to: worker.phone
          });
        } catch(e) { console.error('[reject SMS err]', e.message); }
      }

      console.log('[approve-payout] Job', booking_id, 'rejected');
      return res.status(200).json({ success: true, action: 'rejected' });
    }

    // ── APPROVE ──────────────────────────────────────────
    if (action === 'approve') {
      // Prevent double payout — check for existing Paid payout record first
      const { data: existingPayout } = await supabase
        .from('payouts').select('id, status')
        .eq('booking_id', booking_id)
        .eq('status', 'Paid').single();

      if (existingPayout) {
        console.log('[approve-payout] Already paid — booking:', booking_id);
        return res.status(200).json({ success: true, message: 'Already paid' });
      }

      // Atomically mark booking as Completed — only if still Completed_Pending_Review.
      // This prevents double-processing if the endpoint is called concurrently.
      const { data: updatedBooking, error: bookingUpdateErr } = await supabase
        .from('bookings')
        .update({
          status: 'Completed',
          admin_approved_at: new Date().toISOString(),
          admin_note: admin_note || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', booking_id)
        .eq('status', 'Completed_Pending_Review') // atomic guard
        .select().single();

      if (bookingUpdateErr || !updatedBooking) {
        console.warn('[approve-payout] Atomic update failed — already processed? booking:', booking_id);
        return res.status(409).json({ error: 'Job was already processed or is no longer pending review' });
      }

      // Update worker stats now that approval is confirmed
      await supabase.from('workers').update({
        jobs_completed: (worker.jobs_completed || 0) + 1,
        total_earned: (parseFloat(worker.total_earned) || 0) + 50,
        updated_at: new Date().toISOString()
      }).eq('id', worker.id);

      // Attempt Stripe Connect payout
      let transferId = null;
      let payoutStatus = 'Manual_Pending';
      let payoutError = null;

      if (worker.stripe_connect_id && process.env.STRIPE_SECRET_KEY) {
        try {
          const stripe = Stripe((process.env.STRIPE_SECRET_KEY || '').trim());
          const transfer = await stripe.transfers.create({
            amount: 5000, // $50.00
            currency: 'usd',
            destination: worker.stripe_connect_id,
            metadata: { booking_id, worker_id: worker.id, platform: 'choreoff' }
          });
          transferId = transfer.id;
          payoutStatus = 'Paid';
          console.log('[approve-payout] Stripe transfer sent:', transfer.id, '→', worker.email);
        } catch(stripeErr) {
          payoutError = stripeErr.message;
          payoutStatus = 'Failed';
          console.error('[approve-payout] Stripe failed:', stripeErr.message);
        }
      } else {
        console.log('[approve-payout] No Connect account — manual payout needed for:', worker.email);
      }

      // Record payout
      await supabase.from('payouts').update({
        status: payoutStatus,
        stripe_transfer_id: transferId,
        paid_at: payoutStatus === 'Paid' ? new Date().toISOString() : null,
        error_message: payoutError,
        admin_note: admin_note || null,
        updated_at: new Date().toISOString()
      }).eq('booking_id', booking_id);

      // Send follow-up email to customer
      if (booking.email) {
        try {
          const firstName = (booking.name || 'there').split(' ')[0];
          await resend.emails.send({
            from: 'ChoreOFF <info@choreoff.com>',
            to: booking.email,
            subject: 'Your ChoreOFF reset is complete ✓',
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:40px 24px">
              <h2 style="font-size:1.3rem;margin-bottom:8px">Done, ${firstName}.</h2>
              <p style="color:#666;margin-bottom:20px">Your ChoreOFF home reset is complete.</p>
              <div style="background:#f5f5f2;border-radius:12px;padding:20px;margin-bottom:20px">
                <p style="margin:0;font-size:0.9rem;color:#555;line-height:1.8">✓ Laundry &nbsp;·&nbsp; ✓ Dishes &nbsp;·&nbsp; ✓ Floors &nbsp;·&nbsp; ✓ Tidied & reset</p>
              </div>
              ${booking.booking_type === 'non_member' && process.env.STRIPE_MEMBER_LINK ? `<div style="background:#e8f8f8;border-radius:12px;padding:16px;margin-bottom:20px">
                <p style="margin:0 0 8px;font-weight:600;color:#1e9494">Save $40 every visit as a member</p>
                <a href="${process.env.STRIPE_MEMBER_LINK}" style="color:#2ab8b8;font-size:0.875rem">Join for $29/month →</a>
              </div>` : ''}
              <p style="color:#888;font-size:0.85rem">Questions? Reply to this email.<br>— The ChoreOFF Team</p>
            </div>`
          });
        } catch(e) { console.error('[customer email err]', e.message); }
      }

      // SMS worker confirmation
      if (payoutStatus === 'Paid' && worker.phone && process.env.TWILIO_ACCOUNT_SID) {
        try {
          const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilio.messages.create({
            from: process.env.TWILIO_PHONE,
            body: `✅ ChoreOFF: Job approved! $50 is on its way to your bank account. Check the portal for new jobs: https://choreoff.com/worker`,
            to: worker.phone
          });
        } catch(e) { console.error('[payout SMS err]', e.message); }
      } else if (payoutStatus === 'Manual_Pending' && worker.phone && process.env.TWILIO_ACCOUNT_SID) {
        try {
          const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await twilio.messages.create({
            from: process.env.TWILIO_PHONE,
            body: `✅ ChoreOFF: Job approved! Your $50 will be sent manually within 24 hours. Check the portal for new jobs: https://choreoff.com/worker`,
            to: worker.phone
          });
        } catch(e) {}
      }

      return res.status(200).json({
        success: true,
        action: 'approved',
        payout_status: payoutStatus,
        transfer_id: transferId,
        error: payoutError
      });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch(e) {
    console.error('[approve-payout err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
