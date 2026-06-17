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
  // Distinct accounts across BOTH sources (proxy spend ∪ product events), with
  // first/last-seen so we can derive DAU/WAU/MAU + new-this-week.
  const [userRow] = await rows(sql`
    select
      count(*)                                                          as total,
      count(*) filter (where last_seen  >= now() - interval '1 day')   as active_1d,
      count(*) filter (where last_seen  >= now() - interval '7 days')  as active_7d,
      count(*) filter (where last_seen  >= now() - interval '30 days') as active_30d,
      count(*) filter (where first_seen >= now() - interval '7 days')  as new_7d
    from (
      select sub, min(created_at) as first_seen, max(created_at) as last_seen
      from (
        select sub, created_at from proxy_usage
        union all
        select sub, created_at from product_events
      ) s
      group by sub
    ) a
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
  `);

  const byKind = (await rows(sql`
    select kind, count(*) as calls, coalesce(sum(cost_micro_usd), 0) as micro
    from proxy_usage group by kind order by calls desc
  `)).map((r) => ({ kind: str(r.kind), calls: num(r.calls), spendMicroUsd: num(r.micro) }));

  const byPlan = (await rows(sql`
    select plan, count(distinct sub) as accounts, coalesce(sum(cost_micro_usd), 0) as micro
    from proxy_usage group by plan order by accounts desc
  `)).map((r) => ({ plan: str(r.plan), accounts: num(r.accounts), spendMicroUsd: num(r.micro) }));

  const topModels = (await rows(sql`
    select coalesce(model, '(unknown)') as model, count(*) as calls
    from proxy_usage group by model order by calls desc limit 8
  `)).map((r) => ({ model: str(r.model), calls: num(r.calls) }));

  // Product events (coarse usage beyond raw inference).
  const [eventRow] = await rows(sql`
    select
      count(*)                                                       as total,
      count(*) filter (where created_at >= date_trunc('day', now())) as today
    from product_events
  `);

  const topEvents = (await rows(sql`
    select event, count(*) as count from product_events group by event order by count desc limit 20
  `)).map((r) => ({ event: str(r.event), count: num(r.count) }));

  // Top accounts by activity (calls + events), with spend + best tier seen.
  const accounts = (await rows(sql`
    select
      a.sub,
      a.last_seen,
      a.calls,
      a.events,
      coalesce(p.micro, 0)                          as spend_micro,
      coalesce(p.plan, e.plan, 'free')              as plan
    from (
      select sub,
             max(created_at)                  as last_seen,
             count(*) filter (where src = 'p') as calls,
             count(*) filter (where src = 'e') as events
      from (
        select sub, created_at, 'p' as src from proxy_usage
        union all
        select sub, created_at, 'e' as src from product_events
      ) u
      group by sub
    ) a
    left join (
      select sub, sum(cost_micro_usd) as micro, max(plan) as plan from proxy_usage group by sub
    ) p on p.sub = a.sub
    left join (
      select sub, max(plan) as plan from product_events group by sub
    ) e on e.sub = a.sub
    order by (a.calls + a.events) desc
    limit 20
  `)).map((r) => ({
    sub: str(r.sub),
    plan: str(r.plan),
    calls: num(r.calls),
    events: num(r.events),
    spendMicroUsd: num(r.spend_micro),
    lastSeen: r.last_seen instanceof Date ? r.last_seen.toISOString() : str(r.last_seen),
  }));

  return c.json({
    generatedAt: new Date().toISOString(),
    users: {
      total: num(userRow?.total),
      activeToday: num(userRow?.active_1d),
      active7d: num(userRow?.active_7d),
      active30d: num(userRow?.active_30d),
      new7d: num(userRow?.new_7d),
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
    accounts,
  });
}
