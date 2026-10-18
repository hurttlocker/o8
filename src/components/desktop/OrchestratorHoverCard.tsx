'use client';

import { createPortal } from 'react-dom';
import { FloatingSurface } from './FloatingSurface';
import { formatElapsedAgo } from './repo-focus/tabs/chats/helpers';
import { MetaRow, resolveHoverPosition } from './SpawnedAgentHoverCard';
import { AgentStatusDot, AGENT_STATUS_ACCENT } from './AgentStatusDot';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { packetRuntimeModelDisplayLabel, runtimeModelDisplayLabel } from '@/lib/orchestrator/display';
import { useThreadWorkers } from './thoughts/chat-panel/ThreadWorkerCard';
import { packetsForOrchestratorThread, projectSwarmView, swarmPacketStatus, swarmSessionStatus } from './thoughts/chat-panel/SwarmStatusCard';

const AGENT_LIST_CAP = 6;
const NO_LIVE_AGENTS: Array<{ sessionKey?: string; status?: string }> = [];

/** One existing conversation hover, backed by recorded parent membership. */
export function OrchestratorHoverCard({
  title, repoLabel, backendLabel, branchLabel, workspacePath, updatedAt, threadId,
  packets, anchorRect, onMouseEnter, onMouseLeave,
}: {
  title: string;
  repoLabel: string | null;
  backendLabel: string | null;
  branchLabel?: string | null;
  workspacePath?: string | null;
  updatedAt?: string;
  threadId?: string | null;
  packets: OrchestratorPacket[];
  anchorRect: DOMRect | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const sessions = useThreadWorkers({ threadId: threadId ?? null, repoPath: workspacePath ?? null, busy: false, agents: NO_LIVE_AGENTS });
  const { byId, participants, shared, count } = projectSwarmView({ packets: packetsForOrchestratorThread(packets, threadId), sessions });
  const workers = [
    ...participants.map(participant => {
      const packet = byId.get(participant.id)!;
      return { id: participant.id, title: packet.title, model: packetRuntimeModelDisplayLabel(packet), status: swarmPacketStatus(packet) };
    }),
    ...shared.map(session => ({ id: session.sessionKey, title: session.name, model: runtimeModelDisplayLabel(session.runtime, session.model), status: swarmSessionStatus(session.status) })),
  ];
  if (!anchorRect || typeof document === 'undefined') return null;
  const shown = workers.slice(0, AGENT_LIST_CAP);
  const overflow = count - shown.length;
  const position = resolveHoverPosition(anchorRect, 230 + shown.length * 40 + (overflow ? 20 : 0));
  return createPortal(
    <FloatingSurface role="tooltip" data-orchestrator-hover={threadId ?? ''} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      style={{ position: 'fixed', left: position.left, top: position.top, zIndex: 10000, width: 348, pointerEvents: 'auto' }}
      contentStyle={{ paddingTop: 14, paddingRight: 16, paddingBottom: 13, paddingLeft: 16,
        maxHeight: `calc(100vh - ${position.top + 14}px)`, overflowY: 'auto', overscrollBehavior: 'contain' }}>
      <div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25,
        color: 'var(--t-text)', overflowWrap: 'anywhere', marginBottom: 11 }}>{title}</div>
      <div style={{ display: 'grid', gap: 7 }}>
        {repoLabel ? <MetaRow label="Repo" value={repoLabel} /> : null}
        {branchLabel ? <MetaRow label="Branch" value={branchLabel} /> : null}
        {workspacePath ? <MetaRow label="Workspace" value={<span title={workspacePath}>{workspacePath}</span>} /> : null}
        {updatedAt ? <MetaRow label="Updated" value={formatElapsedAgo(updatedAt)} /> : null}
        {backendLabel ? <MetaRow label="Backend" value={backendLabel} /> : null}
      </div>
      {count > 0 ? <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--t-divider-subtle)', display: 'grid', gap: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{count} {count === 1 ? 'worker' : 'workers'} from this conversation</span>
        {shown.map(worker => <div key={worker.id} data-hover-worker={worker.id}
          style={{ display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) auto', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <AgentStatusDot state={worker.status.state} label={worker.status.label} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={worker.title}>{worker.title}</span>
            <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={worker.model}>{worker.model}</span>
          </span>
          <span style={{ fontSize: 9.5, color: worker.status.state === 'idle' ? 'var(--t-text-muted)' : AGENT_STATUS_ACCENT[worker.status.state], maxWidth: 86, textAlign: 'right' }}>{worker.status.label}</span>
        </div>)}
        {overflow > 0 ? <span style={{ fontSize: 9.5, color: 'var(--t-text-faint)', paddingLeft: 22 }}>+{overflow} more · open the conversation for all workers</span> : null}
      </div> : null}
    </FloatingSurface>, document.body,
  );
}
