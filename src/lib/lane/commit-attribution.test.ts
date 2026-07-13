import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-commit-attribution-'));

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { resolveAttributedCommitMessage, applyAgentAttribution, AGENT_COMMIT_TRAILER } = await import('./commit-attribution');

/**
 * Real-path seam: worktree-side-merge.commitDirtyWorktree calls
 * resolveAttributedCommitMessage(commitMessage) at the actual commit site. This
 * drives THAT function against the persisted operator default (not the toggle
 * in isolation) so the "green tests encode the premise" trap can't hide an
 * unread setting.
 */
describe('agent commit attribution (persisted default → commit message)', () => {
  it('off by default: the message is committed verbatim', async () => {
    await updateOperatorDefaults({ commitAttributionEnabled: false });
    expect(resolveAttributedCommitMessage('feat: add thing')).toBe('feat: add thing');
  });

  it('on: the real commit path appends the trailer', async () => {
    await updateOperatorDefaults({ commitAttributionEnabled: true });
    const out = resolveAttributedCommitMessage('feat: add thing');
    expect(out).toContain('feat: add thing');
    expect(out).toContain(AGENT_COMMIT_TRAILER);
  });

  it('is idempotent — no duplicate trailer', () => {
    const once = applyAgentAttribution('fix: bug', true);
    const twice = applyAgentAttribution(once, true);
    expect(twice).toBe(once);
    expect(twice.split(AGENT_COMMIT_TRAILER).length - 1).toBe(1);
  });
});
