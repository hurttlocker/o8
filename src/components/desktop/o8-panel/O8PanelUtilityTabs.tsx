'use client';

import { useCallback, useRef, useState } from 'react';
import { CircleSpark, DoubleCheck, Folder, Internet } from 'iconoir-react';
import { Terminal as TablerTerminal } from '@/components/desktop/tabler-shims';
import type { O8Tab, RightUtilityTab } from './types';
export type { RightUtilityTab } from './types';

function FilesIcon({ size = 18 }: { size?: number }) {
  return <Folder width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

export function ChatIcon({ size = 18 }: { size?: number }) {
  return <CircleSpark width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

function BrowserIcon({ size = 18 }: { size?: number }) {
  return <Internet width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

export function ReviewIcon({ size = 18 }: { size?: number }) {
  return <DoubleCheck width={size} height={size} color="currentColor" strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

export function TerminalIcon({ size = 18 }: { size?: number }) {
  return <TablerTerminal size={size} strokeWidth={1.6} style={{ display: 'block', flexShrink: 0 }} />;
}

function InboxIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}


interface RightUtilityDefinition {
  id: RightUtilityTab;
  label: string;
  description: string;
  icon: (props: { size?: number }) => React.ReactNode;
}

const RIGHT_UTILITY_TABS: RightUtilityDefinition[] = [
  { id: 'files', label: 'Files', description: 'Browse project files', icon: FilesIcon },
  { id: 'side-chat', label: 'Side chat', description: 'Start a side conversation', icon: ChatIcon },
  { id: 'browser', label: 'Browser', description: 'Open a website', icon: BrowserIcon },
  { id: 'review', label: 'Review', description: 'View code changes', icon: ReviewIcon },
  { id: 'terminal', label: 'Terminal', description: 'Start an interactive shell', icon: TerminalIcon },
  { id: 'inbox', label: 'Needs Attention', description: 'Approvals, follow-ups, and agent failures', icon: InboxIcon },
];

const RIGHT_UTILITY_BY_ID = Object.fromEntries(
  RIGHT_UTILITY_TABS.map((tab) => [tab.id, tab]),
) as Record<RightUtilityTab, RightUtilityDefinition>;

export function RightUtilityTabStrip({
  tabs,
  activeTab,
  inHeader = false,
  onOpenLauncher,
  onSelect,
  onClose,
}: {
  tabs: RightUtilityTab[];
  activeTab: O8Tab;
  inHeader?: boolean;
  onOpenLauncher: () => void;
  onSelect: (tab: RightUtilityTab) => void;
  onClose: (tab: RightUtilityTab) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const closeTab = (tab: RightUtilityTab) => {
    const list = stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const index = tabs.indexOf(tab);
    const next = activeTab === tab ? list?.[index + 1] ?? list?.[index - 1] : stripRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    next?.focus();
    if (!next) stripRef.current?.querySelector<HTMLButtonElement>('[aria-label="Open right panel tab picker"]')?.focus();
    onClose(tab);
  };
  return (
    <div ref={stripRef} data-no-drag style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1, minHeight: inHeader ? 28 : 34, paddingTop: inHeader ? 0 : 4, paddingRight: inHeader ? 0 : 8, paddingBottom: inHeader ? 0 : 4, paddingLeft: inHeader ? 0 : 8, borderBottom: inHeader ? 'none' : '1px solid var(--t-divider)', background: inHeader ? 'transparent' : 'var(--t-bg)' }}>
      <div role="tablist" aria-label="Right panel tabs" style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}>
        {tabs.map((tab) => {
          const def = RIGHT_UTILITY_BY_ID[tab];
          const active = activeTab === tab;
          return (
            <div key={tab} style={{ display: 'inline-flex', alignItems: 'center', height: 28, flexShrink: 0, borderRadius: 7, background: active ? 'var(--t-panel-hover)' : 'transparent', color: active ? 'var(--t-text)' : 'var(--t-text-muted)' }}>
              <button type="button" role="tab" aria-label={def.label} aria-selected={active} tabIndex={active ? 0 : -1} onClick={() => onSelect(tab)}
                onKeyDown={(event) => {
                  if (event.key === 'Delete') { event.preventDefault(); closeTab(tab); return; }
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const index = tabs.indexOf(tab);
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                  onSelect(tabs[next]);
                  stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
                style={{ height: 28, display: 'inline-flex', alignItems: 'center', gap: 6, paddingTop: 0, paddingRight: 5, paddingBottom: 0, paddingLeft: 8, borderRadius: 7, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'var(--font-sans-system)' }}
                onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}>
                {def.icon({ size: 13 })}
                <span style={{ fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', whiteSpace: 'nowrap' }}>{def.label}</span>
              </button>
              <button type="button" aria-label={`Close ${def.label} tab`} onClick={() => closeTab(tab)} style={{ width: 20, height: 24, borderRadius: 5, border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer' }}>
                <XIcon size={10} />
              </button>
            </div>
          );
        })}
        {activeTab === 'launcher' ? <button type="button" role="tab" aria-selected="true" onClick={onOpenLauncher}
          onKeyDown={(event) => {
            if (!tabs.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'ArrowLeft' || event.key === 'End' ? tabs.length - 1 : 0;
            onSelect(tabs[next]); stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
          style={{ height: 28, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, border: 'none', borderRadius: 7, flexShrink: 0, background: 'var(--t-panel-hover)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300 }}>New tab</button> : null}
      </div>
      <button type="button" onClick={onOpenLauncher} aria-label="Open right panel tab picker" title="New tab" style={{ width: 28, height: 28, padding: 0, borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--t-text-muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}><PlusIcon size={14} /></button>
    </div>
  );
}

export function RightUtilityLauncher({ onOpen }: { onOpen: (tab: RightUtilityTab) => void }) {
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setPanelHeight(node.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setPanelHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Available height per card after subtracting padding + gaps. Targets a
  // taller card on big screens; compact rows when the panel is short
  // (e.g. split layouts). Short panels scroll to keep every destination reachable.
  const padding = 28; // 14 top + 14 bottom
  const gapsTotal = 6 * (RIGHT_UTILITY_TABS.length - 1); // N cards = N−1 gaps × 6px
  const usable = Math.max(0, (panelHeight ?? 600) - padding - gapsTotal);
  const fairShare = usable / RIGHT_UTILITY_TABS.length;
  const cardHeight = Math.max(52, Math.min(64, fairShare));
  const compact = cardHeight < 64;
  const iconSize = compact ? 14 : 16;
  const iconBoxSize = compact ? 26 : 30;
  const labelSize = compact ? 12.5 : 13.5;
  const metaSize = 11;
  return (
    <div
      ref={measureRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        background: 'var(--t-bg)',
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 14,
      }}
    >
      <div style={{
        width: '100%',
        minHeight: '100%',
        maxWidth: 460,
        marginLeft: 'auto',
        marginRight: 'auto',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 6,
      }}>
        {RIGHT_UTILITY_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onOpen(tab.id)}
              style={{
                minHeight: cardHeight,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingTop: compact ? 8 : 12,
                paddingRight: 14,
                paddingBottom: compact ? 8 : 12,
                paddingLeft: 14,
                borderRadius: 10,
                border: '1px solid var(--t-divider-subtle)',
                background: 'var(--t-panel)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-panel-hover)';
                event.currentTarget.style.borderColor = 'var(--t-divider)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'var(--t-panel)';
                event.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
              }}
            >
              <span style={{
                width: iconBoxSize,
                height: iconBoxSize,
                borderRadius: 8,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--t-text-secondary)',
                background: 'var(--t-input-bg)',
                border: '1px solid var(--t-divider-subtle)',
                flexShrink: 0,
              }}>
                {Icon({ size: iconSize })}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: labelSize, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px' }}>
                  {tab.label}
                </span>
                <span style={{ fontSize: metaSize, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)' }}>
                  {tab.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
