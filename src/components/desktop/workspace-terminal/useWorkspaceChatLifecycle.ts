'use client';

import { useMemo } from 'react';
import { useLaneArchivedView } from '@/app/dashboard/hooks/useLaneArchivedSet';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import type { OrchestratorPacket, OrchestratorPacketStatus } from '@/lib/orchestrator/types';

interface UseWorkspaceChatLifecycleOptions {
  tab: TerminalTab;
  normalizedSessionKey?: string | null;
  runtimeLabel: string;
}

interface RetirementCopy {
  merged: boolean;
  tone: string;
  iconBg: string;
  heroTitle: string;
  heroSub: string;
  bannerLabel: string;
  bannerSub: string;
}

export function useWorkspaceChatLifecycle({
  tab,
  normalizedSessionKey,
  runtimeLabel,
}: UseWorkspaceChatLifecycleOptions): {
  orchestratorData: ReturnType<typeof useOrchestratorData>;
  livePacket: OrchestratorPacket | null;
  liveStatus: OrchestratorPacketStatus | null;
  laneRetired: boolean;
  retirement: RetirementCopy;
} {
  const orchestratorData = useOrchestratorData();
  const livePacket = useMemo(() => {
    if (!tab.orchestrationPacket) return null;
    const targetSessionKey = normalizedSessionKey ?? tab.id;
    const targetPacketId = tab.orchestrationPacket.packetId ?? null;
    return orchestratorData?.missionState?.packets.find((p) => (
      (targetPacketId && p.id === targetPacketId)
      || (targetSessionKey && p.lane?.sessionKey === targetSessionKey)
    )) ?? null;
  }, [normalizedSessionKey, orchestratorData?.missionState?.packets, tab.id, tab.orchestrationPacket]);
  const liveStatus = livePacket?.status ?? tab.orchestrationPacket?.status ?? null;
  const archivedLaneView = useLaneArchivedView();

  const laneRetired = useMemo(() => {
    if (tab.kind !== 'chat') return false;
    if (liveStatus === 'released' || liveStatus === 'archived') return true;
    // A packet whose CURRENT lane is live must never read as retired just
    // because an EARLIER lane for the same packet was archived (salvage /
    // relaunch cycles leave dead ancestors behind). Live-hit 2026-07-05: a
    // reviewing lane showed "Merged · read-only" — a governance-display lie
    // that invites the operator to skip the review. Only consult the archived
    // view when the packet has no active lane state.
    const ACTIVE_STATUSES = new Set(['queued', 'launching', 'running', 'reviewing', 'recovering', 'blocked', 'awaiting_input', 'awaiting_orchestrator', 'awaiting_human']);
    if (liveStatus && ACTIVE_STATUSES.has(liveStatus)) return false;
    const packetId = livePacket?.id ?? tab.orchestrationPacket?.packetId ?? null;
    if (packetId && archivedLaneView.packetIds.has(packetId)) return true;
    const candidateKeys = [tab.chatSessionKey, normalizedSessionKey, livePacket?.lane?.sessionKey];
    return candidateKeys.some((key) => Boolean(key) && archivedLaneView.sessionKeys.has(key as string));
  }, [tab.kind, tab.chatSessionKey, tab.orchestrationPacket?.packetId, normalizedSessionKey, liveStatus, livePacket, archivedLaneView]);

  const archiveSummary = useMemo(() => {
    const packetId = livePacket?.id ?? tab.orchestrationPacket?.packetId ?? null;
    if (packetId) {
      const byPacket = archivedLaneView.archiveSummariesByPacketId.get(packetId);
      if (byPacket) return byPacket;
    }
    const candidateKeys = [tab.chatSessionKey, normalizedSessionKey, livePacket?.lane?.sessionKey];
    for (const key of candidateKeys) {
      if (!key) continue;
      const bySession = archivedLaneView.archiveSummariesBySessionKey.get(key);
      if (bySession) return bySession;
    }
    return null;
  }, [archivedLaneView, normalizedSessionKey, livePacket, tab.chatSessionKey, tab.orchestrationPacket?.packetId]);

  const retirement = useMemo<RetirementCopy>(() => {
    const merged = liveStatus === 'released' || livePacket?.releaseState === 'released';
    if (merged) {
      return {
        merged: true,
        tone: '#22c55e',
        iconBg: 'rgba(34, 197, 94, 0.10)',
        heroTitle: 'Merged & archived',
        heroSub: `This ${runtimeLabel} session shipped and its lane was archived. The live transcript isn’t available here.`,
        bannerLabel: 'Merged · read-only',
        bannerSub: 'This session’s lane merged and was archived. The transcript stays for review.',
      };
    }
    if (liveStatus === 'failed') {
      return {
        merged: false,
        tone: '#f59e0b',
        iconBg: 'rgba(245, 158, 11, 0.10)',
        heroTitle: 'Ended without merging',
        heroSub: `This ${runtimeLabel} session ended without merging and its lane was archived.`,
        bannerLabel: 'Ended · read-only',
        bannerSub: 'This session ended without merging. The transcript stays for review.',
      };
    }
    // Durable lane outcome outranks the generic archived copy — a merged
    // lane archived by cleanup must read Merged, not "without merging"
    // (live-hit 2026-07-18).
    if (archiveSummary?.outcome === 'merged') {
      return {
        merged: true,
        tone: '#22c55e',
        iconBg: 'rgba(34, 197, 94, 0.10)',
        heroTitle: 'Merged & archived',
        heroSub: archiveSummary.message,
        bannerLabel: 'Merged · read-only',
        bannerSub: `${archiveSummary.message} The transcript stays for review.`,
      };
    }
    if (archiveSummary?.outcome === 'discarded') {
      return {
        merged: false,
        tone: 'var(--t-text-muted)',
        iconBg: 'var(--t-panel)',
        heroTitle: 'Discarded',
        heroSub: archiveSummary.message,
        bannerLabel: 'Discarded · read-only',
        bannerSub: `${archiveSummary.message} The transcript stays for review.`,
      };
    }
    if (archiveSummary?.outcome === 'no_changes') {
      return {
        merged: false,
        tone: 'var(--t-text-muted)',
        iconBg: 'var(--t-panel)',
        heroTitle: 'Finished — no changes',
        heroSub: archiveSummary.message,
        bannerLabel: 'No changes · read-only',
        bannerSub: `${archiveSummary.message} The transcript stays for review.`,
      };
    }
    if (archiveSummary?.outcome === 'pr_opened') {
      return {
        merged: false,
        tone: 'var(--t-accent)',
        iconBg: 'var(--t-panel)',
        heroTitle: 'Pull request opened',
        heroSub: archiveSummary.message,
        bannerLabel: 'PR open · read-only',
        bannerSub: `${archiveSummary.message} The transcript stays for review.`,
      };
    }
    if (archiveSummary?.outcome === 'asked') {
      return {
        merged: false,
        tone: '#f59e0b',
        iconBg: 'rgba(245, 158, 11, 0.10)',
        heroTitle: 'Question unanswered',
        heroSub: archiveSummary.message,
        bannerLabel: 'Asked · read-only',
        bannerSub: `${archiveSummary.message} The transcript stays for review.`,
      };
    }
    return {
      merged: false,
      tone: 'var(--t-text-muted)',
      iconBg: 'var(--t-panel)',
      heroTitle: 'Archived',
      heroSub: archiveSummary?.message ?? `This ${runtimeLabel} session’s lane was archived without merging.`,
      bannerLabel: 'Archived · read-only',
      bannerSub: archiveSummary
        ? `${archiveSummary.message} The transcript stays for review.`
        : 'This session’s lane was archived without merging. The transcript stays for review.',
    };
  }, [archiveSummary, liveStatus, livePacket?.releaseState, runtimeLabel]);

  return { orchestratorData, livePacket, liveStatus, laneRetired, retirement };
}
