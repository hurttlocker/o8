'use client';

import { lazy, Suspense, useState } from 'react';
import { RuntimeUsageSummary } from './RuntimeUsageSummary';
import { useRuntimeUsage } from './use-runtime-usage';

const AnalyticsPage = lazy(() => import('../AnalyticsPage'));

export function UsageWorkspace({ active = true }: { active?: boolean }) {
  const [view, setView] = useState<'limits' | 'activity'>('limits');
  const { snapshot, loading, error, refresh } = useRuntimeUsage(active && view === 'limits');
  return <div data-mcp-scope="usage-workspace" style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none',
    paddingTop: 28, paddingRight: 28, paddingBottom: 40, paddingLeft: 28, background: 'transparent',
    fontFamily: 'var(--font-sans-system)', color: 'var(--t-text)', fontWeight: 300 }}>
    <div style={{ maxWidth: 980, marginRight: 'auto', marginLeft: 'auto', display: 'grid', gap: 24 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 400, letterSpacing: '-0.2px' }}>Usage</h1>
        <div role="tablist" aria-label="Usage views" style={{ display: 'flex', gap: 4 }}>
          {(['limits', 'activity'] as const).map(item => <button key={item} type="button" role="tab" id={`usage-${item}-tab`}
            tabIndex={view === item ? 0 : -1} aria-selected={view === item} aria-controls={`usage-${item}-panel`} onClick={() => setView(item)}
            onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault(); const next = item === 'limits' ? 'activity' : 'limits'; setView(next);
              document.getElementById(`usage-${next}-tab`)?.focus();
            } }}
            style={{ border: 0, borderRadius: 7, height: 26, paddingRight: 12, paddingLeft: 12, font: 'inherit', fontSize: 12,
              background: view === item ? 'var(--t-input-bg)' : 'transparent', color: view === item ? 'var(--t-text)' : 'var(--t-text-muted)', cursor: 'pointer' }}>
            {item === 'limits' ? 'Limits' : 'Activity'}
          </button>)}
        </div>
      </header>
      {view === 'limits' ? <section role="tabpanel" id="usage-limits-panel" aria-labelledby="usage-limits-tab" style={{ display: 'grid', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>Your connected accounts’ allowances and reset times.</p>
          <button type="button" onClick={() => { void refresh(true); }} disabled={loading}
            style={{ border: 0, borderRadius: 7, height: 28, paddingRight: 12, paddingLeft: 12, font: 'inherit', fontSize: 12,
              background: 'var(--t-input-bg)', color: 'var(--t-text)', cursor: loading ? 'wait' : 'pointer' }}>{loading ? 'Refreshing…' : 'Refresh usage'}</button>
        </div>
        {!snapshot && loading ? <span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Reading connected accounts…</span> : null}
        <RuntimeUsageSummary snapshot={snapshot} />
        {error ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>{error}</p> : null}
        <p style={{ margin: 0, fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Allowances are shared across the account. Token activity is shown separately when an account does not report its limits.</p>
      </section> : <section role="tabpanel" id="usage-activity-panel" aria-labelledby="usage-activity-tab">
        <Suspense fallback={<span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Loading activity…</span>}><AnalyticsPage embedded active={active} /></Suspense>
      </section>}
    </div>
  </div>;
}
