// api/validate-token.js
// Called by worker.html to validate a magic link token and return the worker session
const { createClient } = require('@supabase/supabase-js');

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length < 10) {
    return res.status(400).json({ valid: false, error: 'Invalid token format' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Look up token in worker_auth_tokens
    const { data: tr, error: trErr } = await supabase
      .from('worker_auth_tokens')
      .select('worker_id, expires_at')
      .eq('token', token)
      .single();

    if (trErr || !tr) {
      console.log('[validate-token] Token not found');
      return res.status(200).json({ valid: false, error: 'Token not found' });
    }

    if (new Date(tr.expires_at) <= new Date()) {
      console.log('[validate-token] Token expired for worker:', tr.worker_id);
      return res.status(200).json({ valid: false, error: 'Token expired' });
    }

    // Fetch worker — must be Active
    const { data: worker, error: wErr } = await supabase
      .from('workers')
      .select('id, name, email, status, jobs_completed, total_earned, market, city, phone')
      .eq('id', tr.worker_id)
      .eq('status', 'Active')
      .single();

    if (wErr || !worker) {
      console.log('[validate-token] Worker not active:', tr.worker_id);
      return res.status(200).json({ valid: false, error: 'Worker account not active' });
    }

    console.log('[validate-token] Valid session for:', worker.email);
    return res.status(200).json({ valid: true, worker });

  } catch (e) {
    console.error('[validate-token err]', e.message);
    return res.status(500).json({ valid: false, error: 'Server error' });
  }
};
