'use client';

import { useEffect, useState } from 'react';

interface WorkTotals {
  calls: number;
  failedCalls: number;
  reportedUsd: number;
  estimatedUsd: number;
  unlabeledUsd: number;
  unknownCostCalls: number;
  unknownReservedUsd: number;
}

interface WorkGroup extends WorkTotals { key: string }

export interface OpenRouterWorkView {
  days: number;
  lastCallAt: string | null;
  totals: WorkTotals;
  bySource: WorkGroup[];
}

const money = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line per cost basis. Bases are never added together, and unknown cost is never shown as zero. */
export function openRouterWorkLines(totals: WorkTotals): string[] {
  return [
    `${money(totals.reportedUsd)} reported by OpenRouter across ${plural(totals.calls, 'call')}`,
    totals.estimatedUsd > 0 ? `${money(totals.estimatedUsd)} estimated by o8 where OpenRouter reported no cost` : null,
    totals.unlabeledUsd > 0 ? `${money(totals.unlabeledUsd)} recorded without a cost source` : null,
    totals.unknownCostCalls > 0
      ? `${plural(totals.unknownCostCalls, 'call')} with unknown cost${totals.unknownReservedUsd > 0 ? ` (at most ${money(totals.unknownReservedUsd)} reserved)` : ''}`
      : null,
    totals.failedCalls > 0 ? `${plural(totals.failedCalls, 'call')} failed` : null,
  ].filter((line): line is string => Boolean(line));
}

/** OpenRouter calls o8 made itself (#3481). A different scope from the key figures above. */
export function OpenRouterWorkSection() {
  const [work, setWork] = useState<OpenRouterWorkView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let requestSequence = 0;
    const load = async () => {
      const request = ++requestSequence;
      try {
        const response = await fetch('/api/v2/keys/openrouter/work?days=30', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not read o8\'s OpenRouter usage.');
        const payload = await response.json() as Partial<OpenRouterWorkView> | null;
        if (!payload?.totals || !Array.isArray(payload.bySource) || typeof payload.days !== 'number') {
          throw new Error('Could not read o8\'s OpenRouter usage.');
        }
        if (!cancelled && request === requestSequence) { setWork(payload as OpenRouterWorkView); setError(null); }
      } catch (cause) {
        if (!cancelled && request === requestSequence) {
          setError(cause instanceof Error ? cause.message : 'Could not read o8\'s OpenRouter usage.');
        }
      }
    };
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('o8:openrouter-connection-changed', refresh);
    return () => { cancelled = true; window.removeEventListener('o8:openrouter-connection-changed', refresh); };
  }, []);

  if (!work) {
    return error ? <p role="alert" style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{error}</p> : null;
  }

  const sources = work.bySource
    .filter(group => group.calls > 0)
    .map(group => `${group.key} ${money(group.reportedUsd)}${group.unknownCostCalls > 0 ? ` + ${plural(group.unknownCostCalls, 'unknown')}` : ''}`);
  const last = work.lastCallAt ? new Date(work.lastCallAt) : null;

  return <section aria-label="Work run by o8" style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <span style={{ fontSize: 13, color: 'var(--t-text)', fontWeight: 300 }}>Work run by o8</span>
    {error ? <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
      {error} These figures are stale.
    </p> : null}
    {work.totals.calls === 0
      ? <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>o8 made no OpenRouter calls in the last {work.days} days.</p>
      : <>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
          Last {work.days} days: {openRouterWorkLines(work.totals).join(' · ')}.
        </p>
        {sources.length ? <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.55 }}>{sources.join(' · ')}</p> : null}
        {last && !Number.isNaN(last.getTime()) ? <span style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Last call {last.toLocaleString()}</span> : null}
      </>}
    <p style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.55 }}>
      Counted from o8&apos;s own receipts. The key figures above also include use outside o8, so the two are not added together.
    </p>
  </section>;
}
