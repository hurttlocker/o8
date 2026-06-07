'use client';

import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import type { TabCleanupResult } from '@/components/desktop/workspace-terminal/useWorkspaceTabCleanup';

interface TabCleanupButtonProps {
  finishedTabCount: number;
  cleanupFinishedTabs?: () => TabCleanupResult;
  undoCleanup?: (closedTabs: TabCleanupResult['closedTabs']) => void;
}

export function TabCleanupButton({
  finishedTabCount,
  cleanupFinishedTabs,
  undoCleanup,
}: TabCleanupButtonProps) {
  const [toast, setToast] = useState<TabCleanupResult | null>(null);
  const controlsReady = Boolean(cleanupFinishedTabs && undoCleanup);
  const buttonVisible = controlsReady && finishedTabCount >= 1;
  const countLabel = finishedTabCount > 99 ? '99+' : String(finishedTabCount);
  const title = `Clean up ${finishedTabCount} finished ${finishedTabCount === 1 ? 'tab' : 'tabs'}`;

  const handleCleanupClick = useCallback(() => {
    const result = cleanupFinishedTabs?.();
    if (!result || result.closedCount === 0) return;
    setToast(result);
  }, [cleanupFinishedTabs]);

  const handleUndo = useCallback(() => {
    if (!toast) return;
    undoCleanup?.(toast.closedTabs);
    setToast(null);
  }, [toast, undoCleanup]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 5200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!controlsReady || (!buttonVisible && !toast)) return null;

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
      {buttonVisible ? (
        <button
          type="button"
          onClick={handleCleanupClick}
          aria-label={title}
          title={title}
          style={buttonStyle}
          onMouseEnter={hoverOn}
          onMouseLeave={hoverOff}
        >
          <span aria-hidden="true" style={hitZoneStyle} />
          <TrashGlyph size={13} />
          <span style={countStyle}>{countLabel}</span>
        </button>
      ) : null}
      {toast ? (
        <div role="status" style={toastStyle}>
          <span>{`Closed ${toast.closedCount} finished ${toast.closedCount === 1 ? 'tab' : 'tabs'}`}</span>
          <span style={{ color: 'var(--t-text-faint)' }}>·</span>
          <button
            type="button"
            onClick={handleUndo}
            style={undoButtonStyle}
            onMouseEnter={undoHoverOn}
            onMouseLeave={undoHoverOff}
          >
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TrashGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="currentColor" viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z" />
    </svg>
  );
}

const buttonStyle = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  alignSelf: 'center',
  gap: 4,
  minWidth: 36,
  height: 24,
  marginLeft: 2,
  borderRadius: 7,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-accent-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-accent)',
  cursor: 'pointer',
  paddingTop: 0,
  paddingBottom: 0,
  paddingLeft: 7,
  paddingRight: 7,
  transition: 'background 100ms, color 100ms, border-color 100ms',
} as const;

const hitZoneStyle = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: 44,
  height: 44,
  transform: 'translate(-50%, -50%)',
  background: 'transparent',
} as const;

const countStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 13,
  height: 14,
  paddingLeft: 4,
  paddingRight: 4,
  borderRadius: 999,
  background: 'var(--t-accent-soft)',
  color: 'var(--t-accent)',
  fontSize: 10,
  fontWeight: 600,
  lineHeight: '14px',
  fontFamily: 'var(--font-sans-system)',
} as const;

const toastStyle = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 174,
  paddingTop: 6,
  paddingBottom: 6,
  paddingLeft: 9,
  paddingRight: 7,
  borderRadius: 9,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider-subtle)',
  background: 'var(--t-panel-solid)',
  color: 'var(--t-text-secondary)',
  boxShadow: 'var(--t-panel-shadow)',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 12,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
  zIndex: 40,
} as const;

const undoButtonStyle = {
  borderWidth: 0,
  borderRadius: 5,
  background: 'transparent',
  color: 'var(--t-accent)',
  cursor: 'pointer',
  paddingTop: 2,
  paddingBottom: 2,
  paddingLeft: 5,
  paddingRight: 5,
  fontFamily: 'var(--font-sans-system)',
  fontSize: 12,
  fontWeight: 600,
} as const;

function hoverOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--t-hover)';
}

function hoverOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--t-input-bg)';
}

function undoHoverOn(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--t-accent-soft)';
}

function undoHoverOff(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
}
