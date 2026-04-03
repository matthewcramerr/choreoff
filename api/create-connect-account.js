// api/create-connect-account.js
// Creates a Stripe Connect Express account for worker payouts.
// Requires a valid worker auth token — workers must be logged in to initiate onboarding.
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = Stripe((process.env.STRIPE_SECRET_KEY || '').trim());
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { email, name, worker_id, auth_token } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!worker_id || !auth_token) return res.status(401).json({ error: 'Authentication required' });

  try {
    // Validate auth token belongs to this worker and is not expired
    const { data: tokenRow } = await supabase
      .from('worker_auth_tokens')
      .select('worker_id, expires_at')
      .eq('token', auth_token)
      .eq('worker_id', worker_id)
      .single();

    if (!tokenRow || new Date(tokenRow.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    // Confirm worker is Active and the email matches
    const { data: worker } = await supabase
      .from('workers')
      .select('id, name, email, status, stripe_connect_id')
      .eq('id', worker_id)
      .single();

    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    if (worker.status !== 'Active') return res.status(403).json({ error: 'Worker account is not active' });
    if (worker.email.toLowerCase().trim() !== email.toLowerCase().trim()) {
      console.warn('[connect] Email mismatch — token worker:', worker.email, '| request:', email);
      return res.status(403).json({ error: 'Email does not match authenticated worker' });
    }

    // If worker already has a Connect account, just return a new onboarding link (re-onboarding)
    const accountId = worker.stripe_connect_id || null;

    let finalAccountId = accountId;

    if (!finalAccountId) {
      // Create new Stripe Connect Express account
      const account = await stripe.accounts.create({
        type: 'express',
        email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        business_type: 'individual',
        individual: { full_name_aliases: name ? [name] : [] },
        metadata: { platform: 'choreoff', worker_id }
      });

      finalAccountId = account.id;

      // Save connect account ID to worker record
      await supabase
        .from('workers')
        .update({ stripe_connect_id: finalAccountId, updated_at: new Date().toISOString() })
        .eq('id', worker_id);

      console.log('[connect] Created account for:', email, '→', finalAccountId);
    } else {
      console.log('[connect] Re-onboarding existing account for:', email, '→', finalAccountId);
    }

    // Create onboarding link
    const portalBase = process.env.WORKER_PORTAL_URL || 'https://choreoff.com';
    const accountLink = await stripe.accountLinks.create({
      account: finalAccountId,
      refresh_url: `${portalBase}/onboard?connect=refresh`,
      return_url: `${portalBase}/onboard?connect=success&email=${encodeURIComponent(email)}`,
      type: 'account_onboarding'
    });

    return res.status(200).json({ url: accountLink.url });

  } catch (e) {
    console.error('[connect err]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
