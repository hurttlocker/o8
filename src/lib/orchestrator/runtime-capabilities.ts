// Capability map for orchestrator runtime adapters. See docs/runtime-adapter-contract.md.
import { MODEL_IDS } from '@/lib/models';
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
  /**
   * Model capability tier, used by the "Workers use the Brain" auto mode:
   * `auto` turns the Engineering Brain on for every NON-frontier worker so a
   * weaker model gets repo knowledge without burning context on searches.
   * `frontier` — top-tier coding models (Codex GPT-5.5 xhigh, Claude).
   * `standard` — capable but benefits from injected knowledge (Gemini, opencode).
   * `local` — future on-device models (M5 era); always Brain-assisted in auto.
   */
  tier: 'frontier' | 'standard' | 'local';
}

export const ORCHESTRATOR_RUNTIMES: Record<OrchestratorRuntime, OrchestratorRuntimeCapability> = {
  codex: {
    label: 'Codex',
    shortLabel: 'Codex',
    dispatchable: true,
    requiresModel: false,
    // 2026-07-09: dispatched-worker default flipped to gpt-5.6-terra (Sonnet-class,
    // ~half Sol's price). The codex ORCHESTRATOR default is gpt-5.6-sol (see
    // MODEL_IDS.codexDefault); workers ride the cheaper Terra tier. gpt-5.5
    // remains selectable. (History: gpt-5-codex → gpt-5.5 on 2026-04-30 after
    // upstream 400'd gpt-5-codex on ChatGPT-account Codex CLI.)
    defaultModel: MODEL_IDS.codexWorkerDefault,
    accentColor: '#2563eb', // blue — matches existing codex tone in display.ts
    binaryName: 'codex',
    tier: 'frontier',
    description: 'GPT-5.6 coding agent via `codex exec --json` (Sol orchestration · Terra workers). Full-access sandbox, thread resume.',
  },
  'claude-code': {
    label: 'Claude Code',
    shortLabel: 'Claude',
    // #1407 (2026-07-06): operator reversed the old #650 lock. Frontier
    // runtimes orchestrate and work; Claude workers must use interactive
    // stream-json spawn only so they stay sub-billed, never Agent SDK --print.
    dispatchable: true,
    requiresModel: false,
    defaultModel: MODEL_IDS.claudeWorkerDefault,
    accentColor: '#e07a3a', // orange — matches existing claude-code tone in display.ts
    binaryName: 'claude',
    tier: 'frontier',
    description: 'Anthropic Claude Code CLI worker via interactive stream-json. Full-access permission mode, sub-billed; never --print.',
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
    tier: 'standard',
    description: 'Google Gemini CLI worker via headless stream-json with owned-session resume and review support.',
  },
  antigravity: {
    label: 'Antigravity',
    shortLabel: 'AGY',
    dispatchable: false,
    requiresModel: false,
    defaultModel: 'antigravity-default',
    accentColor: '#0f9d58',
    binaryName: 'agy',
    tier: 'standard',
    description: 'Google Antigravity CLI discovery skeleton. Launch stays disabled until a resumable JSON/event contract is documented.',
  },
  opencode: {
    label: 'opencode',
    shortLabel: 'opencode',
    // Promoted in runtime expansion P2: `opencode run --format json --session`
    // gives us a real JSONL/event + resume contract, with auth gated by
    // ~/.local/share/opencode/auth.json in dispatch preflight.
    dispatchable: true,
    requiresModel: true,
    // 2026-04-30: switched from 'opencode/gpt-5-nano' (OpenAI-routed; users
    // without OPENAI_API_KEY silently fail launch) to 'google/gemini-2.5-flash'
    // which routes through opencode's Google provider — the env var
    // GOOGLE_GENERATIVE_AI_API_KEY is the same one the user already has set
    // for direct gemini CLI usage. Operators with explicit OpenAI auth can
    // override per-packet via the assignedModel field.
    defaultModel: 'google/gemini-2.5-flash',
    accentColor: '#a855f7', // purple — distinct from the other three
    binaryName: 'opencode',
    tier: 'standard',
    description: 'Multi-provider coding CLI via `opencode run --format json`; dispatch requires local opencode auth.',
  },
  pi: {
    label: 'Pi',
    shortLabel: 'Pi',
    dispatchable: true,
    requiresModel: false,
    accentColor: '#16a34a',
    binaryName: 'pi',
    tier: 'standard',
    description: 'earendil-works/pi coding agent via RPC-mode JSONL with native steer.',
  },
  cursor: {
    label: 'Cursor',
    shortLabel: 'Cursor',
    dispatchable: true,
    requiresModel: false,
    defaultModel: 'cursor-agent',
    accentColor: '#111827',
    binaryName: 'cursor-agent',
    tier: 'frontier',
    description: 'Cursor CLI headless worker via `cursor-agent -p --output-format stream-json`.',
  },
  grok: {
    label: 'Grok Build',
    shortLabel: 'Grok',
    dispatchable: true,
    requiresModel: false,
    // 2026-07-09: headline model is grok-4.5 (Opus-class, cheaper for context),
    // passed to the `grok` CLI via `--model grok-4.5` — sub-billed through
    // SuperGrok, not a metered API path. Frontier tier (Opus-class treatment).
    defaultModel: MODEL_IDS.grokWorkerDefault,
    accentColor: '#16a34a',
    binaryName: 'grok',
    tier: 'frontier',
    description: 'xAI Grok Build coding CLI (grok-4.5) with headless JSON-schema output — sub-billed via SuperGrok.',
  },
};

export function listDispatchableRuntimes(options?: {
  includeExperimental?: boolean;
  experimental?: OrchestratorRuntime[];
}): OrchestratorRuntime[] {
  void options;
  return (Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[])
    .filter((id) => ORCHESTRATOR_RUNTIMES[id].dispatchable);
}

export function getRuntimeCapability(runtime: OrchestratorRuntime): OrchestratorRuntimeCapability {
  return ORCHESTRATOR_RUNTIMES[runtime];
}

/** Runtimes that ship in the dispatch picker. Mirrors the canonical capability set. */
export const V1_DISPATCH_RUNTIMES: OrchestratorRuntime[] = listDispatchableRuntimes();
