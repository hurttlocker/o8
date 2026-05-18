'use client';

import { useEffect, useMemo, useState } from 'react';
import { ProjectHeader } from './ProjectHeader';
import { RepoAnchorsRow } from './RepoAnchorsRow';
import { RepoHeader } from './RepoHeader';
import { RepoTabs } from './RepoTabs';
import { AgentsTab } from './tabs/AgentsTab';
import { ChatsTab } from './tabs/ChatsTab';
import { ContextTab } from './tabs/ContextTab';
import { MissionTab } from './tabs/MissionTab';
import { SpecTab } from './tabs/SpecTab';
import { FilesTab } from './tabs/FilesTab';
import type { RepoFocusDataProps, RepoFocusRepo, RepoFocusTabId } from './types';
import type { ProjectRecord } from '../repo-registry/useProjects';
import { normalizeRepoPath, packetBelongsToRepo, REPO_FOCUS_FONT } from './utils';

interface LeftPanelProjectFocusProps extends RepoFocusDataProps {
  project: ProjectRecord;
  repos: RepoFocusRepo[];
  selectedRepoPath: string | null;
  onSelectRepoPath: (repoPath: string | null) => void;
  onBack: () => void;
}

const PROJECTWIDE_TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'chats', label: 'Chats' },
  { id: 'agents', label: 'Packets' },
  { id: 'context', label: 'Context' },
  { id: 'mission', label: 'Mission' },
  { id: 'files', label: 'Files' },
];

const REPO_TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'chats', label: 'Chats' },
  { id: 'agents', label: 'Packets' },
  { id: 'context', label: 'Context' },
  { id: 'mission', label: 'Mission' },
  { id: 'spec', label: 'o8.md' },
  { id: 'files', label: 'Files' },
];

export function LeftPanelProjectFocus({
  project,
  repos,
  selectedRepoPath,
  onSelectRepoPath,
  onBack,
  packets,
  missionState,
  ideWorkspaceSessions,
  activeSessionKey,
  onSelectSession,
  onOpenHistoryChat,
  onSelectFile,
  onOpenSpecInWorkspace,
}: LeftPanelProjectFocusProps) {
  const selectedRepo = useMemo<RepoFocusRepo | null>(() => {
    if (!selectedRepoPath) return null;
    const normalized = normalizeRepoPath(selectedRepoPath);
    return repos.find((r) => normalizeRepoPath(r.localPath) === normalized) ?? null;
  }, [repos, selectedRepoPath]);

  const tabsForMode = selectedRepo ? REPO_TABS : PROJECTWIDE_TABS;
  const [activeTab, setActiveTab] = useState<RepoFocusTabId>('chats');

  const visibleActiveTab = tabsForMode.some((tab) => tab.id === activeTab) ? activeTab : 'chats';

  // ESC closes the entire panel — same as the prior repo-focus panel.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const tag = (event.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  // Filter packets to the project's repos (or further to the selected
  // repo when one is anchored). The wider list drives the project header
  // roll-up; the narrower drives in-tab content.
  const projectRepoPaths = useMemo(
    () => repos.map((r) => normalizeRepoPath(r.localPath)),
    [repos],
  );
  const projectPackets = useMemo(() => (
    packets.filter((packet) => projectRepoPaths.some((path) => packetBelongsToRepo(packet, path)))
  ), [packets, projectRepoPaths]);
  const visiblePackets = useMemo(() => (
    selectedRepo
      ? projectPackets.filter((packet) => packetBelongsToRepo(packet, selectedRepo.localPath))
      : projectPackets
  ), [projectPackets, selectedRepo]);
  const allMissionPackets = useMemo(() => {
    const source = missionState?.packets ?? packets;
    if (selectedRepo) return source.filter((packet) => packetBelongsToRepo(packet, selectedRepo.localPath));
    return source.filter((packet) => projectRepoPaths.some((path) => packetBelongsToRepo(packet, path)));
  }, [missionState?.packets, packets, projectRepoPaths, selectedRepo]);

  // Context recall expects a repo. In project-wide mode we either supply
  // the selected repo's symbol text, or the project name as a fallback so
  // the recall UI doesn't crash on undefined.
  const symbolText = useMemo(() => {
    const baseLines = [
      missionState?.summary ?? '',
      missionState?.prompt ?? '',
      ...allMissionPackets.flatMap((packet) => [packet.title, packet.summary, packet.issue?.body ?? '']),
    ];
    const text = baseLines.filter((line) => line.trim().length > 0).join('\n\n');
    return text || (selectedRepo?.name ?? project.name);
  }, [allMissionPackets, missionState?.prompt, missionState?.summary, project.name, selectedRepo]);

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
      <ProjectHeader
        project={project}
        repoCount={repos.length}
        packets={projectPackets}
        missionState={missionState}
        onBack={onBack}
      />

      {repos.length > 1 ? (
        <RepoAnchorsRow
          repos={repos}
          selectedRepoPath={selectedRepoPath}
          onSelect={onSelectRepoPath}
        />
      ) : null}

      {selectedRepo ? (
        <RepoHeader
          repo={selectedRepo}
          packets={allMissionPackets}
          missionState={missionState}
          onBack={() => onSelectRepoPath(null)}
        />
      ) : null}

      <RepoTabs activeTab={visibleActiveTab} onTabChange={setActiveTab} tabs={tabsForMode} />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {visibleActiveTab === 'chats' ? (
          <ChatsTab
            repos={repos}
            selectedRepo={selectedRepo}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onOpenHistoryChat={onOpenHistoryChat}
          />
        ) : null}
        {visibleActiveTab === 'agents' ? (
          <AgentsTab
            repoPath={selectedRepo?.localPath ?? ''}
            packets={visiblePackets}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
          />
        ) : null}
        {visibleActiveTab === 'context' ? (
          selectedRepo ? (
            <ContextTab repoPath={selectedRepo.localPath} symbolText={symbolText} />
          ) : (
            <PickARepoEmpty
              tabName="Context"
              hint="Recall is anchored to one repo at a time."
            />
          )
        ) : null}
        {visibleActiveTab === 'mission' ? (
          <MissionTab
            packets={allMissionPackets}
            missionState={missionState}
            onSelectSession={onSelectSession}
          />
        ) : null}
        {visibleActiveTab === 'spec' && selectedRepo ? (
          <SpecTab repo={selectedRepo} onOpenInWorkspace={onOpenSpecInWorkspace} />
        ) : null}
        {visibleActiveTab === 'files' ? (
          selectedRepo ? (
            <FilesTab
              repo={selectedRepo}
              onSelectFile={(repoPath, filePath) => onSelectFile?.(filePath, repoPath)}
            />
          ) : (
            <PickARepoEmpty
              tabName="Files"
              hint="The file tree is per repo."
            />
          )
        ) : null}
      </div>
    </div>
  );
}

function PickARepoEmpty({ tabName, hint }: { tabName: string; hint: string }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingTop: 32,
        paddingRight: 24,
        paddingBottom: 32,
        paddingLeft: 24,
        textAlign: 'center',
        color: 'var(--t-text-muted)',
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
        Pick a repo to view {tabName}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.45, maxWidth: 280, color: 'var(--t-text-faint)' }}>
        {hint}
      </div>
    </div>
  );
}
