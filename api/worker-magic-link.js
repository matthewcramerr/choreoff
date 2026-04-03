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
  console.log('[magic-link] REQUEST RECEIVED — method:', req.method, '| email:', email || '(none)');

  if (!email) {
    const resp = { error: 'Email required' };
    console.log('[magic-link] RESPONSE 400:', JSON.stringify(resp));
    return res.status(400).json(resp);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Find active worker by email
    const normalizedEmail = email.toLowerCase().trim();
    console.log('[magic-link] Looking up worker for normalized email:', normalizedEmail);
    const { data: worker, error: workerErr } = await supabase
      .from('workers')
      .select('id, name, email, phone, status')
      .eq('email', normalizedEmail)
      .single();

    if (workerErr) console.log('[magic-link] DB lookup error:', workerErr.message, '| code:', workerErr.code);
    if (worker) console.log('[magic-link] Worker found — id:', worker.id, '| status:', worker.status, '| has phone:', !!worker.phone);
    else console.log('[magic-link] No worker record found for:', normalizedEmail);

    // Always return 200 — don't reveal whether email exists
    if (!worker || worker.status !== 'Active') {
      console.log('[magic-link] Worker not found or not Active — returning generic success');
      const resp = { success: true, message: 'If approved, a login link was sent.' };
      console.log('[magic-link] RESPONSE 200:', JSON.stringify(resp));
      return res.status(200).json(resp);
    }

    // Generate token — 24 hour expiry for self-requested links
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    console.log('[magic-link] TOKEN CREATED — expires:', expiresAt, '| token prefix:', token.slice(0, 8) + '...');

    const { error: insertErr } = await supabase.from('worker_auth_tokens').insert({
      worker_id: worker.id, token, expires_at: expiresAt
    });
    if (insertErr) console.error('[magic-link] worker_auth_tokens insert error:', insertErr.message);
    else console.log('[magic-link] Token inserted into worker_auth_tokens');

    // Update worker's current token
    const { error: updateErr } = await supabase.from('workers').update({
      auth_token: token,
      auth_token_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }).eq('id', worker.id);
    if (updateErr) console.error('[magic-link] workers.auth_token update error:', updateErr.message);
    else console.log('[magic-link] workers table auth_token updated');

    const loginLink = `https://choreoff.com/worker?token=${token}`;

    // Send via SMS if phone exists
    if (worker.phone && process.env.TWILIO_ACCOUNT_SID) {
      console.log('[magic-link] SMS ATTEMPT — to:', worker.phone);
      try {
        const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const msg = await tw.messages.create({
          from: process.env.TWILIO_PHONE,
          body: `ChoreOFF: Here's your login link (expires in 24 hours):\n${loginLink}`,
          to: worker.phone
        });
        console.log('[magic-link] SMS SUCCESS — sid:', msg.sid, '| status:', msg.status);
      } catch(e) {
        console.error('[magic-link] SMS FAILED —', e.message, '| code:', e.code);
      }
    } else {
      console.log('[magic-link] SMS SKIPPED — has phone:', !!worker.phone, '| TWILIO_ACCOUNT_SID set:', !!process.env.TWILIO_ACCOUNT_SID);
    }

    // Send via email
    if (process.env.RESEND_API_KEY) {
      console.log('[magic-link] EMAIL ATTEMPT — to:', worker.email, '| RESEND_API_KEY set: true');
      const resend = new Resend(process.env.RESEND_API_KEY);
      try {
        const emailResult = await resend.emails.send({
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
        console.log('[magic-link] EMAIL SUCCESS — id:', emailResult?.data?.id, '| full result:', JSON.stringify(emailResult));
      } catch(e) {
        console.error('[magic-link] EMAIL FAILED —', e.message, '| status:', e.statusCode, '| full error:', JSON.stringify(e));
      }
    } else {
      console.log('[magic-link] EMAIL SKIPPED — RESEND_API_KEY not set');
    }

    const resp = { success: true, message: 'Login link sent via SMS and email.' };
    console.log('[magic-link] RESPONSE 200:', JSON.stringify(resp));
    return res.status(200).json(resp);

  } catch(e) {
    console.error('[magic-link] UNHANDLED ERROR —', e.message, '\n', e.stack);
    const resp = { error: e.message };
    console.log('[magic-link] RESPONSE 500:', JSON.stringify(resp));
    return res.status(500).json(resp);
  }
};
