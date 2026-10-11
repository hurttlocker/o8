'use client';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { area, curveMonotoneX, line } from 'd3-shape';
import type { HistoryBucket } from '@/lib/usage/history-types';
import { providers, count, money, sumBuckets } from './history-view';
import { usageChartPoints, usageChartTicks, type UsageChartPoint } from './usage-chart-data';
import { UsageProviderMark } from './UsageProviderMark';

export function UsageHistoryChart({ buckets, mode, since, until, hourly, timeZone }: {
  buckets: HistoryBucket[]; mode: 'cost' | 'tokens'; since: number; until: number; hourly: boolean; timeZone: string;
}) {
  const [hover, setHover] = useState<{ day: string; keyboard: boolean } | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const tooltip = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const id = useId().replace(/:/g, '');
  const points = useMemo(() => usageChartPoints(buckets, mode, since, until, hourly, timeZone), [buckets, mode, since, until, hourly, timeZone]);
  const series = providers.filter(provider => points.some(point => (point.values[provider.id] ?? 0) > 0));
  const ticks = usageChartTicks(Math.max(0, ...points.flatMap(point => Object.values(point.values).map(value => value ?? 0))));
  const max = ticks.at(-1) ?? 1;
  const format = mode === 'cost' ? money : count;
  const x = (index: number) => 62 + index / Math.max(1, points.length - 1) * 602;
  const y = (value: number) => 226 - value / max * 192;
  const selectedIndex = hover ? points.findIndex(point => point.day === hover.day) : -1;
  const selected = points[selectedIndex];
  const selectedTotals = sumBuckets(buckets.filter(bucket => bucket.day === selected?.day));
  const allUnpriced = selectedTotals.records > 0 && selectedTotals.unpriced === selectedTotals.records;
  const tickStep = ticks[1] ?? 1; const tickPower = 10 ** Math.floor(Math.log10(tickStep));
  const tickDecimals = Math.min(8, Math.max(0, -Math.floor(Math.log10(tickStep))) + Number(tickStep / tickPower === 2.5));
  const label = (day: string, full = false) => hourly ? new Date(day).toLocaleString([], {
    ...(full ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', timeZone })
    : new Date(`${day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const choose = (index: number, keyboard: boolean) => {
    const point = points[Math.max(0, Math.min(points.length - 1, index))]; if (!point) return;
    setHover(current => current?.day === point.day && current.keyboard === keyboard ? current : { day: point.day, keyboard });
  };
  const positionTooltip = () => {
    if (!tooltip.current || !section.current) return;
    const rect = section.current.getBoundingClientRect();
    const width = tooltip.current.offsetWidth; const height = tooltip.current.offsetHeight;
    const cursor = hover?.keyboard ? { x: rect.left + x(selectedIndex) / 680 * rect.width, y: rect.top + 48 } : pointer.current;
    if (!cursor) return;
    let left = cursor.x - rect.left + 16;
    if (left + width > rect.width - 8) left = cursor.x - rect.left - width - 16;
    left = Math.max(8, Math.min(rect.width - width - 8, left));
    let top = cursor.y - rect.top + 16;
    if (rect.top + top + height > window.innerHeight - 12) top = cursor.y - rect.top - height - 16;
    top = Math.max(12 - rect.top, top);
    tooltip.current.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };
  // Move the existing card without rebuilding chart paths on each pointer pixel.
  useLayoutEffect(() => { positionTooltip(); });
  return <section ref={section} aria-label={`${hourly ? 'Hourly' : 'Daily'} ${mode} trend`} style={{ minWidth: 0, position: 'relative' }}>
    <h2 style={{ fontSize: 13.5, fontWeight: 400, marginTop: 0, marginBottom: 12 }}>{hourly ? 'Hourly' : 'Daily'} {mode === 'cost' ? 'API cost estimate' : 'processed tokens'}</h2>
    <svg viewBox="0 0 680 270" role="img" aria-label={`${hourly ? 'Hourly' : 'Daily'} ${mode} by CLI`} aria-describedby={`${id}-help`}
      tabIndex={0} onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect(); if (!rect.width) return;
        const position = (event.clientX - rect.left) / rect.width * 680;
        pointer.current = { x: event.clientX, y: event.clientY };
        positionTooltip();
        choose(Math.round((position - 62) / 602 * (points.length - 1)), false);
      }} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onKeyDown={event => {
        if (event.key === 'Escape') setHover(null);
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); choose(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
            : Math.max(0, selectedIndex) + (event.key === 'ArrowRight' ? 1 : -1), true);
        }
      }} style={{ display: 'block', width: '100%', overflow: 'visible', outlineColor: 'var(--t-accent)', borderRadius: 5 }}>
      <defs>{series.map(provider => <linearGradient key={provider.id} id={`${id}-${provider.id}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={provider.color} stopOpacity={0.12} /><stop offset="100%" stopColor={provider.color} stopOpacity={0.015} />
      </linearGradient>)}</defs>
      {ticks.map(value => <g key={value}>
        <line x1={62} x2={664} y1={y(value)} y2={y(value)} stroke="var(--t-divider)" strokeWidth={0.7} />
        <text x={49} y={y(value) + 4} textAnchor="end" fill="var(--t-text-muted)" fontSize={13}>{mode === 'cost' ? `$${value.toLocaleString(undefined, { maximumFractionDigits: tickDecimals })}` : count(value)}</text>
      </g>)}
      {series.map(provider => {
        const values = (point: UsageChartPoint) => y(point.values[provider.id] ?? 0);
        const shape = line<UsageChartPoint>().x((_, index) => x(index)).y(values).curve(curveMonotoneX)(points);
        const fill = area<UsageChartPoint>().x((_, index) => x(index)).y0(226).y1(values).curve(curveMonotoneX)(points);
        return <g key={provider.id} data-usage-series={provider.id}>
          <path d={fill ?? undefined} fill={`url(#${id}-${provider.id})`} />
          <path d={shape ?? undefined} fill="none" stroke={provider.color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </g>;
      })}
      {[0, Math.floor(points.length / 2), points.length - 1].filter((value, index, all) => all.indexOf(value) === index).map(index =>
        <text key={index} x={x(index)} y={254} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          fill="var(--t-text-muted)" fontSize={13}>{points[index] ? label(points[index].day) : ''}</text>)}
      {selected ? <g>
        <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1={34} y2={226} stroke="var(--t-text-muted)" strokeWidth={0.7} strokeDasharray="3 4" />
        {series.map(provider => <circle key={provider.id} cx={x(selectedIndex)} cy={y(selected.values[provider.id] ?? 0)} r={3.5}
          fill={provider.color} stroke="var(--t-chat-surface-bg)" strokeWidth={1.5} />)}
      </g> : null}
    </svg>
    <div id={`${id}-help`} style={{ fontSize: 9.5, color: 'var(--t-text-muted)', textAlign: 'right', marginTop: 1 }}>Hover or use ← → to explore</div>
    {selected ? <div ref={tooltip} role="status" aria-live={hover?.keyboard ? 'polite' : 'off'} data-usage-chart-tooltip style={{ position: 'absolute', zIndex: 2,
      top: 0, left: 0, pointerEvents: 'none',
      width: 196, maxWidth: 'calc(100% - 24px)', boxSizing: 'border-box', padding: 12, borderRadius: 9,
      background: 'var(--t-popover-surface)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      border: '1px solid var(--t-border)', boxShadow: 'var(--t-panel-shadow)', color: 'var(--t-text)', fontSize: 11,
      lineHeight: 1.4, fontVariantNumeric: 'tabular-nums' }}>
      <div style={{ color: 'var(--t-text-secondary)', marginBottom: 10 }}>{label(selected.day, true)}</div>
      {providers.filter(provider => buckets.some(bucket => bucket.provider === provider.id)).map(provider => {
        const day = sumBuckets(buckets.filter(bucket => bucket.provider === provider.id && bucket.day === selected.day));
        return <div key={provider.id}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 7 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ color: provider.color, display: 'flex' }}><UsageProviderMark provider={provider.id} size={12} /></span>{provider.name}</span>
        <span>{mode === 'cost' && day.records > 0 && day.unpriced === day.records ? 'Unpriced' : format(selected.values[provider.id] ?? 0)}</span>
      </div>; })}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--t-divider)' }}>
        <span>Total</span><span>{mode === 'cost' && allUnpriced ? 'Unpriced' : format(Object.values(selected.values).reduce<number>((sum, value) => sum + (value ?? 0), 0))}</span>
      </div>
      {mode === 'cost' && selectedTotals.unpriced > 0 ? <div style={{ fontSize: 9.5, color: 'var(--t-text-muted)', marginTop: 7 }}>Requests without known prices are excluded.</div> : null}
    </div> : null}
  </section>;
}
