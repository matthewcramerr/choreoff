const Stripe = require(‘stripe’);
const { createClient } = require(’@supabase/supabase-js’);

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
if (req.method !== ‘POST’) return res.status(405).json({ error: ‘Method not allowed’ });

const stripe = Stripe((process.env.STRIPE_SECRET_KEY || ‘’).trim());
const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_SERVICE_KEY
);

const { email, name } = req.body;
if (!email) return res.status(400).json({ error: ‘Email required’ });

try {
// Create Stripe Connect Express account
const account = await stripe.accounts.create({
type: ‘express’,
email,
capabilities: {
card_payments: { requested: true },
transfers: { requested: true }
},
business_type: ‘individual’,
individual: { full_name_aliases: [name] },
metadata: { platform: ‘choreoff’ }
});

```
// Save connect account ID to Supabase
await supabase
  .from('workers')
  .update({ stripe_connect_id: account.id })
  .eq('email', email.toLowerCase().trim());

// Create onboarding link
const accountLink = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: `${process.env.WORKER_PORTAL_URL}/onboard?connect=refresh`,
  return_url: `${process.env.WORKER_PORTAL_URL}/onboard?connect=success&email=${encodeURIComponent(email)}`,
  type: 'account_onboarding'
});

console.log('[connect] Created account for: ' + email);
return res.status(200).json({ url: accountLink.url });
```

} catch (e) {
console.error(’[connect err]’, e.message);
return res.status(500).json({ error: e.message });
}
};