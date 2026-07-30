# o8 license server (M5)

The **server** counterpart to the M4 offline license verifier baked into the o8
desktop app (`src/lib/entitlement/license.ts`). It turns a Stripe checkout into
a signed, EdDSA-licensed JWT that the desktop verifies offline, and exposes
validate / revoke endpoints for online checks.

```
Stripe checkout ──webhook──▶ license server ──mint EdDSA JWT──▶ user's o8 desktop
                              (this service)        ▲
                                                    │ verifies offline with the
                                                    │ baked PUBLIC key (M4)
```

- **Sign** with an Ed25519 PRIVATE key (lives only here, on Railway).
- **Verify** on the desktop with the matching PUBLIC key (baked into the app).
- **Plans:** `pro` = $19/mo solo Pro, `team` = $29/seat/mo team. **No trial.**
- **Auth:** Clerk. The Stripe customer maps to a Clerk `user_id` carried in
  checkout-session metadata (`clerkUserId`); we store it and use it as the JWT
  subject so validation can cross-check revocation.

The token contract MUST match M4: protected header `{ alg: 'EdDSA' }`; claims
`{ plan, iss, sub?, iat, exp }` with `exp` in seconds-epoch. `scripts/contract-test.ts`
proves a server-minted token passes the exact desktop verifier path.

## Stack

Hono + `@hono/node-server`, Stripe SDK, `jose` (sign/verify), Drizzle ORM over
the `postgres` driver. TypeScript, ESM, Node ≥ 22.

## Local dev

```bash
cd services/license-server
npm install
cp .env.example .env        # fill in values
npm run gen-keys            # generate the Ed25519 keypair (see "Keys" below)
npm run db:push             # push the schema to your Postgres
npm run dev                 # tsx watch on PORT (default 8080)
```

Sanity checks (no env / DB / network needed for the contract test):

```bash
npm run contract-test       # mint -> verify round-trip proving the M4 contract
npx tsc --noEmit            # type-check the service
```

## Keys

```bash
npm run gen-keys
```

This prints **two** PEM blocks:

1. **PRIVATE key (PKCS8)** → Railway env var `LICENSE_PRIVATE_KEY`. Secret. Lives
   only on the server. Never commit it.
2. **PUBLIC key (SPKI)** → paste into the desktop app at
   `src/lib/entitlement/license.ts`, replacing the value of
   `LICENSE_PUBLIC_KEY_PEM`. Safe to commit — it only verifies.
   You can also override it at runtime on the desktop via `O8_LICENSE_PUBKEY`.

After swapping the public key, ship a desktop build so users get the new
verifier key.

## Deploy to Railway

1. **Create the project + database**
   - `railway init` (or the dashboard) → new project.
   - Add a **Postgres** plugin. Railway sets `DATABASE_URL` automatically.

2. **Generate + set the signing key**
   - Run `npm run gen-keys` locally.
   - Railway → Variables → add `LICENSE_PRIVATE_KEY` = the PRIVATE PEM block.
   - Paste the PUBLIC PEM block into the desktop `license.ts` and ship a build.

3. **Create the two Stripe products** (Dashboard → Products)
   - **o8 Pro (solo)** — recurring **$19/mo**. Copy its **price id**.
   - **o8 Team** — recurring **$29/seat/mo** (per-seat / metered by quantity).
     Copy its **price id**.
   - Set Railway vars `STRIPE_PRICE_SOLO` (the Pro price id) and
     `STRIPE_PRICE_TEAM` (the Team price id). The server maps
     `STRIPE_PRICE_SOLO → 'pro'` and `STRIPE_PRICE_TEAM → 'team'`.

4. **Stripe API + webhook**
   - Railway var `STRIPE_SECRET_KEY` = your Stripe secret key.
   - Stripe Dashboard → Developers → Webhooks → **Add endpoint**:
     `https://<your-railway-url>/webhooks/stripe`.
   - Subscribe to: `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `invoice.payment_failed`.
   - Copy the endpoint's **signing secret** → Railway var `STRIPE_WEBHOOK_SECRET`.

5. **Remaining vars**
   - `ISSUER` (default `o8-license`), `ADMIN_TOKEN` (long random string —
     `openssl rand -hex 32`). `PORT` is set by Railway.

6. **Push the schema + deploy**
   - First deploy: run `npm run db:push` once against the Railway `DATABASE_URL`
     (locally with the var, or via a Railway one-off command) to create the
     `subscriptions` + `entitlement_events` tables.
   - Railway builds with `npm ci && npm run build` and starts with `npm start`
     (see `railway.json`). Health check: `GET /health`.

### Clerk customer mapping

When you create the Stripe Checkout Session (from your app / Clerk-authed
surface), put the Clerk user id in the session metadata:

```ts
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: SOLO_OR_TEAM_PRICE_ID, quantity: seats }],
  metadata: { clerkUserId: clerkUser.id },   // <- the server reads this
  // ...success/cancel urls
});
```

On `checkout.session.completed` the server reads `metadata.clerkUserId`, stores
it on the subscription row, and mints the license with that id as the JWT
subject. `/validate-entitlement` then cross-checks revocation by that subject.

## Endpoints

| Method + path | Auth | Body / params | Returns |
|---|---|---|---|
| `GET /health` | none | — | `{ ok, service, issuer }` |
| `POST /webhooks/stripe` | Stripe signature | raw event body | `{ received, handled, type }` |
| `POST /validate-entitlement` | none | `{ token }` | `{ valid, plan, expiresAt, revoked, graceDaysLeft }` |
| `POST /issue-entitlement` | `Bearer ADMIN_TOKEN` | `{ plan, sub?, days? }` | `{ license, plan, sub, days }` |
| `DELETE /revoke/:subscriptionId` | `Bearer ADMIN_TOKEN` | path param | `{ revoked, subscriptionId }` |
| `POST /admin/backfill-github` | `Bearer ADMIN_TOKEN` | `{ dryRun?, limit? }` | `{ dryRun, scanned, resolved, updated, skipped }` |
| `POST /github/app/token` | Clerk session JWT | — | Managed App install state or a one-hour installation token |

## GitHub-account identity resolution (#1519)

Founder / subscription rows historically key ONLY on the exact `clerkUserId`
stamped in Stripe checkout metadata. A duplicate Clerk user on the same GitHub
account — or a Clerk-instance migration — strands the entitlement: the direct
`/account/license` lookup 404s and the desktop silently falls back to a free
token. To harden this, rows also carry the **STABLE GitHub account id**
(`github_account_id`, Clerk's `provider_user_id`) + `github_login`.

Requires **`CLERK_SECRET_KEY`** (Clerk Backend API). When unset the server behaves
exactly as before — no backfill, no fallback; the direct `clerkUserId` lookup is
unaffected.

- **Backfill (write path):** best-effort at checkout/webhook and on a successful
  `/account/license` resolution, the row's GitHub account is resolved via the
  Clerk Backend API (`users.getUser → external_accounts`, provider `github`) and
  stamped. Never blocks the payment path.
- **Fallback (read path):** when the caller's `clerkUserId` has no direct
  entitlement, resolve THEIR GitHub account; if a row keys on that
  `github_account_id`, honor it AND migrate that row's `clerkUserId` to the caller
  (one-way, logged `identity_migrated old→new`). The Clerk lookup is cached
  ~10min so a hot loop can't hammer the API.
- **Admin backfill:** `POST /admin/backfill-github` (ADMIN_TOKEN) walks existing
  rows with a `clerkUserId` but no `github_account_id` and populates them.
  Idempotent (only null rows); `{ "dryRun": true }` resolves + counts without
  writing.

```bash
# dry run — see how many rows would be populated
curl -sX POST https://<url>/admin/backfill-github \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"dryRun":true}'
```

Adds nullable columns to `founders` + `subscriptions`; run `npm run db:push`
after deploy to apply.

**`/issue-entitlement`** is for testing before live Stripe — mint a token by
hand:

```bash
curl -sX POST https://<url>/issue-entitlement \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"plan":"pro","sub":"user_clerk_123","days":30}'
```

**`/validate-entitlement`** verifies the EdDSA signature + `exp` (same way the
desktop does) and checks the DB for revocation:

```bash
curl -sX POST https://<url>/validate-entitlement \
  -H 'content-type: application/json' \
  -d '{"token":"<the-jwt>"}'
```

**`/revoke/:subscriptionId`** flips `revokedAt` so future validations fail
(subscription cancellation already does this automatically via the webhook):

```bash
curl -sX DELETE https://<url>/revoke/<stripe_sub_id> \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

## Grace policy

`invoice.payment_failed` does **not** revoke — it logs a warning and records an
`entitlement_events` row. The desktop verifier's offline-grace window (30 days
past `exp`) covers the dunning period. A hard revoke only happens on
`customer.subscription.deleted` or a manual `DELETE /revoke/:id`.

Part of epic #1198 (monetization). This service is deploy-ready scaffolding —
the operator provides the Stripe account, runs `gen-keys`, and deploys.
