import type { DetectionResult } from '@/components/desktop/setup-wizard/types';
import type { CommandPaletteStateTone } from '@/components/shared/UniversalSearch';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import type { TileLayout, TileLeafNode } from '@/lib/tiles/types';
import type { WorkspaceLifecycleRecordView, WorkspaceLifecycleSummaryView } from '@/lib/workspace/lifecycle-types';
import { deriveWorkflowStage, describeWorkflowStage } from '@/lib/workflows/status';
import type { WorktreeInfo } from '@/lib/worktree/types';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type {
  PaletteAgentSummary,
  RepoWorktreeSummary,
  WorkspaceChatTargetOption,
  WorkspaceScopeEntry,
} from './types';

/** Normalize the flat API response into the shape SetupWizard expects. */
export function normalizeDetection(raw: Record<string, unknown>): DetectionResult {
  const toolsArray = (raw.tools ?? []) as Array<{ id: string; detected: boolean; version?: string; path?: string; details?: Record<string, unknown> }>;
  const findTool = (id: string) => toolsArray.find(t => t.id === id);

  const mkTool = (id: string) => {
    const t = findTool(id);
    return {
      detected: t?.detected ?? false,
      version: t?.version,
      path: t?.path,
      ...(t?.details ?? {}),
    };
  };

  // Build apiKeys array from the api-keys tool details
  const apiKeysTool = findTool('api-keys');
  const rawProviders = (apiKeysTool?.details?.providers ?? []) as Array<string | { provider: string; configured: boolean }>;
  const apiKeys = rawProviders.map(p => {
    if (typeof p === 'string') return { provider: p, configured: true };
    return { provider: p.provider, configured: p.configured };
  });

  return {
    tools: {
      codex: { ...mkTool('codex'), threads: (findTool('codex')?.details?.threads as number) ?? 0 },
      claudeCode: { ...mkTool('claude-code'), recentSessions: (findTool('claude-code')?.details?.recentSessions as number) ?? 0 },
      gemini: mkTool('gemini'),
      opencode: { ...mkTool('opencode'), authedProviders: (findTool('opencode')?.details?.authedProviders as string[]) ?? [] },
      ollama: { ...mkTool('ollama'), hasEmbeddingModel: (findTool('ollama')?.details?.hasEmbeddingModel as boolean) ?? false },
    } as DetectionResult['tools'],
    apiKeys,
    hasAnything: Boolean(raw.hasAnything),
    hasAgentSurface: Boolean(raw.hasAgentSurface),
    hasCliAgent: Boolean(raw.hasCliAgent),
    hasApiKey: Boolean(raw.hasApiKey),
    hasEmbeddings: Boolean(raw.hasEmbeddings),
    recommendedPath: String(raw.recommendedPath ?? 'full-wizard'),
    summary: String(raw.summary ?? ''),
  };
}

export function openedLaneSessionsCache() {
  const key = '__o8_opened_lane_sessions';
  const existing = (globalThis as Record<string, unknown>)[key];
  if (existing instanceof Set) {
    return existing as Set<string>;
  }
  const created = new Set<string>();
  (globalThis as Record<string, unknown>)[key] = created;
  return created;
}

export function repoSlugFromRemote(remoteUrl?: string | null) {
  const url = (remoteUrl ?? '').replace(/\.git$/, '');
  const parts = url.split('/');
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

export function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

export function compactSessionTargetText(value: string | null | undefined, max = 34) {
  const text = value?.trim() ?? '';
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function sameWorkspaceLaneState(left: WorkspaceLaneState | null | undefined, right: WorkspaceLaneState | null | undefined) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.tileId === right.tileId
    && left.tabId === right.tabId
    && left.kind === right.kind
    && left.title === right.title
    && left.subtitle === right.subtitle
    && left.repoPath === right.repoPath
    && left.branch === right.branch
    && left.runtime === right.runtime
    && left.sessionKey === right.sessionKey
    && left.status === right.status
    && left.transcriptState === right.transcriptState
    && left.isAdHoc === right.isAdHoc
    && left.packet?.packetId === right.packet?.packetId
    && left.packet?.status === right.packet?.status
    && left.packet?.runtime === right.packet?.runtime;
}

export function workspaceSessionRuntimeLabel(session: MobileInboxSnapshot['sessions'][number]) {
  // Capability-map lookup; optional chaining guards against 'chat' and other non-OrchestratorRuntime values.
  return ORCHESTRATOR_RUNTIMES[session.runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label ?? 'Chat';
}

export function shortRepoName(repo?: string | null) {
  if (!repo) return null;
  return repo.split('/').pop() ?? repo;
}

export function buildOrchestrationPacketBadge(packet: OrchestratorPacket): WorkspaceOrchestrationPacketBadge {
  return {
    packetId: packet.id,
    referenceLabel: packet.referenceLabel,
    title: packet.title,
    status: packet.status,
    runtime: packet.runtime,
    branchTarget: packet.branchTarget,
  };
}

export function packetStatusFromLaneStatus(status?: string | null): OrchestratorPacket['status'] {
  const normalized = status?.trim().toLowerCase();
  if (normalized === 'running') return 'running';
  if (normalized === 'reviewing') return 'awaiting_review';
  if (normalized === 'completed') return 'released';
  if (normalized === 'archived') return 'archived';
  if (normalized === 'awaiting_input' || normalized === 'awaiting_orchestrator' || normalized === 'awaiting_human' || normalized === 'failed' || normalized === 'stuck' || normalized === 'interrupted') return 'blocked';
  return 'launching';
}

export function buildOrchestrationPacketDraft(
  mission: OrchestratorMissionState,
  packet: OrchestratorPacket,
  targetLabel?: string | null,
) {
  return [
    `Mission: ${mission.summary || mission.prompt || packet.title}`,
    `Packet ID: ${packet.referenceLabel}`,
    `Packet: ${packet.title}`,
    packet.summary ? `Summary: ${packet.summary}` : null,
    targetLabel ? `Workspace target: ${targetLabel}` : null,
    packet.branchTarget ? `Branch / worktree target: ${packet.branchTarget}` : null,
    packet.dependencyLabels.length > 0 ? `Dependencies: ${packet.dependencyLabels.join(', ')}` : null,
    'Stay within this packet scope. Surface blockers, review handoffs, and required operator decisions explicitly.',
  ].filter((value): value is string => Boolean(value)).join('\n');
}

export function buildWorkspaceChatTargetOptions(sessions: MobileInboxSnapshot['sessions']): WorkspaceChatTargetOption[] {
  const runtimeCounts = new Map<string, number>();
  const runtimeOrdinals = new Map<string, number>();
  for (const session of sessions) {
    const baseLabel = workspaceSessionRuntimeLabel(session);
    runtimeCounts.set(baseLabel, (runtimeCounts.get(baseLabel) ?? 0) + 1);
  }

  return sessions.map((session) => {
    const baseLabel = workspaceSessionRuntimeLabel(session);
    const nextOrdinal = (runtimeOrdinals.get(baseLabel) ?? 0) + 1;
    runtimeOrdinals.set(baseLabel, nextOrdinal);
    const disambiguators = [
      compactSessionTargetText(session.branch, 22),
      compactSessionTargetText(session.workspace?.split('/').pop(), 18),
    ].filter((value): value is string => Boolean(value));
    const label = (runtimeCounts.get(baseLabel) ?? 0) > 1 ? `${baseLabel} ${nextOrdinal}` : baseLabel;
    const detail = disambiguators[0] ?? null;
    return {
      sessionKey: session.sessionKey,
      label,
      detail,
    };
  });
}

export function repoEntryToWorkspaceScope(repo: RepoRegistryEntry): WorkspaceScopeEntry {
  return {
    registryRepoId: repo.id,
    name: repo.name,
    localPath: repo.localPath,
    branch: repo.readiness?.currentBranch ?? repo.defaultBranch,
    readiness: repo.readiness ?? null,
    remoteUrl: repo.remoteUrl ?? undefined,
  };
}

export function repoSlugFromAgent(agent?: PaletteAgentSummary | null) {
  return agent?.runtimeSurface?.reviewContext?.repoSlug?.trim() || null;
}

export function findTerminalLeafByRepoPath(node: TileLayout['root'], repoPath: string): TileLeafNode | null {
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' && node.content.repoPath === repoPath ? node : null;
  }
  return findTerminalLeafByRepoPath(node.children[0], repoPath) ?? findTerminalLeafByRepoPath(node.children[1], repoPath);
}

export function findUnscopedTerminalLeaf(node: TileLayout['root']): TileLeafNode | null {
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' && !node.content.repoPath ? node : null;
  }
  return findUnscopedTerminalLeaf(node.children[0]) ?? findUnscopedTerminalLeaf(node.children[1]);
}

export function collectOpenTerminalRepoPaths(node: TileLayout['root'], excludeTileId?: string | null): string[] {
  if (node.type === 'leaf') {
    if (
      node.id !== excludeTileId
      && node.content.kind === 'terminal'
      && typeof node.content.repoPath === 'string'
      && node.content.repoPath.trim()
    ) {
      return [node.content.repoPath];
    }
    return [];
  }
  return [
    ...collectOpenTerminalRepoPaths(node.children[0], excludeTileId),
    ...collectOpenTerminalRepoPaths(node.children[1], excludeTileId),
  ];
}

export function collectTerminalLeafIds(node: TileLayout['root']): string[] {
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' ? [node.id] : [];
  }
  return [
    ...collectTerminalLeafIds(node.children[0]),
    ...collectTerminalLeafIds(node.children[1]),
  ];
}

export function findCanvasLeafByRepoPath(node: TileLayout['root'], repoPath: string): TileLeafNode | null {
  if (node.type === 'leaf') {
    return node.content.kind === 'canvas' && node.content.repoPath === repoPath ? node : null;
  }
  return findCanvasLeafByRepoPath(node.children[0], repoPath) ?? findCanvasLeafByRepoPath(node.children[1], repoPath);
}

export function findUnscopedCanvasLeaf(node: TileLayout['root']): TileLeafNode | null {
  if (node.type === 'leaf') {
    return node.content.kind === 'canvas' && !node.content.repoPath ? node : null;
  }
  return findUnscopedCanvasLeaf(node.children[0]) ?? findUnscopedCanvasLeaf(node.children[1]);
}

export function parseIssueNumber(value?: string | null) {
  const match = value?.match(/\bIssue #(\d+)\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

export function readinessTone(state?: RepoReadiness['state'] | null): CommandPaletteStateTone {
  if (state === 'ready') return 'green';
  if (state === 'needs_setup') return 'amber';
  if (state === 'missing' || state === 'blocked') return 'red';
  return 'slate';
}

export function workflowTone(label?: string | null): CommandPaletteStateTone {
  if (label === 'Merge ready') return 'green';
  if (label === 'Working') return 'green';
  if (label === 'Reviewing') return 'purple';
  if (label === 'Waiting') return 'slate';
  if (label === 'Blocked') return 'red';
  return 'blue';
}

export function paletteWorkflowLabel(agent: PaletteAgentSummary) {
  const workflow = deriveWorkflowStage({
    runtimeStatus: agent.status ?? null,
    workspaceStatus: agent.workspaceStatus ?? null,
    lifecycleState: agent.lifecycleState ?? null,
    latestText: agent.currentTask ?? agent.runtimeSurface?.lifecycle?.summary ?? '',
    lastActivityAt: agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : null,
    hasMessages: Boolean(agent.currentTask?.trim()),
    readinessState: agent.repoReadiness?.state ?? null,
  });

  return workflow?.label ?? 'Ready';
}

export function attentionRank(status: string) {
  if (status === 'Folder missing') return 520;
  if (status === 'Needs setup') return 470;
  if (status === 'Blocked') return 500;
  if (status === 'Reviewing') return 420;
  if (status === 'Merge ready') return 360;
  if (status === 'Waiting') return 260;
  if (status === 'Ready') return 180;
  return 0;
}

export function formatAttentionDetail(agent: PaletteAgentSummary) {
  const stage = deriveWorkflowStage({
    runtimeStatus: agent.status ?? null,
    workspaceStatus: agent.workspaceStatus ?? null,
    lifecycleState: agent.lifecycleState ?? null,
    latestText: agent.currentTask ?? agent.runtimeSurface?.lifecycle?.summary ?? '',
    lastActivityAt: agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : null,
    hasMessages: Boolean(agent.currentTask?.trim()),
    readinessState: agent.repoReadiness?.state ?? null,
  });
  const guidance = describeWorkflowStage({
    stage,
    runtimeStatus: agent.status ?? null,
    workspaceStatus: agent.workspaceStatus ?? null,
    lifecycleState: agent.lifecycleState ?? null,
    latestText: agent.currentTask ?? agent.runtimeSurface?.lifecycle?.summary ?? '',
    lastActivityAt: agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : null,
    hasMessages: Boolean(agent.currentTask?.trim()),
    readinessState: agent.repoReadiness?.state ?? null,
    readinessSummary: agent.repoReadiness?.summary ?? null,
    readinessNextAction: agent.repoReadiness?.nextAction ?? null,
  });
  return guidance.nextAction ? `${guidance.detail} ${guidance.nextAction}` : guidance.detail;
}

export function paletteSessionRuntime(agent: PaletteAgentSummary) {
  // Capability-map lookup; optional chaining guards against non-OrchestratorRuntime values.
  return ORCHESTRATOR_RUNTIMES[agent.runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label ?? agent.name;
}

export function paletteSessionTask(agent: PaletteAgentSummary) {
  const candidate = agent.currentTask?.trim() || agent.runtimeSurface?.lifecycle?.summary?.trim() || '';
  if (!candidate) return null;
  if (/^(hi|hey|hello|good (morning|afternoon|evening))\b/i.test(candidate)) return null;
  return compactSessionTargetText(candidate, 52);
}

export function paletteSessionTitle(agent: PaletteAgentSummary) {
  const repoLabel = shortRepoName(repoSlugFromAgent(agent)) ?? shortRepoName(agent.workspace) ?? null;
  const runtimeLabel = paletteSessionRuntime(agent);
  return repoLabel ? `${repoLabel} · ${runtimeLabel}` : runtimeLabel;
}

export function paletteSessionDetail(agent: PaletteAgentSummary) {
  const taskSummary = paletteSessionTask(agent);
  const branchLabel = compactSessionTargetText(agent.branch, 24);
  const statusLabel = paletteWorkflowLabel(agent);
  const detailParts = [taskSummary, branchLabel, statusLabel].filter((value): value is string => Boolean(value));
  return detailParts.join(' · ') || 'Open live lane';
}

export function repoReadinessDetail(entry: RepoRegistryEntry) {
  if (!entry.readiness) {
    return `Saved setup for ${entry.name} is not loaded yet.`;
  }
  return entry.readiness.nextAction
    ? `${entry.readiness.summary} ${entry.readiness.nextAction}`
    : entry.readiness.summary;
}

export function formatBytes(value?: number | null) {
  if (!value || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx += 1;
  }
  return `${size >= 10 || unitIdx === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIdx]}`;
}

export function repoWorktreeDetail(summary: RepoWorktreeSummary | null) {
  if (!summary) return 'No tracked worktrees yet.';
  const activeCount = summary.worktrees.filter((worktree) => ['ready', 'active', 'setup', 'creating'].includes(worktree.status)).length;
  const staleCount = summary.worktrees.filter((worktree) => worktree.status === 'stale').length;
  const parts = [
    `${summary.worktrees.length} worktree${summary.worktrees.length === 1 ? '' : 's'}`,
    `${activeCount} active`,
  ];
  if (staleCount > 0) parts.push(`${staleCount} stale`);
  if (summary.conflicts?.count > 0) parts.push(`${summary.conflicts.count} conflict${summary.conflicts.count === 1 ? '' : 's'}`);
  if (summary.totalDiskUsage > 0) parts.push(formatBytes(summary.totalDiskUsage));
  return parts.join(' · ');
}

export function worktreeStageLabel(status?: WorktreeInfo['status'] | null) {
  if (status === 'creating' || status === 'setup' || status === 'cleaning') return 'Waiting';
  if (status === 'stale') return 'Blocked';
  if (status === 'ready') return 'Ready';
  if (status === 'active') return 'Working';
  if (status === 'merging') return 'Reviewing';
  return 'Ready';
}

export function worktreeStageTone(status?: WorktreeInfo['status'] | null): CommandPaletteStateTone {
  if (status === 'creating' || status === 'setup' || status === 'cleaning') return 'amber';
  if (status === 'stale') return 'red';
  if (status === 'ready') return 'blue';
  if (status === 'active') return 'green';
  if (status === 'merging') return 'purple';
  return 'blue';
}

export function normalizeScopePath(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : null;
}

export function pathBelongsToRepoScope(candidatePath?: string | null, repoPath?: string | null) {
  const candidate = normalizeScopePath(candidatePath);
  const repo = normalizeScopePath(repoPath);
  if (!candidate || !repo) return false;
  return candidate === repo || candidate.startsWith(`${repo}/`);
}

export function sessionScopePath(session?: {
  worktree?: { path?: string | null } | null;
  runtimeSurface?: { cwd?: string | null } | null;
  workspace?: string | null;
}) {
  return session?.worktree?.path
    ?? session?.runtimeSurface?.cwd
    ?? (session?.workspace?.startsWith('/') ? session.workspace : null)
    ?? null;
}

export function sessionBelongsToRepoScope(
  session: {
    worktree?: { path?: string | null } | null;
    runtimeSurface?: { cwd?: string | null } | null;
    workspace?: string | null;
  },
  repoPath: string,
) {
  return pathBelongsToRepoScope(sessionScopePath(session), repoPath);
}

export function summarizeLifecycleRecords(records: WorkspaceLifecycleRecordView[]): WorkspaceLifecycleSummaryView {
  const activeRecords = records.filter((record) => !record.archivedAt);
  const nextAttention = activeRecords
    .filter((record) => record.attentionRank > 0)
    .sort((left, right) => right.attentionRank - left.attentionRank)[0];

  return {
    unreadCount: activeRecords.reduce((sum, record) => sum + record.unreadCount, 0),
    archivedCount: records.filter((record) => Boolean(record.archivedAt)).length,
    nextAttentionWorkspaceId: nextAttention?.id ?? null,
  };
}

export function collectRepoScopedTileIds(
  node: TileLayout['root'],
  repoPath: string,
  result = { terminal: new Set<string>(), canvas: new Set<string>() },
) {
  if (node.type === 'leaf') {
    if (
      (node.content.kind === 'terminal' || node.content.kind === 'canvas')
      && pathBelongsToRepoScope(node.content.repoPath, repoPath)
    ) {
      if (node.content.kind === 'terminal') {
        result.terminal.add(node.id);
      } else {
        result.canvas.add(node.id);
      }
    }
    return result;
  }

  collectRepoScopedTileIds(node.children[0], repoPath, result);
  collectRepoScopedTileIds(node.children[1], repoPath, result);
  return result;
}

export function clearRepoScopeFromTileLayout(node: TileLayout['root'], repoPath: string): TileLayout['root'] {
  if (node.type === 'leaf') {
    if (
      (node.content.kind === 'terminal' || node.content.kind === 'canvas')
      && pathBelongsToRepoScope(node.content.repoPath, repoPath)
    ) {
      return {
        ...node,
        content: {
          ...node.content,
          repoPath: null,
        },
      };
    }
    return node;
  }

  const left = clearRepoScopeFromTileLayout(node.children[0], repoPath);
  const right = clearRepoScopeFromTileLayout(node.children[1], repoPath);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return {
    ...node,
    children: [left, right],
  };
}
