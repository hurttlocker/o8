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
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';

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

async function hasAntigravityCli(): Promise<boolean> {
  try {
    await resolveCli({
      runtimeId: 'antigravity',
      binaryName: 'agy',
      envOverride: 'O8_ANTIGRAVITY_BIN',
      aliases: ['antigravity'],
      extraEnvOverrides: ['ANTIGRAVITY_BIN'],
    });
    return true;
  } catch (error) {
    if (error instanceof CliNotFoundError) return false;
    throw error;
  }
}

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
    if (!await hasAntigravityCli()) return [];
    // Parser seam: official docs confirm `agy --print` for one-shot headless use,
    // but do not document a stable session id + streaming JSON contract.
    return [];
  },

  async readTranscript(_sessionKey: string, _sinceId?: string, _limit?: number): Promise<RuntimeTranscriptEntry[]> {
    void _sessionKey;
    void _sinceId;
    void _limit;
    return [];
  },

  async launch(_opts: LaunchOptions): Promise<RuntimeActionResult> {
    void _opts;
    return unavailable('launch');
  },

  async resume(_sessionKey: string, _message: string): Promise<RuntimeActionResult> {
    void _sessionKey;
    void _message;
    return unavailable('resume');
  },

  async interrupt(_sessionKey: string): Promise<RuntimeActionResult> {
    void _sessionKey;
    return unavailable('interrupt');
  },

  async getChangedFiles(_sessionKey: string): Promise<RuntimeChangedFile[]> {
    void _sessionKey;
    return [];
  },

  async getTelemetry(_sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    void _sessionKey;
    return undefined;
  },
};
