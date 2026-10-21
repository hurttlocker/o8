import type { SemanticBlock, SemanticSurface } from '../../presentation/model.js';

export interface PacketInfoSurfaceEvent {
  id: string;
  timestamp: string;
  actor: string;
  verb: string;
}

export interface PacketInfoSurfaceInput {
  laneId: string;
  packetId: string | null;
  status: string;
  runtime: string;
  actualRuntime: string | null;
  branch: string;
  baseBranch: string;
  repoPath: string;
  worktreePath: string | null;
  label: string;
  events: readonly PacketInfoSurfaceEvent[];
}

export function buildPacketInfoSurface(input: PacketInfoSurfaceInput): SemanticSurface {
  const blocks: SemanticBlock[] = [
    {
      kind: 'facts',
      id: 'packet',
      title: 'packet',
      facts: [
        { id: 'lane', label: 'lane', value: input.laneId },
        { id: 'packet', label: 'packet', value: input.packetId ?? '(none)' },
        { id: 'status', label: 'status', value: input.status },
        { id: 'runtime', label: 'runtime', value: input.runtime },
        { id: 'actual-runtime', label: 'actual runtime', value: input.actualRuntime ?? '(pending)' },
        { id: 'branch', label: 'branch', value: input.branch },
        { id: 'base', label: 'base', value: input.baseBranch },
        { id: 'repo', label: 'repo', value: input.repoPath },
        { id: 'worktree', label: 'worktree', value: input.worktreePath ?? '(none)' },
        { id: 'label', label: 'label', value: input.label },
      ],
    },
  ];

  if (input.events.length > 0) {
    blocks.push({
      kind: 'event-log',
      id: 'recent-events',
      title: `recent events (${input.events.length})`,
      events: input.events.map((event) => ({
        id: event.id,
        timestamp: event.timestamp,
        actor: event.actor,
        verb: event.verb,
      })),
    });
  }

  return {
    id: `packet-info:${input.laneId}`,
    blocks,
  };
}
