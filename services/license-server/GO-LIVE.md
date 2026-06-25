# Founder's Edition — Go-Live Runbook

Everything is built + verified in **Stripe TEST mode**. This is the switch to real money.
Two lanes: **license server / Stripe** (this repo) and **o8-site** (`~/o8-site`, Vercel).

## 0. Prereqs
- A **live** Stripe account (you can create products/coupons/webhooks in it).
- The live secret key (`sk_live_…`) and the Clerk **production** instance keys.

## 1. License server / Stripe (this repo)
1. Put the **live** key on Railway (project `o8-license-server`, production):
   `STRIPE_SECRET_KEY=sk_live_…`
2. Run the one-switch script — it idempotently creates the live founder product +
   prices ($150/$250/$500), the **MISTEREXC7** coupon ($100 off → $50) + promo code,
   and registers the live webhook, then prints the env to set:
   ```bash
   cd ~/o8/services/license-server
   railway run node scripts/go-live-stripe.mjs        # or: STRIPE_SECRET_KEY=sk_live_… node scripts/go-live-stripe.mjs
   ```
3. Set the printed vars on Railway (production) + redeploy:
   - `STRIPE_PRICE_FOUNDER_T1/T2/T3` (the new live price IDs)
   - `STRIPE_WEBHOOK_SECRET` (the new live `whsec_…` — only printed on first create)
   - confirm `STRIPE_SECRET_KEY` is the live key
4. Verify: `curl https://o8-license-server-production.up.railway.app/health` → `{"ok":true}`.

## 2. o8-site (front-end agent, Vercel)
- Deploy with **live** `STRIPE_SECRET_KEY` + Clerk **production** keys.
- Ensure `app/api/founding/checkout/route.ts` keeps `allow_promotion_codes: true`
  (added 2026-06-24 so MISTEREXC7 is enterable) and drop the "TEST mode" comment.
- The checkout already stamps `metadata.product:"founding"` + `clerkUserId` — the
  webhook keys on exactly that, no other change needed.

## 3. Confirm the loop (one real run)
o8.run/founding → sign in → Buy → enter **MISTEREXC7** → pay **$50** → app sign-in
syncs the license → `plan: founder`, managed inference unlocked, "Founding Operator #N" badge.

## Notes
- The license signing key (`LICENSE_PRIVATE_KEY`) is **Stripe-mode-independent** — going
  live on Stripe does NOT change it, and the prod app's baked pubkey already matches it
  (sim-verified 2026-06-24), so no pubkey swap is needed.
- MISTEREXC7 nets $50 only against the **$150 Tier-1** seat (it's a $100-off coupon).
  Fine while the cohort is early/T1; revisit if you want a flat $50 across tiers.
- A second webhook (`symon-api`) also listens to this Stripe account — harmless for
  founder (keyed on the `founding` metadata).
