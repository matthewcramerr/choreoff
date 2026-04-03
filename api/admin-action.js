// api/admin-action.js
// Backend-validated admin mutations — pause worker, cancel job, validate auth
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Validate admin key from header
  const adminKey = req.headers['x-admin-key'] || req.body?.admin_key;
  if (!adminKey || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, id } = req.body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // Validate-only ping — used by admin.html checkAuth()
  if (action === 'validate') {
    return res.status(200).json({ success: true });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    if (action === 'pause-worker') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { error } = await supabase
        .from('workers')
        .update({ status: 'Inactive', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      console.log('[admin-action] Worker paused:', id);
      return res.status(200).json({ success: true });
    }

    if (action === 'cancel-job') {
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const { data: booking } = await supabase
        .from('bookings')
        .select('id, status, worker_id, scheduled_at, name')
        .eq('id', id)
        .single();

      if (!booking) return res.status(404).json({ error: 'Booking not found' });

      // Only Pending or Assigned jobs can be cancelled.
      // Completed_Pending_Review and Completed are protected — must be handled via approve-payout reject.
      const cancellable = ['Pending', 'Assigned'];
      if (!cancellable.includes(booking.status)) {
        return res.status(409).json({
          error: `Can only cancel Pending or Assigned jobs. Current status: ${booking.status}`
        });
      }

      // Atomically cancel
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', cancellable);
      if (error) throw error;

      // If Assigned, notify the worker
      if (booking.status === 'Assigned' && booking.worker_id && process.env.TWILIO_ACCOUNT_SID) {
        try {
          const { data: worker } = await supabase
            .from('workers')
            .select('phone, name')
            .eq('id', booking.worker_id)
            .single();

          if (worker?.phone) {
            const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const jobDate = booking.scheduled_at
              ? new Date(booking.scheduled_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
              : 'your scheduled job';
            await twilio.messages.create({
              from: process.env.TWILIO_PHONE,
              body: `⚠️ ChoreOFF: Your job for ${jobDate} has been cancelled by admin. Check the portal for available jobs: https://choreoff.com/worker`,
              to: worker.phone
            });
            console.log('[admin-action] Worker notified of cancellation:', worker.name);
          }
        } catch(e) { console.error('[admin-action cancel SMS err]', e.message); }
      }

      console.log('[admin-action] Job cancelled:', id, '| was:', booking.status);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('[admin-action err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
