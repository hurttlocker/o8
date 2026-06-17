'use client';

/**
 * OperatorAnalyticsSection — the cross-user FOUNDER view (epic #1249).
 *
 * Distinct from the rest of AnalyticsPage, which is THIS install's own cost/
 * usage. This section answers "how many users, what they use, how they use it"
 * by reading the license server's aggregate API through the gated, founder-only
 * bridge GET /api/operator/analytics. On a normal install the bridge returns
 * { available:false } (no analytics token in env) and this renders NOTHING — so
 * only the operator ever sees it.
 *
 * Dieter Rams × Swiss-Korean: numbered section, hairlines, mono metric
 * callouts, one orange accent. Inline styles only (repo rule).
 */

import { useCallback, useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  SectionLabel,
} from '../settings/shared';

interface OperatorAnalytics {
  generatedAt: string;
  users: { total: number; activeToday: number; active7d: number; active30d: number; new7d: number };
  spend: {
    totalMicroUsd: number;
    todayMicroUsd: number;
    last7dMicroUsd: number;
    byKind: Array<{ kind: string; calls: number; spendMicroUsd: number }>;
    byPlan: Array<{ plan: string; accounts: number; spendMicroUsd: number }>;
  };
  usage: { callsTotal: number; callsToday: number; topModels: Array<{ model: string; calls: number }> };
  events: { total: number; today: number; byName: Array<{ event: string; count: number }> };
  accounts: Array<{ sub: string; plan: string; calls: number; events: number; spendMicroUsd: number; lastSeen: string }>;
}

interface BridgeResponse {
  available?: boolean;
  data?: OperatorAnalytics;
  reason?: string;
}

function fmtUsd(micro: number): string {
  const usd = (micro ?? 0) / 1_000_000;
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${Number(usd.toFixed(6))}`; // trim trailing zeros ($0.0012, not $0.001200)
  return `$${usd.toFixed(2)}`;
}

function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

// ── Small presentational primitives (Rams) ──────────────────────────────────

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 26, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.02em', lineHeight: 1 }}>
        {value}
      </span>
      <span style={{ fontFamily: APP_FONT_STACK, fontSize: 10, fontWeight: 400, letterSpacing: '0.12em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
        {label}
      </span>
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: APP_FONT_STACK, fontSize: 10, fontWeight: 400, letterSpacing: '0.12em', textTransform: 'uppercase', color: RAMS_INK_QUIET, marginTop: 18, marginBottom: 8 }}>
      {children}
    </div>
  );
}

function ChipRow({ items }: { items: Array<{ label: string; value: string }> }) {
  if (items.length === 0) {
    return <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: RAMS_INK_QUIET }}>—</span>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      {items.map((it) => (
        <span key={it.label} style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text-secondary)' }}>
          <span style={{ color: 'var(--t-text)' }}>{it.label}</span>
          <span style={{ color: RAMS_INK_QUIET }}> · {it.value}</span>
        </span>
      ))}
    </div>
  );
}

export function OperatorAnalyticsSection() {
  const [state, setState] = useState<{ loading: boolean; data: OperatorAnalytics | null; available: boolean }>(
    { loading: true, data: null, available: false },
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/operator/analytics', { cache: 'no-store' });
      const body = (await res.json()) as BridgeResponse;
      setState({ loading: false, data: body.data ?? null, available: body.available === true && !!body.data });
    } catch {
      setState({ loading: false, data: null, available: false });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Render NOTHING for non-operators (or while first resolving) — the section
  // simply doesn't exist on a normal install.
  if (state.loading || !state.available || !state.data) return null;

  const d = state.data;
  return (
    <section style={{ marginBottom: 36 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <SectionLabel number="00">OPERATOR · ALL USERS</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, letterSpacing: '0.1em', color: RAMS_INK_QUIET }}>
            {fmtWhen(d.generatedAt)}
          </span>
          <button
            type="button"
            onClick={() => { void load(); }}
            style={{
              fontFamily: MONO_FONT_STACK, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
              color: RAMS_ACCENT, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            refresh
          </button>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`, paddingTop: 18 }}>
        {/* USERS */}
        <div style={{ display: 'flex', gap: 36, flexWrap: 'wrap' }}>
          <Metric label="users total" value={d.users.total} />
          <Metric label="active today" value={d.users.activeToday} />
          <Metric label="active 7d" value={d.users.active7d} />
          <Metric label="active 30d" value={d.users.active30d} />
          <Metric label="new 7d" value={d.users.new7d} />
        </div>

        {/* SPEND */}
        <SubLabel>managed-inference spend</SubLabel>
        <div style={{ display: 'flex', gap: 36, flexWrap: 'wrap' }}>
          <Metric label="total" value={fmtUsd(d.spend.totalMicroUsd)} />
          <Metric label="today" value={fmtUsd(d.spend.todayMicroUsd)} />
          <Metric label="7-day" value={fmtUsd(d.spend.last7dMicroUsd)} />
        </div>
        <div style={{ marginTop: 12 }}>
          <ChipRow items={d.spend.byKind.map((k) => ({ label: k.kind, value: `${k.calls} · ${fmtUsd(k.spendMicroUsd)}` }))} />
        </div>
        <div style={{ marginTop: 8 }}>
          <ChipRow items={d.spend.byPlan.map((p) => ({ label: p.plan, value: `${p.accounts} acct · ${fmtUsd(p.spendMicroUsd)}` }))} />
        </div>

        {/* USAGE */}
        <SubLabel>usage — {d.usage.callsTotal} calls total · {d.usage.callsToday} today</SubLabel>
        <ChipRow items={d.usage.topModels.map((m) => ({ label: m.model, value: String(m.calls) }))} />

        {/* EVENTS */}
        <SubLabel>events — {d.events.total} total · {d.events.today} today</SubLabel>
        <ChipRow items={d.events.byName.map((e) => ({ label: e.event, value: String(e.count) }))} />

        {/* ACCOUNTS */}
        <SubLabel>top accounts</SubLabel>
        {d.accounts.length === 0 ? (
          <BracketLabel tone="quiet">no accounts yet</BracketLabel>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 12, paddingBottom: 6, fontFamily: APP_FONT_STACK, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: RAMS_INK_QUIET }}>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>account</span>
              <span style={{ width: 52, flexShrink: 0 }}>plan</span>
              <span style={{ width: 48, flexShrink: 0, textAlign: 'right' }}>calls</span>
              <span style={{ width: 52, flexShrink: 0, textAlign: 'right' }}>events</span>
              <span style={{ width: 78, flexShrink: 0, textAlign: 'right' }}>spend</span>
              <span style={{ width: 96, flexShrink: 0, textAlign: 'right' }}>last seen</span>
            </div>
            {d.accounts.map((a) => (
              <div key={a.sub} style={{ display: 'flex', gap: 12, alignItems: 'center', paddingTop: 8, paddingBottom: 8, borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`, fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text)' }}>
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.sub}>{a.sub}</span>
                <span style={{ width: 52, flexShrink: 0, color: 'var(--t-text-secondary)' }}>{a.plan}</span>
                <span style={{ width: 48, flexShrink: 0, textAlign: 'right' }}>{a.calls}</span>
                <span style={{ width: 52, flexShrink: 0, textAlign: 'right' }}>{a.events}</span>
                <span style={{ width: 78, flexShrink: 0, textAlign: 'right' }}>{fmtUsd(a.spendMicroUsd)}</span>
                <span style={{ width: 96, flexShrink: 0, textAlign: 'right', color: RAMS_INK_QUIET }}>{fmtWhen(a.lastSeen)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
