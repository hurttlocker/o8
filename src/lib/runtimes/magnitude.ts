import type {
  AgentRuntime,
  RuntimeActionResult,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTelemetry,
  RuntimeTranscriptEntry,
} from './types';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';

const capabilities = {
  discover: true,
  readTranscript: false,
  launch: false,
  resume: false,
  interrupt: false,
  reviewDiffs: false,
  costTelemetry: false,
  streaming: false,
} as const;

async function hasMagnitudeCli(): Promise<boolean> {
  try {
    await resolveCli({
      runtimeId: 'magnitude',
      binaryName: 'magnitude',
      envOverride: 'O8_MAGNITUDE_BIN',
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
    note: `Magnitude ${action} is unavailable through packet dispatch while its headless mode is disabled. Launch it from New tab to run it in a visible repository terminal.`,
  };
}

export const magnitudeRuntime: AgentRuntime = {
  id: 'magnitude',
  displayName: 'Magnitude',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    if (!await hasMagnitudeCli()) return [];
    // Live terminal processes are attached through the shared IDE session
    // registry. Upstream session files stay private until a stable transcript
    // or daemon RPC contract is available.
    return [];
  },

  async readTranscript(): Promise<RuntimeTranscriptEntry[]> {
    return [];
  },

  async launch(): Promise<RuntimeActionResult> {
    return unavailable('launch');
  },

  async resume(): Promise<RuntimeActionResult> {
    return unavailable('resume');
  },

  async interrupt(): Promise<RuntimeActionResult> {
    return unavailable('interrupt');
  },

  async getChangedFiles(): Promise<RuntimeChangedFile[]> {
    return [];
  },

  async getTelemetry(): Promise<RuntimeTelemetry | undefined> {
    return undefined;
  },
};
