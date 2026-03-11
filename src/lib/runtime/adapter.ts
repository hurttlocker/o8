export type RuntimeKind = 'openclaw' | 'acp' | 'codex' | 'claude-code' | 'custom';

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
  steer(runId: string, instruction: string): Promise<void>;
  pause(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  getTelemetry(runId: string): Promise<RunTelemetry>;
}

const openClawCapabilities: RuntimeCapabilities = {
  spawn: true,
  attach: true,
  steer: true,
  pause: false,
  stop: true,
  terminal: true,
  diff: true,
  artifacts: true,
  approvals: true,
  memoryContext: true,
  costTelemetry: true,
};

export const openClawAdapterContract: RuntimeAdapter = {
  kind: 'openclaw',
  displayName: 'OpenClaw / ACP',
  capabilities: openClawCapabilities,
  async spawn(request) {
    return {
      runId: `draft-${request.runtime}-${Date.now()}`,
      sessionKey: 'pending:wire-openclaw-session',
      runtime: request.runtime,
    };
  },
  async attach(sessionKey) {
    return {
      runId: `attached-${Date.now()}`,
      sessionKey,
      runtime: 'openclaw',
    };
  },
  async steer() {
    return;
  },
  async pause() {
    throw new Error('Pause is not wired for the OpenClaw adapter yet.');
  },
  async stop() {
    return;
  },
  async getTelemetry(runId) {
    return {
      runId,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contextUsedPercent: 38,
      estimatedCostUsd: 1.24,
    };
  },
};
