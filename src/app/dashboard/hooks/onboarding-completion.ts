import type { MutableRefObject } from 'react';
import type { OnboardingTask } from '@/components/desktop/onboarding/onboarding-progress';
import type { TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';

interface OnboardingTarget {
  projectId: string;
  tileId: string;
  tabId: string;
  text: string;
}

interface CompletionDependencies {
  loadRegisteredRepos: () => Promise<unknown>;
  handleSelectRegisteredRepo: (id: string) => Promise<unknown>;
  waitForWorkspaceTerminalTarget: (options: {
    repoPath: string;
    preferredTileId?: string;
    fallbackToAnyExisting: boolean;
    activate: boolean;
  }) => Promise<{ tileId: string; handle: Pick<TerminalTabHandle, 'focusTab' | 'openOrchestratorTab' | 'injectIntoOrchestrator'> }>;
  onboardingTargetRef: MutableRefObject<OnboardingTarget | null>;
  setActiveTileId: (id: string) => void;
  flashWorkspaceTab: (id: string) => void;
  handleSetupComplete: (repoPath?: string) => Promise<boolean>;
}

export function createOnboardingCompletionHandler(deps: CompletionDependencies) {
  return async (task?: OnboardingTask) => {
    if (task) {
      await deps.loadRegisteredRepos();
      await deps.handleSelectRegisteredRepo(task.project.id);
      const target = await deps.waitForWorkspaceTerminalTarget({ repoPath: task.project.localPath, preferredTileId: deps.onboardingTargetRef.current?.tileId, fallbackToAnyExisting: true, activate: true });
      const previous = deps.onboardingTargetRef.current;
      const tabId = previous?.projectId === task.project.id && previous.text === task.text && previous.tileId === target.tileId && target.handle.focusTab(previous.tabId)
        ? previous.tabId : target.handle.openOrchestratorTab({ ...task.project, branch: task.project.defaultBranch });
      if (task.text.trim() && (previous?.tabId !== tabId || previous.text !== task.text) && !target.handle.injectIntoOrchestrator(tabId, task.text, { autoSend: false })) throw new Error('Could not prepare the lead conversation. Try again.');
      deps.onboardingTargetRef.current = { projectId: task.project.id, tileId: target.tileId, tabId, text: task.text };
      target.handle.focusTab(tabId);
      deps.setActiveTileId(target.tileId);
      deps.flashWorkspaceTab(tabId);
    }
    return deps.handleSetupComplete(task?.project.localPath);
  };
}
