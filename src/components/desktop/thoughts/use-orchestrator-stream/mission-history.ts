import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  buildMissionArchiveTitle,
  extractLatestCompactionSummary,
  serializeThoughtsHistoryMessages,
  transcriptMatchesStoredHistory,
} from '@/lib/orchestrator/history-transcript';
import type { OrchestratorMissionCompletedDetail } from '@/lib/orchestrator/store';
import { normalizeRepoPath } from './shared';

interface ThoughtsHistoryListEntry {
  tabId: string;
  messageCount: number;
  modifiedAt?: string;
  repoPath?: string | null;
}

interface ArchiveMissionThreadOptions {
  appendLocalEntries: (entries: MobileTranscriptEntry[]) => void;
  planText: string | null;
  replaceTranscript: (entries: MobileTranscriptEntry[]) => void;
  repoPath: string;
  reset: () => void;
  transcript: MobileTranscriptEntry[];
  transitionStripTimerRef: { current: number | null };
}

function missionMergeLabel(count: number) {
  return `${count} MERGE${count === 1 ? '' : 'S'}`;
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
  options: Pick<ArchiveMissionThreadOptions, 'appendLocalEntries' | 'replaceTranscript' | 'transitionStripTimerRef'>,
) {
  if (options.transitionStripTimerRef.current) {
    clearTimeout(options.transitionStripTimerRef.current);
    options.transitionStripTimerRef.current = null;
  }

  const startedAt = Date.now();
  options.replaceTranscript([
    buildMissionTransitionEntry(
      `orch-mission-complete-${startedAt}`,
      `(MISSION COMPLETE · ${missionMergeLabel(detail.mergedCount)} · ARCHIVED)`,
      startedAt,
    ),
  ]);
  options.transitionStripTimerRef.current = window.setTimeout(() => {
    options.transitionStripTimerRef.current = null;
    options.appendLocalEntries([
      buildMissionTransitionEntry(`orch-mission-ready-${startedAt}`, '(NEW THREAD · READY)', startedAt + 220),
    ]);
  }, 220);
}

export async function archiveMissionThread(
  detail: OrchestratorMissionCompletedDetail,
  options: ArchiveMissionThreadOptions,
): Promise<void> {
  const hasArchivableMessages = options.transcript.some((entry) => entry.role === 'user');
  if (hasArchivableMessages) {
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
  }

  await fetch('/api/orchestrator/reset-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath: options.repoPath }),
  }).catch(() => null);

  options.reset();
  showMissionThreadTransition(detail, options);
}
