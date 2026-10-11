'use client';

import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { GitPullRequest, X } from '../lucide-shims';
import type { RightPrTab } from './useRightPrTabs';

export function RightPrTabs({ tabs, activeId, onSelect, onClose }: { tabs: RightPrTab[]; activeId: string | null; onSelect: (tab: RightPrTab) => void; onClose: (tab: RightPrTab) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = Array.from(strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (Math.max(index, 0) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    if (tabs[next]) { onSelect(tabs[next]); buttons[next]?.focus(); }
  };
  if (!tabs.length) return null;
  return <div ref={strip} data-right-pr-tabs role="tablist" aria-label="Open pull requests" onKeyDown={onKeyDown} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none', overscrollBehavior: 'contain' }}>
    {tabs.map((tab, index) => <div key={tab.id} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, borderRadius: 7, background: activeId === tab.id ? 'var(--t-input-bg)' : 'transparent' }}>
      <button type="button" role="tab" aria-selected={activeId === tab.id} aria-controls="right-pr-detail" tabIndex={activeId === tab.id || (!activeId && index === 0) ? 0 : -1} title={`${tab.repo || 'Pull request'} #${tab.number}`} aria-label={`PR #${tab.number}${tab.repo ? ` in ${tab.repo}` : ''}`} onClick={() => onSelect(tab)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 28, paddingTop: 0, paddingRight: 2, paddingBottom: 0, paddingLeft: 8, border: 0, borderRadius: 7, background: 'transparent', color: activeId === tab.id ? 'var(--t-text)' : 'var(--t-text-muted)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }}><GitPullRequest size={12} aria-hidden="true" />#{tab.number}</button>
      <button type="button" onClick={() => onClose(tab)} aria-label={`Close PR #${tab.number}${tab.repo ? ` in ${tab.repo}` : ''}`} style={{ width: 24, height: 28, display: 'grid', placeItems: 'center', padding: 0, border: 0, borderRadius: 6, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer' }}><X size={10} aria-hidden="true" /></button>
    </div>)}
  </div>;
}
