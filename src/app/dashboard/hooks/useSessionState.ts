import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type { OrchestratorRuntimeTruth } from '@/lib/orchestrator/types';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { useReactiveQuery } from '@/lib/query/use-reactive-query';
import { fetchOnce } from '@/lib/panel/fetch-cache';
import type { PaletteAgentSummary } from '../types';

function approvalInboxFingerprint(snapshot: MobileInboxSnapshot | null | undefined): string | null {
  if (!snapshot) return null;

  const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const summaryApprovals = typeof snapshot.summary?.approvals === 'number' ? snapshot.summary.approvals : 0;

  const pendingApprovals = approvals
    .map((approval) => `${approval.id}:${approval.sessionKey}:${approval.createdAt}`)
    .join('|');
  const approvalItems = items
    .filter((item) => item.kind === 'approval' || Boolean(item.approvalId))
    .map((item) => `${item.id}:${item.approvalId ?? ''}:${item.sessionKey ?? ''}`)
    .join('|');
  const pendingSessions = sessions
    .filter((session) => session.approvalStatus === 'pending')
    .map((session) => `${session.sessionKey}:${session.lastEventAt ?? ''}`)
    .join('|');

  return `${summaryApprovals}:${pendingApprovals}:${approvalItems}:${pendingSessions}`;
}

function reviewPayloadTouchesApprovals(data: Record<string, unknown>): boolean {
  const event = typeof data.event === 'string' ? data.event.toLowerCase() : '';
  const kind = typeof data.kind === 'string' ? data.kind.toLowerCase() : '';
  const title = typeof data.title === 'string' ? data.title.toLowerCase() : '';

  return event.includes('approval')
    || kind.includes('approval')
    || title.includes('approval')
    || typeof data.approvalId === 'string'
    || typeof data.approvalStatus === 'string'
    || typeof data.policyRuleId === 'string';
}

export function useSessionState() {
  // ── Core session state ──
  const [activeSessionKey, setActiveSessionKey] = useState<string | undefined>();
  const [agentsJson, setAgentsJson] = useState('[]');
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>();
  const [liveOutputCollapsed, setLiveOutputCollapsed] = useState(false);
  const approvalRefreshRef = useRef<() => void>(() => {});
  const lastApprovalInboxFingerprintRef = useRef<string | null>(null);

  // ── Approval inbox fingerprinting for WS-driven refresh ──
  const triggerApprovalRefreshFromInbox = useCallback((snapshot: MobileInboxSnapshot | null | undefined) => {
    const nextFingerprint = approvalInboxFingerprint(snapshot);
    if (nextFingerprint === null) return;
    if (lastApprovalInboxFingerprintRef.current === null) {
      lastApprovalInboxFingerprintRef.current = nextFingerprint;
      return;
    }
    if (lastApprovalInboxFingerprintRef.current === nextFingerprint) return;
    lastApprovalInboxFingerprintRef.current = nextFingerprint;
    approvalRefreshRef.current();
  }, []);

  const approvalWsCallbacks = useMemo(() => ({
    onInboxUpdate: (data: Record<string, unknown>) => {
      triggerApprovalRefreshFromInbox(data as unknown as MobileInboxSnapshot);
    },
    onReviewUpdate: (data: Record<string, unknown>) => {
      if (reviewPayloadTouchesApprovals(data)) {
        approvalRefreshRef.current();
      }
    },
    onRealtimeEvent: (event: RealtimeEventEnvelope) => {
      if (event.channel !== 'mobile' || event.event !== 'mobile.inbox.snapshot') return;
      const payload = event.data as { inbox?: MobileInboxSnapshot };
      triggerApprovalRefreshFromInbox(payload.inbox);
    },
  }), [triggerApprovalRefreshFromInbox]);

  const { connectionState: wsStatus } = useSharedDesktopWs(undefined, approvalWsCallbacks);

  // ── Approval count -- reactive query, invalidated by WS events ──
  const { data: approvalData } = useReactiveQuery<{ approvals?: ApprovalRecord[] }>({
    queryKey: ['approvals', 'all'],
    queryFn: async () => {
      const res = await fetchOnce('/api/panel/approvals?status=all');
      if (!res.ok) return { approvals: [] };
      return await res.json() as { approvals?: ApprovalRecord[] };
    },
    wsEvents: ['inbox', 'realtime', 'lane-lifecycle'],
    staleTime: 5_000,
  });

  const approvalCount = useMemo(
    () => (approvalData?.approvals ?? []).filter((a) => a.status === 'pending').length,
    [approvalData],
  );
  const resolvedApprovalCount = useMemo(
    () => (approvalData?.approvals ?? []).filter((a) => a.status !== 'pending').length,
    [approvalData],
  );

  useEffect(() => {
    approvalRefreshRef.current = () => {
      // No-op -- TanStack Query handles refetching via WS events now.
      // Kept for compatibility with components that call approvalRefreshRef.current() directly.
    };
  }, []);

  // ── Parsed agents ──
  const parsedAgents = useMemo(() => {
    try {
      return JSON.parse(agentsJson) as PaletteAgentSummary[];
    } catch {
      return [] as PaletteAgentSummary[];
    }
  }, [agentsJson]);

  const orchestratorRuntimeTruth = useMemo<OrchestratorRuntimeTruth[]>(
    () => parsedAgents
      .filter((agent) => agent.sessionKey && (agent.runtime === 'codex' || agent.runtime === 'claude-code'))
      .map((agent) => ({
        sessionKey: agent.sessionKey!,
        runtime: agent.runtime === 'claude-code' ? 'claude-code' as const : 'codex' as const,
        status: agent.status ?? 'idle',
        currentTask: agent.currentTask ?? null,
        lastEventAt: agent.lastEventAt ?? null,
        workflowStageLabel: null,
      })),
    [parsedAgents],
  );

  return {
    // Core state
    activeSessionKey,
    setActiveSessionKey,
    agentsJson,
    setAgentsJson,
    activeWorkspace,
    setActiveWorkspace,
    liveOutputCollapsed,
    setLiveOutputCollapsed,

    // WebSocket
    wsStatus,

    // Approvals
    approvalCount,
    resolvedApprovalCount,

    // Parsed agents
    parsedAgents,
    orchestratorRuntimeTruth,
  };
}
