'use client';

import { useMemo, useState } from 'react';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { IdeWorkspaceSession } from '../types';
import {
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
  const packetSessionKeys = useMemo(() => new Set(packets.map((packet) => packet.lane?.sessionKey).filter(Boolean)), [packets]);
  const idleSessions = useMemo(() => ideWorkspaceSessions.filter((session) => (
    repoOwnsCandidate(repoPath, session.workspace)
    && !packetSessionKeys.has(session.sessionKey)
    && (!session.runtimeSurface?.ownership || session.runtimeSurface.ownership === 'owned')
  )), [ideWorkspaceSessions, packetSessionKeys, repoPath]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', fontFamily: REPO_FOCUS_FONT }}>
      {packets.length === 0 ? (
        <div style={{ paddingTop: 22, paddingRight: 18, paddingBottom: 22, paddingLeft: 18, color: 'var(--t-text-faint)', fontSize: 12.5, lineHeight: 1.45 }}>
          No active agents in this repo. Use the composer below to dispatch.
        </div>
      ) : packets.map((packet) => (
        <PacketRow
          key={packet.id}
          packet={packet}
          active={Boolean(packet.lane?.sessionKey && packet.lane.sessionKey === activeSessionKey)}
          onSelectSession={onSelectSession}
        />
      ))}
      {idleSessions.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setIdleOpen((current) => !current)}
            style={{
              minHeight: 44,
              borderWidth: 0,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              fontFamily: REPO_FOCUS_FONT,
              fontSize: 12,
              fontWeight: 560,
              textAlign: 'left',
              paddingTop: 0,
              paddingRight: 14,
              paddingBottom: 0,
              paddingLeft: 14,
            }}
          >
            {idleOpen ? '-' : '+'} {idleSessions.length} idle agents
          </button>
          {idleOpen ? idleSessions.map((session) => (
            <SessionRow key={session.sessionKey} session={session} onSelectSession={onSelectSession} />
          )) : null}
        </>
      ) : null}
    </div>
  );
}
