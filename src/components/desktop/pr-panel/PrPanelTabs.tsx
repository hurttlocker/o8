'use client';

import { memo, useRef, type KeyboardEvent } from 'react';
import { CheckCircle2, Clock, XCircle } from '../lucide-shims';
import { summarizeChecks } from './check-status';
import type { PrCheck, PrTabId } from './types';

export const PrPanelTabs = memo(function PrPanelTabs({ activeTab, onChange, changesCount, reviewsCount, checks, idBase }: {
  activeTab: PrTabId; onChange: (tab: PrTabId) => void; changesCount: number; reviewsCount: number; checks: PrCheck[]; idBase: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const status = summarizeChecks(checks);
  const tabs: Array<{ id: PrTabId; label: string; count?: number }> = [
    { id: 'summary', label: 'Summary' }, { id: 'timeline', label: 'Timeline' }, { id: 'changes', label: 'Changes', count: changesCount },
    { id: 'checks', label: 'Checks', count: status.failing || undefined }, { id: 'reviews', label: 'Reviews', count: reviewsCount || undefined },
  ];
  const Icon = status.tone === 'failure' ? XCircle : status.tone === 'pending' ? Clock : CheckCircle2;
  const statusColor = status.tone === 'failure' ? 'var(--t-danger)' : status.tone === 'success' ? 'var(--t-success)' : 'var(--t-text-muted)';
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = Array.from(group.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id); buttons[next]?.focus();
  };
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingTop: 10, paddingRight: 18, paddingBottom: 10, paddingLeft: 18, flexShrink: 0 }}>
    <div ref={group} role="tablist" aria-label="Pull request details" onKeyDown={onKeyDown} style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', width: 'fit-content', maxWidth: '100%', flexShrink: 0, borderRadius: 18, padding: 4, border: '1px solid var(--t-border)', background: 'var(--t-hover)' }}>
      {tabs.map((tab) => <button key={tab.id} id={`${idBase}-${tab.id}`} role="tab" type="button" aria-selected={activeTab === tab.id} aria-controls={`${idBase}-${tab.id}-panel`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => onChange(tab.id)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 30, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, border: 0, borderRadius: 14, background: activeTab === tab.id ? 'var(--t-input-bg)' : 'transparent', color: tab.id === 'checks' && status.failing ? 'var(--t-danger)' : activeTab === tab.id ? 'var(--t-text)' : 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }}>
        {tab.id === 'checks' && status.failing ? <XCircle size={13} aria-hidden="true" /> : null}{tab.label}{tab.count ? <span style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{tab.count}</span> : null}
      </button>)}
    </div>
    <button type="button" onClick={() => onChange('checks')} aria-label={`View checks: ${status.label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap', border: 0, padding: 0, background: 'transparent', fontFamily: 'inherit', fontSize: 11, color: statusColor, cursor: 'pointer', minHeight: 22 }}>
      {status.total ? <Icon size={13} aria-hidden="true" /> : null}{status.label}
    </button>
  </div>;
});
