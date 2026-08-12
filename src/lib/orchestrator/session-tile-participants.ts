import type { OrchestratorRuntime, WorkerLaunchContext } from '@/lib/orchestrator/types';
import type {
  SessionTileLayout,
  SessionTileLeaf,
  SessionTileNode,
} from './session-tiles';

export interface SessionTileParticipantTransport {
  participantId: string;
  packetId?: string | null;
  laneId?: string | null;
  sessionKey: string;
  repoPath?: string | null;
  runtime?: OrchestratorRuntime | null;
  taskSummary?: string | null;
  launchContext?: WorkerLaunchContext | null;
}

function collectSessionLeaves(node: SessionTileNode): SessionTileLeaf[] {
  if (node.type === 'leaf') return node.kind === 'session' ? [node] : [];
  return [
    ...collectSessionLeaves(node.children[0]),
    ...collectSessionLeaves(node.children[1]),
  ];
}

export function collectSessionLeavesByArrival(node: SessionTileNode): SessionTileLeaf[] {
  return collectSessionLeaves(node)
    .map((leaf, treeIndex) => ({ leaf, treeIndex }))
    .sort((left, right) => {
      const leftOrder = left.leaf.arrivalOrder ?? left.treeIndex;
      const rightOrder = right.leaf.arrivalOrder ?? right.treeIndex;
      return leftOrder - rightOrder || left.treeIndex - right.treeIndex;
    })
    .map(({ leaf }) => leaf);
}

export function collectSessionKeysByArrival(node: SessionTileNode): string[] {
  return collectSessionLeavesByArrival(node)
    .map((leaf) => leaf.sessionKey)
    .filter((key): key is string => Boolean(key));
}

export function sessionTileParticipantMatchesLeaf(
  leaf: SessionTileLeaf,
  participant: SessionTileParticipantTransport,
): boolean {
  if (leaf.participantId) return leaf.participantId === participant.participantId;
  if (leaf.packetId && participant.packetId) return leaf.packetId === participant.packetId;
  if (leaf.laneId && participant.laneId) return leaf.laneId === participant.laneId;
  return leaf.sessionKey === participant.sessionKey;
}

function launchContextsEqual(
  left: WorkerLaunchContext | undefined,
  right: WorkerLaunchContext | undefined,
): boolean {
  return left?.source === right?.source
    && left?.presentation === right?.presentation
    && left?.repoContext === right?.repoContext
    && left?.workMode === right?.workMode
    && left?.caller === right?.caller
    && left?.parentWorkspaceId === right?.parentWorkspaceId
    && left?.parentThreadId === right?.parentThreadId;
}

/** Retarget a durable worker leaf when its runtime transport rotates. */
export function reconcileSessionTileParticipants(
  layout: SessionTileLayout,
  participants: ReadonlyArray<SessionTileParticipantTransport>,
): SessionTileLayout {
  let changed = false;
  function walk(node: SessionTileNode): SessionTileNode {
    if (node.type === 'leaf') {
      if (node.kind !== 'session') return node;
      const participant = participants.find((candidate) => (
        sessionTileParticipantMatchesLeaf(node, candidate)
      ));
      if (!participant) return node;
      const packetId = participant.packetId ?? undefined;
      const laneId = participant.laneId ?? undefined;
      const repoPath = participant.repoPath?.trim() || node.repoPath;
      const runtime = participant.runtime ?? node.runtime;
      const title = participant.taskSummary?.trim() || node.title;
      const launchContext = participant.launchContext ?? node.launchContext;
      if (
        node.participantId === participant.participantId
        && node.packetId === packetId
        && node.laneId === laneId
        && node.sessionKey === participant.sessionKey
        && node.repoPath === repoPath
        && node.runtime === runtime
        && node.title === title
        && launchContextsEqual(node.launchContext, launchContext)
      ) return node;
      changed = true;
      return {
        ...node,
        participantId: participant.participantId,
        packetId,
        laneId,
        sessionKey: participant.sessionKey,
        repoPath,
        runtime,
        title,
        launchContext,
      };
    }
    const first = walk(node.children[0]);
    const second = walk(node.children[1]);
    return first === node.children[0] && second === node.children[1]
      ? node
      : { ...node, children: [first, second] };
  }
  const root = walk(layout.root);
  return changed ? { ...layout, root } : layout;
}
