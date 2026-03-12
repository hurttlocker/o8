import type { AgentStatus, FleetSnapshot } from '@/lib/fleet/types';

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
  steer(sessionKey: string, instruction: string): Promise<void>;
  pause(runId: string): Promise<void>;
  stop(sessionKey: string): Promise<void>;
  getTelemetry(sessionKey: string): Promise<RunTelemetry>;
}

const openClawCapabilities: RuntimeCapabilities = {
  spawn: false,
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

async function readJson<T>(response: Response) {
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

function mapStatus(status?: AgentStatus): RunTelemetry['status'] {
  switch (status) {
    case 'running':
    case 'reviewing':
      return 'running';
    case 'waiting':
      return 'queued';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    case 'idle':
    default:
      return 'completed';
  }
}

export const openClawAdapterContract: RuntimeAdapter = {
  kind: 'openclaw',
  displayName: 'OpenClaw / ACP',
  capabilities: openClawCapabilities,
  async spawn(request) {
    throw new Error(
      `Spawn is intentionally not wired in the live bridge MVP yet. Mirror first; explicit spawn comes later for ${request.runtime}.`,
    );
  },
  async attach(sessionKey) {
    return {
      runId: `session:${sessionKey}`,
      sessionKey,
      runtime: 'openclaw',
    };
  },
  async steer(sessionKey, instruction) {
    await readJson(
      await fetch('/api/openclaw/steer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionKey,
          message: instruction,
        }),
      }),
    );
  },
  async pause() {
    throw new Error('Pause is not wired for the OpenClaw adapter yet.');
  },
  async stop(sessionKey) {
    await readJson(
      await fetch('/api/openclaw/abort', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionKey,
        }),
      }),
    );
  },
  async getTelemetry(sessionKey) {
    const fleet = await readJson<FleetSnapshot>(
      await fetch('/api/openclaw/fleet', {
        cache: 'no-store',
      }),
    );
    const agent = fleet.agents.find((entry) => entry.sessionKey === sessionKey || entry.id === sessionKey);

    return {
      runId: sessionKey,
      status: mapStatus(agent?.status),
      startedAt: fleet.generatedAt,
      updatedAt: fleet.generatedAt,
      contextUsedPercent: agent?.context.usedPercent,
      estimatedCostUsd: agent?.cost?.sessionUsd,
    };
  },
};
