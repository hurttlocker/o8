# GitHub Broker Setup

This document describes the GitHub App broker path used by o8 for both local development and production.

## Goal

Use a single GitHub App-backed integration path for:

- local desktop usage
- production deployments
- durable repo issue / PR / CI / commit snapshots
- webhook-driven refresh instead of burning user `gh` rate limits

## Existing App

Current app:

- Name: `cortex-dev-agent`
- App ID: `3167857`

Current local key path:

- `~/.o8/github-app.pem`

The app is already installed on `hurttlocker` and has broad repository access.

## Required Environment

Set these on the server that serves o8:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_WEBHOOK_SECRET`

Set this once the production URL exists:

- `CORTEX_IDE_PUBLIC_BASE_URL`

Optional:

- `GITHUB_API_BASE_URL`

Example:

```bash
GITHUB_APP_ID=3167857
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET="replace-me"
CORTEX_IDE_PUBLIC_BASE_URL="https://your-o8-host.example"
```

The webhook URL is:

```text
${CORTEX_IDE_PUBLIC_BASE_URL}/api/github/webhook
```

## GitHub App Settings

In GitHub App settings, confirm:

- Repository permissions:
  - Metadata: Read-only
  - Issues: Read and write
  - Pull requests: Read and write
  - Contents: Read and write
  - Actions: Read-only
- Repository access:
  - `All repositories` for the owner/org using the app

These are already sufficient for the current brokered issue / PR flow.

Still required before production webhook sync works:

- Set `Webhook URL`
- Set `Secret`

## Local Development

Local desktop/dev can use the same app.

Requirements:

- keep `~/.o8/github-app.pem`
- set `GITHUB_APP_WEBHOOK_SECRET`
- optionally set `CORTEX_IDE_PUBLIC_BASE_URL` to a tunnel URL

If you want live webhook delivery locally, use a tunnel:

- `cloudflared`
- `ngrok`
- `smee`

Example:

```bash
cloudflared tunnel --url http://127.0.0.1:47120
```

Then set:

```bash
CORTEX_IDE_PUBLIC_BASE_URL="https://<your-tunnel>.trycloudflare.com"
```

And use this webhook in GitHub:

```text
https://<your-tunnel>.trycloudflare.com/api/github/webhook
```

## Current Broker Coverage

Broker-backed today:

- issue list route
- pull request list route
- GitHub broker status / readiness

Still migrating:

- issue detail
- PR detail and comments
- CI runs
- commits
- write-back actions

## Production Blocker

Production webhook sync cannot be completed until the final public URL exists.

That means:

- the GitHub App can already mint installation tokens
- brokered reads can already work
- webhook-driven sync is blocked on the final public URL

## Recommended Shipping Order

1. Finalize production URL
2. Set `CORTEX_IDE_PUBLIC_BASE_URL`
3. Set `Webhook URL` in the GitHub App
4. Set `GITHUB_APP_WEBHOOK_SECRET`
5. Deploy
6. Test webhook delivery on `issues` and `pull_request`
7. Move remaining GitHub surfaces off `gh`
