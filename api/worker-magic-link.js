// api/worker-magic-link.js
// Called when a worker requests a new login link from the portal
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const { Resend } = require('resend');
const crypto = require('crypto');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Find active worker by email
    const { data: worker } = await supabase
      .from('workers')
      .select('id, name, email, phone, status')
      .eq('email', email.toLowerCase().trim())
      .single();

    // Always return 200 — don't reveal whether email exists
    if (!worker || worker.status !== 'Active') {
      console.log('[magic-link] No active worker for:', email);
      return res.status(200).json({ success: true, message: 'If approved, a login link was sent.' });
    }

    // Generate token — 24 hour expiry for self-requested links
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await supabase.from('worker_auth_tokens').insert({
      worker_id: worker.id, token, expires_at: expiresAt
    });

    // Update worker's current token
    await supabase.from('workers').update({
      auth_token: token,
      auth_token_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }).eq('id', worker.id);

    const loginLink = `https://choreoff.com/worker?token=${token}`;

    // Send via SMS if phone exists
    if (worker.phone && process.env.TWILIO_ACCOUNT_SID) {
      try {
        const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await tw.messages.create({
          from: process.env.TWILIO_PHONE,
          body: `ChoreOFF: Here's your login link (expires in 24 hours):\n${loginLink}`,
          to: worker.phone
        });
      } catch(e) { console.error('[magic-link SMS err]', e.message); }
    }

    // Send via email
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      try {
        await resend.emails.send({
          from: 'ChoreOFF <info@choreoff.com>',
          to: worker.email,
          subject: 'Your ChoreOFF worker portal login link',
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
            <h2 style="font-size:1.3rem;margin-bottom:8px">Here's your login link, ${worker.name.split(' ')[0]}.</h2>
            <p style="color:#666;margin-bottom:24px">Click below to sign in to the ChoreOFF worker portal. This link expires in 24 hours.</p>
            <a href="${loginLink}" style="display:inline-block;background:#2ab8b8;color:white;padding:14px 32px;border-radius:100px;text-decoration:none;font-weight:600;margin-bottom:20px">Sign In to Worker Portal →</a>
            <p style="color:#aaa;font-size:0.8rem">If you didn't request this, ignore this email.</p>
          </div>`
        });
      } catch(e) { console.error('[magic-link email err]', e.message); }
    }

    console.log('[magic-link] Sent to:', worker.email);
    return res.status(200).json({ success: true, message: 'Login link sent via SMS and email.' });

  } catch(e) {
    console.error('[magic-link err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
