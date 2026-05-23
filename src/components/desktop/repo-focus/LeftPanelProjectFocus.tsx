'use client';

import { useEffect, useMemo, useState } from 'react';
import { ProjectHeader } from './ProjectHeader';
import { RepoAnchorsRow } from './RepoAnchorsRow';
import { RepoHeader } from './RepoHeader';
import { RepoTabs } from './RepoTabs';
import { ChatsTab } from './tabs/ChatsTab';
import { ControlRoomTab } from './tabs/ControlRoomTab';
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

// Operator decision 2026-05-23 — hide the Control tab; the basic Chats
// surface does what we need for now. ControlRoomTab.tsx + control-room/
// stay on disk so we can re-enable later by re-adding the entry.
const PROJECTWIDE_TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'chats', label: 'Chats' },
];

const REPO_TABS: Array<{ id: RepoFocusTabId; label: string }> = [
  { id: 'chats', label: 'Chats' },
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
}: LeftPanelProjectFocusProps) {
  const selectedRepo = useMemo<RepoFocusRepo | null>(() => {
    if (!selectedRepoPath) return null;
    const normalized = normalizeRepoPath(selectedRepoPath);
    return repos.find((r) => normalizeRepoPath(r.localPath) === normalized) ?? null;
  }, [repos, selectedRepoPath]);

  const tabsForMode = selectedRepo ? REPO_TABS : PROJECTWIDE_TABS;
  const [activeTab, setActiveTab] = useState<RepoFocusTabId>('chats');

  // Fallback to 'chats' when the saved active tab (e.g. legacy 'control') no
  // longer appears in the visible list. Pre-hide-control this fell back to
  // 'control' which always existed; now 'chats' is the only surfaced tab so
  // it's the safe default.
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

  // Signal the dashboard to widen the left column into "control-room mode"
  // while the Control tab is active; collapse back on Chats and on unmount.
  // (Event, not a prop, to avoid drilling a callback through AgentPanel.)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('o8:control-room-wide', { detail: { wide: visibleActiveTab === 'control' } }));
  }, [visibleActiveTab]);
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('o8:control-room-wide', { detail: { wide: false } }));
  }, []);

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

      <div
        className="cortex-scroll-fade-y cortex-themed-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none' }}
      >
        {visibleActiveTab === 'control' ? (
          <ControlRoomTab
            project={project}
            repos={repos}
            selectedRepo={selectedRepo}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
          />
        ) : null}
        {visibleActiveTab === 'chats' ? (
          <ChatsTab
            repos={repos}
            selectedRepo={selectedRepo}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onOpenHistoryChat={onOpenHistoryChat}
            packets={visiblePackets}
          />
        ) : null}
      </div>
    </div>
  );
}
