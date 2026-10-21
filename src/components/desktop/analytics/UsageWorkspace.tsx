'use client';
import { lazy, Suspense, useState } from 'react';
import { RuntimeUsageSummary } from './RuntimeUsageSummary';
import { useRuntimeUsage } from './use-runtime-usage';
import { useUsageHistory } from './use-usage-history';
import { useUsageMachines } from './use-usage-machines';
import { UsageControl } from './UsageControl';
import { UsageHistoryPanel } from './UsageHistoryPanel';
import { providers } from './history-view';
import type { UsageProviderKind } from '@/lib/usage/history-types';

const AnalyticsPage = lazy(() => import('../AnalyticsPage'));
const views = ['cost', 'tokens', 'limits', 'activity'] as const;
export function UsageWorkspace({ active = true }: { active?: boolean }) {
  const [view, setView] = useState<typeof views[number]>('limits');
  const [days, setDays] = useState<1 | 7 | 30 | 90>(30);
  const [provider, setProvider] = useState<UsageProviderKind | 'all'>('all');
  const [machine, setMachine] = useState('local');
  const historyView = view === 'cost' || view === 'tokens';
  const inventory = useUsageMachines(active && historyView);
  const capacity = useRuntimeUsage(active && view === 'limits');
  const history = useUsageHistory(active && historyView, days, machine);
  const loading = view === 'limits' ? capacity.loading : history.loading;
  const error = view === 'limits' ? capacity.error : historyView ? history.error : null;
  return <div data-mcp-scope="usage-workspace" style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none',
    paddingTop: 20, paddingRight: 28, paddingBottom: 40, paddingLeft: 28, background: 'transparent',
    fontFamily: 'var(--font-sans-system)', color: 'var(--t-text)', fontWeight: 300 }}>
    <div style={{ maxWidth: 1080, marginRight: 'auto', marginLeft: 'auto', display: 'grid', gap: 30 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 14, fontWeight: 400 }}>Usage</h1>
          <span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>/</span>
          {historyView ? <select aria-label="Usage machine" value={machine} onChange={event => setMachine(event.target.value)}
            style={{ fontSize: 12, fontFamily: 'inherit', fontWeight: 300, color: 'var(--t-text-secondary)', background: 'transparent',
              border: 'none', borderRadius: 5, height: 28, maxWidth: 220, outlineColor: 'var(--t-accent)', cursor: 'pointer' }}>
            {inventory.machines.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.local ? 'This machine' : item.label}{!item.enabled ? ' · disabled' : ''}</option>)}
          </select> : <span style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{view === 'limits' ? 'Connected accounts' : 'This machine'}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div role="tablist" aria-label="Usage views" style={{ display: 'flex', gap: 2 }}>
            {views.map(item => <UsageControl key={item} role="tab" id={`usage-${item}-tab`} selected={view === item}
              tabIndex={view === item ? 0 : -1} aria-selected={view === item} aria-controls={`usage-${item}-panel`} onClick={() => setView(item)}
              onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1
                  : (views.indexOf(item) + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length;
                const next = views[index]; setView(next); document.getElementById(`usage-${next}-tab`)?.focus();
              } }}>{item === 'activity' ? 'o8 outcomes' : item[0].toUpperCase() + item.slice(1)}</UsageControl>)}
          </div>
          {historyView ? <div aria-label="Usage date range" style={{ display: 'flex', gap: 2 }}>
            {([1, 7, 30, 90] as const).map(value => <UsageControl key={value} selected={days === value} aria-pressed={days === value}
              onClick={() => setDays(value)}>{value === 1 ? 'Past 24h' : `${value} days`}</UsageControl>)}
          </div> : null}
          {view !== 'activity' ? <UsageControl aria-label="Refresh usage" description={loading ? 'Reading usage…' : 'Refresh usage'}
            disabled={loading} onClick={() => { void (view === 'limits' ? capacity.refresh(true) : history.refresh(true)); }} style={{ width: 28, paddingLeft: 0, paddingRight: 0 }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.5 4.4M17.9 17.9A8 8 0 0 1 4.4 13.5" />
            </svg>
          </UsageControl> : null}
        </div>
      </header>
      {historyView && inventory.error ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>{inventory.error}</p> : null}
      {error ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-muted)' }}>{error}</p> : null}
      {view === 'limits' ? <section role="tabpanel" id="usage-limits-panel" aria-labelledby="usage-limits-tab" style={{ display: 'grid', gap: 20 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--t-text-secondary)' }}>Your connected accounts’ allowances and reset times.</p>
        {!capacity.snapshot && loading ? <span role="status" style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Reading connected accounts…</span> : null}
        <RuntimeUsageSummary snapshot={capacity.snapshot} />
        <p style={{ margin: 0, fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Allowances are shared across the account. Token activity is shown separately when an account does not report its limits.</p>
      </section> : historyView ? <section role="tabpanel" id={`usage-${view}-panel`} aria-labelledby={`usage-${view}-tab`} style={{ display: 'grid', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--t-text-muted)' }}>
          <select aria-label="CLI provider" value={provider} onChange={event => setProvider(event.target.value as typeof provider)}
            style={{ border: '1px solid var(--t-border)', borderRadius: 7, height: 28, paddingLeft: 8, paddingRight: 8, font: 'inherit',
              background: 'var(--t-bg-card)', color: 'var(--t-text-secondary)', outlineColor: 'var(--t-accent)' }}>
            <option value="all">All CLIs</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {history.snapshot ? <span>{new Date(history.snapshot.since).toLocaleDateString([], { month: 'short', day: 'numeric' })} – {new Date(history.snapshot.until).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span> : null}
          {history.loading ? <span role="status">{history.snapshot ? 'Refreshing history…' : `Reading ${machine === 'local' ? 'local' : inventory.machines.find(item => item.id === machine)?.label ?? 'machine'} CLI history…`}</span> : null}
        </div>
        {history.snapshot ? <UsageHistoryPanel snapshot={history.snapshot} mode={view} provider={provider} /> : null}
      </section> : <section role="tabpanel" id="usage-activity-panel" aria-labelledby="usage-activity-tab">
        <Suspense fallback={<span style={{ color: 'var(--t-text-muted)', fontSize: 12 }}>Loading outcomes…</span>}><AnalyticsPage embedded active={active} /></Suspense>
      </section>}
    </div>
  </div>;
}
