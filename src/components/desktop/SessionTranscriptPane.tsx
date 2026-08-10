'use client';

/**
 * SessionTranscriptPane — sessionKey-only transcript surface.
 *
 * Thin adapter over AgentTilePane that resolves the agent record from the
 * orchestrator data context, so the pane can mount in any tile (split-pane
 * orchestrator transcripts, future side-by-side comparison views, etc.)
 * without callers having to thread agent metadata through.
 *
 * Issue #663: extract per-session transcript view as
 * <SessionTranscriptPane sessionKey={key} /> so it can mount in any tile.
 */
import { useCallback, useMemo } from 'react';
import { useOrchestratorData } from './orchestrator-data-context';
import { AgentTilePane } from './workspace-terminal/AgentTilePane';

interface SessionTranscriptPaneProps {
  sessionKey: string;
  focused?: boolean;
  onFocus?: (sessionKey: string) => void;
  onClose?: (sessionKey: string) => void;
}

export function SessionTranscriptPane({
  sessionKey,
  focused = false,
  onFocus,
  onClose,
}: SessionTranscriptPaneProps) {
  const data = useOrchestratorData();
  const agent = useMemo(
    () => (data?.agents ?? []).find((entry) => entry.sessionKey === sessionKey) ?? null,
    [data?.agents, sessionKey],
  );
  const packet = useMemo(
    () => data?.missionState?.packets.find((entry) => entry.lane?.sessionKey === sessionKey) ?? null,
    [data?.missionState?.packets, sessionKey],
  );

  const handleFocus = useCallback((key: string) => {
    onFocus?.(key);
  }, [onFocus]);

  const handleClose = useCallback((key: string) => {
    onClose?.(key);
  }, [onClose]);

  return (
    <AgentTilePane
      sessionKey={sessionKey}
      agent={agent}
      packet={packet}
      focused={focused}
      onClose={handleClose}
      onFocus={handleFocus}
    />
  );
}
