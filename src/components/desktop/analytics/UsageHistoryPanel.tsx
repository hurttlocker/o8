'use client';
import { useState } from 'react';
import type { UsageHistorySummary, UsageProviderKind } from '@/lib/usage/history-types';
import { UsageControl } from './UsageControl';
import { UsageHistoryChart } from './UsageHistoryChart';
import { UsageModelMark, UsageProviderMark } from './UsageProviderMark';
import { UsageSpeedBreakdown } from './UsageSpeedBreakdown';
import { count, money, providers, sumBuckets } from './history-view';

export function UsageHistoryPanel({ snapshot, mode, provider }: { snapshot: UsageHistorySummary;
  mode: 'cost' | 'tokens'; provider: UsageProviderKind | 'all' }) {
  const hourly = snapshot.until - snapshot.since <= 86_400_000;
  const [breakdown, setBreakdown] = useState<'model' | 'day'>('model');
  const buckets = snapshot.buckets.filter(bucket => provider === 'all' || bucket.provider === provider);
  const total = sumBuckets(buckets); const format = mode === 'cost' ? money : count;
  const sessions = Object.entries(snapshot.providerSessions).reduce((sum, [id, value]) => sum + (provider === 'all' || provider === id ? value ?? 0 : 0), 0);
  const names = [...new Set(buckets.map(bucket => breakdown === 'model' ? bucket.model : bucket.day))];
  const rows = names.map(name => ({ name, sum: sumBuckets(buckets.filter(bucket => (breakdown === 'model' ? bucket.model : bucket.day) === name)) }))
    .sort((a, b) => breakdown === 'day' ? b.name.localeCompare(a.name) : (mode === 'cost' ? b.sum.cost - a.sum.cost : b.sum.tokens - a.sum.tokens));
  const types = mode === 'cost' ? [total.categories.input, total.categories.cacheRead, total.categories.cacheWrite, total.categories.output,
    Math.max(0, total.cost - Object.values(total.categories).reduce((a, b) => a + b, 0))]
    : [total.totals.uncachedInputTokens, total.totals.cachedInputTokens, total.totals.cacheCreationTokens, total.totals.outputTokens];
  const typeTotal = types.reduce((a, b) => a + b, 0);
  const colors = ['var(--t-text-muted)', 'var(--t-text-secondary)', 'var(--t-accent)', 'var(--t-text)', 'var(--t-brand-orange)'];
  return <div style={{ display: 'grid', gap: 30 }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 310px), 1fr))', gap: 28, alignItems: 'start' }}>
      <section>
        <div style={{ fontSize: 34, fontWeight: 400, letterSpacing: '-1px', fontVariantNumeric: 'tabular-nums' }}>{mode === 'cost' && total.records > 0 && total.unpriced === total.records ? 'Unpriced' : format(mode === 'cost' ? total.cost : total.tokens)}</div>
        <div style={{ color: 'var(--t-text-muted)', fontSize: 11, marginTop: 4 }}>{count(sessions)} sessions{mode === 'cost' ? ' · API estimate' : ''}</div>
        {mode === 'cost' && total.unpriced ? <div style={{ color: 'var(--t-text-muted)', fontSize: 10.5, marginTop: 6 }}>Excludes {count(total.unpriced)} requests without known prices.</div> : null}
        <div style={{ display: 'grid', gap: 18, marginTop: 24 }}>
          {providers.filter(item => (provider === 'all' || item.id === provider) && buckets.some(bucket => bucket.provider === item.id)).map(item => {
            const sum = sumBuckets(buckets.filter(bucket => bucket.provider === item.id));
            const value = mode === 'cost' ? sum.cost : sum.tokens; const denominator = mode === 'cost' ? total.cost : total.tokens;
            return <div key={item.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                <span style={{ color: item.color, display: 'flex' }}><UsageProviderMark provider={item.id} /></span>
                <span>{item.name}</span><span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{snapshot.providerSessions[item.id] ?? 0} sessions</span>
                <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{mode === 'cost' && sum.unpriced === sum.records ? 'Unpriced' : format(value)}</span>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', marginTop: 6, paddingLeft: 22 }}>
                {denominator ? `${(value / denominator * 100).toFixed(1)}%` : '—'} of {mode} · {mode === 'cost' ? `${count(sum.tokens)} tokens` : sum.unpriced === sum.records ? 'Unpriced' : money(sum.cost)}
                {sum.unpriced ? ` · ${count(sum.unpriced)} unpriced requests` : ''}
              </div>
            </div>;
          })}
          {!buckets.length ? <p style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>No recorded CLI usage in this range.</p> : null}
        </div>
      </section>
      <UsageHistoryChart buckets={buckets} mode={mode} since={snapshot.since} until={snapshot.until} timeZone={snapshot.timeZone} hourly={snapshot.until - snapshot.since <= 86_400_000} />
    </div>
    <section style={{ display: 'grid', gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 13, fontWeight: 400 }}>Totals</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 16 }}>
        {[['Processed tokens', count(total.tokens)], ['Cached input', count(total.totals.cachedInputTokens)],
          ['Uncached input', count(total.totals.uncachedInputTokens)], ['Output', count(total.totals.outputTokens)], ['Cache savings estimate', money(total.savings)]].map(([label, value]) =>
          <div key={label}><div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', marginBottom: 6 }}>{label}</div><span style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{value}</span></div>)}
      </div>
    </section>
    <div style={{ display: 'grid', gridTemplateColumns: mode === 'cost' ? 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' : undefined, gap: 40 }}>
    <section style={{ display: 'grid', alignContent: 'start', gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 400 }}>{mode === 'cost' ? 'Cost' : 'Tokens'} by type</h2>
      <div role="img" aria-label={`${mode} by token category`} style={{ height: 6, display: 'flex', gap: 2, borderRadius: 3, overflow: 'hidden', background: 'var(--t-divider-subtle)' }}>
        {types.map((value, index) => value > 0 ? <span key={index} style={{ width: `${value / typeTotal * 100}%`, background: colors[index] }} /> : null)}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--t-text-secondary)' }}>
        {types.map((value, index) => <span key={index}><span style={{ display: 'inline-block', width: 6, height: 6, marginRight: 5, background: colors[index], borderRadius: 1 }} />
          {['Input', 'Cache read', 'Cache write', 'Output', 'Other'][index]} <span style={{ color: 'var(--t-text)' }}>{format(value)}</span></span>)}
      </div>
    </section>
    {mode === 'cost' ? <UsageSpeedBreakdown cost={total.cost} fast={total.fast} premium={total.premium} unpriced={total.unpriced} /> : null}
    </div>
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 400 }}>Breakdown</h2>
        <div aria-label="Breakdown grouping" style={{ display: 'flex', gap: 2 }}>
          {(['model', 'day'] as const).map(value => <UsageControl key={value} selected={breakdown === value} aria-pressed={breakdown === value}
            onClick={() => setBreakdown(value)}>{value === 'model' ? 'Model' : hourly ? 'Hour' : 'Day'}</UsageControl>)}
        </div>
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12, tableLayout: 'fixed' }}>
        <thead style={{ color: 'var(--t-text-muted)', textAlign: 'left', fontSize: 10.5 }}><tr>
          <th style={{ width: '52%', fontWeight: 300, paddingBottom: 10 }}>{breakdown === 'model' ? 'Model' : hourly ? 'Hour' : 'Day'}</th>
          {['API estimate', mode === 'cost' ? 'Cost share' : 'Token share', 'Tokens'].map(label => <th key={label} style={{ textAlign: 'right', fontWeight: 300, paddingBottom: 10 }}>{label}</th>)}
        </tr></thead>
        <tbody>{rows.map(row => <tr key={row.name} style={{ borderTop: '1px solid var(--t-divider-subtle)' }}>
          <td style={{ paddingTop: 12, paddingBottom: 12, paddingRight: 12, overflowWrap: 'anywhere' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>{breakdown === 'model' ? <UsageModelMark model={row.name} /> : null}
              {breakdown === 'day' && hourly ? new Date(row.name).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', timeZone: snapshot.timeZone }) : row.name}
            </span>
          </td>
          <td style={{ textAlign: 'right', color: 'var(--t-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{row.sum.unpriced === row.sum.records ? 'Unpriced' : money(row.sum.cost)}{row.sum.unpriced && row.sum.unpriced < row.sum.records ? ' + unpriced' : ''}</td>
          <td style={{ textAlign: 'right', color: 'var(--t-text-muted)' }}>{((mode === 'cost' ? row.sum.cost / (total.cost || 1) : row.sum.tokens / (total.tokens || 1)) * 100).toFixed(1)}%</td>
          <td style={{ textAlign: 'right', color: 'var(--t-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{count(row.sum.tokens)}</td>
        </tr>)}</tbody>
      </table>
    </section>
    <details style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.7 }}>
      <summary style={{ cursor: 'pointer' }}>CLI sources and price coverage{total.unpriced ? ` · ${count(total.unpriced)} requests unpriced` : ''}</summary>
      <p>Includes native CLI history on the selected machine, including archived Codex sessions and work started outside o8. API estimates are not subscription charges. Missing rates stay unpriced.</p>
      {snapshot.sources.map(source => <div key={source.provider}>{providers.find(item => item.id === source.provider)?.name}: {source.status === 'missing' ? 'No local store found' : source.status === 'partial' ? 'Partially read · some records unavailable' : `${count(source.files)} files read`}</div>)}
      <p>Prices: {snapshot.pricing.status} · {snapshot.pricing.observedAt ? new Date(snapshot.pricing.observedAt.length === 10 ? `${snapshot.pricing.observedAt}T12:00:00` : snapshot.pricing.observedAt).toLocaleDateString() : 'Date unavailable'}. Cache savings and speed premiums use the current rate snapshot.</p>
    </details>
  </div>;
}
