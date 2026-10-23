'use client';

import { useEffect, useState } from 'react';
import type { UsageHistorySummary } from '@/lib/usage/history-types';
import { UsageProviderMark } from './UsageProviderMark';

export function TodayCacheShare({ snapshot, loading, error }: {
  snapshot: UsageHistorySummary | null; loading: boolean; error: string | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const timeZone = snapshot?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = calendar.format(now);
  const current = snapshot && Number.isFinite(Date.parse(snapshot.observedAt))
    && calendar.format(Date.parse(snapshot.observedAt)) === today && calendar.format(snapshot.until) === today;

  return <section aria-label="Today's cache share" style={{ display: 'grid', gap: 12, paddingTop: 16,
    borderTop: '1px solid var(--t-divider-subtle)', color: 'var(--t-text)' }}>
    <h2 style={{ margin: 0, fontSize: 13, fontWeight: 400 }}>Today&apos;s cache share</h2>
    <p style={{ margin: 0, color: 'var(--t-text-muted)', fontSize: 11, lineHeight: 1.5 }}>
      This machine · {today} · {timeZone}. Input served from cache, across local CLI sessions and models.
    </p>
    {(['claude', 'codex'] as const).map(provider => {
      const name = provider === 'claude' ? 'Claude' : 'Codex';
      const source = snapshot?.sources.find(item => item.provider === provider);
      const buckets = current ? snapshot.buckets.filter(bucket => bucket.provider === provider && bucket.day === today) : [];
      let cached = 0; let input = 0;
      for (const bucket of buckets) {
        cached += bucket.totals.cachedInputTokens;
        input += bucket.totals.uncachedInputTokens + bucket.totals.cachedInputTokens + bucket.totals.cacheCreationTokens;
      }
      const unavailable = !source || source.status === 'missing' || !Number.isFinite(input) || !Number.isFinite(cached) || input < cached || cached < 0;
      const value = !snapshot ? loading ? 'Reading local history…' : 'History unavailable'
        : !current ? 'No observation for today'
          : unavailable ? 'History unavailable'
            : input === 0 ? 'No input observed today'
              : new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(cached / input);
      return <div key={provider} aria-label={`${name} cache share today`}
        style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, flexWrap: 'wrap' }}>
        <UsageProviderMark provider={provider} size={14} /><span>{name}</span>
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {current && source?.status === 'partial' ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>Partial history</span> : null}
      </div>;
    })}
    {snapshot ? <span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>
      Observed {new Date(snapshot.observedAt).toLocaleString([], { timeZone })}. Cache creation counts as input, not a cache hit.
    </span> : null}
    {error ? <p role="status" style={{ margin: 0, color: 'var(--t-text-muted)', fontSize: 11 }}>{error}</p> : null}
  </section>;
}
