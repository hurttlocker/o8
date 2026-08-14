export type ClaudeCodeModelSource = 'native' | 'openrouter' | 'codex-subscription';

export const OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL = '~anthropic/claude-sonnet-latest';
export const CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL = 'gpt-5.6-sol';
export const CLAUDE_CODE_PROFILE_CHANGED_EVENT = 'o8:claude-code-profile-changed';

export interface ClaudeCodeWorkerProfile {
  source: ClaudeCodeModelSource;
  /** Provider-qualified OpenRouter model id. Retained while native is selected. */
  model: string | null;
  /** Codex OAuth model id. Retained while another source is selected. */
  codexModel: string | null;
}

export const CLAUDE_CODE_WORKER_PROFILE_FALLBACK: ClaudeCodeWorkerProfile = {
  source: 'native',
  model: null,
  codexModel: null,
};

export function isClaudeCodeModelSource(value: unknown): value is ClaudeCodeModelSource {
  return value === 'native' || value === 'openrouter' || value === 'codex-subscription';
}

export function normalizeClaudeCodeGatewayModel(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > 200 || !/^[~a-z0-9][a-z0-9._~:/-]*$/i.test(model)) return null;
  return model;
}
