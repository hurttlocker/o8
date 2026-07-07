import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { TerminalTabHandle } from '@/components/desktop/WorkspaceTerminal';
import type { OrchestratorLaneBinding, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { buildOrchestrationPacketBadge } from '../utils';

interface WorkspaceTerminalTarget {
  tileId: string;
  handle: TerminalTabHandle;
}

interface FocusOrchestrationPacketLaneArgs {
  packet: OrchestratorPacket;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  waitForWorkspaceTerminalTarget: (options?: { repoPath?: string | null }) => Promise<WorkspaceTerminalTarget | null>;
  workspaceTerminalHandlesRef: MutableRefObject<Map<string, TerminalTabHandle>>;
}

export type FocusableLaneBinding = Pick<OrchestratorLaneBinding,
  'laneId' | 'sessionKey' | 'tabId' | 'repoPath' | 'worktreePath' | 'runtime' | 'lastHeartbeatAt' | 'lastEventAt' | 'lastEventLabel'
>;

type LaneLookup = {
  id: string;
  label?: string | null;
  repoPath?: string | null;
  worktreePath?: string | null;
  runtime?: OrchestratorRuntime | null;
  sessionKey?: string | null;
  packetId?: string | null;
  lastHeartbeatAt?: number | string | null;
  lastEventAt?: string | null;
  lastEventLabel?: string | null;
};
function focusKnownTab({
  lane,
  packetId,
  setActiveTileId,
  workspaceTerminalHandlesRef,
}: {
  lane: OrchestratorLaneBinding;
  packetId: string;
  setActiveTileId: Dispatch<SetStateAction<string | null>>;
  workspaceTerminalHandlesRef: MutableRefObject<Map<string, TerminalTabHandle>>;
}): boolean {
  if (lane.tileId && lane.tabId) {
    const handle = workspaceTerminalHandlesRef.current.get(lane.tileId);
    if (handle?.focusTab(lane.tabId)) {
      setActiveTileId(lane.tileId);
      return true;
    }
  }

  const keys = [lane.tabId, lane.sessionKey, packetId, lane.laneId]
    .filter((key): key is string => Boolean(key));
  for (const [tileId, candidateHandle] of workspaceTerminalHandlesRef.current.entries()) {
    const match = candidateHandle.getChatTabSnapshots().find((snapshot) => keys.some((key) => (
      snapshot.tabId === key
      || snapshot.sessionKey === key
      || snapshot.packetId === key
    )));
    if (match && candidateHandle.focusTab(match.tabId)) {
      setActiveTileId(match.tileId || tileId);
      return true;
    }
  }

  return false;
}

export async function fetchLaneBinding({
  laneId,
  packetId,
  sessionKey,
  fallbackLane,
  fallbackRuntime,
  fallbackRepoPath,
}: {
  laneId?: string | null;
  packetId?: string | null;
  sessionKey?: string | null;
  fallbackLane?: FocusableLaneBinding | null;
  fallbackRuntime: OrchestratorRuntime;
  fallbackRepoPath?: string | null;
}): Promise<FocusableLaneBinding | null> {
  const normalizedLaneId = laneId?.trim() ?? '';
  const normalizedPacketId = packetId?.trim() ?? '';
  const normalizedSessionKey = sessionKey?.trim() ?? '';
  try {
    const response = await fetch('/api/lanes?active=false', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({})) as { lanes?: LaneLookup[] };
    const lane = (payload.lanes ?? []).find((candidate) => (
      (normalizedLaneId && candidate.id === normalizedLaneId)
      || (normalizedPacketId && candidate.packetId === normalizedPacketId)
      || (normalizedSessionKey && candidate.sessionKey === normalizedSessionKey)
    ));
    if (!lane) return null;

    return {
      laneId: lane.id,
      tabId: fallbackLane?.tabId ?? lane.sessionKey ?? '',
      repoPath: lane.worktreePath ?? lane.repoPath ?? fallbackLane?.repoPath ?? fallbackRepoPath ?? null,
      worktreePath: lane.worktreePath ?? fallbackLane?.worktreePath ?? null,
      runtime: lane.runtime ?? fallbackLane?.runtime ?? fallbackRuntime,
      sessionKey: lane.sessionKey ?? fallbackLane?.sessionKey ?? null,
      lastHeartbeatAt: lane.lastHeartbeatAt == null ? null : String(lane.lastHeartbeatAt),
      lastEventAt: lane.lastEventAt ?? fallbackLane?.lastEventAt ?? null,
      lastEventLabel: lane.lastEventLabel ?? fallbackLane?.lastEventLabel ?? null,
    };
  } catch {
    return null;
  }
}

async function resolveLaneBinding(packet: OrchestratorPacket): Promise<OrchestratorLaneBinding | null> {
  const lane = await fetchLaneBinding({
    laneId: packet.lane?.laneId,
    packetId: packet.id,
    sessionKey: packet.lane?.sessionKey,
    fallbackLane: packet.lane,
    fallbackRuntime: packet.runtime,
    fallbackRepoPath: packet.workspaceTargetPath,
  });
  if (!lane) return null;
  return {
    tileId: packet.lane?.tileId ?? '',
    tabId: lane.tabId ?? '',
    repoPath: lane.repoPath ?? null,
    worktreePath: lane.worktreePath ?? null,
    runtime: lane.runtime,
    sessionKey: lane.sessionKey ?? null,
    laneId: lane.laneId,
    lastHeartbeatAt: lane.lastHeartbeatAt,
    lastEventAt: lane.lastEventAt,
    lastEventLabel: lane.lastEventLabel,
  };
}

export async function resolveFocusableLaneBinding(input: {
  laneId?: string | null;
  packetId?: string | null;
  sessionKey?: string | null;
  runtime: OrchestratorRuntime;
  repoPath?: string | null;
}): Promise<FocusableLaneBinding | null> {
  return fetchLaneBinding({
    laneId: input.laneId,
    packetId: input.packetId,
    sessionKey: input.sessionKey,
    fallbackRuntime: input.runtime,
    fallbackRepoPath: input.repoPath,
  });
}

export function focusOrchestrationPacketLaneInWorkspace({
  packet,
  setActiveTileId,
  waitForWorkspaceTerminalTarget,
  workspaceTerminalHandlesRef,
}: FocusOrchestrationPacketLaneArgs) {
  if (packet.lane && focusKnownTab({ lane: packet.lane, packetId: packet.id, setActiveTileId, workspaceTerminalHandlesRef })) return;

  const sessionKey = packet.lane?.sessionKey?.trim();
  if (!sessionKey) {
    void (async () => {
      const resolvedLane = await resolveLaneBinding(packet);
      if (!resolvedLane) return;
      if (focusKnownTab({ lane: resolvedLane, packetId: packet.id, setActiveTileId, workspaceTerminalHandlesRef })) return;
      const resolvedSessionKey = resolvedLane.sessionKey?.trim();
      if (!resolvedSessionKey) return;
      const target = await waitForWorkspaceTerminalTarget({
        repoPath: resolvedLane.repoPath ?? packet.workspaceTargetPath ?? undefined,
      });
      if (!target) return;
      const hydratedPacket = { ...packet, lane: resolvedLane };
      const tabId = target.handle.openCliChatSession({
        runtime: resolvedLane.runtime,
        targetSessionKey: resolvedSessionKey,
        label: packet.title,
        orchestrationPacket: buildOrchestrationPacketBadge(hydratedPacket),
      });
      setActiveTileId(target.tileId);
      target.handle.focusTab(tabId);
    })();
    return;
  }

  void (async () => {
    const resolvedLane = await resolveLaneBinding(packet);
    if (resolvedLane) {
      if (focusKnownTab({ lane: resolvedLane, packetId: packet.id, setActiveTileId, workspaceTerminalHandlesRef })) return;
      const resolvedSessionKey = resolvedLane.sessionKey?.trim();
      if (resolvedSessionKey) {
        const target = await waitForWorkspaceTerminalTarget({
          repoPath: resolvedLane.repoPath ?? packet.lane?.repoPath ?? packet.workspaceTargetPath ?? undefined,
        });
        if (!target) return;
        const hydratedPacket = { ...packet, lane: resolvedLane };
        const tabId = target.handle.openCliChatSession({
          runtime: resolvedLane.runtime,
          targetSessionKey: resolvedSessionKey,
          label: packet.title,
          orchestrationPacket: buildOrchestrationPacketBadge(hydratedPacket),
        });
        setActiveTileId(target.tileId);
        target.handle.focusTab(tabId);
        return;
      }
    }
    const target = await waitForWorkspaceTerminalTarget({
      repoPath: packet.lane?.repoPath ?? packet.workspaceTargetPath ?? undefined,
    });
    if (!target) return;
    const tabId = target.handle.openCliChatSession({
      runtime: packet.runtime,
      targetSessionKey: sessionKey,
      label: packet.title,
      orchestrationPacket: buildOrchestrationPacketBadge(packet),
    });
    setActiveTileId(target.tileId);
    target.handle.focusTab(tabId);
  })();
}
