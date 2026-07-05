# Onboarding auth — the two-GitHub problem and the single-authorization end state

## The problem (operator-caught, 2026-07-05)

o8 asks for GitHub **twice**, and both prompts said "Sign in with GitHub":

1. **o8 account** (identity) — Clerk sign-in via the `o8://` ticket handoff
   (`startDesktopSignIn` → `o8.run/desktop/sign-in` → one-time Clerk ticket →
   `o8://auth/callback`). Carries the **founder badge, usage, entitlement**.
   Scopes: identity only (`read:user`, `user:email`).
2. **Repo access** — the GitHub **device flow** (`/api/panel/github-device`,
   backing the `gh` CLI). Grants o8 permission to **clone + read your repos**.
   Scope: `repo`.

They are genuinely different tokens with different scopes, but presenting both
as "Sign in with GitHub" read as a pointless double login. Worse, onboarding
only ever did (2) — it never signed you into your account at all, so a fresh
founder finished onboarding with **no badge and no usage**.

## ① Shipped fix (v0.1.537) — reframe, don't unify

- **Onboarding open step** now runs the **o8 account** sign-in (`useO8Auth().signIn`),
  not the device flow. Near-instant for anyone who bought on the web (already
  authed on `o8.run` → ticket mints immediately). Signing in provisions the user
  + syncs the entitlement → the founder badge lights up.
- **Repo step** relabeled **"Connect your GitHub repos"** with copy that says it's
  repo access, explicitly *separate* from the account sign-in.
- Net: one account sign-in + one clearly-distinct repo grant. No more two
  identical prompts.

This still requires two GitHub authorizations. ② removes the second.

## ② Target end state — ONE GitHub authorization for everything

**Goal:** signing into o8 with GitHub grants identity **and** repo access in a
single authorization. The device flow disappears.

**Mechanism (Clerk OAuth with `repo` scope):**

1. **Clerk dashboard** → GitHub social connection → add the **`repo`** scope
   (alongside `read:user`, `user:email`). Now the Clerk sign-in authorizes repo
   access too.
2. **Read the GitHub token from Clerk** server-side for the signed-in user:
   `GET https://api.clerk.com/v1/users/{userId}/oauth_access_tokens/oauth_github`
   (Bearer `CLERK_SECRET_KEY`). Returns the GitHub OAuth token, now `repo`-scoped.
3. **Route repo ops through that token.** Replace the `gh`-CLI/device-flow token
   source in:
   - `/api/panel/repos?source=github` (the list — added in the ① fix, currently
     via `gh api /user/repos`) → call the GitHub API directly with the Clerk token.
   - `/api/panel/github-status` (currently `gh auth status`) → derive from the
     Clerk session + token presence.
   - clone path (`cloneRepoToDefaultLocation`) → use the token for private-repo
     clone auth.
4. **Drop the repo-connect step** from onboarding — repos are listable the moment
   the account sign-in completes.
5. **Deprecate** `/api/panel/github-device` + the `gh` binary dependency once the
   Clerk-token path is proven on a clean machine.

**Trade-offs / decisions to make:**
- OAuth `repo` scope is **broad** (full read/write to all repos) — GitHub OAuth
  apps have no granular per-repo scope. If per-repo consent matters, the
  alternative is a **GitHub App installation** flow (per-repo grants) instead of
  OAuth `repo` — a different, heavier integration. Recommendation: ship OAuth
  `repo` first (one-login win), evaluate a GitHub App later if operators want
  per-repo control.
- Token lifetime: GitHub OAuth tokens don't expire unless the app enables
  expiry; Clerk stores/refreshes. Handle the "token revoked / missing" case by
  falling back to the ① repo-connect step (keep it as a hidden fallback, not the
  default path).
- Removing `gh` also removes a Finder-launch PATH dependency — a net simplification.

**Rollout order:** add `repo` scope in Clerk → add the Clerk-token reader +
GitHub API client → switch the repo list/status/clone to it behind a flag →
verify on a clean machine → drop the device flow + the onboarding repo step.
