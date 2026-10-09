'use client';
import { useMemo, useState } from 'react';
import type { HistoryBucket } from '@/lib/usage/history-types';
import { providers, sumBuckets, count, money } from './history-view';

export function UsageHistoryChart({ buckets, mode, since, until, hourly, timeZone }: {
  buckets: HistoryBucket[]; mode: 'cost' | 'tokens'; since: number; until: number; hourly: boolean; timeZone: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const points = useMemo(() => {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const keys = new Set<string>();
    for (let time = since; time <= until; time += hourly ? 3_600_000 : 86_400_000) {
      keys.add(hourly ? new Date(Math.floor(time / 3_600_000) * 3_600_000).toISOString() : formatter.format(time));
    }
    for (const bucket of buckets) keys.add(bucket.day);
    return [...keys].sort().map(day => ({ day, values: Object.fromEntries(providers.map(provider => {
      const sum = sumBuckets(buckets.filter(bucket => bucket.day === day && bucket.provider === provider.id));
      return [provider.id, mode === 'cost' ? sum.cost : sum.tokens];
    })) }));
  }, [buckets, since, until, hourly, mode, timeZone]);
  const max = Math.max(1, ...points.flatMap(point => Object.values(point.values)));
  const format = mode === 'cost' ? money : count;
  const x = (index: number) => 54 + index / Math.max(1, points.length - 1) * 626;
  const y = (value: number) => 200 - value / max * 172;
  const selected = hover === null ? null : points[Math.min(hover, points.length - 1)];
  const label = (day: string) => hourly ? new Date(day).toLocaleTimeString([], { hour: 'numeric', timeZone }) : new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return <section style={{ minWidth: 0, position: 'relative' }}>
    <h2 style={{ fontSize: 13, fontWeight: 400, marginTop: 0, marginBottom: 12 }}>{hourly ? 'Hourly' : 'Daily'} {mode === 'cost' ? 'API cost estimate' : 'processed tokens'}</h2>
    <svg viewBox="0 0 700 230" role="img" aria-label={`${hourly ? 'Hourly' : 'Daily'} ${mode} by CLI`} tabIndex={0}
      onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); const position = (event.clientX - rect.left) / rect.width * 700;
        setHover(Math.max(0, Math.min(points.length - 1, Math.round((position - 54) / 626 * (points.length - 1))))); }}
      onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onKeyDown={event => { if (event.key === 'Escape') setHover(null);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault();
          setHover(value => Math.max(0, Math.min(points.length - 1, (value ?? 0) + (event.key === 'ArrowRight' ? 1 : -1)))); } }}
      style={{ display: 'block', width: '100%', overflow: 'visible', outlineColor: 'var(--t-accent)' }}>
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <line x1={54} x2={680} y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--t-divider-subtle)" />
        <text x={44} y={y(max * fraction) + 3} textAnchor="end" fill="var(--t-text-muted)" fontSize={10}>{format(max * fraction)}</text>
      </g>)}
      {providers.map(provider => <polyline key={provider.id} fill="none" stroke={provider.color} strokeWidth={1.7}
        vectorEffect="non-scaling-stroke" points={points.map((point, index) => `${x(index)},${y(point.values[provider.id] ?? 0)}`).join(' ')} />)}
      {[0, Math.floor(points.length / 2), points.length - 1].filter((value, index, all) => all.indexOf(value) === index).map(index =>
        <text key={index} x={x(index)} y={223} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} fill="var(--t-text-muted)" fontSize={10}>{points[index] ? label(points[index].day) : ''}</text>)}
      {selected && hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={28} y2={200} stroke="var(--t-text-muted)" strokeDasharray="3 3" /> : null}
    </svg>
    {selected ? <div role="status" aria-live="polite" style={{ position: 'absolute', top: 40, right: 12, pointerEvents: 'none',
      minWidth: 158, padding: 12, borderRadius: 10, background: 'var(--t-bg-card)', border: '1px solid var(--t-border)',
      boxShadow: 'var(--t-glass-shadow)', color: 'var(--t-text)', fontSize: 11 }}>
      <div style={{ color: 'var(--t-text-muted)', marginBottom: 8 }}>{label(selected.day)}</div>
      {providers.filter(provider => buckets.some(bucket => bucket.provider === provider.id)).map(provider => <div key={provider.id}
        style={{ display: 'flex', justifyContent: 'space-between', gap: 20, marginTop: 5 }}>
        <span style={{ color: provider.color }}>{provider.name}</span><span>{format(selected.values[provider.id] ?? 0)}</span>
      </div>)}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--t-divider-subtle)' }}>
        <span>Total</span><span>{format(Object.values(selected.values).reduce((sum, value) => sum + value, 0))}</span>
      </div>
    </div> : null}
  </section>;
}
