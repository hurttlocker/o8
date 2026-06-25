#!/usr/bin/env node
/*
 * go-live-stripe.mjs — idempotently configure a Stripe account for the o8
 * Founder's Edition, then print the Railway env vars to set. Safe to re-run.
 *
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/go-live-stripe.mjs
 *   # or once the live key is on Railway:
 *   railway run node scripts/go-live-stripe.mjs
 *   # preview without creating anything:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/go-live-stripe.mjs --dry-run
 *
 * Ensures (create-if-missing):
 *   • Product "o8 Founding Operator"  (metadata.o8_product=founder)
 *   • One-time prices  T1 $150 / T2 $250 / T3 $500  on that product
 *   • Coupon misterexc7-founder-50 ($100 off, once) + promo code MISTEREXC7 (cap 100)
 *   • Webhook endpoint -> <LICENSE_SERVER_URL>/webhooks/stripe  (the 4 handled events)
 * Then prints STRIPE_PRICE_FOUNDER_T1/T2/T3 (+ STRIPE_WEBHOOK_SECRET if newly created).
 *
 * The webhook secret is returned by Stripe ONLY on create. If the endpoint
 * already exists, roll its secret in the Stripe dashboard and update Railway.
 */

const key = process.env.STRIPE_SECRET_KEY || '';
const mode = key.startsWith('sk_live') ? 'LIVE' : key.startsWith('sk_test') ? 'TEST' : 'UNKNOWN';
const SERVER_URL = (process.env.LICENSE_SERVER_URL || 'https://o8-license-server-production.up.railway.app').replace(/\/$/, '');
const DRY = process.argv.includes('--dry-run');

if (mode === 'UNKNOWN') {
  console.error('✗ STRIPE_SECRET_KEY missing or not an sk_ key');
  process.exit(1);
}
console.log(`MODE: ${mode}${DRY ? ' (dry-run)' : ''}   webhook target: ${SERVER_URL}/webhooks/stripe`);
if (mode === 'TEST') console.log('⚠ Running against TEST. Re-run with the LIVE key to actually go live.\n');

async function sx(path, method = 'GET', body) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? (body instanceof URLSearchParams ? body : new URLSearchParams(body)) : undefined,
  });
  const j = await r.json();
  if (j.error) throw new Error(`${path}: ${j.error.message}`);
  return j;
}

const out = {};

// 1) Founder product (looked up by stable metadata so re-runs don't duplicate).
const prods = await sx('products?limit=100&active=true');
let product = (prods.data || []).find((p) => p.metadata?.o8_product === 'founder');
if (!product) {
  if (DRY) console.log('would CREATE product "o8 Founding Operator"');
  else {
    product = await sx('products', 'POST', { name: 'o8 Founding Operator', 'metadata[o8_product]': 'founder' });
    console.log('created product', product.id);
  }
} else console.log('product ✓', product.id);

// 2) Tiered one-time prices on that product.
const TIERS = [['T1', 15000], ['T2', 25000], ['T3', 50000]];
const prices = product ? await sx(`prices?product=${product.id}&limit=100`) : { data: [] };
for (const [tier, amount] of TIERS) {
  let price = (prices.data || []).find((p) => p.active && !p.recurring && p.unit_amount === amount && p.currency === 'usd');
  if (price) {
    console.log(`${tier} ✓ $${amount / 100}`, price.id);
    out['STRIPE_PRICE_FOUNDER_' + tier] = price.id;
  } else if (DRY) {
    console.log(`would CREATE ${tier} $${amount / 100}`);
    out['STRIPE_PRICE_FOUNDER_' + tier] = '(new)';
  } else {
    price = await sx('prices', 'POST', { product: product.id, unit_amount: String(amount), currency: 'usd', 'metadata[founder_tier]': tier });
    console.log(`created ${tier} $${amount / 100}`, price.id);
    out['STRIPE_PRICE_FOUNDER_' + tier] = price.id;
  }
}

// 3) MISTEREXC7: $100-off coupon + promotion code (so the $150 T1 seat nets $50).
let coupon = null;
try {
  coupon = await sx('coupons/misterexc7-founder-50');
  console.log('coupon ✓', coupon.id, `$${coupon.amount_off / 100} off`);
} catch {
  if (DRY) console.log('would CREATE coupon misterexc7-founder-50 ($100 off, once)');
  else {
    coupon = await sx('coupons', 'POST', { id: 'misterexc7-founder-50', amount_off: '10000', currency: 'usd', duration: 'once', name: 'MISTEREXC7 — Founder $50' });
    console.log('created coupon', coupon.id);
  }
}
const existingPromo = await sx('promotion_codes?code=MISTEREXC7&limit=1');
if (existingPromo.data?.length) {
  console.log('promo ✓ MISTEREXC7', existingPromo.data[0].id, 'active=' + existingPromo.data[0].active);
} else if (DRY) {
  console.log('would CREATE promo code MISTEREXC7 (max_redemptions=100)');
} else if (coupon) {
  const promo = await sx('promotion_codes', 'POST', { coupon: coupon.id, code: 'MISTEREXC7', max_redemptions: '100' });
  console.log('created promo', promo.id, 'MISTEREXC7');
}

// 4) Webhook endpoint -> the license server (the 4 events handleStripeEvent switches on).
const EVENTS = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'];
const hooks = await sx('webhook_endpoints?limit=100');
const wantUrl = `${SERVER_URL}/webhooks/stripe`;
let hook = (hooks.data || []).find((h) => h.url === wantUrl);
if (hook) {
  console.log('webhook ✓', hook.id, '(secret already issued — roll in dashboard + update Railway if you need it again)');
} else if (DRY) {
  console.log('would CREATE webhook', wantUrl, '→ events:', EVENTS.join(','));
} else {
  const params = new URLSearchParams({ url: wantUrl });
  EVENTS.forEach((e) => params.append('enabled_events[]', e));
  hook = await sx('webhook_endpoints', 'POST', params);
  console.log('created webhook', hook.id);
  if (hook.secret) out['STRIPE_WEBHOOK_SECRET'] = hook.secret;
}

// 5) The one-switch output.
console.log('\n── Set these on Railway (o8-license-server, production), then redeploy ──');
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
if (!out.STRIPE_WEBHOOK_SECRET) console.log('# STRIPE_WEBHOOK_SECRET: unchanged (webhook already existed)');
console.log('# And confirm STRIPE_SECRET_KEY on Railway is the LIVE key.');
console.log(DRY ? '\n(dry-run — nothing was created)' : '\n✅ Stripe configured. Set the env above + redeploy, then a real MISTEREXC7 checkout mints a founder license.');
