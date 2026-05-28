# Mobile Dogfood Backend Readiness - 2026-05-28

This is the current backend handoff for o8 mobile dogfooding.

## Runtime Status

- The verified dogfood desktop app is `/Applications/o8-dogfood.app`.
- It is signed and runs the packaged backend from `Contents/Resources/server`.
- It currently owns API `3001` and WS `3002`.
- It is started on login by:
  `/Users/marquisehurtt/Library/LaunchAgents/ai.o8.dogfood.plist`.

The old `/Applications/o8.app` bundle could not be overwritten by this agent because macOS attached a `com.apple.macl` protection label. Keep using `o8-dogfood.app` unless replacing `o8.app` from Finder or another permission context.

## Tailscale Pairing

Mobile pairing now prefers Tailscale over LAN.

- Mac tailnet IPv4: `100.82.184.109`.
- MagicDNS name observed: `marquises-imac.tail22c062.ts.net`.
- Pairing endpoint: `/api/panel/mobile-pairing`.
- Expected pairing response shape now includes `hostKind`.

Example:

```json
{
  "host": "100.82.184.109",
  "hostKind": "tailscale",
  "apiPort": 3001,
  "wsPort": 3002,
  "token": "<ws-token>"
}
```

Do not paste the real `ws-token` into docs or commits.

## ActivityKit / APNs

ActivityKit pushes now use APNs HTTP/2. The old Node `fetch` transport was not sufficient for the APNs provider API.

Durable APNs configuration is outside the repo:

- Config: `/Users/marquisehurtt/.o8/apns.json`
- Private key: `/Users/marquisehurtt/.o8/secrets/AuthKey_5BH42G6KA5.p8`
- Key ID: `5BH42G6KA5`
- Team ID: `3U3MXN796S`
- Bundle ID: `com.marquisehurtt.o8mobile`
- Environment: `sandbox` for local development-signed Release builds

Do not print the private key. Do not move APNs secrets into the repo.

## Verification

- `npx tsc --noEmit --pretty false`: passed after the backend changes.
- `git diff --check` for the changed backend files: passed.
- Tauri packaged build: passed.
- Codesign verification for `/Applications/o8-dogfood.app`: passed.
- Packaged pairing endpoint returned Tailscale host `100.82.184.109`.
- Physical iPhone composer smoke passed after the on-device config was repointed to Tailscale.
- Packaged backend Live Activity sync returned `pushed: 1`, `failed: 0` using `/Users/marquisehurtt/.o8/apns.json`.

## Relevant Commits

- `59fbfd82` - ActivityKit APNs updates over HTTP/2.
- `6979c03d` - Tailscale-first pairing and durable APNs config.
- `b44b5105` - Last pushed desktop commit observed after mobile readiness push.
