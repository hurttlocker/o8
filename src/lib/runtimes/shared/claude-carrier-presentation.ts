import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { ClaudeLoginState } from './claude-login-probe';
import { requiresNativeWorkerToken, WORKER_TOKEN_SETUP_HINT } from '@/lib/claude-code/worker-token';

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
  const nativeAuthDetail = requiresNativeWorkerToken()
    ? 'The native worker needs a dedicated inference credential.'
    : nativeLoginState === 'logged_out'
    ? 'Claude Code CLI is installed but not signed in.'
    : 'Claude Code CLI is installed but its sign-in state could not be verified.';
  return {
    ready: !blocked,
    detail: authenticated
      ? requiresNativeWorkerToken() ? 'Native worker credentials are configured; provider acceptance is checked on launch.' : 'Claude Code CLI is installed and signed in.'
      : nativeSignInBlocked
        ? carrier === 'native'
          ? nativeAuthDetail
          : `${nativeAuthDetail.slice(0, -1)}; workers use the ${CARRIER_LABELS[carrier]} carrier.`
        : 'Claude Code CLI is installed but its sign-in state could not be verified.',
    fix: blocked ? requiresNativeWorkerToken() ? WORKER_TOKEN_SETUP_HINT : 'Run `claude` once to sign in.' : 'No action needed.',
  };
}
