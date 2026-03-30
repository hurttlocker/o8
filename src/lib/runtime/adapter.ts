import type { AgentStatus, FleetSnapshot } from '@/lib/fleet/types';

export type RuntimeKind = 'acp' | 'codex' | 'claude-code' | 'custom';

export interface RuntimeCapabilities {
  spawn: boolean;
  attach: boolean;
  steer: boolean;
  pause: boolean;
  stop: boolean;
  terminal: boolean;
  diff: boolean;
  artifacts: boolean;
  approvals: boolean;
  memoryContext: boolean;
  costTelemetry: boolean;
}

export interface SpawnRunRequest {
  task: string;
  workspace: string;
  runtime: RuntimeKind;
  model?: string;
  squadId?: string;
  labels?: string[];
}

export interface RunHandle {
  runId: string;
  sessionKey: string;
  runtime: RuntimeKind;
}

export interface RunTelemetry {
  runId: string;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  contextUsedPercent?: number;
  estimatedCostUsd?: number;
}

export interface RuntimeAdapter {
  kind: RuntimeKind;
  displayName: string;
  capabilities: RuntimeCapabilities;
  spawn(request: SpawnRunRequest): Promise<RunHandle>;
  attach(sessionKey: string): Promise<RunHandle>;
  steer(sessionKey: string, instruction: string): Promise<void>;
  pause(runId: string): Promise<void>;
  stop(sessionKey: string): Promise<void>;
  getTelemetry(sessionKey: string): Promise<RunTelemetry>;
}
