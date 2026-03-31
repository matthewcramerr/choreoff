const { createClient } = require(’@supabase/supabase-js’);
const { Resend } = require(‘resend’);

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
if (req.method !== ‘POST’) return res.status(405).json({ error: ‘Method not allowed’ });

const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_SERVICE_KEY
);

const { booking_id, worker_id, photo_url } = req.body;
if (!booking_id || !worker_id) return res.status(400).json({ error: ‘Missing fields’ });

try {
// Verify booking belongs to this worker
const { data: booking } = await supabase
.from(‘bookings’)
.select(’*’)
.eq(‘id’, booking_id)
.eq(‘worker_id’, worker_id)
.single();

```
if (!booking) return res.status(404).json({ error: 'Booking not found' });
if (booking.status === 'Completed') return res.status(200).json({ message: 'Already completed' });

// Mark booking complete
await supabase
  .from('bookings')
  .update({
    status: 'Completed',
    completed_at: new Date().toISOString(),
    photo_url: photo_url || null,
    updated_at: new Date().toISOString()
  })
  .eq('id', booking_id);

console.log('[complete] Job completed: ' + booking_id + ' by worker: ' + worker_id);

// Trigger payout via internal API call
try {
  await fetch(`${process.env.WORKER_PORTAL_URL}/api/payout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_id, worker_id })
  });
  console.log('[complete] Payout triggered for booking: ' + booking_id);
} catch (payoutErr) {
  console.error('[complete] Payout trigger failed:', payoutErr.message);
}

// Send follow-up email to customer
if (process.env.RESEND_API_KEY && booking.email) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'ChoreOFF <info@choreoff.com>',
      to: booking.email,
      subject: 'Your ChoreOFF visit is complete 🏠✨',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">
          <h2 style="font-size:1.4rem;margin-bottom:8px">Your reset is done, ${(booking.name || 'there').split(' ')[0]}.</h2>
          <p style="color:#666;margin-bottom:24px">Your ChoreOFF worker just finished. Come home to clean dishes, done laundry, and a reset space.</p>
          <div style="background:#f5f5f2;border-radius:12px;padding:20px;margin-bottom:24px">
            <p style="margin:0 0 8px;font-weight:600">Completed this visit:</p>
            <p style="margin:0;color:#555;font-size:0.9rem;line-height:1.6">✓ Laundry · ✓ Dishes · ✓ Floors & surfaces · ✓ Tidying & reset</p>
          </div>
          ${booking.booking_type === 'non_member' ? `
          <div style="background:#e8f8f8;border-radius:12px;padding:20px;margin-bottom:24px;border:1px solid #2ab8b8">
            <p style="margin:0 0 8px;font-weight:600;color:#1e9494">Want to save $40 every visit?</p>
            <p style="margin:0 0 12px;color:#555;font-size:0.9rem">ChoreOFF members get every visit for $139 instead of $179.</p>
            <a href="https://choreoff.com/#pricing" style="display:inline-block;background:#2ab8b8;color:white;padding:10px 20px;border-radius:100px;text-decoration:none;font-size:0.875rem;font-weight:600">Become a Member — $29/month</a>
          </div>
          ` : `
          <div style="background:#e8f8f8;border-radius:12px;padding:20px;margin-bottom:24px;border:1px solid #2ab8b8">
            <p style="margin:0 0 8px;font-weight:600;color:#1e9494">Ready for your next visit?</p>
            <a href="https://buy.stripe.com/STRIPE_139" style="display:inline-block;background:#2ab8b8;color:white;padding:10px 20px;border-radius:100px;text-decoration:none;font-size:0.875rem;font-weight:600">Book a Member Visit — $139</a>
          </div>
          `}
          <p style="color:#888;font-size:0.85rem">Questions or feedback? Reply to this email.<br>— The ChoreOFF Team</p>
        </div>
      `
    });
    console.log('[email] Follow-up sent to: ' + booking.email);
  } catch (emailErr) {
    console.error('[email err]', emailErr.message);
  }
}

return res.status(200).json({ success: true });
```

} catch (e) {
console.error(’[complete err]’, e.message);
return res.status(500).json({ error: e.message });
}
};