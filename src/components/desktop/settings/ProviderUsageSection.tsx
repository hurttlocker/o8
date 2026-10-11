'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicRuntimeIdentity } from '@/lib/runtime/identity-catalog';
import type { RuntimeCapacitySnapshot } from '@/lib/runtimes/types';
import { SettingsGroup } from './grouped';
import { RamsButton } from './shared';

/** Account limits are observations, never inferred from local token totals. */
export function ProviderUsageSection({ runtimeId, label }: { runtimeId: string; label: string }) {
  const [snapshots, setSnapshots] = useState<RuntimeCapacitySnapshot[]>([]);
  const [identities, setIdentities] = useState<PublicRuntimeIdentity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const supported = runtimeId === 'codex' || runtimeId === 'claude-code';
  const refresh = useCallback(async (fresh = false) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/runtime/capacity${fresh ? '?fresh=1' : ''}`, { cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error('Usage unavailable');
      const payload = await response.json();
      if (payload.schema !== 'o8/runtime-capacity-control/v1' || !Array.isArray(payload.capacities)) throw new Error('Usage unavailable');
      const matching: RuntimeCapacitySnapshot[] = payload.capacities.filter((snapshot: RuntimeCapacitySnapshot | null) => snapshot?.runtime === runtimeId);
      if (matching.some(snapshot => !['available', 'stale', 'unavailable', 'malformed'].includes(snapshot.status) || !Array.isArray(snapshot.buckets) || snapshot.buckets.some(bucket => !bucket || typeof bucket.id !== 'string' || typeof bucket.label !== 'string'))) throw new Error('Usage unavailable');
      if (!request.signal.aborted) {
        setSnapshots(matching);
        setIdentities(Array.isArray(payload.identities) ? payload.identities.filter((identity: PublicRuntimeIdentity | null) => identity?.runtime === runtimeId && typeof identity.label === 'string') : []);
      }
    } catch {
      if (!request.signal.aborted) setError('Could not refresh account usage');
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [runtimeId]);

  useEffect(() => {
    setSnapshots([]);
    if (supported) void refresh();
    return () => controller.current?.abort();
  }, [refresh, supported]);

  return <SettingsGroup header={`${label} account usage`}>
    <div style={{ padding: 16, fontSize: 13, lineHeight: 1.55, color: 'var(--t-text-secondary)' }}>
      {supported ? <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <span>{loading ? 'Checking account limits…' : 'Reported account limits'}</span>
          <RamsButton disabled={loading} onClick={() => { void refresh(true); }}>{loading ? 'Checking…' : 'Refresh'}</RamsButton>
        </div>
        {error ? <p role="alert" style={{ marginTop: 0, color: 'var(--t-text)' }}>{error}. Previous observations may be out of date.</p> : null}
        {!loading && snapshots.length === 0 ? <p style={{ margin: 0 }}>Account limits are not available yet.</p> : null}
        {snapshots.map((snapshot, index) => <div key={`${snapshot.identityId ?? 'default'}-${index}`} style={{ marginTop: index ? 16 : 0 }}>
          <div style={{ color: 'var(--t-text)', marginBottom: 6 }}>
            {snapshot.identityId ? identities.find(identity => identity.id === snapshot.identityId)?.label ?? 'Account identity not reported' : 'Default CLI account'}
            {identities.some(identity => identity.id === snapshot.identityId && identity.selected) ? ' · Selected' : ''}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t-text-muted)', marginBottom: 8 }}>
            {error || snapshot.status === 'stale' ? 'Stale observation' : snapshot.status === 'available' ? 'Account observation' : 'Account limits unavailable'}
            {snapshot.observedAt ? ` · ${new Date(snapshot.observedAt).toLocaleString()}` : ''}
          </div>
          {snapshot.buckets.map(bucket => {
            const ratio = bucket.usedRatio;
            const known = snapshot.status !== 'unavailable' && snapshot.status !== 'malformed' && typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
            const reset = bucket.resetsAt ? new Date(bucket.resetsAt) : null;
            return <div key={bucket.id} style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--t-text)' }}>{bucket.label}</span>
                <span>{known ? `${Math.round(ratio * 100)}% used` : 'Usage not reported'}</span>
              </div>
              {known ? <div role="meter" aria-label={`${bucket.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} style={{ height: 4, background: 'var(--t-panel-border)', borderRadius: 4, marginTop: 8, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${ratio * 100}%`, background: 'var(--t-text-secondary)' }} />
              </div> : null}
              <div style={{ fontSize: 12, color: 'var(--t-text-muted)', marginTop: 6 }}>{reset && Number.isFinite(reset.getTime()) ? `Resets ${reset.toLocaleString()}` : 'No reset reported'}</div>
            </div>;
          })}
          <div style={{ fontSize: 12, color: 'var(--t-text-muted)', marginTop: 10 }}>{snapshot.confidence === null ? 'Confidence not reported' : snapshot.confidence === 'estimated' ? 'Estimated' : snapshot.confidence === 'exhausted-only' ? 'Exhaustion signal only' : 'Reported'} · {snapshot.source ?? 'Source not reported'}</div>
        </div>)}
      </> : <>
        <p style={{ marginTop: 0 }}>Account limits are not reported by this connection</p>
        {runtimeId === 'cursor' ? <a href="https://cursor.com/dashboard/usage" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--t-text)' }}>Open Cursor account usage <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ verticalAlign: 'middle' }}><path d="M7 17 17 7M7 7h10v10" /></svg></a> : null}
      </>}
    </div>
  </SettingsGroup>;
}
