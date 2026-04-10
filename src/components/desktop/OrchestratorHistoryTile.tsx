'use client';

import { memo, useCallback, useRef } from 'react';
import { useOrchestratorTileBus } from './orchestrator-tile-bus';
import {
  ThoughtsHistoryPanel,
  type ThoughtsHistoryPanelHandle,
} from './thoughts/ThoughtsHistoryPanel';

/**
 * Tile-native wrapper around ThoughtsHistoryPanel. Rich searchable view
 * of all orchestrator conversations across repos. Clicking a thread
 * routes back to the orchestrator chat tile via the orchestrator tile
 * bus — if the chat tile isn't mounted yet, the bus opens one and
 * replays the thread load once the chat registers.
 */

interface OrchestratorHistoryTileProps {
  onClose: () => void;
  activeThreadId?: string | null;
}

function OrchestratorHistoryTileBase({
  onClose,
  activeThreadId = null,
}: OrchestratorHistoryTileProps) {
  const panelRef = useRef<ThoughtsHistoryPanelHandle>(null);
  const orchestratorBus = useOrchestratorTileBus();

  const handleSelect = useCallback(
    (tabId: string) => {
      orchestratorBus.loadThreadInChat(tabId);
    },
    [orchestratorBus],
  );

  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: 'var(--t-bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          background: 'var(--t-panel)',
          minHeight: 44,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}
        >
          Orchestrator History
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ThoughtsHistoryPanel
          ref={panelRef}
          visible
          activeThreadId={activeThreadId}
          onSelectThread={handleSelect}
          thoughtsBodyBackground={thoughtsBodyBackground}
          thoughtsElevatedSurface={thoughtsElevatedSurface}
          thoughtsElevatedBorder={thoughtsElevatedBorder}
          thoughtsElevatedShadow={thoughtsElevatedShadow}
        />
      </div>
    </div>
  );
}

export const OrchestratorHistoryTile = memo(OrchestratorHistoryTileBase);
