import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { FalseDispatchAttemptResult } from './orchestrator-false-dispatch';
import type { OrchestratorTurnRecord } from './orchestrator-crash-survival';
import type {
  createToolCallTracker,
  OrchestratorEvent,
  OrchestratorTurnUsage,
} from './orchestrator-stream-events';

export interface OrchestratorProcConfig {
  cwd: string;
  model: string;
  permissionMode: 'full' | 'plan';
  toolProfile: ToolProfile;
  effort: ThinkingEffort;
  mcpConfigPath: string;
  mcpConfigHash: string;
  mcpConfigMaterial: string;
  modelSource: string;
  carrierFingerprint: string;
}

export interface OrchestratorActiveTurn {
  onEvent: (event: OrchestratorEvent) => void;
  captureEvent: (event: OrchestratorEvent) => void;
  resolve: (outcome: FalseDispatchAttemptResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
  toolTracker: ReturnType<typeof createToolCallTracker>;
  turnSessionId: string | null;
  cost: number | null;
  usage?: OrchestratorTurnUsage | null;
  lastAssistantText: string;
  sawToolUseAfterText: boolean;
  launchAgentCallCount: number;
  crashRecord: OrchestratorTurnRecord | null;
  stopCrashTail: (() => void) | null;
  promptFingerprint: string | null;
}

export interface WarmState {
  procConfig: OrchestratorProcConfig | null;
  activeTurn: OrchestratorActiveTurn | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stdoutLineBuffer: string;
  stderrBuffer: string;
  lastUsedAt: number;
  crashStdoutPath: string | null;
  crashStderrPath: string | null;
  resumeAfterKill: boolean;
  resumeUnavailable: boolean;
  sessionPrompt: string | null;
}
