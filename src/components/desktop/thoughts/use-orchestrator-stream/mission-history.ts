import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  buildMissionArchiveTitle,
  extractLatestCompactionSummary,
  serializeThoughtsHistoryMessages,
  transcriptMatchesStoredHistory,
} from '@/lib/orchestrator/history-transcript';
import { markMissionCarded, type OrchestratorMissionCompletedDetail } from '@/lib/orchestrator/store';
import type { OrchestratorStatusEventData } from '@/lib/orchestrator/status-events';
import { normalizeRepoPath } from './shared';

interface ThoughtsHistoryListEntry {
  tabId: string;
  messageCount: number;
  modifiedAt?: string;
  repoPath?: string | null;
}

interface ArchiveMissionThreadOptions {
  planText: string | null;
  replaceTranscript: (entries: MobileTranscriptEntry[]) => void;
  getTranscript: () => MobileTranscriptEntry[];
  repoPath: string;
  reset: () => void;
  transcript: MobileTranscriptEntry[];
  transitionStripTimerRef: { current: number | null };
}

function buildMissionTransitionEntry(id: string, text: string, timestamp: number): MobileTranscriptEntry {
  return { id, role: 'system', text, timestamp };
}

async function findStoredThoughtsThreadTabId(
  transcript: MobileTranscriptEntry[],
  repoPath: string,
): Promise<string | null> {
  if (transcript.length === 0) return null;

  try {
    const listResponse = await fetch('/api/v2/chat-history/list?include=orchestrator', { cache: 'no-store' });
    if (!listResponse.ok) return null;
    const payload = await listResponse.json() as { conversations?: ThoughtsHistoryListEntry[] };
    const repoPathKey = normalizeRepoPath(repoPath);
    const candidates = (payload.conversations ?? [])
      .filter((thread) => thread.tabId.startsWith('thoughts-') && thread.messageCount === transcript.length)
      .filter((thread) => {
        const candidateRepoPath = normalizeRepoPath(thread.repoPath);
        return !repoPathKey || !candidateRepoPath || candidateRepoPath === repoPathKey;
      })
      .sort((left, right) => new Date(right.modifiedAt ?? 0).getTime() - new Date(left.modifiedAt ?? 0).getTime())
      .slice(0, 8);

    for (const candidate of candidates) {
      const historyResponse = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(candidate.tabId)}`, { cache: 'no-store' });
      if (!historyResponse.ok) continue;
      const history = await historyResponse.json() as { messages?: unknown[] };
      if (transcriptMatchesStoredHistory(transcript, history.messages)) {
        return candidate.tabId;
      }
    }
  } catch {
    // silent
  }

  return null;
}

function showMissionThreadTransition(
  detail: OrchestratorMissionCompletedDetail,
  options: Pick<ArchiveMissionThreadOptions, 'replaceTranscript' | 'getTranscript' | 'transitionStripTimerRef'>,
) {
  if (options.transitionStripTimerRef.current) {
    clearTimeout(options.transitionStripTimerRef.current);
    options.transitionStripTimerRef.current = null;
  }

  // Claim this mission so the lifecycle-driven status feed (the fallback for
  // MCP-dispatched missions) doesn't also card it.
  markMissionCarded(detail.missionId);

  const startedAt = Date.now();
  const confirmationId = `orch-mission-complete-${startedAt}`;
  const mergeCount = detail.mergedCount;
  const summary = mergeCount > 0
    ? `Mission complete — ${mergeCount} ${mergeCount === 1 ? 'packet' : 'packets'} merged and archived. Ready for the next one.`
    : 'Mission archived. Ready for the next one.';
  const statusEvent: OrchestratorStatusEventData = {
    kind: 'mission-complete',
    mergedCount: mergeCount,
    archivedCount: detail.archivedCount,
    summary: detail.summary || undefined,
    repoPath: detail.repoPath,
    packets: detail.packets,
  };
  options.replaceTranscript([{ ...buildMissionTransitionEntry(confirmationId, summary, startedAt), statusEvent }]);

  // After a beat, clear the confirmation so the thread returns to its empty
  // state (greeting + quick-action cards) — the completed mission is preserved
  // in the history list, so the live thread doesn't need to keep a marker.
  // Guard against wiping a turn the operator started in the meantime: only
  // clear when the confirmation is still the sole entry.
  options.transitionStripTimerRef.current = window.setTimeout(() => {
    options.transitionStripTimerRef.current = null;
    const current = options.getTranscript();
    if (current.length === 1 && current[0]?.id === confirmationId) {
      options.replaceTranscript([]);
    }
  }, 4600);
}

export async function archiveMissionThread(
  detail: OrchestratorMissionCompletedDetail,
  options: ArchiveMissionThreadOptions,
): Promise<void> {
  const hasArchivableMessages = options.transcript.some((entry) => entry.role === 'user');
  // Empty transcript → full no-op. Mission-completed re-fires on boot (WS
  // reconnect / incremental packet load oscillates non-terminal→terminal) used
  // to fall through to reset(): each one minted an empty thoughts-* placeholder,
  // repointed the live thread ref, suppressed reload-restore, and killed the
  // warm backend session — the 2026-07-14 "my chats vanished" storm (10 empty
  // files in one boot). Nothing to archive means nothing to rotate.
  if (!hasArchivableMessages) return;

  const currentTabId = await findStoredThoughtsThreadTabId(options.transcript, options.repoPath);
  const archiveTabId = `thoughts-${Date.now()}-archive`;
  const archiveResponse = await fetch('/api/v2/chat-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tabId: archiveTabId,
      messages: serializeThoughtsHistoryMessages(options.transcript),
      model: 'claude-code',
      title: buildMissionArchiveTitle({
        missionSummary: detail.summary,
        compactionSummary: extractLatestCompactionSummary(options.transcript),
        mergedCount: detail.mergedCount,
        completedAt: detail.completedAt,
      }),
      planText: options.planText ?? undefined,
      repoPath: options.repoPath,
    }),
  });
  if (!archiveResponse.ok) {
    throw new Error('Unable to archive the completed mission thread.');
  }
  if (currentTabId) {
    await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(currentTabId)}`, { method: 'DELETE' }).catch(() => null);
  }

  await fetch('/api/orchestrator/reset-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath: options.repoPath }),
  }).catch(() => null);

  options.reset();
  showMissionThreadTransition(detail, options);
}
