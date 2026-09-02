import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { ClaudeLoginState } from './claude-login-probe';

const CARRIER_LABELS: Record<ClaudeCodeModelSource, string> = {
  native: 'native Claude Code',
  openrouter: 'OpenRouter gateway',
  'codex-subscription': 'Codex subscription',
};

export function claudeCarrierPresentation(
  carrier: ClaudeCodeModelSource,
  authenticated: boolean,
  nativeSignInBlocked: boolean,
  nativeLoginState: ClaudeLoginState = 'unknown',
): { ready: boolean; detail: string; fix: string } {
  const blocked = carrier === 'native' && nativeSignInBlocked;
  const nativeAuthDetail = nativeLoginState === 'logged_out'
    ? 'Claude Code CLI is installed but not signed in.'
    : 'Claude Code CLI is installed but its sign-in state could not be verified.';
  return {
    ready: !blocked,
    detail: authenticated
      ? 'Claude Code CLI is installed and signed in.'
      : nativeSignInBlocked
        ? carrier === 'native'
          ? nativeAuthDetail
          : `${nativeAuthDetail.slice(0, -1)}; workers use the ${CARRIER_LABELS[carrier]} carrier.`
        : 'Claude Code CLI is installed but its sign-in state could not be verified.',
    fix: blocked ? 'Run `claude` once to sign in.' : 'No action needed.',
  };
}
