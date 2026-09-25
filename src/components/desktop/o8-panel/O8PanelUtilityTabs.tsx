'use client';

import { useCallback, useState } from 'react';
import { CircleSpark, DoubleCheck, Folder, Internet } from 'iconoir-react';
import { Terminal as TablerTerminal } from '@/components/desktop/tabler-shims';
import type { O8Tab } from './types';

export type RightUtilityTab = Extract<O8Tab, 'files' | 'side-chat' | 'browser' | 'review' | 'terminal' | 'inbox'>;

const RIGHT_UTILITY_TAB_IDS: RightUtilityTab[] = ['files', 'side-chat', 'browser', 'review', 'terminal', 'inbox'];

export function isRightUtilityTab(tab: O8Tab): tab is RightUtilityTab {
  return RIGHT_UTILITY_TAB_IDS.includes(tab as RightUtilityTab);
}

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
  onOpenLauncher,
  onSelect,
  onClose,
}: {
  tabs: RightUtilityTab[];
  activeTab: O8Tab;
  onOpenLauncher: () => void;
  onSelect: (tab: RightUtilityTab) => void;
  onClose: (tab: RightUtilityTab) => void;
}) {
  return (
    <div style={{
      // Cursor-density strip (browser siphon pass 1, Q 2026-07-12): 34px not
      // 44, quiet weights per the locked tab language — active = bg fill,
      // never bold.
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      minHeight: 34,
      paddingTop: 4,
      paddingRight: 8,
      paddingBottom: 4,
      paddingLeft: 8,
      borderBottom: '1px solid var(--t-divider)',
      background: 'var(--t-bg)',
      flexShrink: 0,
    }}>
      <button
        type="button"
        onClick={onOpenLauncher}
        aria-label="Open right panel tab picker"
        title="Open tab picker"
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          border: 'none',
          background: activeTab === 'launcher' ? 'var(--t-panel-hover)' : 'transparent',
          color: activeTab === 'launcher' ? 'var(--t-text)' : 'var(--t-text-muted)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = activeTab === 'launcher' ? 'var(--t-panel-hover)' : 'transparent'; }}
      >
        <PlusIcon size={14} />
      </button>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
      }}>
        {tabs.map((tab) => {
          const def = RIGHT_UTILITY_BY_ID[tab];
          const Icon = def.icon;
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onSelect(tab)}
              aria-label={def.label}
              style={{
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                paddingTop: 0,
                paddingRight: 6,
                paddingBottom: 0,
                paddingLeft: 8,
                borderRadius: 7,
                border: '1px solid transparent',
                background: active ? 'var(--t-panel-hover)' : 'transparent',
                color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
            >
              {Icon({ size: 12.5 })}
              <span style={{ fontSize: 12, fontWeight: active ? 400 : 300, letterSpacing: '-0.1px', whiteSpace: 'nowrap' }}>
                {def.label}
              </span>
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab);
                }}
                style={{
                  width: 15,
                  height: 15,
                  borderRadius: 4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--t-text-faint)',
                }}
              >
                <XIcon size={9} />
              </span>
            </button>
          );
        })}
      </div>
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
    // Cleanup handled by callback-ref re-fire when node changes.
  }, []);
  // Available height per card after subtracting padding + gaps. Targets a
  // taller card on big screens; compact rows when the panel is short
  // (e.g. split layouts) — never overflows into a scroll.
  const padding = 28; // 14 top + 14 bottom
  const gapsTotal = 6 * (RIGHT_UTILITY_TABS.length - 1); // N cards = N−1 gaps × 6px
  const usable = Math.max(0, (panelHeight ?? 600) - padding - gapsTotal);
  const fairShare = usable / RIGHT_UTILITY_TABS.length;
  const cardHeight = Math.max(52, Math.min(64, fairShare));
  const compact = cardHeight < 64;
  const iconSize = compact ? 14 : 16;
  const iconBoxSize = compact ? 26 : 30;
  const labelSize = compact ? 12.5 : 13.5;
  const metaSize = compact ? 9 : 9.5;
  return (
    <div
      ref={measureRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--t-bg)',
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 14,
      }}
    >
      <div style={{
        width: '100%',
        height: '100%',
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
