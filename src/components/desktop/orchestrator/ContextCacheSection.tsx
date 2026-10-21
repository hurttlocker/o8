'use client';

import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { formatTokens } from '@/lib/util/format-tokens';

export interface ContextCacheReuse {
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  percent: number;
}

/** Terminal usage is normalized to uncached input, cache read, and cache write. */
export function latestContextCacheReuse(messages: readonly MobileTranscriptEntry[]): ContextCacheReuse | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry.role !== 'assistant' || !entry.tokens) continue;
    const usage = entry.tokens;
    // Older transcripts can contain input/output without cache telemetry.
    if (usage.cacheRead === undefined && usage.cacheWrite === undefined) return null;
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const readTokens = count(usage.cacheRead);
    const writeTokens = count(usage.cacheWrite);
    const promptTokens = count(usage.input) + readTokens + writeTokens;
    if (!promptTokens) return null;
    return { promptTokens, readTokens, writeTokens, percent: Math.round(readTokens / promptTokens * 100) };
  }
  return null;
}

export function ContextCacheSection({ reuse }: { reuse: ContextCacheReuse | null }) {
  return <div data-testid="context-cache-section" style={{ borderTop: '1px solid var(--t-border)', paddingTop: 12, paddingRight: 14, paddingBottom: 12, paddingLeft: 14 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--t-text)' }}>
      <span>Prompt cache</span><span data-testid="context-cache-reuse" style={{ color: reuse ? 'var(--t-accent)' : 'var(--t-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{reuse ? `${reuse.percent}% reused` : 'Awaiting usage'}</span>
    </div>
    {reuse ? <div style={{ height: 5, borderRadius: 999, background: 'var(--t-divider-subtle)', marginTop: 9, marginBottom: 9, overflow: 'hidden' }}><div style={{ height: '100%', width: `${reuse.percent}%`, borderRadius: 999, background: 'var(--t-accent)' }} /></div> : null}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: reuse ? 0 : 7, color: 'var(--t-text-muted)', fontSize: 10.5, lineHeight: '15px' }}>
      <span>{reuse ? `${formatTokens(reuse.readTokens)} of ${formatTokens(reuse.promptTokens)} input · last reported turn` : 'Available after a provider reports cache usage.'}</span>
    </div>
    <div style={{ marginTop: 6, color: 'var(--t-text-faint)', fontSize: 10.5, lineHeight: '15px' }}>Expiry is not reported in this transcript. Reuse shows the last response, not whether the next prompt is still warm.</div>
  </div>;
}
