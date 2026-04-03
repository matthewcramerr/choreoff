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
      // Only cancel if still Pending
      const { data: booking } = await supabase
        .from('bookings')
        .select('status')
        .eq('id', id)
        .single();
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      if (booking.status !== 'Pending') {
        return res.status(409).json({ error: 'Can only cancel Pending jobs. Current status: ' + booking.status });
      }
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'Pending');
      if (error) throw error;
      console.log('[admin-action] Job cancelled:', id);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (e) {
    console.error('[admin-action err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
