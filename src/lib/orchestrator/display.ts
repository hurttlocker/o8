import type {
  OrchestratorPacketStatus,
  OrchestratorRuntime,
  WorkspaceOrchestrationPacketBadge,
} from './types';

export { normalizeRuntimeStatusToOrchestratorStatus } from './runtime-status';

export interface OrchestratorDisplayTone {
  label: string;
  shortLabel: string;
  color: string;
  background: string;
  border: string;
  dot: string;
}

export function orchestratorRuntimeTone(runtime?: OrchestratorRuntime | string | null): OrchestratorDisplayTone {
  if (runtime === 'claude-code') {
    return {
      label: 'Claude Code',
      shortLabel: 'CC',
      color: '#e07a3a',
      background: 'rgba(224, 122, 58, 0.12)',
      border: 'rgba(224, 122, 58, 0.2)',
      dot: '#e07a3a',
    };
  }

  return {
    label: 'Codex',
    shortLabel: 'CX',
    color: '#2563eb',
    background: 'rgba(37, 99, 235, 0.12)',
    border: 'rgba(37, 99, 235, 0.2)',
    dot: '#2563eb',
  };
}

export function orchestratorStatusTone(status?: OrchestratorPacketStatus | null): OrchestratorDisplayTone {
  switch (status) {
    case 'queued':
      return {
        label: 'Queued',
        shortLabel: 'Q',
        color: '#1d4ed8',
        background: 'rgba(37, 99, 235, 0.1)',
        border: 'rgba(37, 99, 235, 0.18)',
        dot: '#2563eb',
      };
    case 'launching':
      return {
        label: 'Launching',
        shortLabel: 'Go',
        color: '#2563eb',
        background: 'rgba(37, 99, 235, 0.12)',
        border: 'rgba(37, 99, 235, 0.2)',
        dot: '#3b82f6',
      };
    case 'running':
      return {
        label: 'Running',
        shortLabel: 'Run',
        color: '#16a34a',
        background: 'rgba(22, 163, 74, 0.12)',
        border: 'rgba(22, 163, 74, 0.18)',
        dot: '#22c55e',
      };
    case 'awaiting_review':
      return {
        label: 'Reviewing',
        shortLabel: 'Rev',
        color: '#b45309',
        background: 'rgba(245, 158, 11, 0.12)',
        border: 'rgba(245, 158, 11, 0.2)',
        dot: '#f59e0b',
      };
    case 'blocked':
      return {
        label: 'Blocked',
        shortLabel: 'Hold',
        color: '#dc2626',
        background: 'rgba(239, 68, 68, 0.1)',
        border: 'rgba(239, 68, 68, 0.18)',
        dot: '#ef4444',
      };
    case 'recovering':
      return {
        label: 'Recovering',
        shortLabel: 'Fix',
        color: '#7c3aed',
        background: 'rgba(124, 58, 237, 0.12)',
        border: 'rgba(124, 58, 237, 0.2)',
        dot: '#8b5cf6',
      };
    case 'failed':
      return {
        label: 'Failed',
        shortLabel: 'Fail',
        color: '#991b1b',
        background: 'rgba(153, 27, 27, 0.12)',
        border: 'rgba(153, 27, 27, 0.2)',
        dot: '#dc2626',
      };
    case 'released':
      return {
        label: 'Completed',
        shortLabel: 'Done',
        color: '#0f766e',
        background: 'rgba(20, 184, 166, 0.12)',
        border: 'rgba(20, 184, 166, 0.2)',
        dot: '#14b8a6',
      };
    case 'archived':
      return {
        label: 'Archived',
        shortLabel: 'Arc',
        color: '#6b7280',
        background: 'rgba(107, 114, 128, 0.12)',
        border: 'rgba(107, 114, 128, 0.18)',
        dot: '#94a3b8',
      };
    case 'draft':
    case 'idle':
    default:
      return {
        label: 'Waiting',
        shortLabel: 'Wait',
        color: '#64748b',
        background: 'rgba(148, 163, 184, 0.12)',
        border: 'rgba(148, 163, 184, 0.2)',
        dot: '#94a3b8',
      };
  }
}

export function adHocLaneTitle(kind?: 'chat' | 'llm-chat' | 'terminal' | 'canvas' | 'orchestrator') {
  if (kind === 'terminal') return 'Terminal';
  if (kind === 'canvas') return 'Inspector';
  if (kind === 'orchestrator') return 'Orchestrator';
  if (kind === 'chat') return 'Agent';
  return 'Assistant';
}

export function laneDisplayTitle(
  packet?: Pick<WorkspaceOrchestrationPacketBadge, 'title'> | null,
  kind?: 'chat' | 'llm-chat' | 'terminal' | 'canvas' | 'orchestrator',
) {
  const title = packet?.title?.trim();
  return title || adHocLaneTitle(kind);
}
