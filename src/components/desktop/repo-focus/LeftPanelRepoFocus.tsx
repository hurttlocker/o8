'use client';

import { useMemo, useState } from 'react';
import { RepoHeader } from './RepoHeader';
import { RepoTabs } from './RepoTabs';
import { AgentsTab } from './tabs/AgentsTab';
import { ContextTab } from './tabs/ContextTab';
import { MissionTab } from './tabs/MissionTab';
import { SpecTab } from './tabs/SpecTab';
import { FilesTab } from './tabs/FilesTab';
import { RepoFocusUsageStrip } from './RepoFocusUsageStrip';
import type { RepoFocusDataProps, RepoFocusRepo, RepoFocusTabId } from './types';
import { packetBelongsToRepo, REPO_FOCUS_FONT } from './utils';

interface LeftPanelRepoFocusProps extends RepoFocusDataProps {
  repo: RepoFocusRepo;
  onBack: () => void;
}

export function LeftPanelRepoFocus({
  repo,
  onBack,
  packets,
  missionState,
  ideWorkspaceSessions,
  activeSessionKey,
  onSelectSession,
}: LeftPanelRepoFocusProps) {
  const [tabState, setTabState] = useState<{ repoPath: string; tab: RepoFocusTabId }>(() => ({
    repoPath: repo.localPath,
    tab: 'agents',
  }));
  const activeTab = tabState.repoPath === repo.localPath ? tabState.tab : 'agents';

  const allMissionPackets = useMemo(
    () => (missionState?.packets ?? packets).filter((packet) => packetBelongsToRepo(packet, repo.localPath)),
    [missionState?.packets, packets, repo.localPath],
  );
  const visiblePackets = useMemo(
    () => packets.filter((packet) => packetBelongsToRepo(packet, repo.localPath)),
    [packets, repo.localPath],
  );
  const symbolText = useMemo(() => {
    const parts = [
      missionState?.summary ?? '',
      missionState?.prompt ?? '',
      ...allMissionPackets.flatMap((packet) => [packet.title, packet.summary, packet.issue?.body ?? '']),
    ];
    return parts.filter((part) => part.trim().length > 0).join('\n\n') || repo.name;
  }, [allMissionPackets, missionState?.prompt, missionState?.summary, repo.name]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: 'var(--t-text)',
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <RepoHeader repo={repo} packets={allMissionPackets} missionState={missionState} onBack={onBack} />
      <RepoTabs activeTab={activeTab} onTabChange={(tab) => setTabState({ repoPath: repo.localPath, tab })} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {activeTab === 'agents' ? (
          <AgentsTab
            repoPath={repo.localPath}
            packets={visiblePackets}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
          />
        ) : null}
        {activeTab === 'context' ? (
          <ContextTab repoPath={repo.localPath} symbolText={symbolText} />
        ) : null}
        {activeTab === 'mission' ? (
          <MissionTab packets={allMissionPackets} missionState={missionState} onSelectSession={onSelectSession} />
        ) : null}
        {activeTab === 'spec' ? (
          <SpecTab repo={repo} />
        ) : null}
        {activeTab === 'files' ? (
          <FilesTab repo={repo} />
        ) : null}
      </div>
      <RepoFocusUsageStrip />
    </div>
  );
}
