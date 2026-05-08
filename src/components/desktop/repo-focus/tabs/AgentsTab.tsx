'use client';

import { useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession } from '../types';
import {
  isConcluded,
  isLivePacket,
  packetEventTime,
  REPO_FOCUS_FONT,
  repoOwnsCandidate,
} from '../utils';
import { PacketRow, SessionRow } from './AgentRows';

interface AgentsTabProps {
  repoPath: string;
  packets: OrchestratorPacket[];
  ideWorkspaceSessions?: IdeWorkspaceSession[];
  activeSessionKey?: string | null;
  onSelectSession?: (sessionKey: string) => void;
}

export function AgentsTab({
  repoPath,
  packets,
  ideWorkspaceSessions = [],
  activeSessionKey,
  onSelectSession,
}: AgentsTabProps) {
  const [idleOpen, setIdleOpen] = useState(false);
  const [mergedOpen, setMergedOpen] = useState(false);

  // Split packets into live work + the concluded archive. Live drives
  // the primary list; concluded packets (released / archived / merged /
  // failed) sit behind a collapsible drawer, sorted newest first, so
  // the operator can audit every shipped packet for this repo without
  // them dominating today's view.
  const livePackets = useMemo(() => packets.filter(isLivePacket), [packets]);
  const concludedPackets = useMemo(
    () => packets
      .filter(isConcluded)
      .slice()
      .sort((a, b) => packetEventTime(b) - packetEventTime(a)),
    [packets],
  );

  const packetSessionKeys = useMemo(() => new Set(livePackets.map((packet) => packet.lane?.sessionKey).filter(Boolean)), [livePackets]);
  const idleSessions = useMemo(() => ideWorkspaceSessions.filter((session) => (
    repoOwnsCandidate(repoPath, session.workspace)
    && !packetSessionKeys.has(session.sessionKey)
    && (!session.runtimeSurface?.ownership || session.runtimeSurface.ownership === 'owned')
  )), [ideWorkspaceSessions, packetSessionKeys, repoPath]);

  const hasLive = livePackets.length > 0;
  const hasIdle = idleSessions.length > 0;
  const hasConcluded = concludedPackets.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', fontFamily: REPO_FOCUS_FONT }}>
      {hasLive ? (
        livePackets.map((packet) => (
          <PacketRow
            key={packet.id}
            packet={packet}
            active={Boolean(packet.lane?.sessionKey && packet.lane.sessionKey === activeSessionKey)}
            onSelectSession={onSelectSession}
          />
        ))
      ) : !hasIdle && !hasConcluded ? (
        <div style={{ paddingTop: 22, paddingRight: 18, paddingBottom: 22, paddingLeft: 18, color: 'var(--t-text-faint)', fontSize: 12.5, lineHeight: 1.45 }}>
          No active agents. Use the composer below to dispatch.
        </div>
      ) : null}

      {hasIdle ? (
        <>
          <DrawerHeader
            open={idleOpen}
            label={`${idleSessions.length} idle agent${idleSessions.length === 1 ? '' : 's'}`}
            onToggle={() => setIdleOpen((current) => !current)}
          />
          {idleOpen ? idleSessions.map((session) => (
            <SessionRow key={session.sessionKey} session={session} onSelectSession={onSelectSession} />
          )) : null}
        </>
      ) : null}

      {hasConcluded ? (
        <>
          <DrawerHeader
            open={mergedOpen}
            label={`${concludedPackets.length} archived`}
            dotColor="#16a34a"
            onToggle={() => setMergedOpen((current) => !current)}
          />
          {mergedOpen ? concludedPackets.map((packet) => (
            <PacketRow
              key={packet.id}
              packet={packet}
              active={false}
              onSelectSession={onSelectSession}
            />
          )) : null}
        </>
      ) : null}
    </div>
  );
}

function DrawerHeader({
  open,
  label,
  dotColor,
  onToggle,
}: {
  open: boolean;
  label: string;
  dotColor?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        minHeight: 36,
        borderWidth: 0,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
        background: 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        fontFamily: REPO_FOCUS_FONT,
        fontSize: 11.5,
        fontWeight: 560,
        letterSpacing: '-0.005em',
        textAlign: 'left',
        paddingTop: 0,
        paddingRight: 14,
        paddingBottom: 0,
        paddingLeft: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        transition: 'color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          width: 12,
          color: 'var(--t-text-faint)',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </span>
      {dotColor ? (
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      ) : null}
      <span>{label}</span>
    </button>
  );
}
