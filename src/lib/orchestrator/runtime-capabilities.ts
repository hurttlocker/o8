import type { OrchestratorRuntime } from './types';

export interface OrchestratorRuntimeCapability {
  /** Display label in pickers, chips */
  label: string;
  /** Short label for tight spaces */
  shortLabel: string;
  /** Can this runtime receive dispatched packets via mission control? */
  dispatchable: boolean;
  /** Does it require a --model flag to be picked before launch? */
  requiresModel: boolean;
  /** Default model if user doesn't pick one */
  defaultModel?: string;
  /** Chip / icon color for UI; HEX */
  accentColor: string;
  /** Binary name (for cli-resolver + diagnostics) */
  binaryName: string;
  /** Human-readable description for the launch picker tooltip */
  description: string;
}

export const ORCHESTRATOR_RUNTIMES: Record<OrchestratorRuntime, OrchestratorRuntimeCapability> = {
  codex: {
    label: 'Codex',
    shortLabel: 'Codex',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'gpt-5-codex',
    accentColor: '#2563eb', // blue — matches existing codex tone in display.ts
    binaryName: 'codex',
    description: 'GPT-5.4 xhigh coding agent via `codex exec --json`. Full-access sandbox, thread resume.',
  },
  'claude-code': {
    label: 'Claude Code',
    shortLabel: 'Claude',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'claude-sonnet-4-5',
    accentColor: '#e07a3a', // orange — matches existing claude-code tone in display.ts
    binaryName: 'claude',
    description: 'Anthropic Claude Code CLI with session resume and full tool surface.',
  },
  gemini: {
    label: 'Gemini',
    shortLabel: 'Gemini',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'gemini-3.1-pro-preview',
    accentColor: '#4285f4', // Google blue
    binaryName: 'gemini',
    description: 'Google Gemini CLI with --yolo autonomous dispatch and JSONL streaming.',
  },
  opencode: {
    label: 'opencode',
    shortLabel: 'opencode',
    dispatchable: true,
    requiresModel: true,
    defaultModel: 'opencode/gpt-5-nano',
    accentColor: '#a855f7', // purple — distinct from the other three
    binaryName: 'opencode',
    description: 'Multi-provider coding CLI via `opencode run` — routes to any provider model.',
  },
};

export function listDispatchableRuntimes(): OrchestratorRuntime[] {
  return (Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[])
    .filter((id) => ORCHESTRATOR_RUNTIMES[id].dispatchable);
}

export function getRuntimeCapability(runtime: OrchestratorRuntime): OrchestratorRuntimeCapability {
  return ORCHESTRATOR_RUNTIMES[runtime];
}
