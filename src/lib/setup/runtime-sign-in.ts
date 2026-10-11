import type { SetupRuntime } from './runtime-recommendation';

export interface RuntimeSignInInfo { command?: string; instruction: string }

// Supported interactive entry points from the runtime adapters. Never execute
// commands extracted from detector prose or supplied by a setup response.
const SIGN_IN: Record<string, RuntimeSignInInfo> = {
  codex: { command: 'codex login', instruction: 'Run the command and finish Codex sign-in in your browser.' },
  'claude-code': { command: 'claude', instruction: 'Open Claude Code and follow its sign-in instructions.' },
  opencode: { command: 'opencode2 auth login', instruction: 'Choose the provider you use and follow its sign-in instructions.' },
  cursor: { command: 'cursor-agent login', instruction: 'Run the command and finish Cursor sign-in in your browser.' },
  pi: { command: 'pi', instruction: 'Open your installed Pi CLI and configure its model provider.' },
  gemini: { command: 'gemini', instruction: 'Open Gemini CLI and connect your enterprise account or configured API access.' },
};

export function getRuntimeSignInInfo(runtime: SetupRuntime): RuntimeSignInInfo | null {
  if (runtime.builtIn || runtime.available || runtime.unavailableReason !== 'needs_auth') return null;
  if (runtime.id === 'claude-code' && runtime.fix.includes('`o8 worker login`')) {
    return { command: 'o8 worker login', instruction: 'Follow the operator terminal instructions to connect Claude Code workers.' };
  }
  return SIGN_IN[runtime.id] ?? { instruction: runtime.fix || 'Follow this tool’s sign-in instructions, then check its readiness here.' };
}
