# Clerk production cutover (issue #1336)

**Problem.** During onboarding the GitHub OAuth consent screen reads *"Authorize Clerk
Development & Staging Instances — wants to access your account."* Production sign-ups are
flowing through the Clerk **development** instance. That's bad trust optics at the most
sensitive moment of onboarding, and dev-instance user pools **do not migrate** to a
production instance.

**Goal.** Point o8.run + the desktop `o8://` handoff at the **production** Clerk instance so
the consent screen names **o8** (via a production domain + custom social credentials), while
keeping `clerkUserId` consistent end-to-end (site checkout ↔ desktop session ↔ license
binding).

> This is an **operator** cutover: Clerk-dashboard actions + env swaps on three deploy
> surfaces. **No app code changes are required** — every consumer already reads the instance
> from env. The file:line map below is the evidence for that claim.

---

## One instance, three surfaces

All three surfaces must point at **the same** Clerk instance so `clerkUserId` matches across
the whole flow. Today they share the **development** instance; the cutover moves all three to
**production**.

| Surface | Deploy target | Clerk key(s) it needs | Where it's read |
|---|---|---|---|
| **o8-site** (o8.run) | Vercel project `o8-site` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` | `proxy.ts:16-17`, `app/layout.tsx:92`, and the ticket **minter** `app/desktop/sign-in/ticket/route.ts` (the only place the secret is used) |
| **o8 desktop** | signed build (`npm run ship`) | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (publishable only) | baked into the build at `src/components/auth/O8AuthProvider.tsx:11`; consumed client-side by the ticket handler `src/components/auth/DesktopAuthCallbackHandler.tsx` |
| **license-server** | Railway | `CLERK_ISSUER` (JWKS issuer URL) | the private `o8-license-server` Clerk verifier validates desktop session tokens against the instance JWKS |

**The `o8://` handoff, end to end** — the site **mints** a one-time Clerk sign-in ticket with
the **secret** key (`app/desktop/sign-in/ticket/route.ts` → `signInTokens.createSignInToken`),
returns it as `o8://auth/callback?ticket=…&state=…`; the desktop **consumes** it with the
**publishable** key (`DesktopAuthCallbackHandler.tsx` → `si.ticket()` → `si.finalize()` →
`setActive()`). Both ends must be on the **same** instance or the ticket won't verify.

---

## Part A — Clerk dashboard (the production instance)

Do these in the Clerk dashboard for the **o8** application, on its **Production** instance.

1. **Create / promote the Production instance.** In the o8 application, switch the instance
   selector to **Production** (Clerk creates one per application; if it exists already, open
   it). Production is a distinct instance with its own keys and its own user pool.

2. **Set the production domain to `o8.run`.** Under **Domains**, add `o8.run` (or the chosen
   auth subdomain, e.g. `accounts.o8.run` / `clerk.o8.run`). Clerk will show the required
   **DNS records** — a set of `CNAME` records (Frontend API, accounts portal, and email/DKIM
   records like `clerk`, `clkmail`, `clk._domainkey`, `clk2._domainkey`). Add every record it
   lists at the o8.run DNS host and wait for Clerk to verify them (green checks). **This is
   the step that makes the consent screen say o8 instead of "Clerk Development & Staging
   Instances"** — the dev instance uses a shared `*.accounts.dev` domain; production uses your
   verified domain.

3. **Configure the GitHub social connection with CUSTOM credentials.** Under
   **User & Authentication → Social Connections → GitHub**, production requires **your own**
   GitHub OAuth credentials (the dev instance uses Clerk's shared GitHub app — that's the
   "Clerk Development & Staging Instances" name the user saw).
   - Register a **new GitHub OAuth app** at <https://github.com/settings/applications/new>
     (org: hurttlocker). Name it **o8** (this string is what the consent screen shows).
   - Set the **Authorization callback URL** to the value Clerk shows on the GitHub connection
     panel — the production Frontend API callback, e.g.
     `https://clerk.o8.run/v1/oauth_callback` (copy the exact URL from Clerk; don't guess it).
   - Paste GitHub's **Client ID** + **Client Secret** into Clerk's GitHub connection and
     enable it.
   - **This is a SEPARATE GitHub OAuth app from the #1338 device-flow app.** #1338's app is
     the *public device-flow client id* baked into the desktop build for the "Connect GitHub"
     repo-connect CTA; this one is Clerk's *social sign-in* connection for account login. Two
     different apps, two different callback models — do not reuse one for the other.

4. **(If used) configure the Google social connection** the same way with custom Google OAuth
   credentials, and set **allowed origins / redirect** to include `https://o8.run` and the
   `o8://` scheme where Clerk allows it.

5. **Copy the production keys** from **API Keys**: `pk_live_…` (publishable) and `sk_live_…`
   (secret). Note the **Frontend API / Issuer** URL (e.g. `https://clerk.o8.run`) for the
   license-server.

---

## Part B — env swaps on our side (in this order)

Do the backend/verification surface **first**, then the site, then the desktop build, so a
token minted after the site flips can already be verified.

1. **license-server (Railway) — set `CLERK_ISSUER` first.**
   Set `CLERK_ISSUER=https://clerk.o8.run` (the production Frontend API / issuer, exact value
   from Part A step 5). Redeploy. The `o8-license-server` Clerk verifier uses
   `createRemoteJWKSet(new URL('/.well-known/jwks.json', env.CLERK_ISSUER))` and
   `jwtVerify(token, keySet, { issuer: env.CLERK_ISSUER })`. Until this matches the
   instance minting the tokens, license verification 503s / rejects.

2. **o8-site (Vercel project `o8-site`) — swap both keys.**
   In the Vercel dashboard for project `o8-site` (`.vercel/project.json`:
   `projectName: "o8-site"`), set for **Production**:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_…`
   - `CLERK_SECRET_KEY=sk_live_…`
   Redeploy production (`vercel --prod`, or trigger from the dashboard). These feed `proxy.ts`,
   `app/layout.tsx`, and the ticket minter `app/desktop/sign-in/ticket/route.ts`.

3. **o8 desktop build — swap the publishable key, then ship.**
   The desktop bakes `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` at build time
   (`O8AuthProvider.tsx:11`). Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_…` in the build
   environment (or the local `.env` used for `npm run ship`), then cut a new signed release so
   the installed app carries the production publishable key. (Desktop uses the publishable key
   only — no secret ships in the app.)
   - If the sign-in host changes, also set `NEXT_PUBLIC_O8_SIGN_IN_URL` (default
     `https://o8.run/desktop/sign-in`, `src/lib/auth/start-desktop-sign-in.ts:14-15`).

> Order rationale: (1) issuer first so verification is ready; (2) site next so it starts
> minting prod tokens; (3) desktop last so the shipped app consumes prod tickets against a
> site that's already on prod. A brief window where the site is on prod but an older installed
> app is still on dev keys will fail the ticket exchange — that's expected until users
> auto-update; it's why desktop ships last and promptly.

---

## Part C — verification

- [ ] From **o8.run**, start sign-in and reach the GitHub consent screen. It now reads
      **"Authorize o8"** (your app name), **not** "Clerk Development & Staging Instances".
- [ ] The Clerk-hosted sign-in/account pages load on the **production domain**
      (`o8.run` / `clerk.o8.run`), not `*.accounts.dev`.
- [ ] The **`o8://` handoff still works**: sign in on o8.run → browser hands back to the
      installed app via `o8://auth/callback?ticket=…` → the app finalizes the session and
      shows the signed-in user (`DesktopAuthCallbackHandler.tsx` path). Confirm the desktop
      build you're testing carries the `pk_live_` key.
- [ ] A desktop session token **verifies** against the license-server (no 503 from
      `account-license.ts`), i.e. `CLERK_ISSUER` matches the instance that minted the token.
- [ ] Stripe checkout still carries `clerkUserId` in metadata and binds to the same account
      (the private `o8-license-server` Stripe webhook and `src/lib/db/users.ts` `findOrCreateByClerk`).

### Known / expected

- **Dev-instance users do NOT migrate.** Accounts created on the development instance live in
  a separate user pool and will **not** appear in production. Anyone who signed up during the
  dev-instance window must sign up again on production. There is no automatic migration; if a
  specific dev account must be preserved, export/recreate it manually. Communicate this before
  flipping if any real users exist on the dev instance.
- **Two GitHub OAuth apps now exist** and must not be confused: the **#1338 device-flow** app
  (public client id baked into the desktop build for repo "Connect GitHub") and the **Clerk
  social-connection** app configured in Part A step 3 (account sign-in). Different callback
  URLs, different purposes.
- **Same instance end-to-end** is the invariant: site, desktop, and license-server must all
  reference the production instance so `clerkUserId` stays consistent. Mixing dev + prod keys
  across surfaces breaks the ticket exchange and/or JWKS verification.

---

## Touchpoint reference (no code changes — env only)

**o8 desktop (`~/o8`)**
- `src/components/auth/O8AuthProvider.tsx:11` — bakes `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; `:147` `<ClerkProvider publishableKey=…>`.
- `src/middleware.ts:282-298` — reads pub + secret keys; wraps `clerkMiddleware` only when both present (desktop is publishable-only, so the bare loopback gate runs and Clerk works client-side via the ticket flow).
- `src/lib/auth/start-desktop-sign-in.ts:14-17,38` — opens `NEXT_PUBLIC_O8_SIGN_IN_URL` (default `https://o8.run/desktop/sign-in`) with `redirect_uri=o8://auth/callback` + CSRF `state`.
- `src/components/auth/DesktopAuthCallbackHandler.tsx` — consumes the ticket: `si.ticket({ ticket })` → `si.finalize()` → `setActive()`.
- `src/lib/auth/current-user.ts:5-6`, `src/app/api/panel/entitlement/sync/route.ts:11-12`, `src/lib/chat/gateway-client.ts:40-43` — server-side Clerk gates.
- `.env.example:64-69` — Clerk section (`CLERK_SECRET_KEY` marked "o8-site / Vercel only").

**license-server (private `o8-license-server` deployment repo)**
- `src/env.ts:103-107` — `CLERK_ISSUER`.
- `src/clerk-verify.ts:16-32` — JWKS verification against `CLERK_ISSUER`.
- `src/account-license.ts:8,25-30` — 503 when `CLERK_ISSUER` unset / mismatched.
- `GO-LIVE.md:8,27` — already flags "Clerk production instance keys".

**o8-site (`~/o8-site`, Vercel project `o8-site`)**
- `.env.example:4-7` — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (placeholders, currently `pk_test_`/`sk_test_`); comment: "Same Clerk instance as the o8 desktop app."
- `proxy.ts:16-20` — `clerkMiddleware` gated on both keys present.
- `app/layout.tsx:92-93` — `<ClerkProvider>` when pub key set.
- `app/desktop/sign-in/ticket/route.ts` — the **ticket minter** (only place the secret key is used): `clerkClient().signInTokens.createSignInToken` → `o8://…?ticket=…&state=…`.
- `app/desktop/sign-in/DesktopSignIn.tsx:114-115` — `strategy: "oauth_github"` GitHub round-trip (the social connection configured in Part A step 3).
- `.vercel/project.json` — `projectName: "o8-site"` (the Vercel project to set prod env on).
