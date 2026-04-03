const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const { Resend } = require('resend');
const crypto = require('crypto');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { worker_id, action } = req.body;
  if (!worker_id) return res.status(400).json({ error: 'Missing worker_id' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    const { data: worker } = await supabase
      .from('workers').select('*').eq('id', worker_id).single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    if (action === 'approve') {
      // Generate a secure login token valid for 7 days
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      // Store token in worker_auth_tokens table
      await supabase.from('worker_auth_tokens').insert({
        worker_id: worker.id,
        token,
        expires_at: expiresAt
      });

      // Activate worker
      await supabase.from('workers').update({
        status: 'Active',
        approved_at: new Date().toISOString(),
        auth_token: token,
        auth_token_expires_at: expiresAt,
        updated_at: new Date().toISOString()
      }).eq('id', worker_id);

      const loginLink = `https://choreoff.com/worker?token=${token}`;

      // SMS with magic login link
      if (process.env.TWILIO_ACCOUNT_SID && worker.phone) {
        try {
          const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
          await tw.messages.create({
            from: process.env.TWILIO_PHONE,
            body: `🎉 Welcome to ChoreOFF, ${worker.name.split(' ')[0]}! You're approved.\n\nSign in to start claiming jobs:\n${loginLink}\n\nThis link expires in 7 days. Questions? info@choreoff.com`,
            to: worker.phone
          });
        } catch(e) { console.error('[approve SMS err]', e.message); }
      }

      // Welcome email with login link
      if (process.env.RESEND_API_KEY && worker.email) {
        try {
          await resend.emails.send({
            from: 'ChoreOFF <info@choreoff.com>',
            to: worker.email,
            subject: "You're approved — welcome to ChoreOFF! 🎉",
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:40px 24px">
              <h2 style="font-size:1.4rem;margin-bottom:8px">You're in, ${worker.name.split(' ')[0]}.</h2>
              <p style="color:#666;margin-bottom:24px">Your ChoreOFF worker account is approved. Click below to sign in and start claiming jobs.</p>
              <a href="${loginLink}" style="display:inline-block;background:#2ab8b8;color:white;padding:14px 32px;border-radius:100px;text-decoration:none;font-weight:600;font-size:0.95rem;margin-bottom:24px">Sign In to Worker Portal →</a>
              <p style="color:#888;font-size:0.82rem;margin-bottom:24px">This link is unique to you and expires in 7 days. After that, use your email to request a new link from the portal.</p>
              <div style="background:#f5f5f2;border-radius:12px;padding:16px;margin-bottom:24px">
                <p style="margin:0 0 8px;font-weight:600;font-size:0.875rem">Quick reminders:</p>
                <p style="margin:0;color:#555;font-size:0.85rem;line-height:1.8">• $50 per completed job after admin review<br>• Jobs are first-come, first-served<br>• Full address sent via SMS after you claim<br>• Photo required to submit completion</p>
              </div>
              <p style="color:#888;font-size:0.82rem">Questions? Reply to this email.<br>— The ChoreOFF Team</p>
            </div>`
          });
        } catch(e) { console.error('[approve email err]', e.message); }
      }

      return res.status(200).json({
        success: true,
        message: 'Worker approved, magic login link sent via SMS + email',
        login_link: loginLink
      });

    } else if (action === 'reject') {
      await supabase.from('workers').update({
        status: 'Inactive',
        updated_at: new Date().toISOString()
      }).eq('id', worker_id);

      if (process.env.RESEND_API_KEY && worker.email) {
        try {
          await resend.emails.send({
            from: 'ChoreOFF <info@choreoff.com>',
            to: worker.email,
            subject: 'ChoreOFF worker application update',
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:40px 24px">
              <p>Hi ${worker.name.split(' ')[0]},</p>
              <p style="color:#666">Thank you for applying to ChoreOFF. After reviewing your application, we're unable to move forward at this time.</p>
              <p style="color:#888;font-size:0.85rem">— The ChoreOFF Team</p>
            </div>`
          });
        } catch(e) {}
      }

      return res.status(200).json({ success: true, message: 'Worker rejected' });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch(e) {
    console.error('[approve err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
