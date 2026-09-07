import type {
  AgentRuntime,
  LaunchOptions,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTelemetry,
  RuntimeTranscriptEntry,
} from './types';

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: false,
  resume: false,
  interrupt: false,
  reviewDiffs: false,
  costTelemetry: false,
  streaming: false,
};

function unavailable(action: string): RuntimeActionResult {
  return {
    ok: false,
    note: `Antigravity ${action} is disabled until agy exposes a documented resumable JSON/event contract.`,
  };
}

export const antigravityRuntime: AgentRuntime = {
  id: 'antigravity',
  displayName: 'Antigravity',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    // Parser seam: official docs confirm `agy --print` for one-shot headless use,
    // but do not document a stable session id + streaming JSON contract.
    return [];
  },

  async readTranscript(_sessionKey: string, _sinceId?: string, _limit?: number): Promise<RuntimeTranscriptEntry[]> {
    return [];
  },

  async launch(_opts: LaunchOptions): Promise<RuntimeActionResult> {
    return unavailable('launch');
  },

  async resume(_sessionKey: string, _message: string): Promise<RuntimeActionResult> {
    return unavailable('resume');
  },

  async interrupt(_sessionKey: string): Promise<RuntimeActionResult> {
    return unavailable('interrupt');
  },

  async getChangedFiles(_sessionKey: string): Promise<RuntimeChangedFile[]> {
    return [];
  },

  async getTelemetry(_sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    return undefined;
  },
};
