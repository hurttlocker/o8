'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ExtraAgentRowView, type ExtraAgentRow, type LaneStatus } from '@/components/desktop/AgentPanelExtraAgentRow';
import { OrchestratorHoverCard } from '@/components/desktop/OrchestratorHoverCard';
import type { SidebarFixture } from '@/lib/ui/sidebar-fixtures';
import type { ChatsTabProps } from './types';
import { attentionBand, attentionRank } from './sections';
import { staysInWorkingView, type ChatGroupMode } from './sidebar-view';
import { usePublishSidebarAttention } from './sidebar-view-store';
import { getLastVisited, markVisited } from './read-state';
import { useRowReadState } from './use-row-read-state';

const LANES: Record<SidebarFixture['state'], LaneStatus> = {
  running: 'running', stuck: 'recovering', failed: 'failed', waiting: 'awaiting_input',
  finished: 'completed', merged: 'merged', review: 'reviewing', rejected: 'reviewing', idle: 'idle',
};

function sampleRow(sample: SidebarFixture): ExtraAgentRow {
  return {
    key: sample.tabId, origin: 'CLI', runtime: 'Demo', model: null,
    name: sample.title, subtitle: 'Synthetic sidebar sample',
    status: sample.state === 'running' ? 'running' : ['stuck', 'failed'].includes(sample.state) ? 'error'
      : ['waiting', 'review', 'rejected'].includes(sample.state) ? 'waiting' : 'idle',
    lastActivityAt: Date.parse(sample.updatedAt), sessionKey: sample.tabId,
    repoPath: sample.repoPath, packetId: null, laneId: null, laneStatus: LANES[sample.state],
    outcome: sample.state === 'merged' ? 'merged' : sample.state === 'waiting' ? 'asked' : null,
    outcomeNote: sample.preview, lastEventLabel: null, rejected: sample.state === 'rejected',
    scheduled: sample.scheduled,
  };
}

export function sidebarFixtureAttention(sample: SidebarFixture) {
  const row = sampleRow(sample);
  return {
    status: row.laneStatus, outcome: row.outcome, rejected: row.rejected,
    unread: (getLastVisited(`ui-demo:${sample.tabId}`) ?? 0) < row.lastActivityAt,
  };
}

export function isWorkingSidebarFixture(sample: SidebarFixture, activeSessionKey?: string | null) {
  return staysInWorkingView(sidebarFixtureAttention(sample), activeSessionKey?.replace(/^llm-chat:/, '') === sample.tabId);
}

/** Saved sample transcripts rendered with the same row and motion as real workers. */
export function SidebarDemoStates({ fixtures, mode, shelf, publishAttention = true, showLabel = true, activeSessionKey, onOpenHistoryChat }: {
  fixtures: SidebarFixture[];
  mode: ChatGroupMode;
  shelf?: 'working' | 'settled';
  publishAttention?: boolean;
  showLabel?: boolean;
  activeSessionKey?: string | null;
  onOpenHistoryChat: ChatsTabProps['onOpenHistoryChat'];
}) {
  useRowReadState();
  const [hover, setHover] = useState<{ sample: SidebarFixture; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, [mode]);
  const rows = fixtures.map((sample) => {
    const row = sampleRow(sample);
    const subject = sidebarFixtureAttention(sample);
    return { sample, row, subject, active: activeSessionKey?.replace(/^llm-chat:/, '') === sample.tabId };
  });
  usePublishSidebarAttention(rows.filter(({ subject }) => attentionRank(subject) > 0).length, publishAttention && shelf !== 'settled');
  const shown = rows.filter(({ sample, subject, active }) => mode === 'scheduled' ? sample.scheduled
    : mode === 'working' ? shelf === 'settled' ? !staysInWorkingView(subject, active) : staysInWorkingView(subject, active) : true);
  if (mode === 'flat' || mode === 'working') shown.sort((a, b) => attentionRank(b.subject) - attentionRank(a.subject)
    || b.row.lastActivityAt - a.row.lastActivityAt);
  else shown.sort((a, b) => b.row.lastActivityAt - a.row.lastActivityAt);
  if (!shown.length) return null;
  const closeHover = () => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setHover(null), 160);
  };
  return (
    <section aria-label="Demo worker states" data-o8-sidebar-demo="true">
      {showLabel ? <div style={{ paddingTop: 3, paddingRight: 12, paddingBottom: 5, paddingLeft: 12,
        fontSize: 9.5, color: 'var(--t-text-faint)', fontFamily: 'var(--font-sans-system)' }}>
        Demo states{mode === 'repo' ? ` · ${[...new Set(shown.map(({ sample }) => sample.repoName))].join(', ')}` : ''}
      </div> : null}
      {shown.map(({ sample, row, subject, active }) => (
        <motion.div key={sample.tabId} layout="position" transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          data-o8-demo-state={sample.state} data-o8-demo-scheduled={sample.scheduled}>
          <ExtraAgentRowView row={row} active={active} busy={!onOpenHistoryChat} band={attentionBand(subject)}
            roomy={mode === 'flat' || (mode === 'working' && shelf !== 'settled')} repoLabel={mode === 'repo' ? null : sample.repoName}
            onFocusRow={() => {
              clearHoverTimer();
              markVisited(`ui-demo:${sample.tabId}`);
              setHover(null);
              onOpenHistoryChat?.(sample.tabId, sample.title, {
                name: sample.repoName, localPath: sample.repoPath, branch: sample.branch,
              });
            }}
            onOpenHoverCard={(_row, rect) => {
              clearHoverTimer();
              hoverTimer.current = setTimeout(() => setHover({ sample, rect }), 350);
            }} onCloseHoverCard={closeHover} />
        </motion.div>
      ))}
      {hover ? <OrchestratorHoverCard key={mode} title={hover.sample.title} repoLabel={hover.sample.repoName}
        branchLabel={hover.sample.branch} workspacePath={hover.sample.repoPath} updatedAt={hover.sample.updatedAt}
        backendLabel={hover.sample.scheduled ? 'Demo · Scheduled · no job runs' : 'Demo · saved transcript'}
        packets={[]} anchorRect={hover.rect} onMouseEnter={clearHoverTimer} onMouseLeave={closeHover} /> : null}
    </section>
  );
}
