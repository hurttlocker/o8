'use client';

import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import type { RuntimeCapacityBucket, RuntimeCapacitySnapshot } from '@/lib/runtimes/types';
import { formatTokens } from '@/lib/util/format-tokens';
import { UsageProviderMark } from './UsageProviderMark';

function runtimeName(runtime: string): string {
  return runtime === 'codex' ? 'Codex' : runtime === 'claude-code' ? 'Claude' : runtime;
}
function resetLabel(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
function stateLabel(capacity: RuntimeCapacitySnapshot): string {
  if (capacity.status === 'stale') return 'Last observation · stale';
  if (capacity.confidence === 'exact') return 'Subscription limits';
  if (capacity.buckets.some(bucket => bucket.unit === 'tokens')) return 'Local activity · quota not reported';
  if (capacity.reason === 'subscription_limits_unsupported') return 'No subscription limits';
  return 'Not available';
}
function valueLabel(bucket: RuntimeCapacityBucket): string {
  if (typeof bucket.usedRatio === 'number') return `${Math.round(bucket.usedRatio * 100)}% used`;
  if (typeof bucket.used === 'number' && bucket.unit === 'tokens') return `${formatTokens(bucket.used)} tokens`;
  if (typeof bucket.remaining === 'number') return `${bucket.remaining} remaining`;
  return 'Not reported';
}

export function RuntimeUsageSummary({ snapshot, compact = false }: {
  snapshot: RuntimeCapacityControlSnapshot | null; compact?: boolean;
}) {
  return <div data-runtime-usage-summary style={{ display: 'grid', gap: compact ? 14 : 24,
    gridTemplateColumns: compact ? undefined : 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
    fontFamily: 'var(--font-sans-system)', fontWeight: 300, color: 'var(--t-text)' }}>
    {snapshot?.capacities.map((capacity, index) => {
      const identity = snapshot.identities?.find(candidate => candidate.id === capacity.identityId);
      const observed = resetLabel(capacity.observedAt);
      return <section key={`${capacity.runtime}:${capacity.identityId ?? index}`} aria-label={`${runtimeName(capacity.runtime)} usage`}
        style={{ display: 'grid', alignContent: 'start', gap: 12, paddingTop: 14, borderTop: '1px solid var(--t-divider-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5 }}>
          {capacity.runtime === 'codex' || capacity.runtime === 'claude-code' ? <UsageProviderMark provider={capacity.runtime === 'codex' ? 'codex' : 'claude'} size={14} /> : null}
          <span>{runtimeName(capacity.runtime)}{identity ? ` · ${identity.label}` : ''}</span>
        </div>
        <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{stateLabel(capacity)}</span>
        {capacity.buckets.map(bucket => {
          const reset = capacity.confidence === 'exact' ? resetLabel(bucket.resetsAt) : null;
          const percent = typeof bucket.usedRatio === 'number' ? Math.max(0, Math.min(100, bucket.usedRatio * 100)) : null;
          return <div key={bucket.id} style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: compact ? 11 : 12 }}>
              <span style={{ color: 'var(--t-text-secondary)' }}>{bucket.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{valueLabel(bucket)}</span>
            </div>
            {percent !== null ? <div role="progressbar" aria-label={`${runtimeName(capacity.runtime)} ${bucket.label} used`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
              style={{ height: compact ? 3 : 4, borderRadius: 2, background: 'var(--t-divider-subtle)', overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', background: percent >= 80 ? 'var(--t-brand-orange)' : 'var(--t-accent)' }} />
            </div> : null}
            {reset ? <span style={{ fontSize: 9.5, color: 'var(--t-text-muted)' }}>Resets {reset}</span> : null}
          </div>;
        })}
        {capacity.buckets.length === 0 ? <span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>
          {capacity.reason === 'subscription_limits_unsupported' ? 'This login does not report plan allowances.' : 'No usage windows were reported. Refresh to try again.'}
        </span> : null}
        {!compact && observed ? <span style={{ fontSize: 9.5, color: 'var(--t-text-muted)' }}>Observed {observed}</span> : null}
      </section>;
    })}
    {snapshot?.capacities.length === 0 ? <span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>No connected runtime reports usage yet.</span> : null}
  </div>;
}
