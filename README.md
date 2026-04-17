# o8

**The governance layer for autonomous engineering teams.**

Run a fleet of AI agents with review gates, approvals, and shared memory. Local-first. Any model.

> Claude plans. Codex builds. o8 ships.

---

## Preview

![o8 landing page](./assets/landing-preview.png)

Product screenshots coming soon.

## Quick links

- Landing: [hurttlocker/o8-site](https://github.com/hurttlocker/o8-site)
- [CHANGELOG.md](./CHANGELOG.md) — what shipped, when
- [STATS.md](./STATS.md) — build velocity

This repo holds the public development log. Engineering source is private; we sync feature-grade commits here on every merge.

## What's inside

- **CHANGELOG.md** — features and perf wins, date-grouped, rebranded from the private log. Bug fixes and internal refactors stay private.
- **STATS.md** — rolling snapshot of how much has shipped: last week, last day, all-time active days.
- **assets/** — marketing preview images.

## How entries make the cut

The public feed is filtered, not a dump. An entry only lands here if:

1. The commit prefix is `feat:` / `perf:` / `design:` (no `fix:` / `chore:` / `refactor:` / auto-commit noise)
2. It's from the last 180 days
3. It passes a blocklist for internal codenames, competitor mentions, architecture details, and strategy keywords
4. A sed pass rewrites internal product names to `o8` and generalizes implementation phrases before publication

Every sync is gated on the blocklist — if a new codename or strategy term ever slips in, the workflow fails closed. That keeps the public log honest.

## Staying updated

- Star this repo to follow releases
- See every feature land in near-real-time (auto-sync on push to the private main)
