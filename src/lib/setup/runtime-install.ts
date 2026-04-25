/**
 * Runtime install metadata — small, reusable map of "how to install runtime X"
 * shared between the onboarding wizard, dispatch step, and the pre-dispatch
 * guard modal.
 *
 * Issue #633 — first-run validation. Centralising this here means we only
 * have to update install commands in one place when an upstream rename
 * happens (eg. `@openai/codex` → `openai-codex` in the future).
 */

export interface RuntimeInstallInfo {
  /** Runtime id matching the detection endpoint (`codex`, `claude-code`, …). */
  id: string;
  /** Friendly label for UI copy. */
  label: string;
  /** Single shell command that installs the CLI globally. */
  command?: string;
  /** External docs / install link if `npm i -g …` doesn't apply. */
  link?: string;
  /** One-sentence description shown in the inline hint. */
  hint: string;
}

export const RUNTIME_INSTALL_INFO: Record<string, RuntimeInstallInfo> = {
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    command: 'npm i -g @openai/codex',
    hint: 'Install the OpenAI Codex CLI to dispatch packets.',
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'npm i -g @anthropic-ai/claude-code',
    hint: "Install Anthropic's Claude Code CLI to dispatch packets.",
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'npm i -g @google/gemini-cli',
    hint: "Install Google's Gemini CLI to dispatch packets.",
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode CLI',
    command: 'npm i -g opencode-ai',
    hint: 'Install OpenCode to bring your own keys across 75+ providers.',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    link: 'https://ollama.com',
    hint: 'Install Ollama to run local models for embeddings + offline workflows.',
  },
};

export function getRuntimeInstallInfo(runtimeId: string): RuntimeInstallInfo | null {
  return RUNTIME_INSTALL_INFO[runtimeId] ?? null;
}
