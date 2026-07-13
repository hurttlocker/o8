import 'server-only';

import { resolveCommitAttributionEnabledSync } from '@/lib/operator/defaults';

/**
 * Optional agent commit attribution (Git & PRs settings). When the operator
 * turns "Tag commits created by agents" on, the agent worktree commit gets a
 * standard `Co-Authored-By` trailer so the fleet's work is attributable in git
 * history. Default off → the message is committed verbatim, exactly as before.
 */
export const AGENT_COMMIT_TRAILER = 'Co-Authored-By: o8 agent <agent@o8.run>';

/** Append the attribution trailer when `enabled`, unless it's already present. */
export function applyAgentAttribution(message: string, enabled: boolean): string {
  if (!enabled) return message;
  if (message.includes(AGENT_COMMIT_TRAILER)) return message;
  const trimmed = message.replace(/\s+$/, '');
  return `${trimmed}\n\n${AGENT_COMMIT_TRAILER}\n`;
}

/**
 * The real commit path calls this — it reads the persisted operator default and
 * applies the trailer. Kept as its own tiny, testable entry (real-path seam).
 */
export function resolveAttributedCommitMessage(message: string): string {
  return applyAgentAttribution(message, resolveCommitAttributionEnabledSync());
}
