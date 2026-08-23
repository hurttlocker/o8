'use client';

import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { AgentStatusDot, agentStatusToDotState } from '@/components/desktop/AgentStatusDot';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { packetRuntimeModelDisplayLabel } from '@/lib/orchestrator/display';
import type { IdeWorkspaceSession } from '../types';
import {
  formatElapsed,
  packetStatusColor,
  packetStatusLabel,
  packetTimeLabel,
  packetVisualState,
  REPO_FOCUS_FONT,
  runtimeFromValue,
} from '../utils';

function RuntimeIcon({ runtime }: { runtime?: string | null }) {
  switch (runtimeFromValue(runtime)) {
    case 'claude-code':
      return <ClaudeIcon size={15} />;
    case 'gemini':
      return <GeminiIcon size={15} />;
    case 'opencode':
      return <OpenCodeIcon size={15} />;
    default:
      return <CodexIcon size={15} />;
  }
}

function packetDotLabel(packet: OrchestratorPacket): string {
  switch (packetVisualState(packet)) {
    case 'awaiting_review':
      return 'review ready';
    case 'failed':
      return 'failed';
    case 'merged':
      return 'merged';
    case 'running':
      return 'running';
    default:
      return 'idle';
  }
}

function sessionDotLabel(status: string): string {
  switch (status.toLowerCase()) {
    case 'reviewing':
    case 'awaiting_review':
      return 'review ready';
    case 'awaiting_input':
      return 'needs input';
    case 'awaiting_human':
      return 'needs you';
    case 'awaiting_orchestrator':
      return 'escalated';
    case 'failed':
    case 'blocked':
      return 'failed';
    case 'archived':
      return 'archived';
    case 'completed':
    case 'merged':
    case 'released':
      return 'merged';
    case 'running':
    case 'launching':
    case 'recovering':
      return 'running';
    default:
      return 'idle';
  }
}

export function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        minHeight: 22,
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        background: 'var(--t-input-bg)',
        color,
        paddingTop: 0,
        paddingRight: 7,
        paddingBottom: 0,
        paddingLeft: 7,
        fontSize: 10.5,
        fontWeight: 560,
        letterSpacing: '-0.01em',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

export function PacketRow({
  packet,
  active,
  onSelectSession,
}: {
  packet: OrchestratorPacket;
  active: boolean;
  onSelectSession?: (sessionKey: string) => void;
}) {
  const sessionKey = packet.lane?.sessionKey ?? null;
  return (
    <button
      type="button"
      onClick={() => {
        if (sessionKey) onSelectSession?.(sessionKey);
      }}
      style={{
        width: '100%',
        minHeight: 56,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderWidth: 0,
        background: active ? 'var(--t-input-bg)' : 'transparent',
        color: 'var(--t-text)',
        cursor: sessionKey ? 'pointer' : 'default',
        textAlign: 'left',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
      }}
    >
      <AgentStatusDot state={agentStatusToDotState(packetVisualState(packet))} label={packetDotLabel(packet)} />
      <RuntimeIcon runtime={packet.runtime} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {packet.referenceLabel ? `${packet.referenceLabel}: ${packet.title}` : packet.title}
        </span>
        <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
          {packetRuntimeModelDisplayLabel(packet)} · {packetTimeLabel(packet)}
        </span>
      </span>
      <StatusPill label={packetStatusLabel(packet)} color={packetStatusColor(packet)} />
    </button>
  );
}

export function SessionRow({
  session,
  onSelectSession,
}: {
  session: IdeWorkspaceSession;
  onSelectSession?: (sessionKey: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectSession?.(session.sessionKey)}
      style={{
        width: '100%',
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderWidth: 0,
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: REPO_FOCUS_FONT,
        paddingTop: 6,
        paddingRight: 14,
        paddingBottom: 6,
        paddingLeft: 24,
      }}
    >
      <AgentStatusDot state={agentStatusToDotState(session.status)} label={sessionDotLabel(session.status)} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.name || session.runtime || 'Agent'}
        </span>
        <span style={{ display: 'block', marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
          {session.branch || 'workspace'} · {formatElapsed(session.lastActivityAt ?? session.lastEventAt)} idle
        </span>
      </span>
      <StatusPill label={session.status} color="var(--t-text-muted)" />
    </button>
  );
}
