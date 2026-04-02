const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const twilio = require('twilio');

// This runs daily via a cron job or manual trigger
// Call POST /api/remind to send day-before reminders

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    // Find all bookings scheduled for tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStart = new Date(tomorrow.setHours(0,0,0,0)).toISOString();
    const tomorrowEnd = new Date(tomorrow.setHours(23,59,59,999)).toISOString();

    const { data: bookings } = await supabase
      .from('bookings')
      .select('*, workers(name, phone)')
      .gte('scheduled_at', tomorrowStart)
      .lte('scheduled_at', tomorrowEnd)
      .in('status', ['Pending', 'Assigned']);

    if (!bookings || bookings.length === 0) {
      console.log('[remind] No bookings tomorrow');
      return res.status(200).json({ sent: 0 });
    }

    let sent = 0;

    for (const booking of bookings) {
      const jobTime = new Date(booking.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const jobDate = new Date(booking.scheduled_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

      // SMS worker reminder
      if (booking.worker_id && booking.workers?.phone && process.env.TWILIO_ACCOUNT_SID) {
        try {
          const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await tw.messages.create({
            from: process.env.TWILIO_PHONE,
            body: `⏰ ChoreOFF reminder: You have a job TOMORROW at ${jobTime}.\n📍 ${booking.address || 'Address in portal'}\n👤 ${booking.name || 'Customer'}\n\nhttps://choreoff.com/worker`,
            to: booking.workers.phone
          });
          console.log('[remind] Worker SMS sent:', booking.workers.name);
          sent++;
        } catch(e) { console.error('[remind worker SMS err]', e.message); }
      }

      // Email customer reminder
      if (booking.email && process.env.RESEND_API_KEY) {
        try {
          await resend.emails.send({
            from: 'ChoreOFF <info@choreoff.com>',
            to: booking.email,
            subject: `Reminder: Your ChoreOFF visit is tomorrow at ${jobTime}`,
            html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px">
              <h2 style="font-size:1.3rem;margin-bottom:8px">See you tomorrow, ${(booking.name || 'there').split(' ')[0]}! 👋</h2>
              <p style="color:#666;margin-bottom:24px">Just a reminder that your ChoreOFF visit is scheduled for <strong>tomorrow, ${jobDate} at ${jobTime}</strong>.</p>
              <div style="background:#e8f8f8;border-radius:12px;padding:20px;margin-bottom:24px;border:1px solid #2ab8b8">
                <p style="margin:0 0 8px;font-weight:600;color:#1e9494">Quick checklist before we arrive:</p>
                <p style="margin:0;color:#555;font-size:0.875rem;line-height:1.8">☐ Detergent and dish soap ready<br>☐ Hamper accessible for laundry<br>☐ Any perishables off countertops</p>
              </div>
              <p style="color:#888;font-size:0.85rem">Need to reschedule? Please do so at least 24 hours in advance by replying to this email.<br>— The ChoreOFF Team</p>
            </div>`
          });
          console.log('[remind] Customer email sent:', booking.email);
          sent++;
        } catch(e) { console.error('[remind customer email err]', e.message); }
      }
    }

    console.log('[remind] Total reminders sent:', sent);
    return res.status(200).json({ success: true, bookings: bookings.length, sent });

  } catch(e) {
    console.error('[remind err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
