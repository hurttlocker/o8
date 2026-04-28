// Capability map for orchestrator runtime adapters. See docs/runtime-adapter-contract.md.
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
    // dispatchable=false: the orchestrator no longer dispatches claude-code
    // packets (decision locked 2026-04-28, issue #650). The adapter still
    // ships for read-only discovery of user-spawned terminal sessions.
    // Native Claude sub-agents stay available via the Agent tool inline.
    dispatchable: false,
    requiresModel: false,
    defaultModel: 'claude-sonnet-4-5',
    accentColor: '#e07a3a', // orange — matches existing claude-code tone in display.ts
    binaryName: 'claude',
    description: 'Anthropic Claude Code CLI — read-only inventory only. Use Codex / Gemini / opencode for dispatch.',
  },
  gemini: {
    label: 'Gemini',
    shortLabel: 'Gemini',
    dispatchable: true,
    requiresModel: false,
    // 2026-04-28: reverted from gemini-3.1-pro to gemini-3-pro-preview after
    // the 3.1-pro fan-out test (mission-958a824e-b0a) showed 5/5 hallucinated
    // completions at thinkingEffort=max. See memory
    // gemini_fanout_reliability_apr28.md. The GEMINI_FALLBACK_CASCADE rolls
    // back further if 3-pro-preview hits quota.
    defaultModel: 'gemini-3-pro-preview',
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

export function listDispatchableRuntimes(options?: { includeExperimental?: boolean }): OrchestratorRuntime[] {
  const includeExperimental = options?.includeExperimental ?? false;
  return (Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[])
    .filter((id) => {
      if (!ORCHESTRATOR_RUNTIMES[id].dispatchable) return false;
      // opencode is experimental for v1 — only appears in dispatch pickers
      // when the operator has flipped `experimentalOpencode` on.
      if (id === 'opencode' && !includeExperimental) return false;
      return true;
    });
}

export function getRuntimeCapability(runtime: OrchestratorRuntime): OrchestratorRuntimeCapability {
  return ORCHESTRATOR_RUNTIMES[runtime];
}

/** Runtimes that ship in the v1 dispatch picker. Keep this narrow. */
export const V1_DISPATCH_RUNTIMES: OrchestratorRuntime[] = ['codex', 'gemini', 'opencode'];
