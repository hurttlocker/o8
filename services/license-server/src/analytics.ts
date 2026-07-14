import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { db } from './db/client.js';
import { productEvents, type NewProductEvent } from './db/schema.js';
import { authPlan } from './proxy.js';

/**
 * Usage analytics (epic #1249, monetization plan §11.2).
 *
 *  - POST /v1/telemetry  — coarse product-event ingest (plan-token auth, same
 *                          as the proxy). COARSE ONLY: event name + small props;
 *                          oversized payloads are dropped (the only way props
 *                          get big is leaked content). Never hard-fails the
 *                          caller — telemetry must never break the app.
 *  - GET  /admin/analytics — the founder dashboard's data (ADMIN-guarded in
 *                          index.ts). Aggregates the two first-party sources we
 *                          already keep — proxy_usage (COGS ledger) +
 *                          product_events (coarse usage) — into "how many users,
 *                          what they use, how they use it." No content is ever
 *                          stored or returned.
 */

// ── Telemetry ingest ──────────────────────────────────────────────────────────

const MAX_EVENT_NAME = 80;
const MAX_PROPS_BYTES = 2_000;
const MAX_BATCH = 50;

/** Keep coarse props; drop anything oversized (a big payload means leaked content). */
function sanitizeProps(props: unknown): Record<string, unknown> | null {
  if (props === null || props === undefined || typeof props !== 'object' || Array.isArray(props)) {
    return null;
  }
  let json: string;
  try {
    json = JSON.stringify(props);
  } catch {
    return null;
  }
  if (json.length > MAX_PROPS_BYTES) return null;
  return props as Record<string, unknown>;
}

interface IncomingEvent {
  event?: unknown;
  props?: unknown;
}

/** POST /v1/telemetry — append coarse product events for the caller's account. */
export async function handleTelemetry(c: Context): Promise<Response> {
  const auth = await authPlan(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const { plan, sub } = auth;

  let body: { event?: unknown; props?: unknown; events?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const incoming: IncomingEvent[] = Array.isArray(body.events)
    ? (body.events as IncomingEvent[]).slice(0, MAX_BATCH)
    : [{ event: body.event, props: body.props }];

  const rows: NewProductEvent[] = [];
  for (const e of incoming) {
    const name = typeof e.event === 'string' ? e.event.trim().slice(0, MAX_EVENT_NAME) : '';
    if (!name) continue;
    rows.push({ id: randomUUID(), sub, plan, event: name, props: sanitizeProps(e.props) });
  }
  if (rows.length === 0) return c.json({ ok: true, recorded: 0 });

  try {
    await db.insert(productEvents).values(rows);
  } catch (err) {
    // Never fail the user's app because the telemetry write failed.
    console.error('[analytics] failed to record telemetry:', err);
    return c.json({ ok: false, error: 'record failed' });
  }
  return c.json({ ok: true, recorded: rows.length });
}

// ── Site-event ingest ─────────────────────────────────────────────────────────

/** Coarse events from o8.run itself (server-to-server, analytics-token guard in
 *  index.ts). Strictly whitelisted: this path can only append the counters
 *  below under the synthetic sub `site:web` — it can never touch licenses or
 *  write arbitrary event names, which keeps the analytics token effectively
 *  read-only. `site:%` subs are excluded from every identity/account metric. */
const SITE_EVENTS = new Set(['site.download_click']);

export async function handleSiteEvent(c: Context): Promise<Response> {
  let body: { event?: unknown; props?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const event = typeof body.event === 'string' ? body.event.trim() : '';
  if (!SITE_EVENTS.has(event)) {
    return c.json({ error: 'event not allowed' }, 400);
  }
  try {
    await db.insert(productEvents).values({
      id: randomUUID(),
      sub: 'site:web',
      plan: 'site',
      event,
      props: sanitizeProps(body.props),
    });
  } catch (err) {
    console.error('[analytics] failed to record site event:', err);
    return c.json({ ok: false, error: 'record failed' });
  }
  return c.json({ ok: true });
}

// ── Aggregate read ────────────────────────────────────────────────────────────

/** drizzle/postgres-js returns a RowList (array); node-postgres returns {rows}.
 *  Coerce both so the aggregator is driver-agnostic. */
function asRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

/** Postgres returns bigint/numeric as strings — coerce to a JS number. */
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

async function rows(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return asRows(await db.execute(query));
}

/** GET /admin/analytics — founder dashboard data. Admin guard is in index.ts. */
export async function handleAnalytics(c: Context): Promise<Response> {
  // Drop dev/test/smoke noise from every metric — these synthetic subs
  // (laptop-test, founder-test, install:smoke-*, smoke-gemini) are not real
  // users and would inflate the counts we care about for beta.
  const notDev = sql`sub not like '%smoke%' and sub not like '%laptop-test%' and sub not like '%founder-test%'`;

  // Identity model (beta): a REAL USER is a signed-in GitHub/Clerk account
  // (sub `user_*`). `install:*` is the pre-sign-in / not-yet-linked shadow of a
  // download — everyone signs into GitHub to download, so their real identity is
  // the account, and after sign-in all usage keys on `user_*`. Headline "users"
  // therefore counts DISTINCT ACCOUNTS (a person with N installs is ONE user);
  // installs/downloads are reported separately and never inflate it.
  const [userRow] = await rows(sql`
    with raw as (
      select sub, min(created_at) as first_seen, max(created_at) as last_seen
      from (
        select sub, created_at from proxy_usage
        union all
        select sub, created_at from product_events
      ) s
      where ${notDev}
      group by sub
    ),
    resolved as (
      -- a linked install collapses onto its owning account; else it stays itself
      select coalesce(l.clerk_user_id, r.sub) as ident, r.sub as raw_sub, r.first_seen, r.last_seen
      from raw r left join install_links l on l.install_sub = r.sub
    ),
    acct as (
      select ident,
             min(first_seen) as first_seen,
             max(last_seen)  as last_seen,
             count(*) filter (where raw_sub like 'install:%') as devices
      from resolved group by ident
    )
    select
      -- people = everyone who actually used o8: signed-in accounts + anonymous
      -- (unlinked) installs. The headline the dashboard leads with.
      count(*) filter (where ident like 'user_%' or ident like 'install:%')                      as people,
      count(*) filter (where ident like 'user_%')                                                as total,
      count(*) filter (where ident like 'user_%' and last_seen  >= now() - interval '1 day')     as active_1d,
      count(*) filter (where ident like 'user_%' and last_seen  >= now() - interval '7 days')    as active_7d,
      count(*) filter (where ident like 'user_%' and last_seen  >= now() - interval '30 days')   as active_30d,
      count(*) filter (where ident like 'user_%' and first_seen >= now() - interval '7 days')    as new_7d,
      count(*) filter (where ident like 'install:%')                                             as installs,
      count(*) filter (where ident like 'install:%' and last_seen >= now() - interval '7 days')  as installs_7d,
      coalesce(sum(devices) filter (where ident like 'user_%'), 0)                               as linked_devices
    from acct
  `);

  // Spend + call counts (proxy_usage is the COGS ledger).
  const [spendRow] = await rows(sql`
    select
      coalesce(sum(cost_micro_usd), 0)                                                          as total_micro,
      coalesce(sum(cost_micro_usd) filter (where created_at >= date_trunc('day', now())), 0)    as today_micro,
      coalesce(sum(cost_micro_usd) filter (where created_at >= now() - interval '7 days'), 0)   as last7d_micro,
      count(*)                                                                                  as calls_total,
      count(*) filter (where created_at >= date_trunc('day', now()))                            as calls_today
    from proxy_usage
    where ${notDev}
  `);

  const byKind = (await rows(sql`
    select kind, count(*) as calls, coalesce(sum(cost_micro_usd), 0) as micro
    from proxy_usage where ${notDev} group by kind order by calls desc
  `)).map((r) => ({ kind: str(r.kind), calls: num(r.calls), spendMicroUsd: num(r.micro) }));

  const byPlan = (await rows(sql`
    select plan, count(distinct sub) as accounts, coalesce(sum(cost_micro_usd), 0) as micro
    from proxy_usage where ${notDev} group by plan order by accounts desc
  `)).map((r) => ({ plan: str(r.plan), accounts: num(r.accounts), spendMicroUsd: num(r.micro) }));

  const topModels = (await rows(sql`
    select coalesce(model, '(unknown)') as model, count(*) as calls
    from proxy_usage where ${notDev} group by model order by calls desc limit 8
  `)).map((r) => ({ model: str(r.model), calls: num(r.calls) }));

  // Product events (coarse usage beyond raw inference).
  const [eventRow] = await rows(sql`
    select
      count(*)                                                       as total,
      count(*) filter (where created_at >= date_trunc('day', now())) as today
    from product_events
    where ${notDev}
  `);

  const topEvents = (await rows(sql`
    select event, count(*) as count from product_events where ${notDev} group by event order by count desc limit 20
  `)).map((r) => ({ event: str(r.event), count: num(r.count) }));

  // Daily activity — last 30 days, zero-filled, for the dashboard's trend
  // chart. Active users collapse linked installs onto their owning account and
  // count signed-in accounts only, matching the headline "users" metric.
  const daily = (await rows(sql`
    with days as (
      select generate_series(
        date_trunc('day', now()) - interval '29 days',
        date_trunc('day', now()),
        interval '1 day'
      )::date as day
    ),
    p as (
      select date_trunc('day', created_at)::date as day,
             count(*) as calls,
             coalesce(sum(cost_micro_usd), 0) as micro
      from proxy_usage
      where ${notDev} and created_at >= date_trunc('day', now()) - interval '29 days'
      group by 1
    ),
    e as (
      select date_trunc('day', created_at)::date as day,
             count(*) as events,
             count(*) filter (where event = 'site.download_click') as downloads
      from product_events
      where ${notDev} and created_at >= date_trunc('day', now()) - interval '29 days'
      group by 1
    ),
    a as (
      -- actives = PEOPLE who used o8 that day: signed-in accounts plus
      -- anonymous (unlinked) installs; linked installs collapse onto their
      -- owner, and synthetic site:% subs never count as people.
      select date_trunc('day', s.created_at)::date as day,
             count(distinct coalesce(l.clerk_user_id, s.sub))
               filter (where coalesce(l.clerk_user_id, s.sub) like 'user_%'
                    or coalesce(l.clerk_user_id, s.sub) like 'install:%') as actives
      from (
        select sub, created_at from proxy_usage
        union all
        select sub, created_at from product_events
      ) s
      left join install_links l on l.install_sub = s.sub
      where ${notDev} and s.created_at >= date_trunc('day', now()) - interval '29 days'
      group by 1
    )
    select to_char(d.day, 'YYYY-MM-DD') as day,
           coalesce(p.calls, 0)     as calls,
           coalesce(p.micro, 0)     as micro,
           coalesce(e.events, 0)    as events,
           coalesce(e.downloads, 0) as downloads,
           coalesce(a.actives, 0)   as actives
    from days d
    left join p on p.day = d.day
    left join e on e.day = d.day
    left join a on a.day = d.day
    order by d.day
  `)).map((r) => ({
    day: str(r.day),
    calls: num(r.calls),
    spendMicroUsd: num(r.micro),
    events: num(r.events),
    downloads: num(r.downloads),
    activeUsers: num(r.actives),
  }));

  // Top accounts — ONE row per real person: linked installs roll into their
  // account (devices), and the founder's GitHub handle labels the row instead of
  // a raw id. Unlinked installs stay as their own (anonymous) rows.
  const accounts = (await rows(sql`
    with raw as (
      select sub, created_at, 'p' as src, cost_micro_usd as cost from proxy_usage where ${notDev}
      union all
      select sub, created_at, 'e' as src, 0 as cost from product_events where ${notDev} and sub not like 'site:%'
    ),
    res as (
      select coalesce(l.clerk_user_id, r.sub) as ident, r.sub as raw_sub, r.created_at, r.src, r.cost
      from raw r left join install_links l on l.install_sub = r.sub
    ),
    agg as (
      select ident,
             max(created_at)                                                as last_seen,
             count(*) filter (where src = 'p')                              as calls,
             count(*) filter (where src = 'e')                              as events,
             coalesce(sum(cost), 0)                                         as spend_micro,
             count(distinct raw_sub) filter (where raw_sub like 'install:%') as devices
      from res group by ident
    )
    select
      a.ident, a.last_seen, a.calls, a.events, a.spend_micro, a.devices,
      case when f.clerk_user_id is not null then 'founder' else coalesce(pl.plan, 'free') end as plan,
      coalesce(f.gh, il.gh)      as github
    from agg a
    left join ( select sub, max(plan) as plan from proxy_usage group by sub ) pl on pl.sub = a.ident
    left join (
      -- displayName is only set when checkout metadata carried a handle; the
      -- identity backfill writes github_login instead. Fall back so a founder
      -- whose checkout lookup failed still labels their row (ghost-founder fix).
      select clerk_user_id, coalesce(nullif(perks_json->>'displayName', ''), github_login) as gh
      from founders where status = 'active'
    ) f
      on f.clerk_user_id = a.ident
    left join (
      -- EVERY signed-in user labels with their GitHub handle (captured at
      -- link-install time via Clerk) — not just founders. clogginsdev showed
      -- as an anonymous user_ row while actively dogfooding (live-hit 07-14).
      select clerk_user_id, max(github_login) as gh
      from install_links where github_login is not null group by clerk_user_id
    ) il
      on il.clerk_user_id = a.ident
    order by (a.calls + a.events) desc
    limit 20
  `)).map((r) => ({
    sub: str(r.ident),
    github: r.github ? str(r.github) : null,
    plan: str(r.plan),
    calls: num(r.calls),
    events: num(r.events),
    devices: num(r.devices),
    spendMicroUsd: num(r.spend_micro),
    lastSeen: r.last_seen instanceof Date ? r.last_seen.toISOString() : str(r.last_seen),
  }));

  return c.json({
    generatedAt: new Date().toISOString(),
    users: {
      people: num(userRow?.people),
      total: num(userRow?.total),
      activeToday: num(userRow?.active_1d),
      active7d: num(userRow?.active_7d),
      active30d: num(userRow?.active_30d),
      new7d: num(userRow?.new_7d),
    },
    installs: {
      total: num(userRow?.installs),
      active7d: num(userRow?.installs_7d),
      linkedDevices: num(userRow?.linked_devices),
    },
    spend: {
      totalMicroUsd: num(spendRow?.total_micro),
      todayMicroUsd: num(spendRow?.today_micro),
      last7dMicroUsd: num(spendRow?.last7d_micro),
      byKind,
      byPlan,
    },
    usage: {
      callsTotal: num(spendRow?.calls_total),
      callsToday: num(spendRow?.calls_today),
      topModels,
    },
    events: {
      total: num(eventRow?.total),
      today: num(eventRow?.today),
      byName: topEvents,
    },
    daily,
    accounts,
  });
}
