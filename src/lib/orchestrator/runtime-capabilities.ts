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
    // 2026-04-30: switched from 'gpt-5-codex' to 'gpt-5.5'. Upstream Codex API
    // started returning HTTP 400 invalid_request_error "model is not supported
    // when using Codex with a ChatGPT account" for gpt-5-codex. gpt-5.5 is the
    // current supported model on ChatGPT-account Codex CLI.
    defaultModel: 'gpt-5.5',
    accentColor: '#2563eb', // blue — matches existing codex tone in display.ts
    binaryName: 'codex',
    description: 'GPT-5.5 coding agent via `codex exec --json`. Full-access sandbox, thread resume.',
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
    // dispatchable=false: Gemini is hidden from the v1 picker (decision
    // 2026-05-31). We ship Claude + Codex only; Gemini lives behind the
    // `experimentalGemini` operator-defaults flag, mirroring opencode. The
    // adapter still ships so existing Gemini lanes stay readable + dispatch
    // validation (includeExperimental) keeps accepting them.
    dispatchable: false,
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
    // dispatchable=false: opencode disabled in the v1 picker (decision
    // 2026-04-30). The big-3 (Codex / Gemini / Claude) cover every operator
    // request we've seen; opencode adds support burden without a user pulling
    // for it. Re-enable when someone asks. Adapter still ships so existing
    // owned sessions remain readable.
    dispatchable: false,
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
    description: 'Multi-provider coding CLI — disabled by default. Use Codex / Gemini for dispatch.',
  },
};

// `opencode` + `gemini` ship hidden behind their own experimental operator
// flags. Server-side validation passes `includeExperimental: true` to accept
// every hidden runtime (existing lanes must still validate); client pickers
// pass `experimental: [...]` to ungate only the runtimes whose flag is on.
// Hide opencode and gemini from the shipping v1 picker while they remain experimental/non-primary dispatch paths.
const HIDDEN_DISPATCH_RUNTIMES = new Set<OrchestratorRuntime>(['opencode', 'gemini']);

export function listDispatchableRuntimes(options?: {
  includeExperimental?: boolean;
  experimental?: OrchestratorRuntime[];
}): OrchestratorRuntime[] {
  const includeAll = options?.includeExperimental ?? false;
  const allow = new Set<OrchestratorRuntime>(options?.experimental ?? []);
  return (Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[])
    .filter((id) => {
      const cap = ORCHESTRATOR_RUNTIMES[id];
      if (cap.dispatchable) return true;
      if (HIDDEN_DISPATCH_RUNTIMES.has(id)) return includeAll || allow.has(id);
      return false;
    });
}

export function getRuntimeCapability(runtime: OrchestratorRuntime): OrchestratorRuntimeCapability {
  return ORCHESTRATOR_RUNTIMES[runtime];
}

/** Runtimes that ship in the v1 dispatch picker. Keep this narrow. */
export const V1_DISPATCH_RUNTIMES: OrchestratorRuntime[] = ['codex'];
