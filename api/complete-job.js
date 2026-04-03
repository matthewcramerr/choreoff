const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { booking_id, worker_id, photo_url } = req.body;
  if (!booking_id || !worker_id) return res.status(400).json({ error: 'Missing fields' });
  if (!photo_url) return res.status(400).json({ error: 'Photo required to complete job' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // 1. Verify worker exists and is Active
    const { data: worker } = await supabase
      .from('workers').select('id, name, status, email, phone')
      .eq('id', worker_id).single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    if (worker.status !== 'Active') return res.status(403).json({ error: 'Worker not approved' });

    // 2. Verify booking exists, is Assigned, and belongs to THIS worker
    const { data: booking } = await supabase
      .from('bookings').select('*')
      .eq('id', booking_id)
      .eq('worker_id', worker_id)
      .single();

    if (!booking) return res.status(404).json({ error: 'Booking not found or not yours' });
    if (booking.status === 'Completed_Pending_Review') {
      return res.status(200).json({ success: true, message: 'Already submitted — pending review' });
    }
    if (booking.status !== 'Assigned') {
      return res.status(409).json({ error: 'Job is not in a completable state: ' + booking.status });
    }

    // 3. Mark as Completed_Pending_Review — NOT paid yet
    const { error: updateErr } = await supabase
      .from('bookings')
      .update({
        status: 'Completed_Pending_Review',
        photo_url,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', booking_id)
      .eq('worker_id', worker_id)
      .eq('status', 'Assigned'); // atomic — only succeeds if still Assigned

    if (updateErr) {
      console.error('[complete] Update error:', updateErr.message);
      return res.status(500).json({ error: 'Failed to update job status' });
    }

    // 4. Ensure payout record exists as Pending (not Paid)
    const { data: existingPayout } = await supabase
      .from('payouts').select('id, status').eq('booking_id', booking_id).single();

    if (!existingPayout) {
      await supabase.from('payouts').insert({
        booking_id, worker_id, amount: 50.00, status: 'Pending'
      });
    }

    // 5. Notify admin
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      try {
        await resend.emails.send({
          from: 'ChoreOFF <info@choreoff.com>',
          to: 'info@choreoff.com',
          subject: `📸 Job ready for review — ${worker.name}`,
          html: `<div style="font-family:sans-serif;padding:24px;max-width:520px">
            <h2 style="color:#2ab8b8;margin-bottom:16px">Job Completed — Pending Review</h2>
            <p><strong>Worker:</strong> ${worker.name}</p>
            <p><strong>Job ID:</strong> ${booking_id}</p>
            <p><strong>Customer:</strong> ${booking.name || '—'}</p>
            <p><strong>Address:</strong> ${booking.address || '—'}</p>
            <p><strong>Completed:</strong> ${new Date().toLocaleString()}</p>
            ${photo_url ? `<p><strong>Photo:</strong> <a href="${photo_url}">${photo_url}</a></p>` : ''}
            <br>
            <a href="https://choreoff.com/admin" style="background:#2ab8b8;color:white;padding:12px 24px;border-radius:100px;text-decoration:none;font-weight:600">Review in Admin →</a>
          </div>`
        });
      } catch(e) { console.error('[complete notify err]', e.message); }
    }

    console.log('[complete] Job', booking_id, 'submitted for review by', worker.name);
    return res.status(200).json({
      success: true,
      message: 'Job submitted. Awaiting admin review before payout.'
    });

  } catch(e) {
    console.error('[complete err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
