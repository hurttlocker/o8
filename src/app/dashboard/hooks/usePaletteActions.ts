import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { requestConfirm } from '@/components/shared/ConfirmToastHost';
import type { SettingsTab } from '@/components/desktop/SettingsPage';
import type { WsConnectionState } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { CommandPaletteAction } from '@/components/shared/UniversalSearch';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { WorktreeInfo } from '@/lib/worktree/types';
import type { WorkspaceLifecycleRecordView } from '@/lib/workspace/lifecycle-types';
import { deriveWorkflowStage, describeWorkflowStage } from '@/lib/workflows/status';
import type {
  PaletteAgentSummary,
  RepoWorktreeSummary,
  WorkspaceLifecycleMutationAction,
} from '../types';
import {
  attentionRank,
  formatAttentionDetail,
  paletteSessionDetail,
  paletteSessionRuntime,
  paletteSessionTitle,
  paletteWorkflowLabel,
  readinessTone,
  repoReadinessDetail,
  repoSlugFromAgent,
  repoWorktreeDetail,
  shortenPath,
  workflowTone,
  worktreeStageLabel,
  worktreeStageTone,
} from '../utils';

interface CurrentIssueTarget {
  number: number;
  repo: string;
  title: string;
}

interface LaunchWorkspaceAgentRequest {
  repoPath: string;
  runtime?: 'codex' | 'claude-code' | 'gemini' | 'opencode';
  modelId?: string;
  initialText?: string;
  autoSend?: boolean;
  createNew?: boolean;
  label?: string;
  targetSessionKey?: string;
  supervisorStatus?: string | null;
  autoArchiveOnIdle?: boolean;
}

interface LaunchWorkspaceRepoTaskRequest {
  kind: 'issue' | 'pr';
  repo: string;
  number: number;
  title: string;
  body?: string;
  branch?: string;
}

interface UsePaletteActionsArgs {
  activeSessionKey: string | undefined;
  archivedWorkspaceCandidate: WorkspaceLifecycleRecordView | null;
  currentIssueTarget: CurrentIssueTarget | null;
  currentReviewAgent: PaletteAgentSummary | null;
  currentWorkspaceLifecycleRecord: WorkspaceLifecycleRecordView | null;
  globalRepo: string | null;
  globalRepoEntries: RepoRegistryEntry[];
  globalRepoEntry: RepoRegistryEntry | null;
  handleLaunchWorkspaceAgent: (request: LaunchWorkspaceAgentRequest) => Promise<void>;
  handleLaunchWorkspaceRepoTask: (request: LaunchWorkspaceRepoTaskRequest) => Promise<void>;
  handleOpenCI: (repo: string) => void;
  handleOpenFolder: () => Promise<void>;
  handleOpenSettingsTab: (tab: SettingsTab) => void;
  handleReviewPR: (prNumber: number, repo?: string) => void;
  handleRunInTerminal: (command: string) => void;
  handleSelectIssue: (issueNumber: number, repo?: string) => void;
  handleSelectRegisteredRepo: (repoId: string | null) => Promise<void>;
  handleSelectSession: (sessionKey: string) => void;
  mutateWorkspaceLifecycle: (action: WorkspaceLifecycleMutationAction, workspaceId: string) => Promise<void>;
  nextAttentionWorkspace: WorkspaceLifecycleRecordView | null;
  openRepoWorkspaceModal: (repoEntry: RepoRegistryEntry) => void;
  paletteAgents: PaletteAgentSummary[];
  scopedRepoAgents: PaletteAgentSummary[];
  selectedRepoWorktrees: RepoWorktreeSummary | null;
  selectedRepoWorktreesLoading: boolean;
  selectedSessionAgent: PaletteAgentSummary | null;
  selectedSessionWorktree: WorktreeInfo | null;
  staleSelectedRepoWorktrees: WorktreeInfo[];
  wsStatus: WsConnectionState;
  focusRepoSetup: (repoEntry: RepoRegistryEntry) => void;
  setActiveSessionKey: Dispatch<SetStateAction<string | undefined>>;
  setActiveWorkspace: Dispatch<SetStateAction<string | undefined>>;
  setChatVisible: Dispatch<SetStateAction<boolean>>;
  setSelectedRepoWorktreeRefreshNonce: Dispatch<SetStateAction<number>>;
  setSetupWizardOpen: Dispatch<SetStateAction<boolean>>;
  setSidebarVisible: Dispatch<SetStateAction<boolean>>;
  setRightPanelMode: (mode: 'chat' | 'workspace') => void;
}

export function usePaletteActions({
  activeSessionKey,
  archivedWorkspaceCandidate,
  currentIssueTarget,
  currentReviewAgent,
  currentWorkspaceLifecycleRecord,
  globalRepo,
  globalRepoEntries,
  globalRepoEntry,
  handleLaunchWorkspaceAgent,
  handleLaunchWorkspaceRepoTask,
  handleOpenCI,
  handleOpenFolder,
  handleOpenSettingsTab,
  handleReviewPR,
  handleRunInTerminal,
  handleSelectIssue,
  handleSelectRegisteredRepo,
  handleSelectSession,
  mutateWorkspaceLifecycle,
  nextAttentionWorkspace,
  openRepoWorkspaceModal,
  paletteAgents,
  scopedRepoAgents,
  selectedRepoWorktrees,
  selectedRepoWorktreesLoading,
  selectedSessionAgent,
  selectedSessionWorktree,
  staleSelectedRepoWorktrees,
  wsStatus,
  focusRepoSetup,
  setActiveSessionKey,
  setActiveWorkspace,
  setChatVisible,
  setSelectedRepoWorktreeRefreshNonce,
  setSetupWizardOpen,
  setSidebarVisible,
  setRightPanelMode,
}: UsePaletteActionsArgs) {
  return useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [];
    const workflowContextAgent = currentReviewAgent ?? selectedSessionAgent ?? scopedRepoAgents[0] ?? null;
    const workflowContextStage = workflowContextAgent
      ? deriveWorkflowStage({
          runtimeStatus: workflowContextAgent.status ?? null,
          workspaceStatus: workflowContextAgent.workspaceStatus ?? null,
          lifecycleState: workflowContextAgent.lifecycleState ?? null,
          latestText: workflowContextAgent.currentTask ?? workflowContextAgent.runtimeSurface?.lifecycle?.summary ?? '',
          lastActivityAt: workflowContextAgent.lastEventAt ? new Date(workflowContextAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(workflowContextAgent.currentTask?.trim()),
          readinessState: workflowContextAgent.repoReadiness?.state ?? globalRepoEntry?.readiness?.state ?? null,
        })
      : deriveWorkflowStage({
          readinessState: globalRepoEntry?.readiness?.state ?? null,
          latestText: '',
        });
    const workflowContextGuidance = describeWorkflowStage({
      stage: workflowContextStage,
      runtimeStatus: workflowContextAgent?.status ?? null,
      workspaceStatus: workflowContextAgent?.workspaceStatus ?? null,
      lifecycleState: workflowContextAgent?.lifecycleState ?? null,
      latestText: workflowContextAgent?.currentTask ?? workflowContextAgent?.runtimeSurface?.lifecycle?.summary ?? '',
      lastActivityAt: workflowContextAgent?.lastEventAt ? new Date(workflowContextAgent.lastEventAt).getTime() : null,
      hasMessages: Boolean(workflowContextAgent?.currentTask?.trim()),
      readinessState: workflowContextAgent?.repoReadiness?.state ?? globalRepoEntry?.readiness?.state ?? null,
      readinessSummary: workflowContextAgent?.repoReadiness?.summary ?? globalRepoEntry?.readiness?.summary ?? null,
      readinessNextAction: workflowContextAgent?.repoReadiness?.nextAction ?? globalRepoEntry?.readiness?.nextAction ?? null,
    });
    const repoAttention = globalRepoEntries
      .filter((entry) => entry.readiness?.state === 'blocked' || entry.readiness?.state === 'needs_setup')
      .sort((a, b) => {
        const aScore = attentionRank(a.readiness?.label ?? '');
        const bScore = attentionRank(b.readiness?.label ?? '');
        if (aScore !== bScore) return bScore - aScore;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 4);

    for (const entry of repoAttention) {
      actions.push({
        id: `repo-attention:${entry.id}`,
        category: 'attention',
        title: `${entry.readiness?.label}: ${entry.name}`,
        detail: repoReadinessDetail(entry),
        stateLabel: entry.readiness?.label,
        stateTone: readinessTone(entry.readiness?.state),
        keywords: [entry.name, entry.localPath, entry.readiness?.summary ?? '', entry.readiness?.nextAction ?? ''],
        priority: attentionRank(entry.readiness?.label ?? ''),
        run: () => focusRepoSetup(entry),
      });
    }

    const attentionCandidates = paletteAgents
      .map((agent) => {
        const status = paletteWorkflowLabel(agent);
        return {
          agent,
          status,
          score: attentionRank(status) + Math.min(agent.alerts ?? 0, 8) * 12,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { agent, status, score } of attentionCandidates) {
      actions.push({
        id: `attention:${agent.sessionKey}`,
        category: 'attention',
        title: `${status}: ${agent.name}`,
        detail: formatAttentionDetail(agent),
        stateLabel: status,
        stateTone: agent.repoReadiness
          ? readinessTone(agent.repoReadiness.state)
          : workflowTone(status),
        keywords: [agent.sessionKey, agent.currentTask ?? '', repoSlugFromAgent(agent) ?? '', agent.workspace ?? '', status],
        priority: score,
        run: () => {
          setSidebarVisible(true);
          setActiveSessionKey(agent.sessionKey);
        },
      });
    }

    const liveSessionCandidates = paletteAgents
      .filter((agent) => Boolean(agent.sessionKey))
      .sort((a, b) => {
        if (a.isCurrentSession !== b.isCurrentSession) return a.isCurrentSession ? -1 : 1;
        const aRepoMatch = repoSlugFromAgent(a) === globalRepo || a.workspace === globalRepoEntry?.localPath;
        const bRepoMatch = repoSlugFromAgent(b) === globalRepo || b.workspace === globalRepoEntry?.localPath;
        if (aRepoMatch !== bRepoMatch) return aRepoMatch ? -1 : 1;
        const aRank = attentionRank(paletteWorkflowLabel(a));
        const bRank = attentionRank(paletteWorkflowLabel(b));
        if (aRank !== bRank) return bRank - aRank;
        const aTime = a.lastEventAt ? new Date(a.lastEventAt).getTime() : 0;
        const bTime = b.lastEventAt ? new Date(b.lastEventAt).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, 6);

    for (const agent of liveSessionCandidates) {
      const workflowLabel = paletteWorkflowLabel(agent);
      const repoReadinessState = agent.repoReadiness?.state ?? null;
      actions.push({
        id: `session:focus:${agent.sessionKey}`,
        category: 'workspace',
        title: `Focus ${paletteSessionTitle(agent)}`,
        detail: paletteSessionDetail(agent),
        stateLabel: workflowLabel,
        stateTone: repoReadinessState ? readinessTone(repoReadinessState) : workflowTone(workflowLabel),
        keywords: [
          agent.name,
          paletteSessionRuntime(agent),
          agent.currentTask ?? '',
          agent.workspace ?? '',
          agent.branch ?? '',
          repoSlugFromAgent(agent) ?? '',
          'focus session',
          'switch session',
          agent.sessionKey,
        ],
        priority: agent.isCurrentSession ? 460 : 430,
        run: () => handleSelectSession(agent.sessionKey),
      });
    }

    if (globalRepoEntry) {
      const repoReadinessLabel = globalRepoEntry.readiness?.label;
      const repoReadinessTone = readinessTone(globalRepoEntry.readiness?.state);
      const repoReadinessSummary = repoReadinessDetail(globalRepoEntry);

      actions.push({
        id: 'workspace:launch-agent',
        category: 'workspace',
        title: 'Launch workspace agent',
        detail: globalRepoEntry.readiness
          ? `${repoReadinessLabel}: ${repoReadinessSummary}`
          : `Start a fresh CLI session in ${globalRepoEntry.name}.`,
        stateLabel: repoReadinessLabel,
        stateTone: repoReadinessTone,
        keywords: [globalRepoEntry.name, globalRepoEntry.localPath, globalRepo ?? '', 'launch', 'workspace', 'agent'],
        priority: 320,
        run: () => handleLaunchWorkspaceAgent({
          repoPath: globalRepoEntry.localPath,
          createNew: true,
        }),
      });

      actions.push({
        id: 'workspace:create-worktree',
        category: 'workspace',
        title: 'Create workspace worktree',
        detail: selectedRepoWorktreesLoading
          ? `Checking worktree health for ${globalRepoEntry.name}…`
          : repoWorktreeDetail(selectedRepoWorktrees),
        stateLabel: globalRepoEntry.readiness?.label ?? (selectedRepoWorktrees && !selectedRepoWorktrees.conflicts?.safe ? 'Blocked' : 'Ready'),
        stateTone: globalRepoEntry.readiness
          ? readinessTone(globalRepoEntry.readiness.state)
          : selectedRepoWorktrees && !selectedRepoWorktrees.conflicts?.safe
            ? 'red'
            : 'blue',
        keywords: ['create worktree', 'new workspace', 'workspace branch', globalRepoEntry.name],
        priority: 298,
        run: () => openRepoWorkspaceModal(globalRepoEntry),
      });

      if (selectedRepoWorktrees && !selectedRepoWorktrees.conflicts?.safe) {
        actions.push({
          id: 'workspace:review-worktree-conflicts',
          category: 'attention',
          title: `Blocked: ${globalRepoEntry.name} worktree conflicts`,
          detail: `${selectedRepoWorktrees.conflicts?.count} overlapping worktree file${selectedRepoWorktrees.conflicts?.count === 1 ? '' : 's'} need operator attention before stacking more work.`,
          stateLabel: 'Blocked',
          stateTone: 'red',
          keywords: ['worktree conflict', 'overlap', 'blocked', globalRepoEntry.name],
          priority: 410,
          run: () => focusRepoSetup(globalRepoEntry),
        });
      }

      if (globalRepoEntry.readiness?.state === 'needs_setup' && globalRepoEntry.setup.installCommand) {
        actions.push({
          id: 'workspace:run-setup',
          category: 'recovery',
          title: `Run saved setup for ${globalRepoEntry.name}`,
          detail: `Execute ${globalRepoEntry.setup.installCommand} in the operator terminal.`,
          stateLabel: globalRepoEntry.readiness.label,
          stateTone: readinessTone(globalRepoEntry.readiness.state),
          keywords: [globalRepoEntry.setup.installCommand, 'install deps', 'setup', 'bootstrap', globalRepoEntry.name],
          priority: 340,
          run: () => {
            handleRunInTerminal(`cd ${JSON.stringify(globalRepoEntry.localPath)} && ${globalRepoEntry.setup.installCommand}`);
          },
        });
      }

      if (selectedSessionWorktree?.path) {
        actions.push({
          id: 'workspace:finder-worktree',
          category: 'workspace',
          title: 'Open current worktree in Finder',
          detail: `${selectedSessionWorktree.id} · ${selectedSessionWorktree.path}`,
          stateLabel: worktreeStageLabel(selectedSessionWorktree.status),
          stateTone: worktreeStageTone(selectedSessionWorktree.status),
          keywords: [selectedSessionWorktree.id, selectedSessionWorktree.path, 'worktree', 'finder', 'workspace path'],
          priority: 246,
          run: async () => {
            const response = await fetch('/api/panel/open-in', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editor: 'finder', repo: selectedSessionWorktree.path }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to open the current worktree in Finder.');
            }
          },
        });

        actions.push({
          id: 'recovery:copy-worktree-path',
          category: 'recovery',
          title: 'Copy current worktree path',
          detail: shortenPath(selectedSessionWorktree.path),
          stateLabel: worktreeStageLabel(selectedSessionWorktree.status),
          stateTone: worktreeStageTone(selectedSessionWorktree.status),
          keywords: [selectedSessionWorktree.id, selectedSessionWorktree.path, 'copy worktree path', 'worktree'],
          priority: 226,
          run: async () => {
            await navigator.clipboard.writeText(selectedSessionWorktree.path);
          },
        });
      }

      actions.push({
        id: 'workspace:copy-path',
        category: 'recovery',
        title: 'Copy current repo path',
        detail: shortenPath(globalRepoEntry.localPath),
        keywords: [globalRepoEntry.localPath, 'copy path', 'cwd', 'repo path'],
        priority: 220,
        run: async () => {
          await navigator.clipboard.writeText(globalRepoEntry.localPath);
        },
      });

      if (staleSelectedRepoWorktrees.length > 0) {
        actions.push({
          id: 'recovery:prune-stale-worktrees',
          category: 'recovery',
          title: `Prune stale worktrees in ${globalRepoEntry.name}`,
          detail: `${staleSelectedRepoWorktrees.length} stale worktree${staleSelectedRepoWorktrees.length === 1 ? '' : 's'} will be removed. ${repoWorktreeDetail(selectedRepoWorktrees)}`,
          stateLabel: selectedRepoWorktrees && !selectedRepoWorktrees.conflicts?.safe ? 'Blocked' : 'Ready',
          stateTone: selectedRepoWorktrees && !selectedRepoWorktrees.conflicts?.safe ? 'red' : 'blue',
          keywords: ['prune stale worktrees', 'cleanup worktrees', 'stale worktree', globalRepoEntry.name],
          priority: 345,
          run: async () => {
            const confirmed = await requestConfirm({
              title: `Prune ${staleSelectedRepoWorktrees.length} stale worktree${staleSelectedRepoWorktrees.length === 1 ? '' : 's'} for ${globalRepoEntry.name}?`,
              message: 'This removes the stale worktree directories and their branches.',
              confirmLabel: 'Prune',
              danger: true,
            });
            if (!confirmed) {
              return;
            }
            const response = await fetch('/api/worktrees', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repo: globalRepoEntry.localPath, action: 'prune' }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to prune stale worktrees.');
            }
            setSelectedRepoWorktreeRefreshNonce((current) => current + 1);
          },
        });
      }
    } else {
      actions.push({
        id: 'workspace:open-folder',
        category: 'workspace',
        title: 'Open folder',
        detail: 'Register a local checkout and make it the active workspace.',
        keywords: ['open folder', 'repo', 'workspace', 'register repo'],
        priority: 320,
        run: handleOpenFolder,
      });

    }

    if (globalRepoEntry) {
      actions.push({
        id: 'workspace:open-folder-anyway',
        category: 'workspace',
        title: 'Open another folder',
        detail: 'Register or switch to a different local checkout.',
        keywords: ['open folder', 'switch repo', 'add repo', 'workspace'],
        priority: 180,
        run: handleOpenFolder,
      });
    }

    if (currentReviewAgent?.pr?.number) {
      const reviewRepo = repoSlugFromAgent(currentReviewAgent) || globalRepo;
      if (reviewRepo) {
        const reviewReadiness = globalRepoEntry?.readiness ?? currentReviewAgent.repoReadiness ?? null;
        const reviewStage = currentReviewAgent.workflowStage ?? deriveWorkflowStage({
          runtimeStatus: currentReviewAgent.status ?? null,
          workspaceStatus: currentReviewAgent.workspaceStatus ?? null,
          lifecycleState: currentReviewAgent.lifecycleState ?? null,
          latestText: currentReviewAgent.currentTask ?? '',
          lastActivityAt: currentReviewAgent.lastEventAt ? new Date(currentReviewAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(currentReviewAgent.currentTask?.trim()),
          readinessState: reviewReadiness?.state ?? null,
          prState: currentReviewAgent.pr.state ?? 'open',
        });
        const reviewGuidance = describeWorkflowStage({
          stage: reviewStage,
          runtimeStatus: currentReviewAgent.status ?? null,
          workspaceStatus: currentReviewAgent.workspaceStatus ?? null,
          lifecycleState: currentReviewAgent.lifecycleState ?? null,
          latestText: currentReviewAgent.currentTask ?? '',
          lastActivityAt: currentReviewAgent.lastEventAt ? new Date(currentReviewAgent.lastEventAt).getTime() : null,
          hasMessages: Boolean(currentReviewAgent.currentTask?.trim()),
          readinessState: reviewReadiness?.state ?? null,
          readinessSummary: reviewReadiness?.summary ?? null,
          readinessNextAction: reviewReadiness?.nextAction ?? null,
          prState: currentReviewAgent.pr.state ?? 'open',
        });
        const reviewStateLabel = reviewStage?.label ?? reviewReadiness?.label ?? 'Reviewing';
        const reviewStateTone = reviewStage ? workflowTone(reviewStage.label) : reviewReadiness ? readinessTone(reviewReadiness.state) : 'purple';
        actions.push({
          id: 'review:open-pr',
          category: 'review',
          title: `Review current PR #${currentReviewAgent.pr.number}`,
          detail: reviewGuidance.nextAction ? `${currentReviewAgent.pr.title} · ${reviewGuidance.nextAction}` : currentReviewAgent.pr.title,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, currentReviewAgent.pr.title, 'pull request', 'review pr', 'open pr', String(currentReviewAgent.pr.number)],
          priority: 310,
          run: () => handleReviewPR(currentReviewAgent.pr!.number, reviewRepo),
        });

        actions.push({
          id: 'review:launch-pr',
          category: 'review',
          title: `Launch PR #${currentReviewAgent.pr.number} review`,
          detail: reviewGuidance.nextAction ?? 'Open a CLI review lane with current repo readiness context.',
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'launch review', 'pr review', currentReviewAgent.pr.title],
          priority: 290,
          run: () => handleLaunchWorkspaceRepoTask({
            kind: 'pr',
            repo: reviewRepo,
            number: currentReviewAgent.pr!.number,
            title: currentReviewAgent.pr!.title,
            branch: currentReviewAgent.branch,
          }),
        });

        actions.push({
          id: 'review:checks',
          category: 'review',
          title: 'Open current checks',
          detail: reviewGuidance.detail,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'checks', 'ci', 'status checks'],
          priority: 280,
          run: () => handleOpenCI(reviewRepo),
        });

        actions.push({
          id: 'review:merge',
          category: 'review',
          title: `Merge current PR #${currentReviewAgent.pr.number}`,
          detail: reviewGuidance.mergeDetail,
          stateLabel: reviewStateLabel,
          stateTone: reviewStateTone,
          keywords: [reviewRepo, 'merge pr', 'merge pull request', currentReviewAgent.pr.title],
          priority: 260,
          disabled: !reviewGuidance.mergeAllowed,
          unavailableReason: !reviewGuidance.mergeAllowed ? reviewGuidance.mergeDetail : undefined,
          run: async () => {
            const response = await fetch(`/api/panel/prs/${currentReviewAgent.pr!.number}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'merge', repo: reviewRepo }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
              throw new Error(data.error || 'Unable to merge the current pull request.');
            }
            handleReviewPR(currentReviewAgent.pr!.number, reviewRepo);
          },
        });
      }
    }

    if (!currentReviewAgent?.pr?.number && globalRepo) {
      actions.push({
        id: 'review:checks-only',
        category: 'review',
        title: 'Open current checks',
        detail: `Inspect the latest CI state for ${globalRepo}.`,
        stateLabel: globalRepoEntry?.readiness?.label ?? 'Reviewing',
        stateTone: globalRepoEntry?.readiness ? readinessTone(globalRepoEntry.readiness.state) : 'purple',
        keywords: [globalRepo, 'checks', 'ci', 'status checks'],
        priority: 240,
        run: () => handleOpenCI(globalRepo),
      });
    }

    if (currentIssueTarget) {
      actions.push({
        id: 'review:open-issue',
        category: 'review',
        title: `Open current issue #${currentIssueTarget.number}`,
        detail: `${currentIssueTarget.repo} · ${currentIssueTarget.title}`,
        stateLabel: globalRepoEntry?.readiness?.label ?? 'Working',
        stateTone: globalRepoEntry?.readiness ? readinessTone(globalRepoEntry.readiness.state) : 'green',
        keywords: [currentIssueTarget.repo, 'issue', currentIssueTarget.title, String(currentIssueTarget.number)],
        priority: 275,
        run: () => handleSelectIssue(currentIssueTarget.number, currentIssueTarget.repo),
      });
    }

    actions.push({
      id: 'settings:connectors',
      category: 'settings',
      title: 'Open connector settings',
      detail: 'GitHub auth, broker status, and repo access.',
      keywords: ['settings', 'connectors', 'github', 'broker'],
      priority: 210,
      run: () => handleOpenSettingsTab('git-prs'),
    });

    actions.push({
      id: 'settings:appearance',
      category: 'settings',
      title: 'Open appearance settings',
      detail: 'Theme and desktop shell behavior.',
      keywords: ['settings', 'appearance', 'theme', 'nav rail'],
      priority: 195,
      run: () => handleOpenSettingsTab('appearance'),
    });

    actions.push({
      id: 'settings:analytics',
      category: 'settings',
      title: 'Open usage analytics',
      detail: 'Spend, token usage, and agent efficiency.',
      keywords: ['settings', 'analytics', 'usage', 'cost', 'tokens', 'codex', 'claude'],
      priority: 190,
      run: () => handleOpenSettingsTab('analytics'),
    });

    actions.push({
      id: 'recovery:setup',
      category: 'recovery',
      title: 'Rerun setup',
      detail: 'Open the setup flow and recheck local tools and providers.',
      stateLabel: wsStatus === 'disconnected' ? 'Blocked' : wsStatus === 'reconnecting' || wsStatus === 'connecting' ? 'Waiting' : undefined,
      stateTone: wsStatus === 'disconnected' ? 'red' : wsStatus === 'reconnecting' || wsStatus === 'connecting' ? 'amber' : undefined,
      keywords: ['rerun setup', 'setup wizard', 'doctor', 'recovery'],
      priority: wsStatus === 'connected' ? 170 : 260,
      run: () => setSetupWizardOpen(true),
    });

    if (wsStatus !== 'connected') {
      actions.push({
        id: 'recovery:workspace-bridge',
        category: 'recovery',
        title: wsStatus === 'disconnected' ? 'Workspace bridge disconnected' : 'Workspace bridge reconnecting',
        detail: wsStatus === 'disconnected'
          ? 'Saved tabs stay local, but live session updates are paused until the bridge comes back.'
          : 'Live session updates are resyncing. Reload only if the workspace does not recover on its own.',
        stateLabel: wsStatus === 'disconnected' ? 'Blocked' : 'Waiting',
        stateTone: wsStatus === 'disconnected' ? 'red' : 'amber',
        keywords: ['workspace bridge', 'disconnected', 'reconnecting', 'ws', 'reload workspace'],
        priority: wsStatus === 'disconnected' ? 520 : 300,
        run: () => window.location.reload(),
      });
    }

    if (activeSessionKey && !selectedSessionAgent && paletteAgents.length > 0) {
      const fallbackSession = paletteAgents.find((agent) => agent.isCurrentSession) ?? paletteAgents[0];
      actions.push({
        id: 'recovery:missing-session',
        category: 'recovery',
        title: 'Selected session is no longer live',
        detail: 'The current chat selection fell out of the live inventory. Jump to a monitored session or reload the workspace snapshot.',
        stateLabel: 'Blocked',
        stateTone: 'red',
        keywords: ['missing session', 'session unavailable', activeSessionKey].filter((keyword): keyword is string => Boolean(keyword)),
        priority: 510,
        run: () => {
          if (fallbackSession) {
            setActiveSessionKey(fallbackSession.sessionKey);
            setChatVisible(true);
            setRightPanelMode('chat');
            return;
          }
          window.location.reload();
        },
      });
    }

    actions.push({
      id: 'recovery:restore',
      category: 'recovery',
      title: 'Restore workspace tabs',
      detail: 'Reload the dashboard and reattach saved workspace tabs in place.',
      keywords: ['restore session', 'restore tabs', 'reload workspace', 'recover'],
      priority: wsStatus === 'connected' ? 160 : 250,
      run: () => window.location.reload(),
    });

    if (nextAttentionWorkspace) {
      actions.push({
        id: `workspace:attention:${nextAttentionWorkspace.id}`,
        category: 'attention',
        title: 'Open next workspace needing attention',
        detail: nextAttentionWorkspace.attentionDetail,
        stateLabel: nextAttentionWorkspace.attentionLabel,
        stateTone: nextAttentionWorkspace.workflowStage
          ? workflowTone(nextAttentionWorkspace.workflowStage.label)
          : 'amber',
        keywords: [
          'next workspace',
          'next attention',
          nextAttentionWorkspace.repo,
          nextAttentionWorkspace.branch,
          nextAttentionWorkspace.workspacePath,
        ],
        priority: 330 + Math.min(nextAttentionWorkspace.attentionRank, 120),
        run: async () => {
          const matchingRepo = globalRepoEntries.find((entry) => (
            nextAttentionWorkspace.repoPath === entry.localPath
            || nextAttentionWorkspace.workspacePath.startsWith(`${entry.localPath}/`)
          )) ?? null;
          if (matchingRepo) {
            await handleSelectRegisteredRepo(matchingRepo.id);
          }
          setActiveWorkspace(nextAttentionWorkspace.workspacePath);
          setSidebarVisible(true);
          setChatVisible(true);
          if (nextAttentionWorkspace.sessionKey) {
            setActiveSessionKey(nextAttentionWorkspace.sessionKey);
            setRightPanelMode('chat');
            return;
          }
          setRightPanelMode('workspace');
        },
      });
    }

    if (currentWorkspaceLifecycleRecord) {
      actions.push({
        id: `workspace:archive:${currentWorkspaceLifecycleRecord.id}`,
        category: 'workspace',
        title: 'Archive workspace',
        detail: currentWorkspaceLifecycleRecord.archive.detail,
        stateLabel: currentWorkspaceLifecycleRecord.workflowStage?.label ?? currentWorkspaceLifecycleRecord.attentionLabel,
        stateTone: currentWorkspaceLifecycleRecord.workflowStage
          ? workflowTone(currentWorkspaceLifecycleRecord.workflowStage.label)
          : 'slate',
        keywords: [
          'archive workspace',
          'archive lane',
          currentWorkspaceLifecycleRecord.repo,
          currentWorkspaceLifecycleRecord.branch,
        ],
        priority: 120,
        disabled: !currentWorkspaceLifecycleRecord.archive.available,
        unavailableReason: currentWorkspaceLifecycleRecord.archive.unavailableReason,
        run: async () => {
          if (!currentWorkspaceLifecycleRecord.archive.available) return;
          await mutateWorkspaceLifecycle('archive', currentWorkspaceLifecycleRecord.id);
        },
      });
    } else {
      actions.push({
        id: 'workspace:archive-unavailable',
        category: 'workspace',
        title: 'Archive workspace',
        detail: workflowContextGuidance.archiveDetail,
        stateLabel: workflowContextStage?.label ?? 'Unavailable',
        stateTone: workflowContextStage ? workflowTone(workflowContextStage.label) : 'slate',
        keywords: ['archive workspace', 'archive lane', 'archive'],
        priority: 12,
        disabled: true,
        unavailableReason: workflowContextGuidance.archiveUnavailableReason,
        run: () => undefined,
      });
    }

    if (archivedWorkspaceCandidate) {
      actions.push({
        id: `workspace:resume:${archivedWorkspaceCandidate.id}`,
        category: 'workspace',
        title: 'Resume archived workspace',
        detail: archivedWorkspaceCandidate.resume.detail,
        stateLabel: 'Archived',
        stateTone: 'slate',
        keywords: [
          'resume workspace',
          'resume archived workspace',
          'restore archived workspace',
          archivedWorkspaceCandidate.repo,
          archivedWorkspaceCandidate.branch,
        ],
        priority: 115,
        disabled: !archivedWorkspaceCandidate.resume.available,
        unavailableReason: archivedWorkspaceCandidate.resume.unavailableReason,
        run: async () => {
          if (!archivedWorkspaceCandidate.resume.available) return;
          await mutateWorkspaceLifecycle('restore', archivedWorkspaceCandidate.id);
          const matchingRepo = globalRepoEntries.find((entry) => (
            archivedWorkspaceCandidate.repoPath === entry.localPath
            || archivedWorkspaceCandidate.workspacePath.startsWith(`${entry.localPath}/`)
          )) ?? null;
          if (matchingRepo) {
            await handleSelectRegisteredRepo(matchingRepo.id);
          }
          setActiveWorkspace(archivedWorkspaceCandidate.workspacePath);
          setRightPanelMode('workspace');
          setChatVisible(true);
        },
      });
    } else {
      actions.push({
        id: 'workspace:resume-unavailable',
        category: 'workspace',
        title: 'Resume archived workspace',
        detail: workflowContextGuidance.resumeDetail,
        stateLabel: workflowContextStage?.label ?? 'Unavailable',
        stateTone: workflowContextStage ? workflowTone(workflowContextStage.label) : 'slate',
        keywords: ['resume workspace', 'resume archived workspace', 'resume'],
        priority: 11,
        disabled: true,
        unavailableReason: workflowContextGuidance.resumeUnavailableReason,
        run: () => undefined,
      });
    }

    return actions;
  }, [
    activeSessionKey,
    currentIssueTarget,
    currentReviewAgent,
    globalRepo,
    globalRepoEntry,
    globalRepoEntries,
    handleLaunchWorkspaceAgent,
    handleLaunchWorkspaceRepoTask,
    handleSelectSession,
    handleReviewPR,
    handleOpenFolder,
    handleOpenSettingsTab,
    handleOpenCI,
    handleRunInTerminal,
    handleSelectRegisteredRepo,
    handleSelectIssue,
    openRepoWorkspaceModal,
    paletteAgents,
    focusRepoSetup,
    currentWorkspaceLifecycleRecord,
    archivedWorkspaceCandidate,
    mutateWorkspaceLifecycle,
    nextAttentionWorkspace,
    selectedRepoWorktrees,
    selectedRepoWorktreesLoading,
    selectedSessionWorktree,
    selectedSessionAgent,
    scopedRepoAgents,
    staleSelectedRepoWorktrees,
    wsStatus,
    setActiveSessionKey,
    setActiveWorkspace,
    setChatVisible,
    setSelectedRepoWorktreeRefreshNonce,
    setSetupWizardOpen,
    setSidebarVisible,
    setRightPanelMode,
  ]);
}
