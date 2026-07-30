# Beta founding invites (#beta-referral)

The operator's share-able beta invite system. Reference: gabriell_lab's Ophelia
"Share Early Access" modal, rendered in o8's language. The invite is a
collectible **founding pass** (a unique code + colorway), not a bare link.

Surface: `ShareBetaModal` (`src/app/preview/canvas-glass/share-beta.tsx`),
opened at the **end of the welcome tour** (`CanvasTour onComplete`).

## What's real now (desktop, local)

Generation, persistence, and sent/redeemed tracking run locally in SQLite —
the "desktop real now" half of the build.

- **Table** `beta_invites` (`src/lib/db/schema.ts`, created in
  `ensureBetaInvitesTable` in `src/lib/db/index.ts`): `code` (PK), `owner`,
  `accent`, `position`, `status` (`available | sent | redeemed`), `sent_at`,
  `redeemed_at`, `redeemed_by`, `created_at`.
- **Store** `src/lib/invites/store.ts`: `ensureFoundingInvites(owner)` seeds the
  set of 5 on first read (idempotent), `listInvites`, `markSent`,
  `resolveOwner` (GitHub installation login → OS username → `operator`), and the
  `redeemInvite` stub.
- **Routes** (default-deny middleware; the desktop attaches the operator bearer
  even on loopback):
  - `GET /api/invites` → `{ owner, invites: [{code, accent, position, status}] }` (ensures + returns).
  - `POST /api/invites/sent { code }` → marks a pass handed out.
  - `POST /api/invites/redeem { code, redeemedBy? }` → **local stub** (see below).

## Central phase — BUILT (deploy pending)

Cross-machine redemption is wired end to end (extends the M5 license-server,
Railway + Postgres). What remains is the deploy.

### Central service (`services/license-server`, Hono + Drizzle)

- `invites` table (`services/license-server/src/db/schema.ts`): `code` (PK), `owner`, `accent`,
  `position`, `status` (`sent | redeemed`), `redeemed_by`, timestamps.
- `services/license-server/src/invites.ts`: `registerInvite` (idempotent per owner; rejects a code
  another owner already holds → desktop regenerates), `resolveInvite`,
  `redeemInvite` (one-time, captures the invitee email).
- Routes (`services/license-server/src/index.ts`): `POST /invites/register` (scoped
  `INVITE_REGISTER_TOKEN` bearer, 503 when unset), `GET /invites/:code`
  (public resolve), `POST /invites/redeem` (public, one-time).

### Desktop → central (`src/lib/invites/store.ts`)

On `markSent`, the `/api/invites/sent` route fires `registerWithCentral` — a
best-effort POST to `/invites/register`. Gated on `O8_INVITE_SERVICE_URL` +
`O8_INVITE_REGISTER_TOKEN`; unset = local-only (no behavior change).

### Landing (`o8-site` → Vercel / o8.run)

`app/i/[code]/page.tsx` resolves server-side via `INVITE_SERVICE_URL` and
renders the founding pass + inviter; `RedeemForm` + `app/api/invite/redeem/route.ts`
proxy to the central redeem (service URL stays server-side).

### Still local-only

The desktop's own `redeemInvite` (`POST /api/invites/redeem`) is same-install
testing only — real redemption is the central service via the landing.
Reflecting redeemed-state back onto the operator's passes (poll central) is a
follow-up.

## Deploy runbook

1. **Railway (license-server):** set `INVITE_REGISTER_TOKEN` (`openssl rand -hex 32`);
   deploy; create the table — `railway run npm run db:push` (or local
   `DATABASE_URL=… npm run db:push`). Smoke:
   `curl $URL/invites/o8_0123456789abcdefABCDEF` →
   `{"valid":false,"reason":"not_found"}` (404).
2. **Vercel (o8-site):** set `INVITE_SERVICE_URL=https://api.o8.run`;
   `git push` (auto-deploys to o8.run).
3. **Desktop:** set `O8_INVITE_SERVICE_URL` + `O8_INVITE_REGISTER_TOKEN`
   (matching step 1) in the build env; `npm run ship`.
4. **End-to-end:** copy a code in the app → open `o8.run/i/<code>` in a fresh
   browser → claim with an email → reopening shows "already claimed."
