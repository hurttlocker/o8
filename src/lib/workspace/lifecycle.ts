import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeWorkflowStage, workflowBadge, type WorkflowStageBadge } from '@/lib/workflows/status';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import { getDataDir } from '@/lib/data-dir-migration';

type WorkspaceStatus = 'in_progress' | 'in_review' | 'done' | 'idle' | 'cancelled';

export interface LiveWorkspaceLifecycleInput {
  id: string;
  repo: string;
  repoPath: string;
  workspacePath: string;
  branch: string;
  repoSlug?: string | null;
  sessionKey?: string | null;
  runtime?: string | null;
  agentName?: string | null;
  agentStatus?: string | null;
  currentTask?: string | null;
  workspaceStatus?: WorkspaceStatus | null;
  workflowStage?: WorkflowStageBadge | null;
}

interface PersistedWorkspaceLifecycleRecord {
  id: string;
  repo: string;
  repoPath: string;
  workspacePath: string;
  branch: string;
  repoSlug?: string | null;
  sessionKey?: string | null;
  runtime?: string | null;
  agentName?: string | null;
  agentStatus?: string | null;
  currentTask?: string | null;
  workspaceStatus?: WorkspaceStatus | null;
  workflowStageKey?: WorkflowStageBadge['key'] | null;
  archivedAt?: string | null;
  restoredAt?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastActivityAt?: string | null;
  lastReadAt?: string | null;
  unreadCount: number;
  lastFingerprint?: string | null;
}

interface WorkspaceLifecycleStore {
  version: 1;
  records: PersistedWorkspaceLifecycleRecord[];
}

type WorkspaceMutation =
  | { action: 'archive'; workspaceId: string }
  | { action: 'restore'; workspaceId: string }
  | { action: 'mark_read'; workspaceId: string };

const STATE_DIR = getDataDir();
const STORE_PATH = path.join(STATE_DIR, 'workspace-lifecycle.json');

function nowIso() {
  return new Date().toISOString();
}

function normalizePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed.replace(/^~(?=\/|$)/, os.homedir())).replace(/\/+$/, '');
}

function pathBelongsToRepoScope(candidatePath?: string | null, repoPath?: string | null) {
  const candidate = candidatePath ? normalizePath(candidatePath) : '';
  const repo = repoPath ? normalizePath(repoPath) : '';
  if (!candidate || !repo) return false;
  return candidate === repo || candidate.startsWith(`${repo}/`);
}

function defaultWorkflowStage(workspaceStatus?: WorkspaceStatus | null) {
  if (workspaceStatus === 'done') return workflowBadge('ready');
  if (workspaceStatus === 'cancelled') return workflowBadge('blocked');
  if (workspaceStatus === 'in_review') return workflowBadge('reviewing');
  if (workspaceStatus === 'in_progress') return workflowBadge('working');
  return workspaceStatus === 'idle' ? workflowBadge('ready') : null;
}

function readStore(): WorkspaceLifecycleStore {
  try {
    if (!existsSync(STORE_PATH)) {
      return { version: 1, records: [] };
    }
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as WorkspaceLifecycleStore;
    return {
      version: 1,
      records: Array.isArray(raw.records) ? raw.records : [],
    };
  } catch {
    return { version: 1, records: [] };
  }
}

function writeStore(store: WorkspaceLifecycleStore) {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function workspaceFingerprint(input: LiveWorkspaceLifecycleInput) {
  return [
    input.sessionKey ?? '',
    input.runtime ?? '',
    input.agentStatus ?? '',
    input.currentTask ?? '',
    input.workspaceStatus ?? '',
    input.workflowStage?.key ?? '',
    input.branch,
  ].join('::');
}

function liveInputPriority(input: LiveWorkspaceLifecycleInput) {
  const stageWeight = input.workflowStage?.key === 'blocked'
    ? 6
    : input.workflowStage?.key === 'waiting'
      ? 5
      : input.workflowStage?.key === 'reviewing'
        ? 4
        : input.workflowStage?.key === 'merge_ready'
          ? 3
          : input.workflowStage?.key === 'working'
            ? 2
            : input.workflowStage?.key === 'queued'
              ? 1
              : 0;
  const statusWeight = input.agentStatus === 'failed'
    ? 5
    : input.agentStatus === 'waiting'
      ? 4
      : input.agentStatus === 'reviewing'
        ? 3
        : input.agentStatus === 'running'
          ? 2
          : 1;
  return stageWeight * 10 + statusWeight;
}

function persistedStage(record: PersistedWorkspaceLifecycleRecord) {
  if (record.workflowStageKey) {
    return workflowBadge(record.workflowStageKey);
  }
  return defaultWorkflowStage(record.workspaceStatus);
}

function buildAttentionRank(record: PersistedWorkspaceLifecycleRecord, live: boolean, stage: WorkflowStageBadge | null) {
  if (record.archivedAt) return -1;
  if (!live && (record.unreadCount ?? 0) === 0 && !['blocked', 'waiting', 'reviewing', 'merge_ready'].includes(stage?.key ?? '')) {
    return 0;
  }
  const stageScore = stage?.key === 'blocked'
    ? 120
    : stage?.key === 'waiting'
      ? 95
      : stage?.key === 'reviewing'
        ? 78
        : stage?.key === 'merge_ready'
          ? 68
          : stage?.key === 'working'
            ? 54
            : stage?.key === 'queued'
              ? 42
              : 14;
  return stageScore + Math.min(record.unreadCount, 6) * 14 + (live ? 10 : 0);
}

function buildAttentionLabel(record: PersistedWorkspaceLifecycleRecord, live: boolean, stage: WorkflowStageBadge | null) {
  if (record.archivedAt) return 'Archived';
  if (record.unreadCount > 0 && live) return 'Unread';
  if (stage?.label) return stage.label;
  return live ? 'Live' : 'History';
}

function buildAttentionDetail(record: PersistedWorkspaceLifecycleRecord, live: boolean, stage: WorkflowStageBadge | null) {
  if (record.archivedAt) {
    return 'Archived workspace history is preserved but removed from the active attention queue.';
  }
  if (record.unreadCount > 0 && live) {
    return record.currentTask?.trim()
      ? `Unread workspace update: ${record.currentTask.trim()}`
      : 'Unread workspace update needs review.';
  }
  if (stage?.key === 'blocked') {
    return 'This workspace is blocked and needs operator intervention before it is trustworthy again.';
  }
  if (stage?.key === 'waiting') {
    return 'This workspace is waiting on setup, validation, or a human gate.';
  }
  if (stage?.key === 'reviewing') {
    return 'This workspace is in review and still needs a human decision.';
  }
  if (stage?.key === 'working') {
    return 'This workspace is still actively working.';
  }
  return live
    ? 'Live workspace state is stable.'
    : 'Recent workspace history is preserved for restore and follow-up.';
}

function buildArchiveAction(record: PersistedWorkspaceLifecycleRecord, live: boolean, stage: WorkflowStageBadge | null) {
  if (record.archivedAt) {
    return {
      available: false,
      detail: 'This workspace is already archived.',
      unavailableReason: 'Workspace is already archived.',
    };
  }

  const canArchive = !live
    || record.workspaceStatus === 'done'
    || record.workspaceStatus === 'cancelled'
    || stage?.key === 'ready';

  if (canArchive) {
    return {
      available: true,
      detail: 'Archive removes this workspace from active attention lists while preserving its durable history.',
    };
  }

  const guidance = describeWorkflowStage({
    stage,
    runtimeStatus: record.agentStatus ?? null,
    workspaceStatus: record.workspaceStatus ?? null,
    latestText: record.currentTask ?? '',
    hasMessages: Boolean(record.currentTask?.trim()),
  });

  return {
    available: false,
    detail: guidance.archiveDetail,
    unavailableReason: guidance.archiveUnavailableReason,
  };
}

function buildResumeAction(record: PersistedWorkspaceLifecycleRecord) {
  if (!record.archivedAt) {
    return {
      available: false,
      detail: 'This workspace is already active.',
      unavailableReason: 'Workspace is not archived.',
    };
  }

  return {
    available: true,
    detail: 'Restore this archived workspace to the active queue without pretending that a runtime session is already live.',
  };
}

function toView(record: PersistedWorkspaceLifecycleRecord, liveIds: Set<string>): WorkspaceLifecycleRecordView {
  const live = liveIds.has(record.id);
  const stage = persistedStage(record);
  const attentionRank = buildAttentionRank(record, live, stage);

  return {
    id: record.id,
    repo: record.repo,
    repoPath: record.repoPath,
    workspacePath: record.workspacePath,
    branch: record.branch,
    repoSlug: record.repoSlug ?? null,
    sessionKey: record.sessionKey ?? null,
    runtime: record.runtime ?? null,
    agentName: record.agentName ?? null,
    agentStatus: record.agentStatus ?? null,
    currentTask: record.currentTask ?? null,
    workspaceStatus: record.workspaceStatus ?? null,
    workflowStage: stage,
    live,
    archivedAt: record.archivedAt ?? null,
    restoredAt: record.restoredAt ?? null,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    lastActivityAt: record.lastActivityAt ?? null,
    lastReadAt: record.lastReadAt ?? null,
    unreadCount: Math.max(0, record.unreadCount ?? 0),
    hasHistory: Boolean(record.lastActivityAt || record.archivedAt || record.restoredAt),
    attentionRank,
    attentionLabel: buildAttentionLabel(record, live, stage),
    attentionDetail: buildAttentionDetail(record, live, stage),
    archive: buildArchiveAction(record, live, stage),
    resume: buildResumeAction(record),
  };
}

function sortViews(records: WorkspaceLifecycleRecordView[]) {
  return [...records].sort((left, right) => {
    const archivedDelta = Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt));
    if (archivedDelta !== 0) return archivedDelta;
    if (right.attentionRank !== left.attentionRank) return right.attentionRank - left.attentionRank;
    const rightActivity = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : 0;
    const leftActivity = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : 0;
    if (rightActivity !== leftActivity) return rightActivity - leftActivity;
    return left.repo.localeCompare(right.repo);
  });
}

function buildSummary(records: WorkspaceLifecycleRecordView[]): WorkspaceLifecycleSummaryView {
  const active = records.filter((record) => !record.archivedAt);
  const nextAttention = active
    .filter((record) => record.attentionRank > 0)
    .sort((left, right) => right.attentionRank - left.attentionRank)[0];

  return {
    unreadCount: active.reduce((sum, record) => sum + record.unreadCount, 0),
    archivedCount: records.filter((record) => Boolean(record.archivedAt)).length,
    nextAttentionWorkspaceId: nextAttention?.id ?? null,
  };
}

export function buildWorkspaceLifecycleId(input: {
  repoPath: string;
  workspacePath?: string | null;
  branch?: string | null;
}) {
  const base = `${normalizePath(input.repoPath)}::${normalizePath(input.workspacePath ?? input.repoPath)}::${(input.branch ?? 'main').trim() || 'main'}`;
  let hash = 5381;
  for (let index = 0; index < base.length; index += 1) {
    hash = ((hash << 5) + hash) ^ base.charCodeAt(index);
  }
  return `workspace-${Math.abs(hash >>> 0).toString(36)}`;
}

export function syncWorkspaceLifecycleRecords(liveInputs: LiveWorkspaceLifecycleInput[]) {
  const store = readStore();
  const recordsById = new Map(store.records.map((record) => [record.id, record]));
  const nextRecords: PersistedWorkspaceLifecycleRecord[] = [];
  const liveIds = new Set<string>();
  const now = nowIso();

  const coalescedLiveInputs = new Map<string, LiveWorkspaceLifecycleInput>();
  for (const liveInput of liveInputs) {
    const existing = coalescedLiveInputs.get(liveInput.id);
    if (!existing || liveInputPriority(liveInput) >= liveInputPriority(existing)) {
      coalescedLiveInputs.set(liveInput.id, liveInput);
    }
  }

  for (const liveInput of coalescedLiveInputs.values()) {
    liveIds.add(liveInput.id);
    const existing = recordsById.get(liveInput.id);
    const nextFingerprint = workspaceFingerprint(liveInput);
    const changed = existing ? existing.lastFingerprint !== nextFingerprint : false;
    const autoRestored = Boolean(existing?.archivedAt);

    nextRecords.push({
      id: liveInput.id,
      repo: liveInput.repo,
      repoPath: liveInput.repoPath,
      workspacePath: liveInput.workspacePath,
      branch: liveInput.branch,
      repoSlug: liveInput.repoSlug ?? existing?.repoSlug ?? null,
      sessionKey: liveInput.sessionKey ?? null,
      runtime: liveInput.runtime ?? existing?.runtime ?? null,
      agentName: liveInput.agentName ?? existing?.agentName ?? null,
      agentStatus: liveInput.agentStatus ?? existing?.agentStatus ?? null,
      currentTask: liveInput.currentTask ?? existing?.currentTask ?? null,
      workspaceStatus: liveInput.workspaceStatus ?? existing?.workspaceStatus ?? null,
      workflowStageKey: liveInput.workflowStage?.key ?? existing?.workflowStageKey ?? null,
      archivedAt: autoRestored ? null : existing?.archivedAt ?? null,
      restoredAt: autoRestored ? now : existing?.restoredAt ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastActivityAt: changed
        ? now
        : existing?.lastActivityAt ?? now,
      lastReadAt: autoRestored ? null : existing?.lastReadAt ?? null,
      unreadCount: autoRestored
        ? 1
        : existing
          ? changed
            ? Math.min((existing.unreadCount ?? 0) + 1, 99)
            : existing.unreadCount ?? 0
          : 0,
      lastFingerprint: nextFingerprint,
    });
    recordsById.delete(liveInput.id);
  }

  for (const record of recordsById.values()) {
    nextRecords.push({
      ...record,
      lastSeenAt: record.lastSeenAt || record.firstSeenAt || now,
      unreadCount: Math.max(0, record.unreadCount ?? 0),
    });
  }

  writeStore({ version: 1, records: nextRecords });
  // The store retains every record ever seen for history. The returned view
  // only exposes records that are currently live OR explicitly archived by
  // the user — stale records (not live, no archive timestamp) would
  // otherwise linger in the sidebar forever as ghosts. When a live session
  // ends without being archived (lane disappeared, worktree removed), drop
  // the record from the view; history is still available via the store.
  const visibleRecords = nextRecords.filter((record) => (
    liveIds.has(record.id) || Boolean(record.archivedAt)
  ));
  const views = sortViews(visibleRecords.map((record) => toView(record, liveIds)));
  return {
    records: views,
    summary: buildSummary(views),
  };
}

export function mutateWorkspaceLifecycleRecord(mutation: WorkspaceMutation) {
  const store = readStore();
  const index = store.records.findIndex((record) => record.id === mutation.workspaceId);
  if (index < 0) {
    throw new Error('Workspace record not found.');
  }

  const record = store.records[index];
  const now = nowIso();
  switch (mutation.action) {
    case 'archive':
      store.records[index] = {
        ...record,
        archivedAt: now,
        unreadCount: 0,
      };
      break;
    case 'restore':
      store.records[index] = {
        ...record,
        archivedAt: null,
        restoredAt: now,
      };
      break;
    case 'mark_read':
      store.records[index] = {
        ...record,
        lastReadAt: now,
        unreadCount: 0,
      };
      break;
    default:
      throw new Error('Unsupported workspace lifecycle mutation.');
  }

  writeStore(store);
  const liveIds = new Set<string>();
  const views = sortViews(store.records.map((item) => toView(item, liveIds)));
  return {
    record: views.find((item) => item.id === mutation.workspaceId) ?? null,
    summary: buildSummary(views),
  };
}

export function removeWorkspaceLifecycleRecordsForRepoPath(repoPath: string) {
  const normalizedRepoPath = normalizePath(repoPath);
  if (!normalizedRepoPath) {
    return {
      removedCount: 0,
      records: [] as WorkspaceLifecycleRecordView[],
      summary: buildSummary([]),
    };
  }

  const store = readStore();
  const nextRecords = store.records.filter((record) => (
    !pathBelongsToRepoScope(record.repoPath, normalizedRepoPath)
    && !pathBelongsToRepoScope(record.workspacePath, normalizedRepoPath)
  ));
  const removedCount = store.records.length - nextRecords.length;
  if (removedCount === 0) {
    const liveIds = new Set<string>();
    const views = sortViews(store.records.map((item) => toView(item, liveIds)));
    return {
      removedCount: 0,
      records: views,
      summary: buildSummary(views),
    };
  }

  writeStore({ version: 1, records: nextRecords });
  const liveIds = new Set<string>();
  const views = sortViews(nextRecords.map((item) => toView(item, liveIds)));
  return {
    removedCount,
    records: views,
    summary: buildSummary(views),
  };
}
